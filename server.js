// === Smart Classroom Attendance Server (Final Fixed + Enhanced Version) ===
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 8080;

const SUBJECT_CATALOG = ["OOSE", "OS", "DSE", "DBMS", "PSSM-MATHS", "CD"];

// === CONFIG ===
const CLASS_LAT = parseFloat(process.env.CLASS_LAT || "13.0827");
const CLASS_LON = parseFloat(process.env.CLASS_LON || "80.2707");
const CLASS_RADIUS_METERS = parseFloat(process.env.CLASS_RADIUS_METERS || "50000");
const SERVER_URL = "https://tallowy-kera-conducibly.ngrok-free.dev";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// === PATHS ===
const DB_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, "attendance.db");

// === TWILIO CONFIG ===
const TWILIO_SID = process.env.TWILIO_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";

let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) {
  try {
    twilioClient = require("twilio")(TWILIO_SID, TWILIO_TOKEN);
    console.log("📱 Twilio client connected successfully.");
  } catch (err) {
    console.warn("⚠️ Twilio initialization failed:", err.message);
  }
} else {
  console.log("⚠️ Twilio credentials missing — SMS simulation mode enabled.");
}

// === DATABASE INIT ===
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ Database error:", err);
  else console.log("✅ SQLite DB open:", DB_PATH);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      student_name TEXT,
      parent_phone TEXT
    )`);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      label TEXT,
      period INTEGER,
      date TEXT,
      started_at INTEGER,
      ended_at INTEGER
    )`);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      student_name TEXT,
      date TEXT,
      status TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      marked_ts INTEGER,
      UNIQUE(session_id, student_id)
    )`);

  db.run(`
    CREATE TABLE IF NOT EXISTS staff_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      subjects TEXT NOT NULL,
      is_superadmin INTEGER DEFAULT 0
    )`);

  // Backward compatible migration for older DBs without this column.
  db.run("ALTER TABLE staff_users ADD COLUMN is_superadmin INTEGER DEFAULT 0", () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS student_users (
      student_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      student_name TEXT
    )`);

  db.run(`
    CREATE TABLE IF NOT EXISTS subjects (
      name TEXT PRIMARY KEY
    )`);
});

// === MIDDLEWARE ===
app.use(cors());
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "smart-classroom-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// === HELPERS ===
const nowTs = () => Math.floor(Date.now() / 1000);
const genSessionId = () => "S" + Math.random().toString(36).substring(2, 10).toUpperCase();

const distanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const normalizeStatus = (value) => {
  const v = String(value || "Present").trim().toLowerCase();
  return v === "absent" ? "Absent" : "Present";
};

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

const parseSubjectList = (subjectText) =>
  String(subjectText || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const uniqueSubjects = (arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));

const areSubjectsValid = (arr) => arr.every((s) => SUBJECT_CATALOG.includes(s));

const ensureStaffUser = async (username, password, displayName, subjectsCsv, isSuperAdmin = false) => {
  const found = await getAsync("SELECT username FROM staff_users WHERE username=?", [username]);
  if (found) return;
  const hash = await bcrypt.hash(password, 10);
  await runAsync(
    "INSERT INTO staff_users(username, password_hash, display_name, subjects, is_superadmin) VALUES(?, ?, ?, ?, ?)",
    [username, hash, displayName, subjectsCsv, isSuperAdmin ? 1 : 0]
  );
};

const ensureStudentUser = async (studentId, password, studentName) => {
  const found = await getAsync("SELECT student_id FROM student_users WHERE student_id=?", [studentId]);
  if (found) return;
  const hash = await bcrypt.hash(password, 10);
  await runAsync(
    "INSERT INTO student_users(student_id, password_hash, student_name) VALUES(?, ?, ?)",
    [studentId, hash, studentName || studentId]
  );
};

const ensureAuthSeedData = async () => {
  try {
    await ensureStaffUser(
      "superadmin",
      "super123",
      "Super Admin",
      SUBJECT_CATALOG.join(","),
      true
    );
    await ensureStaffUser("staff_oose", "oose123", "OOSE Staff", "OOSE");
    await ensureStaffUser("staff_os", "os123", "OS Staff", "OS");
    await ensureStaffUser("staff_dse", "dse123", "DSE Staff", "DSE");
    await ensureStaffUser("staff_dbms", "dbms123", "DBMS Staff", "DBMS");
    await ensureStaffUser("staff_pssm", "pssm123", "PSSM Staff", "PSSM-MATHS");
    await ensureStaffUser("staff_cd", "cd123", "CD Staff", "CD");

    const studentRows = await allAsync(
      "SELECT student_id, student_name FROM students ORDER BY student_id LIMIT 20"
    );
    for (const s of studentRows) {
      await ensureStudentUser(s.student_id, `${s.student_id.toLowerCase()}123`, s.student_name || s.student_id);
    }
  } catch (e) {
    console.error("⚠️ Failed to seed auth users:", e.message);
  }
};

const ensureSubjectSeedData = async () => {
  try {
    await runAsync("DELETE FROM subjects");
    for (const s of SUBJECT_CATALOG) {
      await runAsync("INSERT OR IGNORE INTO subjects(name) VALUES(?)", [s]);
    }
  } catch (e) {
    console.error("⚠️ Failed to seed subjects:", e.message);
  }
};

const requireStaff = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === "staff") return next();
  return res.status(401).json({ ok: false, error: "Staff login required" });
};

const requireStudent = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === "student") return next();
  return res.status(401).json({ ok: false, error: "Student login required" });
};

const requireSuperAdmin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === "staff" && req.session.user.isSuperAdmin) {
    return next();
  }
  return res.status(403).json({ ok: false, error: "Super-admin access required" });
};

const sendSms = async (to, body) => {
  if (!to) return console.log("⚠️ Skipping SMS: No phone number provided.");
  if (!twilioClient) return console.log("[SMS SIMULATED]", to, body);

  try {
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body });
    console.log(`✅ [SMS SENT] → ${to}: ${body}`);
  } catch (e) {
    console.error("❌ [SMS ERROR]:", e.message);
  }
};

const buildStudentSummary = async (studentId) => {
  const studentProfile =
    (await getAsync("SELECT student_name FROM students WHERE student_id=?", [studentId])) ||
    (await getAsync("SELECT student_name FROM student_users WHERE student_id=?", [studentId]));

  const rows = await allAsync(
    `SELECT a.status, a.date, s.label AS subject, a.session_id, a.marked_ts
     FROM attendance a
     LEFT JOIN sessions s ON s.id = a.session_id
     WHERE a.student_id = ?
     ORDER BY a.marked_ts DESC`,
    [studentId]
  );

  const summaryBySubject = {};
  let total = 0;
  let present = 0;
  let absent = 0;

  for (const r of rows) {
    const subject = r.subject || "Unknown";
    const status = normalizeStatus(r.status);
    if (!summaryBySubject[subject]) {
      summaryBySubject[subject] = { subject, taken: 0, present: 0, absent: 0, attendancePercent: 0 };
    }

    summaryBySubject[subject].taken += 1;
    total += 1;
    if (status === "Present") {
      summaryBySubject[subject].present += 1;
      present += 1;
    } else {
      summaryBySubject[subject].absent += 1;
      absent += 1;
    }
  }

  const subjects = Object.values(summaryBySubject)
    .map((s) => ({
      ...s,
      attendancePercent: s.taken ? Math.round((s.present / s.taken) * 100) : 0,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));

  return {
    student: {
      studentId,
      studentName: studentProfile?.student_name || studentId,
    },
    totals: {
      total,
      present,
      absent,
      attendancePercent: total ? Math.round((present / total) * 100) : 0,
    },
    subjects,
    rows,
  };
};

const getLowAttendanceItems = async (threshold, subjectFilter = []) => {
  const allStudents = await allAsync(
    "SELECT student_id, COALESCE(student_name, student_id) AS student_name FROM students ORDER BY student_id"
  );
  const items = [];

  for (const student of allStudents) {
    const summary = await buildStudentSummary(student.student_id);
    for (const s of summary.subjects) {
      if (subjectFilter.length && !subjectFilter.includes(s.subject)) continue;
      if (s.attendancePercent < threshold) {
        items.push({
          studentId: student.student_id,
          studentName: student.student_name,
          subject: s.subject,
          attendancePercent: s.attendancePercent,
          taken: s.taken,
          present: s.present,
          absent: s.absent,
        });
      }
    }
  }

  return items.sort((a, b) => a.attendancePercent - b.attendancePercent);
};

setTimeout(() => {
  ensureSubjectSeedData();
  ensureAuthSeedData();
}, 200);

// === ROUTES ===

// === GPS Attendance Mark (used by student.html QR scan) ===
app.post("/api/mark_with_gps", requireStudent, (req, res) => {
  const { session_id, latitude, longitude } = req.body;
  const student_id = req.session.user.studentId;
  const student_name = req.session.user.studentName;
  if (!session_id || !student_id)
    return res.status(400).json({ ok: false, error: "Missing session_id or student_id" });

  db.get("SELECT * FROM sessions WHERE id=?", [session_id], (err, sess) => {
    if (err || !sess) return res.status(400).json({ ok: false, error: "Invalid session ID" });

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lon))
      return res.status(400).json({ ok: false, error: "Invalid GPS coordinates" });

    // Distance validation (optional)
    const dist = Math.floor(distanceMeters(CLASS_LAT, CLASS_LON, lat, lon));
    if (dist > CLASS_RADIUS_METERS) {
      return res.status(403).json({ ok: false, error: "Outside classroom range", distance: dist });
    }

    const ts = nowTs();
    const date = sess.date || new Date().toISOString().slice(0, 10);

    db.run(
      `INSERT INTO attendance (session_id, student_id, student_name, date, status, latitude, longitude, marked_ts)
       VALUES (?, ?, ?, ?, 'Present', ?, ?, ?)
       ON CONFLICT(session_id, student_id)
       DO UPDATE SET status='Present', latitude=?, longitude=?, marked_ts=?`,
      [session_id, student_id, student_name || "", date, lat, lon, ts, lat, lon, ts],
      (err2) => {
        if (err2) return res.status(500).json({ ok: false, error: err2.message });
        console.log(`✅ GPS attendance marked: ${student_id} (${lat}, ${lon})`);
        res.json({ ok: true, message: "Attendance marked successfully", distance: dist });
      }
    );
  });
});


// Health check
app.get("/api/health", (req, res) => res.json({ ok: true, server: "running" }));

// Authentication
app.post("/api/auth/staff/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Username and password required" });
    }

    const row = await getAsync("SELECT * FROM staff_users WHERE username=?", [username]);
    if (!row) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    req.session.user = {
      role: "staff",
      username: row.username,
      displayName: row.display_name || row.username,
      subjects: parseSubjectList(row.subjects),
      isSuperAdmin: !!row.is_superadmin,
    };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/auth/student/login", async (req, res) => {
  try {
    const studentId = String(req.body.student_id || req.body.studentId || "").trim();
    const password = String(req.body.password || "");
    if (!studentId || !password) {
      return res.status(400).json({ ok: false, error: "Student ID and password required" });
    }

    const row = await getAsync("SELECT * FROM student_users WHERE student_id=?", [studentId]);
    if (!row) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    req.session.user = {
      role: "student",
      studentId: row.student_id,
      studentName: row.student_name || row.student_id,
    };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  res.json({ ok: true, user: req.session.user || null });
});

app.get("/api/subjects", (req, res) => {
  res.json({ ok: true, subjects: SUBJECT_CATALOG });
});

// Admin credential management
app.get("/api/admin/staff-users", requireSuperAdmin, async (req, res) => {
  try {
    const rows = await allAsync(
      "SELECT username, display_name, subjects, is_superadmin FROM staff_users ORDER BY username"
    );
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/staff-users", requireSuperAdmin, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const displayName = String(req.body.display_name || req.body.displayName || username).trim();
    const subjectArray = uniqueSubjects(parseSubjectList(req.body.subjects));
    if (!areSubjectsValid(subjectArray)) {
      return res.status(400).json({ ok: false, error: "Only configured subjects are allowed" });
    }
    const subjects = subjectArray.join(",");
    const password = String(req.body.password || "");

    if (!username || !subjects || !password) {
      return res.status(400).json({ ok: false, error: "username, subjects, and password are required" });
    }

    const hash = await bcrypt.hash(password, 10);
    await runAsync(
      "INSERT INTO staff_users(username, password_hash, display_name, subjects, is_superadmin) VALUES (?, ?, ?, ?, ?)",
      [username, hash, displayName, subjects, 0]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put("/api/admin/staff-users/:username", requireSuperAdmin, async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    const displayName = String(req.body.display_name || req.body.displayName || "").trim();
    const subjectArray = uniqueSubjects(parseSubjectList(req.body.subjects));
    if (subjectArray.length && !areSubjectsValid(subjectArray)) {
      return res.status(400).json({ ok: false, error: "Only configured subjects are allowed" });
    }
    const subjects = subjectArray.join(",");
    const password = String(req.body.password || "");

    if (!username) return res.status(400).json({ ok: false, error: "username required" });
    await runAsync(
      "UPDATE staff_users SET display_name = COALESCE(NULLIF(?, ''), display_name), subjects = COALESCE(NULLIF(?, ''), subjects) WHERE username=?",
      [displayName, subjects, username]
    );

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await runAsync("UPDATE staff_users SET password_hash=? WHERE username=?", [hash, username]);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/student-users", requireStaff, async (req, res) => {
  try {
    const rows = await allAsync(
      `SELECT su.student_id, COALESCE(su.student_name, st.student_name, su.student_id) AS student_name,
              st.parent_phone
       FROM student_users su
       LEFT JOIN students st ON st.student_id = su.student_id
       ORDER BY su.student_id`
    );
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/student-users", requireStaff, async (req, res) => {
  try {
    const studentId = String(req.body.student_id || req.body.studentId || "").trim();
    const studentName = String(req.body.student_name || req.body.studentName || studentId).trim();
    const parentPhone = String(req.body.parent_phone || req.body.parentPhone || "").trim();
    const password = String(req.body.password || "").trim();

    if (!studentId || !password) {
      return res.status(400).json({ ok: false, error: "student_id and password are required" });
    }

    const hash = await bcrypt.hash(password, 10);
    await runAsync(
      `INSERT INTO student_users(student_id, password_hash, student_name)
       VALUES (?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET password_hash=excluded.password_hash, student_name=excluded.student_name`,
      [studentId, hash, studentName]
    );

    await runAsync(
      `INSERT INTO students(student_id, student_name, parent_phone)
       VALUES (?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET
         student_name=excluded.student_name,
         parent_phone=CASE WHEN excluded.parent_phone='' THEN students.parent_phone ELSE excluded.parent_phone END`,
      [studentId, studentName, parentPhone]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/alerts/low-attendance", requireStaff, async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(100, Number(req.query.threshold || 75)));
    const allowedSubjects = req.session.user.subjects || [];
    const items = await getLowAttendanceItems(threshold, allowedSubjects);
    res.json({ ok: true, threshold, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/reset-old-data", requireSuperAdmin, async (req, res) => {
  try {
    await runAsync("DELETE FROM attendance");
    await runAsync("DELETE FROM sessions");
    await runAsync("DELETE FROM staff_users");
    await runAsync("DELETE FROM student_users");
    await ensureSubjectSeedData();
    await ensureAuthSeedData();
    res.json({ ok: true, message: "Old data cleared and default users re-seeded" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Start Session
app.post("/api/session/start", requireStaff, (req, res) => {
  const { label, period } = req.body || {};
  const allowedSubjects = req.session.user.subjects || [];
  const requestedLabel = String(label || "").trim();
  const subject = requestedLabel || allowedSubjects[0] || "Class Session";
  if (!SUBJECT_CATALOG.includes(subject)) {
    return res.status(400).json({ ok: false, error: "Invalid subject. Use configured subjects only." });
  }
  if (allowedSubjects.length && !allowedSubjects.includes(subject)) {
    return res.status(403).json({ ok: false, error: "Not allowed for selected subject" });
  }
  const date = new Date().toISOString().slice(0, 10);
  const sid = genSessionId();
  const ts = nowTs();
  

  db.run(
    "INSERT INTO sessions(id, label, period, date, started_at) VALUES (?, ?, ?, ?, ?)",
    [sid, subject, period || 1, date, ts],
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });

      const baseUrl =
        PUBLIC_BASE_URL ||
        `${(req.headers["x-forwarded-proto"] || req.protocol)}://${req.get("host")}`;
      const studentUrl = `${baseUrl.replace(/\/$/, "")}/student.html?session=${sid}`;
      res.json({ ok: true, sessionId: sid, studentUrl, label: subject, date });
    }
  );
});

// Fetch Sessions
app.get("/api/sessions", requireStaff, (req, res) => {
  const allowedSubjects = req.session.user.subjects || [];
  const sql = allowedSubjects.length
    ? `SELECT * FROM sessions WHERE label IN (${allowedSubjects.map(() => "?").join(",")}) ORDER BY started_at DESC`
    : "SELECT * FROM sessions ORDER BY started_at DESC";
  db.all(sql, allowedSubjects, (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json(rows || []);
  });
});

// Fetch attendance rows for one session
app.get("/api/attendance/session/:sid", requireStaff, (req, res) => {
  const sid = req.params.sid;
  db.all(
    `SELECT a.*, s.label AS subject
     FROM attendance a
     LEFT JOIN sessions s ON s.id = a.session_id
     WHERE a.session_id=?
     ORDER BY a.marked_ts DESC, a.student_id ASC`,
    [sid],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json(rows || []);
    }
  );
});

// Fetch Students
app.get("/api/students", requireStaff, (req, res) =>
  db.all("SELECT * FROM students ORDER BY student_id", (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json(rows || []);
  })
);

// Add Students
app.post("/api/students/add", requireStaff, (req, res) => {
  const students = req.body;
  if (!Array.isArray(students))
    return res.status(400).json({ ok: false, error: "Expected array of students" });

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO students (student_id, student_name, parent_phone) VALUES (?, ?, ?)"
  );
  for (const s of students) {
    const id = s.student_id || s.id || s.roll_no || s.roll || s.roll_number;
    if (!id) continue;
    stmt.run(id, s.student_name || s.name || "", s.parent_phone || s.phone || "");
  }
  stmt.finalize((err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, added: students.length });
  });
});

// === Manual Mark (with Twilio automation) ===
app.post("/api/manual/mark", requireStaff, (req, res) => {
  const sessionId = req.body.sessionId || req.body.session_id;
  const studentId = req.body.studentId || req.body.student_id;
  const studentName = req.body.studentName || req.body.student_name || "";
  const statusRaw = req.body.status;
  const status = normalizeStatus(statusRaw);

  if (!sessionId || !studentId)
    return res.status(400).json({ ok: false, error: "Missing sessionId or studentId" });

  const ts = nowTs();
  const date = new Date().toISOString().slice(0, 10);

  db.run(
    `INSERT INTO attendance(session_id, student_id, student_name, date, status, marked_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, student_id) DO UPDATE SET status=?, marked_ts=?`,
    [sessionId, studentId, studentName, date, status, ts, status, ts],
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });

      console.log(`📝 Manual mark saved: ${studentId} → ${status} (session ${sessionId})`);

      if (status === "Absent") {
        db.get(
          "SELECT parent_phone, student_name FROM students WHERE student_id=?",
          [studentId],
          async (err2, row) => {
            if (!err2 && row && row.parent_phone) {
              const msg = `Dear Parent, your ward ${row.student_name || studentId} was marked ABSENT on ${date} for session ${sessionId}.`;
              await sendSms(row.parent_phone, msg);
            }
          }
        );
      }
      

      res.json({ ok: true, updated: true, status });
    }
  );
});

// === End Session & Notify Absentees ===
app.post("/api/session/end", requireStaff, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  db.run("UPDATE sessions SET ended_at=? WHERE id=?", [nowTs(), sessionId]);

  db.all(
    `SELECT a.student_id, a.student_name, s.parent_phone, a.status
     FROM attendance a
     LEFT JOIN students s ON a.student_id = s.student_id
     WHERE a.session_id = ? AND LOWER(a.status) <> 'present'`,
    [sessionId],
    async (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });

      console.log(`🔔 Absentees to notify for ${sessionId}: ${rows.length}`);

      for (const r of rows) {
        if (r.parent_phone) {
          const msg = `Dear Parent, your ward ${r.student_name || r.student_id} was absent for session ${sessionId}.`;
          await sendSms(r.parent_phone, msg);
        }
      }

      res.json({ ok: true, message: "Absentees notified", absentees: rows.length });
    }
  );
});

// === Export Attendance CSV ===
app.get("/api/export/session/:sid", requireStaff, (req, res) => {
  const sid = req.params.sid;
  db.all("SELECT * FROM attendance WHERE session_id=? ORDER BY student_id", [sid], (err, rows) => {
    if (err) return res.status(500).send("DB error");
    if (!rows || !rows.length) return res.status(404).send("No records found");

    console.log(`📦 Exporting ${rows.length} row(s) for session ${sid}`);

    const csvFile = path.join(__dirname, `attendance_${sid}.csv`);
    const csvWriter = createCsvWriter({
      path: csvFile,
      header: [
        { id: "session_id", title: "Session ID" },
        { id: "student_id", title: "Student ID" },
        { id: "student_name", title: "Student Name" },
        { id: "status", title: "Status" },
        { id: "date", title: "Date" },
        { id: "latitude", title: "Latitude" },
        { id: "longitude", title: "Longitude" },
        { id: "marked_ts", title: "Timestamp" },
      ],
    });

    csvWriter
      .writeRecords(rows)
      .then(() => res.download(csvFile))
      .catch((e) => res.status(500).send("CSV write error: " + e.message));
  });
});

const writeStudentSummaryToPdf = (res, summary, threshold) => {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  const safeName = String(summary.student.studentId).replace(/[^a-z0-9_-]/gi, "_");
  res.setHeader("Content-Disposition", `attachment; filename=student_${safeName}_report.pdf`);
  doc.pipe(res);

  doc.fontSize(18).text("Smart Classroom - Student Attendance Report", { align: "center" });
  doc.moveDown(0.8);
  doc.fontSize(12).text(`Student ID: ${summary.student.studentId}`);
  doc.text(`Student Name: ${summary.student.studentName}`);
  doc.text(`Generated At: ${new Date().toLocaleString()}`);
  doc.moveDown(0.6);

  doc.text(`Overall Attendance: ${summary.totals.attendancePercent}%`);
  doc.text(`Classes Taken: ${summary.totals.total} | Present: ${summary.totals.present} | Absent: ${summary.totals.absent}`);
  doc.moveDown(0.8);

  doc.fontSize(13).text("Subject-wise Summary");
  doc.fontSize(11);
  summary.subjects.forEach((s) => {
    const alert = s.attendancePercent < threshold ? " [LOW]" : "";
    doc.text(
      `${s.subject}: ${s.attendancePercent}% (${s.present}/${s.taken})${alert}`
    );
  });

  doc.moveDown(0.8);
  doc.fontSize(13).text("Recent Entries");
  doc.fontSize(10);
  summary.rows.slice(0, 35).forEach((r) => {
    doc.text(
      `${r.date || "-"} | ${r.subject || "Unknown"} | ${r.status || "-"} | session ${r.session_id || "-"}`
    );
  });

  doc.end();
};

const writeStudentSummaryToXlsx = async (res, summary, threshold) => {
  const workbook = new ExcelJS.Workbook();
  const overview = workbook.addWorksheet("Overview");
  overview.columns = [
    { header: "Field", key: "field", width: 28 },
    { header: "Value", key: "value", width: 40 },
  ];
  overview.addRows([
    { field: "Student ID", value: summary.student.studentId },
    { field: "Student Name", value: summary.student.studentName },
    { field: "Overall Attendance %", value: summary.totals.attendancePercent },
    { field: "Classes Taken", value: summary.totals.total },
    { field: "Present", value: summary.totals.present },
    { field: "Absent", value: summary.totals.absent },
    { field: "Alert Threshold %", value: threshold },
    { field: "Generated At", value: new Date().toLocaleString() },
  ]);

  const subjectWs = workbook.addWorksheet("Subjects");
  subjectWs.columns = [
    { header: "Subject", key: "subject", width: 24 },
    { header: "Taken", key: "taken", width: 10 },
    { header: "Present", key: "present", width: 10 },
    { header: "Absent", key: "absent", width: 10 },
    { header: "Attendance %", key: "attendancePercent", width: 14 },
    { header: "Alert", key: "alert", width: 12 },
  ];
  summary.subjects.forEach((s) => {
    subjectWs.addRow({
      ...s,
      alert: s.attendancePercent < threshold ? "LOW" : "OK",
    });
  });

  const rowsWs = workbook.addWorksheet("Entries");
  rowsWs.columns = [
    { header: "Session ID", key: "session_id", width: 16 },
    { header: "Date", key: "date", width: 14 },
    { header: "Subject", key: "subject", width: 20 },
    { header: "Status", key: "status", width: 12 },
    { header: "Marked At", key: "marked", width: 24 },
  ];
  summary.rows.forEach((r) => {
    rowsWs.addRow({
      session_id: r.session_id,
      date: r.date,
      subject: r.subject || "Unknown",
      status: r.status,
      marked: r.marked_ts ? new Date(r.marked_ts * 1000).toLocaleString() : "-",
    });
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  const safeName = String(summary.student.studentId).replace(/[^a-z0-9_-]/gi, "_");
  res.setHeader("Content-Disposition", `attachment; filename=student_${safeName}_report.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
};

app.get("/api/export/student/:studentId.xlsx", requireStaff, async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(100, Number(req.query.threshold || 75)));
    const summary = await buildStudentSummary(req.params.studentId);
    await writeStudentSummaryToXlsx(res, summary, threshold);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/export/student/:studentId.pdf", requireStaff, async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(100, Number(req.query.threshold || 75)));
    const summary = await buildStudentSummary(req.params.studentId);
    writeStudentSummaryToPdf(res, summary, threshold);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/student/export/me.xlsx", requireStudent, async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(100, Number(req.query.threshold || 75)));
    const summary = await buildStudentSummary(req.session.user.studentId);
    await writeStudentSummaryToXlsx(res, summary, threshold);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/student/export/me.pdf", requireStudent, async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(100, Number(req.query.threshold || 75)));
    const summary = await buildStudentSummary(req.session.user.studentId);
    writeStudentSummaryToPdf(res, summary, threshold);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Student profile + subject-wise summary
app.get("/api/student/summary", requireStudent, async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(100, Number(req.query.threshold || 75)));
    const summary = await buildStudentSummary(req.session.user.studentId);
    const alerts = summary.subjects.filter((s) => s.attendancePercent < threshold);

    res.json({
      ok: true,
      student: {
        role: "student",
        studentId: summary.student.studentId,
        studentName: summary.student.studentName,
      },
      totals: summary.totals,
      subjects: summary.subjects,
      rows: summary.rows,
      threshold,
      alerts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Single entry endpoint: auto-route by current login role.
app.get("/app", (req, res) => {
  const user = req.session?.user;
  if (!user) {
    const appPagePath = path.join(__dirname, "public", "app.html");
    if (fs.existsSync(appPagePath)) return res.sendFile(appPagePath);
    return res.redirect("/login.html");
  }
  if (user.role === "staff") return res.redirect("/admin.html");
  if (user.role === "student") return res.redirect("/student_dashboard.html");
  return res.redirect("/login.html");
});

// Root
app.get("/", (req, res) => {
  res.redirect("/app");
});

// === START SERVER ===
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (PUBLIC_BASE_URL) console.log(`🌍 Public URL: ${PUBLIC_BASE_URL}`);
});
