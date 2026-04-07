import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Scanner;

// =====================================================================
// WEEK 1 & 2: Student Class with Constructor Overloading
// =====================================================================
class Student {
    private String studentId;
    private String name;

    // Default constructor
    public Student() {}

    // Overloaded constructor to initialize with student records
    public Student(String studentId, String name) {
        this.studentId = studentId;
        this.name = name;
    }

    public String getStudentId() {
        return studentId;
    }

    public String getName() {
        return name;
    }

    @Override
    public String toString() {
        return "Student ID: " + studentId + ", Name: " + name;
    }
}

// =====================================================================
// WEEK 1: AttendanceRecord Class
// =====================================================================
class AttendanceRecord {
    private Student student;
    private LocalDate date;

    public AttendanceRecord(Student student, LocalDate date) {
        this.student = student;
        this.date = date;
    }

    public Student getStudent() {
        return student;
    }

    public LocalDate getDate() {
        return date;
    }

    @Override
    public String toString() {
        // Format: YYYY-MM-DD,S001,Student Name
        return date + "," + student.getStudentId() + "," + student.getName();
    }
}

// =====================================================================
// WEEK 3 & 4: Main Manager Class
// =====================================================================
public class AttendanceManager {
    // WEEK 3: Use ArrayList to track students and attendance
    private ArrayList<Student> studentRoster;
    private ArrayList<AttendanceRecord> attendanceLog;

    public AttendanceManager() {
        this.studentRoster = new ArrayList<>();
        this.attendanceLog = new ArrayList<>();
    }

    public void addStudent(Student student) {
        studentRoster.add(student);
    }
    
    public Student findStudentById(String studentId) {
        for(Student s : studentRoster) {
            if(s.getStudentId().equalsIgnoreCase(studentId)) {
                return s;
            }
        }
        return null;
    }

    public void markAttendance(Student student) {
        AttendanceRecord record = new AttendanceRecord(student, LocalDate.now());
        attendanceLog.add(record);
        System.out.println("Marked present today: " + student.getName());
    }

    public void printAttendanceLog() {
        System.out.println("\n--- Full Attendance Log ---");
        if (attendanceLog.isEmpty()) {
            System.out.println("No records found.");
        } else {
            for (AttendanceRecord record : attendanceLog) {
                System.out.println(record);
            }
        }
        System.out.println("---------------------------\n");
    }

    // WEEK 4: Save logs to a file with Exception Handling
    public void saveLogsToFile(String filename) {
        try (FileWriter writer = new FileWriter(filename)) {
            for (AttendanceRecord record : attendanceLog) {
                writer.write(record.toString() + "\n");
            }
            System.out.println("Attendance log saved successfully to " + filename);
        } catch (IOException e) {
            System.err.println("Error saving file: " + e.getMessage());
        }
    }

    // WEEK 4: Load logs from a file with Exception Handling
    public void loadLogsFromFile(String filename) {
        File file = new File(filename);
        if (!file.exists()) {
            System.out.println("Log file not found. Starting with an empty log.");
            return;
        }

        try (Scanner scanner = new Scanner(file)) {
            attendanceLog.clear(); // Clear current log before loading
            while (scanner.hasNextLine()) {
                String line = scanner.nextLine();
                String[] parts = line.split(",");
                if (parts.length == 3) {
                    LocalDate date = LocalDate.parse(parts[0]);
                    // Important: Find the student from the roster to avoid duplicates
                    Student student = findStudentById(parts[1]); 
                    if (student == null) { // If student not in roster, create a new one
                        student = new Student(parts[1], parts[2]);
                    }
                    attendanceLog.add(new AttendanceRecord(student, date));
                }
            }
            System.out.println("Attendance log loaded successfully from " + filename);
        } catch (IOException e) {
            System.err.println("Error loading file: " + e.getMessage());
        }
    }

    // Main method to run the demonstration
    public static void main(String[] args) {
        AttendanceManager manager = new AttendanceManager();
        String logFileName = "attendance.txt";

        // Step 1: Create students (Week 2) and add them to the roster (Week 3)
        Student student1 = new Student("S001", "Ajay Kumar");
        Student student2 = new Student("S002", "Priya Singh");
        Student student3 = new Student("S003", "Vijay Raj");

        manager.addStudent(student1);
        manager.addStudent(student2);
        manager.addStudent(student3);

        // Step 2: Load any previously saved logs (Week 4)
        manager.loadLogsFromFile(logFileName);
        
        // Step 3: Display the logs that were just loaded
        System.out.println("Displaying logs after loading from file:");
        manager.printAttendanceLog();
        
        // Step 4: Mark new attendance for today (Week 3)
        System.out.println("Marking new attendance for today...");
        manager.markAttendance(student1);
        manager.markAttendance(student3);

        // Step 5: Display the combined log (old records + new ones)
        System.out.println("\nDisplaying logs after adding new records:");
        manager.printAttendanceLog();

        // Step 6: Save the complete log back to the file (Week 4)
        manager.saveLogsToFile(logFileName);
    }
}