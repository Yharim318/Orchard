package orchard;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * Over-the-air updates: keeps orchard.exe in step with the newest release on GitHub.
 *
 * <p>Every few hours (and shortly after start) it asks GitHub for the latest release of {@link #REPO}. When that
 * release is newer than this build and has an {@code orchard.exe} asset, the new exe is downloaded next to the
 * running one, checked (size, SHA-256 from GitHub, and a test run with {@code --version}) and swapped in: Windows lets
 * a running exe be renamed, so the old one becomes {@code orchard.old.exe} and the new one takes its name. From then
 * on every start runs the new version; the app offers "Restart now", and restarts by itself once nothing has played
 * for {@link #IDLE_RESTART} (a restart closes the browser gracefully, so the Apple Music sign-in is kept).
 *
 * <p>Only the Windows exe built by the release workflow updates itself on its own (releases ship only that exe); a
 * build made with build.cmd ({@link Orchard#RELEASE_BUILD} false) installs a release only when "Check now" is pressed,
 * so local builds aren't replaced behind the developer's back. The setting is a file in the data folder
 * ({@code auto-update}: "on"/"off", default on); {@code --no-update} or ORCHARD_NO_UPDATE turns it off for one run.
 */
final class Updater {

    static final String REPO = "Yharim318/Orchard";
    private static final String ASSET = "orchard.exe";
    private static final Duration FIRST_CHECK = Duration.ofSeconds(30);
    private static final Duration CHECK_EVERY = Duration.ofHours(6);
    private static final Duration IDLE_RESTART = Duration.ofMinutes(30);
    private static final boolean WINDOWS =
            System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");

    private final Path dataDir;
    private final List<String> args;
    private final BooleanSupplier playing;
    private final Path exe;             // the running orchard.exe, or null when this build can't update itself
    private final String unsupported;   // why not, when exe is null
    private final boolean blocked;      // --no-update / ORCHARD_NO_UPDATE
    private final boolean devBuild = !Orchard.RELEASE_BUILD; // made with build.cmd: never updates on its own
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL) // release downloads redirect to GitHub's file host
            .build();
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "updater");
        t.setDaemon(true);
        return t;
    });

    private volatile boolean enabled;
    private volatile String status = "idle";   // idle, checking, downloading, current, ready, error, off
    private volatile String message = "";
    private volatile String latest;             // newest version seen on GitHub
    private volatile String ready;              // version installed and waiting for a restart
    private volatile long checkedAt;
    private volatile long lastPlayingAt = System.currentTimeMillis();
    private volatile boolean restarting;

    Updater(Path dataDir, List<String> args, boolean noUpdateFlag, BooleanSupplier playing) {
        this.dataDir = dataDir;
        this.args = List.copyOf(args);
        this.playing = playing;
        this.blocked = noUpdateFlag || Orchard.env("NO_UPDATE") != null;
        Path found = null;
        String why = null;
        if (!WINDOWS) {
            why = "Automatic updates are only available for the Windows app (orchard.exe).";
        } else {
            found = runningExe();
            if (found == null) why = "Automatic updates only work for orchard.exe, not when Orchard runs from Java.";
        }
        this.exe = found;
        this.unsupported = why;
        this.enabled = !"off".equals(readSetting());
    }

    /** Starts the background checks (does nothing when this build can't update itself). */
    void start() {
        if (exe == null) {
            Log.info(unsupported);
            return;
        }
        if (blocked) {
            Log.info("Automatic updates are turned off for this run (--no-update / ORCHARD_NO_UPDATE).");
        } else if (devBuild) {
            Log.info("Development build (made with build.cmd): it doesn't update itself; Settings > Updates > "
                    + "Check now installs the latest release.");
        }
        worker.schedule(this::removeOldExe, 5, TimeUnit.SECONDS);
        worker.schedule(() -> {
            if (active()) check();
        }, FIRST_CHECK.toSeconds(), TimeUnit.SECONDS);
        worker.scheduleWithFixedDelay(() -> {
            if (active() && System.currentTimeMillis() - checkedAt >= CHECK_EVERY.toMillis()) check();
        }, 10, 10, TimeUnit.MINUTES);
        worker.scheduleWithFixedDelay(this::restartWhenIdle, 1, 1, TimeUnit.MINUTES);
    }

    private boolean active() {
        return enabled && !blocked && !devBuild;
    }

    // ------------------------------------------------------------------ what the app sees

    synchronized Map<String, Object> status() {
        return Json.obj(
                "supported", exe != null,
                "enabled", enabled,
                "blocked", blocked,
                "dev", devBuild,
                "current", Orchard.VERSION,
                "latest", latest,
                "ready", ready,
                "status", exe == null ? "unsupported" : !active() && "idle".equals(status) ? "off" : status,
                "message", exe == null ? unsupported : message,
                "checkedAt", checkedAt == 0 ? null : checkedAt,
                "repo", REPO);
    }

    /** Turns automatic updates on or off (remembered in the data folder). Turning them on checks right away. */
    Map<String, Object> setEnabled(boolean on) {
        enabled = on;
        writeSetting(on ? "on" : "off");
        Log.info("Automatic updates turned " + (on ? "on" : "off") + ".");
        if (active() && exe != null && ready == null) worker.execute(() -> check());
        return status();
    }

    /** "Check now": checks (and installs) even when automatic updates are off, since the user asked. */
    Map<String, Object> checkNow() {
        if (exe == null) throw new WebServer.HttpError(400, unsupported);
        worker.execute(() -> check());
        synchronized (this) {
            if (!"downloading".equals(status) && ready == null) setStatus("checking", "Checking for updates…");
        }
        return status();
    }

    /** Restarts into the installed update (after the HTTP answer has gone out). */
    Map<String, Object> restartNow() {
        if (ready == null) throw new WebServer.HttpError(409, "No update is waiting.");
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(400);
            } catch (InterruptedException ignored) {
                // restart anyway
            }
            restart("you asked for it");
        }, "update-restart");
        t.setDaemon(true);
        t.start();
        return status();
    }

    private synchronized void setStatus(String s, String msg) {
        status = s;
        message = msg == null ? "" : msg;
    }

    // ------------------------------------------------------------------ checking and installing

    private void check() {
        if (exe == null || ready != null || restarting) {
            if (ready != null) setStatus("ready", "Orchard " + ready + " is installed. Restart to start using it.");
            return;
        }
        setStatus("checking", "Checking for updates…");
        try {
            Map<String, Object> rel = latestRelease();
            checkedAt = System.currentTimeMillis();
            if (rel == null) {
                setStatus("current", "No releases have been published yet.");
                return;
            }
            String tag = Json.str(rel, "tag_name");
            String version = tag == null ? null : tag.replaceFirst("^[vV]", "");
            latest = version;
            if (version == null || compare(version, Orchard.VERSION) <= 0) {
                setStatus("current", "Orchard is up to date.");
                return;
            }
            Map<String, Object> asset = null;
            for (Object o : Json.list(rel.get("assets"))) {
                Map<String, Object> a = Json.map(o);
                if (a != null && ASSET.equalsIgnoreCase(Json.str(a, "name"))) asset = a;
            }
            if (asset == null) {
                setStatus("current", "Orchard " + version + " is out, but its release has no " + ASSET + " yet.");
                return;
            }
            String assetId = Json.str(asset, "id");
            if (assetId != null && assetId.equals(readFile("update-installed"))) {
                // Already installed this exact file once. It reports an older version than its release says (the
                // version in Orchard.java wasn't bumped), so installing it again would loop forever.
                setStatus("current", "Orchard is up to date.");
                Log.warn("Release " + tag + " was installed before but reports version " + Orchard.VERSION
                        + "; not installing it again.");
                return;
            }
            install(version, asset, assetId);
        } catch (Exception e) {
            String why = e.getMessage() != null ? e.getMessage() : e.toString();
            setStatus("error", "Couldn't update: " + why);
            Log.warn("Update failed: " + why);
        }
    }

    /** The latest published release (drafts and pre-releases excluded by GitHub), or null if there is none. */
    private Map<String, Object> latestRelease() throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create("https://api.github.com/repos/" + REPO + "/releases/latest"))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "Orchard-updater")
                .timeout(Duration.ofSeconds(30))
                .GET().build();
        HttpResponse<String> r = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() == 404) return null;
        if (r.statusCode() == 403 || r.statusCode() == 429) throw new IOException("GitHub is rate-limiting update checks; trying again later");
        if (r.statusCode() != 200) throw new IOException("GitHub answered HTTP " + r.statusCode());
        return Json.parseObject(r.body());
    }

    private void install(String version, Map<String, Object> asset, String assetId) throws Exception {
        String url = Json.str(asset, "browser_download_url");
        if (url == null || !url.startsWith("https://")) throw new IOException("the release has no download link");
        setStatus("downloading", "Downloading Orchard " + version + "…");
        Log.info("Downloading Orchard " + version + " from " + url);

        Path dir = exe.toAbsolutePath().getParent();
        String base = baseName();
        Path download = dir.resolve(base + ".update.exe");
        try {
            Files.deleteIfExists(download);
            Files.newOutputStream(download).close(); // can we write next to orchard.exe at all?
        } catch (IOException e) {
            throw new IOException("Orchard can't write to " + dir + ". Move orchard.exe to a folder you own "
                    + "(e.g. your user folder) to get updates.");
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .header("Accept", "application/octet-stream")
                    .header("User-Agent", "Orchard-updater")
                    .timeout(Duration.ofMinutes(10))
                    .GET().build();
            HttpResponse<Path> r = http.send(req, HttpResponse.BodyHandlers.ofFile(download));
            if (r.statusCode() != 200) throw new IOException("download failed (HTTP " + r.statusCode() + ")");
            verify(download, asset, version);

            // Swap: the running exe can be renamed (not deleted) on Windows.
            Path old = dir.resolve(base + ".old.exe");
            if (!deleteQuietly(old)) old = dir.resolve(base + ".old-" + System.currentTimeMillis() + ".exe");
            Files.move(exe, old);
            try {
                Files.move(download, exe);
            } catch (IOException e) {
                Files.move(old, exe); // put the running version back
                throw e;
            }
            if (assetId != null) writeFile("update-installed", assetId);
            ready = version;
            setStatus("ready", "Orchard " + version + " is installed. Restart to start using it.");
            Log.info("Orchard " + version + " installed; it starts the next time Orchard does.");
        } finally {
            deleteQuietly(download);
        }
    }

    /** The download is the file GitHub has (size, SHA-256) and actually runs (it prints its version and exits). */
    private void verify(Path file, Map<String, Object> asset, String version) throws Exception {
        long size = Files.size(file);
        Object expected = asset.get("size");
        if (expected instanceof Number n && n.longValue() != size) {
            throw new IOException("the download is incomplete (" + size + " of " + n + " bytes)");
        }
        String digest = Json.str(asset, "digest"); // "sha256:<hex>", given by GitHub for newer uploads
        if (digest != null && digest.startsWith("sha256:")) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = Files.newInputStream(file)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
            }
            String got = HexFormat.of().formatHex(md.digest());
            if (!got.equalsIgnoreCase(digest.substring(7))) throw new IOException("the download is damaged (checksum mismatch)");
        }
        try (InputStream in = Files.newInputStream(file)) {
            byte[] head = in.readNBytes(2);
            if (head.length < 2 || head[0] != 'M' || head[1] != 'Z') throw new IOException("the download isn't a Windows program");
        }
        // Run it once: a release that can't even start must never replace a working Orchard.
        Process p = new ProcessBuilder(file.toString(), "--version").redirectErrorStream(true).start();
        p.getOutputStream().close();
        byte[] out;
        try (InputStream in = p.getInputStream()) {
            out = in.readNBytes(4096);
        }
        if (!p.waitFor(60, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("the new version didn't start properly (timed out)");
        }
        if (p.exitValue() != 0) throw new IOException("the new version didn't start properly (exit code " + p.exitValue() + ")");
        String reported = new String(out, StandardCharsets.UTF_8).trim();
        if (!reported.isEmpty() && !reported.equals(version)) {
            Log.warn("Release " + version + " reports itself as version " + reported + ".");
        }
    }

    // ------------------------------------------------------------------ restarting

    private void restartWhenIdle() {
        try {
            if (playing.getAsBoolean()) {
                lastPlayingAt = System.currentTimeMillis();
                return;
            }
            if (ready != null && active() && System.currentTimeMillis() - lastPlayingAt >= IDLE_RESTART.toMillis()) {
                restart("nothing has played for " + IDLE_RESTART.toMinutes() + " minutes");
            }
        } catch (RuntimeException e) {
            Log.debug("Idle check failed: " + e);
        }
    }

    /**
     * Starts the new exe (which waits for this process to finish exiting, so the port and the browser profile are
     * free) and exits; the shutdown hook closes the browser gracefully so the sign-in is kept.
     */
    private synchronized void restart(String why) {
        if (restarting) return;
        restarting = true;
        Log.info("Restarting into Orchard " + ready + " (" + why + ").");
        List<String> cmd = new ArrayList<>();
        cmd.add(exe.toString());
        for (int i = 0; i < args.size(); i++) {
            if (args.get(i).equals("--wait-for")) i++; // from our own previous restart
            else cmd.add(args.get(i));
        }
        cmd.add("--wait-for");
        cmd.add(String.valueOf(ProcessHandle.current().pid()));
        try {
            new ProcessBuilder(cmd)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException e) {
            restarting = false;
            setStatus("error", "Couldn't restart: " + e.getMessage() + ". Close and reopen Orchard to update.");
            Log.warn("Couldn't start the new version: " + e.getMessage());
            return;
        }
        System.exit(0);
    }

    /** {@code --wait-for <pid>}: a restarting Orchard is still closing; wait for it before taking its port. */
    static void waitForExit(long pid) {
        ProcessHandle.of(pid).ifPresent(h -> {
            try {
                h.onExit().get(60, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // carry on; a port clash is reported as usual
            }
        });
    }

    // ------------------------------------------------------------------ files

    /** The running orchard.exe (native build), or null when Orchard runs on a JVM. */
    private static Path runningExe() {
        String cmd = ProcessHandle.current().info().command().orElse(null);
        if (cmd == null) return null;
        Path p = Path.of(cmd);
        String name = p.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!name.endsWith(".exe") || name.equals("java.exe") || name.equals("javaw.exe")) return null;
        return p.toAbsolutePath();
    }

    private String baseName() {
        String n = exe.getFileName().toString();
        return n.substring(0, n.length() - 4);
    }

    /** Removes the exe a previous update replaced (it may still be running for a moment after a restart). */
    private void removeOldExe() {
        if (exe == null) return;
        String base = baseName().toLowerCase(Locale.ROOT);
        try (var files = Files.newDirectoryStream(exe.toAbsolutePath().getParent(), "*.exe")) {
            for (Path f : files) {
                String n = f.getFileName().toString().toLowerCase(Locale.ROOT);
                if (n.startsWith(base + ".old") || n.equals(base + ".update.exe")) {
                    if (!deleteQuietly(f)) worker.schedule(this::removeOldExe, 1, TimeUnit.MINUTES);
                }
            }
        } catch (IOException ignored) {
            // nothing to clean up
        }
    }

    private static boolean deleteQuietly(Path f) {
        try {
            Files.deleteIfExists(f);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private String readSetting() {
        return readFile("auto-update");
    }

    private void writeSetting(String v) {
        writeFile("auto-update", v);
    }

    private String readFile(String name) {
        try {
            return Files.readString(dataDir.resolve(name)).trim();
        } catch (IOException e) {
            return null;
        }
    }

    private void writeFile(String name, String value) {
        try {
            Files.writeString(dataDir.resolve(name), value);
        } catch (IOException e) {
            Log.warn("Could not save " + name + ": " + e.getMessage());
        }
    }

    /** Compares dotted versions numerically ("0.10.0" > "0.9.2"); a missing part counts as 0. */
    static int compare(String a, String b) {
        String[] x = a.split("[.]"), y = b.split("[.]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int c = Long.compare(num(x, i), num(y, i));
            if (c != 0) return c;
        }
        return 0;
    }

    private static long num(String[] parts, int i) {
        if (i >= parts.length) return 0;
        String digits = parts[i].replaceFirst("^(\\d*).*$", "$1"); // "3-beta" → 3
        return digits.isEmpty() ? 0 : Long.parseLong(digits);
    }
}
