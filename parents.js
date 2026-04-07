// add_parents.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// open your database file
const dbPath = path.join(__dirname, "attendance.db");
const db = new sqlite3.Database(dbPath);

// sample data: replace phone numbers with real ones
const students = [
  { id: "S001", name: "Ajay Kumar", phone: "8122134566" },
  { id: "S002", name: "Priya Singh", phone: "8939951516" },
  { id: "S003", name: "Vijay Raj", phone: "1111222333" },
  { id: "S004", name: "Rahul Sharma", phone: "9988776655" },
  { id: "S005", name: "Neha Patel", phone: "1223344556" },
];

// ensure table has parent_phone column
db.serialize(() => {
  db.run(`ALTER TABLE students ADD COLUMN parent_phone TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error("⚠️ Error adding column:", err.message);
    }
  });

  const stmt = db.prepare(
    "UPDATE students SET parent_phone = ? WHERE student_id = ?"
  );

  students.forEach((s) => {
    stmt.run(s.phone, s.id);
  });

  stmt.finalize(() => {
    console.log("✅ Parent phone numbers added/updated successfully.");
    db.close();
  });
});
