package orchard;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/** Tiny console logger; everything also goes to the log file (see {@link ConsoleWindow}). */
final class Log {
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss");
    static volatile boolean debug = Orchard.env("DEBUG") != null;

    private Log() {}

    static void info(String msg) {
        print("INFO ", msg);
    }

    static void warn(String msg) {
        print("WARN ", msg);
    }

    static void debug(String msg) {
        if (debug) print("DEBUG", msg);
    }

    /** Plain text (banner, help) to stdout and the log. */
    static synchronized void out(String text) {
        System.out.println(text);
        ConsoleWindow.append(text);
    }

    /** Plain error text to stderr and the log. */
    static synchronized void err(String text) {
        System.err.println(text);
        ConsoleWindow.append(text);
    }

    private static synchronized void print(String level, String msg) {
        String line = LocalTime.now().format(TIME) + " " + level + " " + msg;
        System.out.println(line);
        ConsoleWindow.append(line);
    }
}
