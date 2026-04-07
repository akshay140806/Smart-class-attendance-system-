// init_db.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Open your database
const dbPath = path.join(__dirname, "attendance.db");
const db = new sqlite3.Database(dbPath);

// Create the students table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_phone TEXT
    )
  `, (err) => {
    if (err) {
      console.error("❌ Error creating table:", err.message);
    } else {
      console.log("✅ 'students' table created successfully!");
    }
  });
});

db.close();
