package orchard;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Picks the browser Orchard runs in, preferring the user's default browser, and launches it under DevTools control.
 * It must be Chromium-based (Orchard drives it over the DevTools protocol) and have Widevine DRM, which rules out
 * Firefox/Safari and plain open-source Chromium.
 */
final class BrowserLauncher {

    record Running(Process process, String browserWsUrl, Path executable) {}

    /** Executable names of Chromium-based browsers that ship Widevine. */
    private static final List<String> CHROMIUM_EXES = List.of("chrome", "msedge", "brave", "vivaldi", "thorium",
            "google chrome", "microsoft edge", "brave browser", "google-chrome", "google-chrome-stable",
            "microsoft-edge", "microsoft-edge-stable", "brave-browser", "brave-browser-stable", "vivaldi-stable",
            "chromium", "chromium-browser");

    private BrowserLauncher() {}

    static Path find(String override, Path dataDir) {
        for (String explicit : new String[] {override, Orchard.env("BROWSER")}) {
            if (explicit != null && !explicit.isBlank()) {
                Path p = Path.of(explicit);
                if (Files.isRegularFile(p)) return p;
                Path onPath = searchPath(explicit);
                if (onPath != null) return onPath;
                throw new IllegalStateException("Browser not found: " + explicit);
            }
        }
        Path pinned = remembered(dataDir);
        if (pinned != null) return pinned;
        Path def = defaultBrowser();
        if (def != null) {
            if (isChromium(def)) {
                Log.info("Using your default browser");
                return def;
            }
            Log.info("Your default browser (" + def.getFileName() + ") can't run Orchard's player; it needs a "
                    + "Chromium-based browser such as Chrome, Edge or Brave. Looking for one of those.");
        }
        return fallback();
    }

    static boolean isChromium(Path exe) {
        String name = exe.getFileName().toString().toLowerCase(Locale.ROOT).replaceFirst("\\.exe$", "");
        return CHROMIUM_EXES.contains(name);
    }

    private static Path fallback() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        List<Path> candidates = new ArrayList<>();
        if (os.contains("win")) {
            String[][] browsers = {
                    {"Google", "Chrome", "Application", "chrome.exe"},
                    {"Microsoft", "Edge", "Application", "msedge.exe"},
                    {"BraveSoftware", "Brave-Browser", "Application", "brave.exe"}};
            for (String[] b : browsers) {
                for (String env : new String[] {"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"}) {
                    String base = System.getenv(env);
                    if (base != null) candidates.add(Path.of(base, b));
                }
            }
        } else if (os.contains("mac")) {
            String home = System.getProperty("user.home");
            for (String root : new String[] {"/Applications", home + "/Applications"}) {
                candidates.add(Path.of(root, "Google Chrome.app/Contents/MacOS/Google Chrome"));
                candidates.add(Path.of(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"));
                candidates.add(Path.of(root, "Brave Browser.app/Contents/MacOS/Brave Browser"));
            }
        } else {
            // Open-source Chromium builds usually lack Widevine, so they are the last resort.
            for (String name : new String[] {"google-chrome-stable", "google-chrome", "microsoft-edge-stable",
                    "microsoft-edge", "brave-browser", "chromium", "chromium-browser"}) {
                Path p = searchPath(name);
                if (p != null) candidates.add(p);
            }
            candidates.add(Path.of("/opt/google/chrome/chrome"));
        }
        for (Path p : candidates) {
            if (Files.isRegularFile(p)) return p;
        }
        return null;
    }

    // ------------------------------------------------------------------ default browser detection

    /** The OS's default web browser executable, or null if it can't be determined. */
    static Path defaultBrowser() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        try {
            if (os.contains("win")) return windowsDefault();
            if (os.contains("mac")) return macDefault();
            return linuxDefault();
        } catch (Exception e) {
            Log.debug("Could not determine the default browser: " + e.getMessage());
            return null;
        }
    }

    private static Path windowsDefault() throws IOException, InterruptedException {
        String base = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\";
        // Newer Windows 11 builds keep the real choice under UserChoiceLatest; the old UserChoice key can be stale.
        String[] keys = {"https\\UserChoiceLatest\\ProgId", "https\\UserChoiceLatest", "https\\UserChoice",
                "http\\UserChoiceLatest\\ProgId", "http\\UserChoice"};
        String progId = null;
        for (String k : keys) {
            progId = regValue(run("reg", "query", base + k, "/v", "ProgId"), "ProgId");
            if (progId != null) break;
        }
        if (progId == null) return null;
        String command = regValue(run("reg", "query", "HKCR\\" + progId + "\\shell\\open\\command", "/ve"), "(Default)");
        if (command == null) return null;
        String exe;
        if (command.startsWith("\"")) {
            int end = command.indexOf('"', 1);
            exe = end > 0 ? command.substring(1, end) : null;
        } else {
            int dot = command.toLowerCase(Locale.ROOT).indexOf(".exe");
            exe = dot > 0 ? command.substring(0, dot + 4) : null;
        }
        Path p = exe == null ? null : Path.of(exe);
        return p != null && Files.isRegularFile(p) ? p : null;
    }

    /** Parses `reg query` output lines like "    ProgId    REG_SZ    BraveHTML". */
    private static String regValue(String output, String name) {
        if (output == null) return null;
        for (String line : output.split("\\R")) {
            String t = line.trim();
            if (t.startsWith(name) && t.contains("REG_")) {
                int i = t.indexOf("REG_");
                int sp = t.indexOf(' ', i);
                if (sp > 0) return t.substring(sp).trim();
            }
        }
        return null;
    }

    private static Path macDefault() throws IOException, InterruptedException {
        String out = run("defaults", "read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers");
        if (out == null) return null;
        String bundle = null;
        for (String block : out.split("\\}")) {
            if (block.matches("(?s).*LSHandlerURLScheme\\s*=\\s*\"?https\"?;.*")) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("LSHandlerRoleAll\\s*=\\s*\"?([\\w.-]+)\"?;").matcher(block);
                if (m.find()) bundle = m.group(1).toLowerCase(Locale.ROOT);
            }
        }
        if (bundle == null) return null;
        String app = switch (bundle) {
            case "com.google.chrome" -> "Google Chrome.app/Contents/MacOS/Google Chrome";
            case "com.microsoft.edgemac" -> "Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
            case "com.brave.browser" -> "Brave Browser.app/Contents/MacOS/Brave Browser";
            case "com.vivaldi.vivaldi" -> "Vivaldi.app/Contents/MacOS/Vivaldi";
            case "org.chromium.chromium" -> "Chromium.app/Contents/MacOS/Chromium";
            default -> null; // Safari, Firefox, … can't run Orchard
        };
        if (app == null) return Path.of(bundle); // non-Chromium: reported by name only
        for (String root : new String[] {"/Applications", System.getProperty("user.home") + "/Applications"}) {
            Path p = Path.of(root, app);
            if (Files.isRegularFile(p)) return p;
        }
        return null;
    }

    private static Path linuxDefault() throws IOException, InterruptedException {
        String out = run("xdg-settings", "get", "default-web-browser");
        if (out == null || out.isBlank()) return null;
        String name = out.trim().replaceFirst("\\.desktop$", "");
        Path p = searchPath(name);
        if (p == null && name.endsWith("-stable")) p = searchPath(name.substring(0, name.length() - 7));
        return p != null ? p : Path.of(name);
    }

    private static String run(String... cmd) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        byte[] out = p.getInputStream().readAllBytes();
        if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
            p.destroyForcibly();
            return null;
        }
        return p.exitValue() == 0 ? new String(out) : null;
    }

    private static Path searchPath(String name) {
        String path = System.getenv("PATH");
        if (path == null) return null;
        for (String dir : path.split(File.pathSeparator)) {
            if (dir.isBlank()) continue;
            Path p = Path.of(dir, name);
            if (Files.isRegularFile(p) && Files.isExecutable(p)) return p;
        }
        return null;
    }

    static Running launch(Path exe, Path profileDir, String appUrl, Path logFile, List<String> extraArgs)
            throws IOException, InterruptedException {
        Files.createDirectories(profileDir);
        Path portFile = profileDir.resolve("DevToolsActivePort");
        closeLeftoverBrowser(portFile);
        Files.deleteIfExists(portFile);
        prepareProfile(exe, profileDir);

        List<String> cmd = new ArrayList<>(List.of(
                exe.toString(),
                "--user-data-dir=" + profileDir.toAbsolutePath(),
                "--remote-debugging-port=0",
                "--app=" + appUrl,
                "--no-first-run",
                "--no-default-browser-check",
                "--autoplay-policy=no-user-gesture-required",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "--window-size=1320,860"));
        cmd.addAll(extraArgs);
        Log.debug("Launching: " + String.join(" ", cmd));
        Process process = new ProcessBuilder(cmd)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile.toFile()))
                .start();

        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            if (Files.exists(portFile)) {
                List<String> lines = Files.readAllLines(portFile);
                if (lines.size() >= 2 && !lines.get(0).isBlank()) {
                    String ws = "ws://127.0.0.1:" + lines.get(0).trim() + lines.get(1).trim();
                    return new Running(process, ws, exe);
                }
            }
            if (!process.isAlive()) {
                throw new IOException("The browser exited immediately (code " + process.exitValue()
                        + "). If a previous Orchard window is still open, close it and try again. Log: " + logFile);
            }
            Thread.sleep(100);
        }
        process.destroy();
        throw new IOException("The browser did not start its DevTools endpoint in time. Log: " + logFile);
    }

    /**
     * Browser-specific profile tweaks, applied while the browser is not running. Brave ships with Widevine (the DRM
     * module Apple Music needs) switched off and asks before enabling it, so opt in up front in Orchard's own profile.
     */
    private static void prepareProfile(Path exe, Path profileDir) {
        if (!exe.getFileName().toString().toLowerCase(Locale.ROOT).contains("brave")) return;
        setPref(profileDir.resolve("Local State"), "brave", "widevine_opted_in", true);
        setPref(profileDir.resolve("Default").resolve("Preferences"), "brave", "widevine_opted_in", true);
    }

    private static void setPref(Path file, String group, String key, Object value) {
        try {
            java.util.Map<String, Object> root = Files.exists(file)
                    ? Json.parseObject(Files.readString(file)) : new java.util.LinkedHashMap<>();
            java.util.Map<String, Object> g = Json.map(root.get(group));
            if (g == null) {
                g = new java.util.LinkedHashMap<>();
                root.put(group, g);
            }
            if (value.equals(g.get(key))) return;
            g.put(key, value);
            Files.createDirectories(file.getParent());
            Files.writeString(file, Json.write(root));
        } catch (Exception e) {
            Log.debug("Could not update browser preference " + file + ": " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ keeping the Apple sign-in

    private static final String CHOICE_FILE = "browser-choice";
    private static final String LEGACY_PROFILE = "browser-profile";

    /**
     * The browser chosen on an earlier run. The sign-in lives in that browser's profile, so Orchard sticks with it
     * even if the default browser changes or is detected differently; only --browser / ORCHARD_BROWSER switch.
     */
    static Path remembered(Path dataDir) {
        try {
            Path f = dataDir.resolve(CHOICE_FILE);
            if (!Files.exists(f)) return null;
            Path p = Path.of(Files.readString(f).trim());
            return Files.isRegularFile(p) ? p : null;
        } catch (Exception e) {
            return null;
        }
    }

    static void remember(Path dataDir, Path exe) {
        try {
            Path abs = exe.toAbsolutePath();
            Path prev = remembered(dataDir);
            if (abs.equals(prev)) return;
            if (prev != null) {
                Log.warn("Switching Orchard's browser from " + prev.getFileName() + " to " + abs.getFileName()
                        + ": you'll need to sign in to Apple Music once in it. Run with --browser \"" + prev
                        + "\" to go back (your sign-in there is kept).");
            }
            Files.writeString(dataDir.resolve(CHOICE_FILE), abs.toString());
        } catch (IOException e) {
            Log.debug("Could not remember the browser choice: " + e.getMessage());
        }
    }

    /**
     * The profile folder for {@code exe}: {@code <data>/browser-<name>}. Before returning it, closes any browser
     * left running on it and adopts the profile from older Orchard versions ({@code browser-profile}) when that is
     * where this browser's Apple Music sign-in actually is. Never deletes a profile; a replaced one is renamed.
     */
    static Path profileDir(Path dataDir, Path exe) {
        String name = exe.getFileName().toString().replaceFirst("(?i)\\.exe$", "")
                .replaceAll("[^A-Za-z0-9-]", "-").toLowerCase(Locale.ROOT);
        Path target = dataDir.resolve("browser-" + name);
        Path legacy = dataDir.resolve(LEGACY_PROFILE);
        if (!Files.isDirectory(legacy) || !sameBrowser(legacy, exe)) return target;
        closeLeftoverBrowser(target.resolve("DevToolsActivePort"));
        closeLeftoverBrowser(legacy.resolve("DevToolsActivePort"));
        try {
            if (!Files.exists(target)) {
                Files.move(legacy, target);
                Log.info("Moved your existing browser profile (with your Apple Music sign-in) to " + target);
            } else if (hasAppleSignIn(legacy) && !hasAppleSignIn(target)) {
                Path aside = dataDir.resolve(target.getFileName() + ".replaced-" + System.currentTimeMillis());
                Files.move(target, aside);
                Files.move(legacy, target);
                Log.info("Restored your Apple Music sign-in from the old browser profile (the signed-out one was "
                        + "kept as " + aside.getFileName() + ").");
            }
        } catch (IOException e) {
            Log.warn("Could not adopt the old browser profile " + legacy + ": " + e.getMessage());
        }
        return target;
    }

    /** Whether the profile was last run by the same browser (Chromium's "Last Browser" file, UTF-16). */
    private static boolean sameBrowser(Path profile, Path exe) {
        try {
            String last = new String(Files.readAllBytes(profile.resolve("Last Browser")),
                    java.nio.charset.StandardCharsets.ISO_8859_1).replace("\0", "").trim();
            String lastName = last.substring(Math.max(last.lastIndexOf('\\'), last.lastIndexOf('/')) + 1);
            return lastName.equalsIgnoreCase(exe.getFileName().toString());
        } catch (Exception e) {
            return false;
        }
    }

    /** Whether the profile's cookie store has Apple Music's sign-in cookie (names are stored in plain text). */
    static boolean hasAppleSignIn(Path profile) {
        byte[] needle = "media-user-token".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        for (Path db : List.of(profile.resolve("Default/Network/Cookies"), profile.resolve("Default/Cookies"))) {
            try {
                if (Files.exists(db) && indexOf(Files.readAllBytes(db), needle) >= 0) return true;
            } catch (IOException ignored) {
                // locked or unreadable
            }
        }
        return false;
    }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    /**
     * If Orchard was killed without a clean shutdown, its browser may still hold the profile; a new launch would then
     * just hand off to it and exit. Close that leftover browser first.
     */
    static void closeLeftoverBrowser(Path portFile) {
        if (!Files.exists(portFile)) return;
        try {
            List<String> lines = Files.readAllLines(portFile);
            if (lines.size() < 2) return;
            CdpClient old = CdpClient.connect("ws://127.0.0.1:" + lines.get(0).trim() + lines.get(1).trim());
            Log.info("Closing an Orchard browser left over from a previous run.");
            try {
                old.call("Browser.close", null, null, 5);
            } catch (RuntimeException ignored) {
                // connection drops as the browser exits
            }
            old.closedFuture().get(10, java.util.concurrent.TimeUnit.SECONDS);
            Thread.sleep(500);
        } catch (Exception e) {
            Log.debug("No leftover browser: " + e.getMessage());
        }
    }
}
