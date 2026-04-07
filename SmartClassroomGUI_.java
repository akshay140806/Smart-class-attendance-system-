import javax.swing.*;
import java.awt.*;
import java.awt.event.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Locale;
import javax.imageio.ImageIO;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.client.j2se.MatrixToImageWriter;

public class SmartClassroomGUI_ extends JFrame {

    private static final String SERVER_URL = "https://tallowy-kera-conducibly.ngrok-free.dev";

    private static final int CONNECT_TIMEOUT = 8000;
    private static final int READ_TIMEOUT = 15000;

    private final JLabel qrLabel = new JLabel("QR will appear here", SwingConstants.CENTER);
    private final JTextArea logArea = new JTextArea();
    private final JComboBox<String> subjectBox;
    private String lastSessionId = null;
    private String lastStudentUrl = null;

    public SmartClassroomGUI_() {
        setTitle("Smart Classroom — Attendance System");
        setSize(1000, 700);
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setLocationRelativeTo(null);
        setLayout(new BorderLayout(8, 8));

        JLabel title = new JLabel("Smart Classroom — Session Control Panel", SwingConstants.CENTER);
        title.setFont(new Font("Segoe UI", Font.BOLD, 22));
        add(title, BorderLayout.NORTH);

        // Center area
        JPanel center = new JPanel(new BorderLayout(8, 8));
        qrLabel.setPreferredSize(new Dimension(420, 420));
        qrLabel.setBorder(BorderFactory.createLineBorder(Color.GRAY));
        qrLabel.setText("<html><center>No QR<br/>Start a session</center></html>");
        center.add(qrLabel, BorderLayout.WEST);

        logArea.setEditable(false);
        JScrollPane sp = new JScrollPane(logArea);
        sp.setPreferredSize(new Dimension(520, 420));
        center.add(sp, BorderLayout.CENTER);
        add(center, BorderLayout.CENTER);

        // Bottom buttons
        JPanel bottom = new JPanel(new FlowLayout(FlowLayout.CENTER, 10, 10));
        subjectBox = new JComboBox<>(new String[]{"OOPS", "DSA", "CN", "OS", "AI", "ML"});

        JButton startBtn = new JButton("Start Session");
        JButton endBtn = new JButton("End Session");
        JButton manualBtn = new JButton("Manual Mark");
        JButton viewBtn = new JButton("View Sessions");
        JButton exportBtn = new JButton("Export CSV");
        JButton clearBtn = new JButton("Clear QR");
        JButton exitBtn = new JButton("Exit");

        bottom.add(new JLabel("Subject:"));
        bottom.add(subjectBox);
        bottom.add(startBtn);
        bottom.add(endBtn);
        bottom.add(manualBtn);
        bottom.add(viewBtn);
        bottom.add(exportBtn);
        bottom.add(clearBtn);
        bottom.add(exitBtn);
        add(bottom, BorderLayout.SOUTH);

        // Event Listeners
        startBtn.addActionListener(e -> startSession());
        endBtn.addActionListener(e -> endSession());
        manualBtn.addActionListener(e -> manualMark());
        viewBtn.addActionListener(e -> viewSessions());
        exportBtn.addActionListener(e -> exportCSV());
        clearBtn.addActionListener(e -> clearQR());
        exitBtn.addActionListener(e -> System.exit(0));

        appendLog("✅ Ready. Connecting to server...");
        checkServerConnection();
    }

    // --- Check if server is reachable ---
    private void checkServerConnection() {
        try {
            URL url = new URL(SERVER_URL + "/api/health");
            HttpURLConnection conn = setupConnection(url, "GET");
            String resp = readAnyStream(conn);
            appendLog("🌐 Server connection successful → " + SERVER_URL);
        } catch (Exception e) {
            appendLog("❌ Cannot connect to server! Ensure server.js and ngrok are running.\nError: " + e.getMessage());
        }
    }

    // --- Logging Utility ---
    private void appendLog(String msg) {
        SwingUtilities.invokeLater(() -> {
            logArea.append("[" + LocalTime.now().withNano(0) + "] " + msg + "\n");
            logArea.setCaretPosition(logArea.getDocument().getLength());
        });
    }

    // 🟢 Start session
    private void startSession() {
        String subject = (String) subjectBox.getSelectedItem();
        String date = LocalDate.now().toString();
        appendLog("📡 Starting session for " + subject + " (" + date + ")");

        try {
            URL url = new URL(SERVER_URL + "/api/session/start");
            HttpURLConnection conn = setupConnection(url, "POST");
            String body = String.format(Locale.ROOT, "{\"label\":\"%s\",\"period\":1,\"date\":\"%s\"}", subject, date);
            sendRequestBody(conn, body);

            String resp = readAnyStream(conn);
            lastSessionId = findJsonField(resp, "sessionId");
            lastStudentUrl = findJsonField(resp, "studentUrl");

            if (lastSessionId == null || lastStudentUrl == null) {
                appendLog("❌ Invalid response: " + resp);
                return;
            }

            appendLog("✅ Session started ID: " + lastSessionId);
            appendLog("Student QR URL: " + lastStudentUrl);
            generateAndShowQR(lastStudentUrl);

        } catch (Exception ex) {
            appendLog("⚠️ Start session error: " + ex.getMessage());
        }
    }

    // 🔴 End Session
    private void endSession() {
        if (lastSessionId == null) {
            JOptionPane.showMessageDialog(this, "⚠️ No active session found.");
            return;
        }
        try {
            URL url = new URL(SERVER_URL + "/api/session/end");
            HttpURLConnection conn = setupConnection(url, "POST");
            sendRequestBody(conn, "{\"sessionId\":\"" + lastSessionId + "\"}");
            String resp = readAnyStream(conn);

            appendLog("✅ End Session: " + resp);
            JOptionPane.showMessageDialog(this, "✅ Session ended successfully.\n" + resp);

        } catch (Exception e) {
            appendLog("❌ End session failed: " + e.getMessage());
        }
    }

    // ✍️ Manual Attendance Entry (GUI + Twilio trigger)
    private void manualMark() {
        if (lastSessionId == null) {
            JOptionPane.showMessageDialog(this, "⚠️ Start a session first.");
            return;
        }

        String sid = lastSessionId;
        String roll = JOptionPane.showInputDialog(this, "Enter Student ID:");
        if (roll == null || roll.isBlank()) return;

        String name = JOptionPane.showInputDialog(this, "Enter Student Name (optional):");
        if (name == null) name = "";

        Object[] opts = {"Present", "Absent"};
        int choice = JOptionPane.showOptionDialog(this, "Mark attendance for " + roll,
                "Manual Mark", JOptionPane.DEFAULT_OPTION, JOptionPane.QUESTION_MESSAGE, null, opts, opts[0]);
        String status = (choice == 0 ? "Present" : "Absent");

        try {
            URL url = new URL(SERVER_URL + "/api/manual/mark");
            HttpURLConnection conn = setupConnection(url, "POST");
            String body = String.format(Locale.ROOT,
                    "{\"sessionId\":\"%s\",\"studentId\":\"%s\",\"studentName\":\"%s\",\"status\":\"%s\"}",
                    sid, roll.trim(), name.trim(), status);
            sendRequestBody(conn, body);

            String resp = readAnyStream(conn);
            appendLog("📝 Manual mark: " + roll + " → " + status);
            appendLog("📨 Server Response: " + resp);

            if (status.equals("Absent")) {
                appendLog("📱 Twilio SMS sent automatically to parent (if phone number exists).");
            }

        } catch (Exception e) {
            appendLog("❌ Manual mark error: " + e.getMessage());
        }
    }

    // 📋 View all sessions
    private void viewSessions() {
        try {
            URL url = new URL(SERVER_URL + "/api/sessions");
            HttpURLConnection conn = setupConnection(url, "GET");
            String resp = readAnyStream(conn);

            appendLog("📄 Sessions: " + resp);
            JTextArea area = new JTextArea(resp);
            area.setEditable(false);
            JScrollPane sp = new JScrollPane(area);
            sp.setPreferredSize(new Dimension(800, 400));
            JOptionPane.showMessageDialog(this, sp, "All Sessions (JSON)", JOptionPane.INFORMATION_MESSAGE);
        } catch (Exception e) {
            appendLog("❌ View sessions error: " + e.getMessage());
        }
    }

    // 💾 Export CSV
    private void exportCSV() {
        if (lastSessionId == null) {
            JOptionPane.showMessageDialog(this, "⚠️ Start a session first.");
            return;
        }
        try {
            String fileName = "attendance_" + lastSessionId + ".csv";
            URL url = new URL(SERVER_URL + "/api/export/session/" + URLEncoder.encode(lastSessionId, "UTF-8"));
            HttpURLConnection conn = setupConnection(url, "GET");

            if (conn.getResponseCode() != 200) {
                appendLog("❌ Export failed. HTTP " + conn.getResponseCode());
                return;
            }

            try (InputStream in = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(fileName)) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) > 0) fos.write(buf, 0, len);
            }

            appendLog("✅ Export saved: " + fileName);
            JOptionPane.showMessageDialog(this, "✅ Export completed: " + fileName);
        } catch (Exception e) {
            appendLog("❌ Export error: " + e.getMessage());
        }
    }

    private void clearQR() {
        qrLabel.setIcon(null);
        qrLabel.setText("<html><center>QR cleared</center></html>");
        appendLog("🧹 QR cleared.");
    }

    // --- Utilities ---
    private HttpURLConnection setupConnection(URL url, String method) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT);
        conn.setReadTimeout(READ_TIMEOUT);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Content-Type", "application/json");
        if (method.equals("POST")) conn.setDoOutput(true);
        return conn;
    }

    private void sendRequestBody(HttpURLConnection conn, String body) throws IOException {
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.getBytes(StandardCharsets.UTF_8));
        }
    }

    // ✅ Handles both success and error streams
    private String readAnyStream(HttpURLConnection conn) throws IOException {
        InputStream in = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        return readStream(in);
    }

    private String readStream(InputStream in) throws IOException {
        if (in == null) return null;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            return sb.toString().trim();
        }
    }

    private String findJsonField(String json, String key) {
        if (json == null) return null;
        String pattern = "\"" + key + "\"\\s*:\\s*\"([^\"]+)\"";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(pattern).matcher(json);
        return m.find() ? m.group(1) : null;
    }

    private void generateAndShowQR(String text) {
        try {
            BitMatrix matrix = new MultiFormatWriter().encode(text, BarcodeFormat.QR_CODE, 420, 420);
            BufferedImage img = MatrixToImageWriter.toBufferedImage(matrix);
            qrLabel.setIcon(new ImageIcon(img));
            qrLabel.setText(null);
        } catch (Exception e) {
            appendLog("⚠️ QR generation error: " + e.getMessage());
        }
    }

    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> new SmartClassroomGUI_().setVisible(true));
    }
}
