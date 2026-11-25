package orchard;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Base64;
import java.util.Locale;

/**
 * Orchard's log window. On Windows, orchard.exe is built as a windowless program (see build.cmd), so it never opens a
 * terminal. Everything it logs goes to {@code <data>/orchard.log}, and Ctrl+Shift+T in the Orchard window opens or
 * closes a console window that follows that file. On macOS/Linux the log still goes to the file and stdout; the
 * window is Windows-only.
 */
final class ConsoleWindow {

    private ConsoleWindow() {}

    private static final boolean WINDOWS =
            System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    private static final int PENDING_LIMIT = 1 << 20;

    private static final StringBuilder pending = new StringBuilder(); // output before the log file is open
    private static BufferedWriter writer;
    private static Path logFile;
    private static Process viewer;

    /** Adds one or more lines to the log file (or keeps them until {@link #logTo} opens it). */
    static synchronized void append(String text) {
        if (writer != null) {
            try {
                writer.write(text);
                writer.write(System.lineSeparator());
                writer.flush();
            } catch (IOException e) {
                writer = null; // disk full or file gone: keep running without a log file
            }
        } else if (pending.length() < PENDING_LIMIT) {
            pending.append(text).append(System.lineSeparator());
        }
    }

    /** Starts writing the log to {@code file} (replacing the previous run's log). */
    static synchronized void logTo(Path file) {
        try {
            writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                    StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            logFile = file;
            writer.write(pending.toString());
            writer.flush();
            pending.setLength(0);
        } catch (IOException e) {
            writer = null;
            System.err.println("Could not write " + file + ": " + e.getMessage());
        }
        Runtime.getRuntime().addShutdownHook(new Thread(ConsoleWindow::closeViewer, "log-window"));
    }

    /** Opens the log window if it isn't open (e.g. so an error there can be read). */
    static synchronized void show() {
        if (logFile != null && (viewer == null || !viewer.isAlive())) viewer = openViewer(logFile, false);
    }

    /** Opens the log window if it is closed, closes it if open. Returns "shown", "hidden" or "unavailable". */
    static synchronized String toggle() {
        if (viewer != null && viewer.isAlive()) {
            closeViewer();
            return "hidden";
        }
        if (logFile == null) return "unavailable";
        viewer = openViewer(logFile, false);
        return viewer != null ? "shown" : "unavailable";
    }

    /**
     * Exits during startup (help text, bad option, port in use). Without a terminal (orchard.exe double-clicked)
     * nobody would see the message, so it is shown in a log window that stays open after Orchard has exited.
     */
    static void exitShowing(int code) {
        if (System.console() == null) {
            try {
                Path file = Path.of(System.getProperty("java.io.tmpdir"), "orchard-startup.log");
                synchronized (ConsoleWindow.class) {
                    Files.writeString(file, pending, StandardCharsets.UTF_8);
                }
                openViewer(file, true);
            } catch (IOException | RuntimeException ignored) {
                // nothing more we can do
            }
        }
        System.exit(code);
    }

    private static synchronized void closeViewer() {
        Process p = viewer;
        viewer = null;
        if (p == null || !p.isAlive()) return;
        p.descendants().forEach(ProcessHandle::destroy);
        p.destroy();
    }

    /**
     * Opens a classic console window (conhost, so it behaves the same whatever the default terminal is) running
     * PowerShell, which prints the log and follows it. {@code stay}: the log is final; wait for the user to close it.
     */
    private static Process openViewer(Path file, boolean stay) {
        if (!WINDOWS) return null;
        String root = System.getenv().getOrDefault("SystemRoot", "C:\\Windows");
        Path conhost = Path.of(root, "System32", "conhost.exe");
        Path powershell = Path.of(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!Files.isRegularFile(conhost) || !Files.isRegularFile(powershell)) return null;
        String path = "'" + file.toAbsolutePath().toString().replace("'", "''") + "'";
        String script = "$Host.UI.RawUI.WindowTitle = 'Orchard log'\n"
                + "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}\n"
                + (stay
                        ? "Get-Content -LiteralPath " + path + " -Encoding UTF8\n"
                                + "Write-Host ''\nRead-Host 'Press Enter to close' | Out-Null\n"
                        : "Write-Host 'Orchard log - Ctrl+Shift+T in the Orchard window hides this window.' "
                                + "-ForegroundColor DarkGray\n"
                                + "Get-Content -LiteralPath " + path + " -Encoding UTF8 -Tail 3000 -Wait\n");
        String encoded = Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE));
        try {
            return new ProcessBuilder(conhost.toString(), powershell.toString(), "-NoLogo", "-NoProfile",
                    "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded)
                    .redirectInput(ProcessBuilder.Redirect.INHERIT)
                    .redirectOutput(ProcessBuilder.Redirect.INHERIT)
                    .redirectError(ProcessBuilder.Redirect.INHERIT)
                    .start();
        } catch (IOException e) {
            // Not Log.warn: that would take Log's lock while holding this class's one (Log takes them the other way).
            String msg = "Could not open the log window: " + e.getMessage();
            System.err.println(msg);
            append(msg);
            return null;
        }
    }
}
