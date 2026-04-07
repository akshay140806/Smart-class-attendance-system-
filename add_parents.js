// add_parents.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'data','attendance.db'));

const students = [
  { id: "S001", name: "Ajay Kumar", phone: "+918122134566" },
  { id: "S002", name: "Priya Singh", phone: "+918939951516" },
  { id: "S003", name: "Vijay Raj", phone: "+918939951517" },
  { id: "S004", name: "Rahul Sharma", phone: "+916385840461" },
  { id: "S005", name: "Neha Patel", phone: "+919994680448" },
];

db.serialize(()=>{
  const stmt = db.prepare("INSERT OR REPLACE INTO students(student_id, student_name, parent_phone) VALUES (?,?,?)");
  students.forEach(s => stmt.run(s.id, s.name, s.phone));
  stmt.finalize(()=> { console.log("Done"); db.close(); });
});
