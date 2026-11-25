package orchard;

import java.io.IOException;
import java.io.InputStream;
import java.net.BindException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;

/** Entry point: starts the server, the LAN discovery and the browser-hosted Apple Music engine. */
public final class Main {

    private Main() {}

    private static final class Options {
        int port = 8787;
        String name;
        String browser;
        Path dataDir;
        boolean noBrowser;
        boolean localOnly;
        boolean headless;
        boolean engineWindow;
        boolean console;
        final List<String> peers = new ArrayList<>();
    }

    public static void main(String[] args) throws Exception {
        Options o = parse(args);
        List<String> notes = new ArrayList<>(); // logged once the log file is ours
        Path dataDir = o.dataDir != null ? o.dataDir : defaultDataDir(o.port, notes);
        Files.createDirectories(dataDir);
        String id = loadOrCreateId(dataDir);
        String name = o.name != null ? o.name : Net.hostname();

        Orchard app = new Orchard(id, name, o.port, !o.localOnly);
        Hub hub = new Hub(
                () -> Json.obj("speaker", app.self(), "info", app.info()),
                app::state,
                app::speakers);
        Discovery discovery = new Discovery(id, name, o.port, o.peers, () -> hub.broadcast("speakers", app.speakers()));
        app.init(hub, discovery);

        WebServer server;
        try {
            server = new WebServer(app, o.localOnly ? "127.0.0.1" : "0.0.0.0", o.port, dataDir);
        } catch (BindException e) {
            Log.err("Port " + o.port + " is already in use. Is Orchard (or the older Juice) already running? "
                    + "Use --port to pick another one.");
            ConsoleWindow.exitShowing(1);
            return;
        }
        // Only now (this is the one running Orchard) take over the log file; Ctrl+Shift+T shows it in a window.
        ConsoleWindow.logTo(dataDir.resolve("orchard.log"));
        if (o.console) ConsoleWindow.show();
        notes.forEach(Log::info);
        server.start();
        if (!o.localOnly) discovery.start();

        String localUrl = "http://localhost:" + o.port + "/";
        Log.out("");
        Log.out("  Orchard " + Orchard.VERSION + " - " + name);
        Log.out("  This computer:   " + localUrl);
        for (Net.Address a : app.remoteAddresses()) {
            String how = switch (a.kind()) {
                case LAN -> "same Wi-Fi / network";
                case TAILSCALE -> "via Tailscale";
                case PUBLIC -> "public address";
            };
            Log.out("  Phone remote:    http://" + a.ip() + ":" + o.port + "/   (" + how + ")");
        }
        Log.out("");

        if (o.noBrowser) {
            app.setEngineProblem("Orchard was started without a browser (--no-browser), so nothing can play here.");
        } else {
            startEngine(app, hub, o, dataDir, localUrl);
        }
        new CountDownLatch(1).await();
    }

    private static void startEngine(Orchard app, Hub hub, Options o, Path dataDir, String localUrl) {
        Path exe;
        try {
            exe = BrowserLauncher.find(o.browser, dataDir);
        } catch (IllegalStateException e) {
            exe = null;
            Log.warn(e.getMessage());
        }
        if (exe == null) {
            String msg = "No supported browser found. Install Google Chrome or Microsoft Edge "
                    + "(or pass --browser <path>), then restart Orchard.";
            Log.warn(msg);
            app.setEngineProblem(msg);
            ConsoleWindow.show(); // no Orchard window will open, so show the log window to say why
            return;
        }
        Log.info("Using browser " + exe);
        BrowserLauncher.remember(dataDir, exe);
        try {
            List<String> extra = new ArrayList<>();
            if (o.headless) extra.add("--headless=new");
            // One profile per browser (they can't safely share one); it holds the Apple Music sign-in.
            Path profile = BrowserLauncher.profileDir(dataDir, exe);
            BrowserLauncher.Running browser = BrowserLauncher.launch(exe, profile,
                    o.engineWindow ? localUrl + "?host=1" : Engine.APP_URL, dataDir.resolve("browser.log"), extra);
            CdpClient cdp = CdpClient.connect(browser.browserWsUrl());
            HostLink hostLink = new HostLink(app);
            Engine engine = new Engine(cdp, java.util.List.of(Engine.ORCHARD_PREFIX, localUrl),
                    resource("/engine/engine.js"), o.engineWindow, hostLink,
                    state -> hub.broadcast("state", state), ui -> hub.broadcast("engine-ui", ui));
            app.setEngine(engine);
            engine.onAppClosed(() -> System.exit(0));
            cdp.closedFuture().thenAccept(reason -> {
                Log.info("Browser closed (" + reason + "); exiting.");
                System.exit(0);
            });
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                // Ask the browser to quit and let it finish: killing it mid-exit can lose cookies it has not
                // written to disk yet, including a fresh Apple Music sign-in.
                engine.shutdown();
                try {
                    if (!browser.process().waitFor(8, java.util.concurrent.TimeUnit.SECONDS)) {
                        browser.process().destroy();
                    }
                } catch (InterruptedException ignored) {
                    // exiting anyway
                }
            }, "shutdown"));
            engine.start();
        } catch (Exception e) {
            Log.warn("Could not start the browser: " + e.getMessage());
            app.setEngineProblem("Could not start the browser: " + e.getMessage());
            ConsoleWindow.show();
        }
    }

    // ------------------------------------------------------------------ setup helpers

    private static Options parse(String[] args) {
        Options o = new Options();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            switch (a) {
                case "--port" -> o.port = Integer.parseInt(next(args, ++i, a));
                case "--name" -> o.name = next(args, ++i, a);
                case "--browser" -> o.browser = next(args, ++i, a);
                case "--data" -> o.dataDir = Path.of(next(args, ++i, a));
                case "--no-browser" -> o.noBrowser = true;
                case "--local" -> o.localOnly = true;
                case "--peer" -> o.peers.add(next(args, ++i, a));
                case "--headless" -> o.headless = true;
                case "--engine-window" -> o.engineWindow = true;
                case "--debug" -> Log.debug = true;
                case "--console" -> o.console = true;
                case "-h", "--help" -> {
                    Log.out("""
                            Orchard - a Spotify-style Apple Music client with remote control.

                            Usage: orchard [options]
                              --port <n>        HTTP port (default 8787)
                              --name <text>     Speaker name shown on other devices
                              --browser <path>  Chrome / Edge / Brave executable to use
                              --data <dir>      Where to keep the browser profile and settings
                              --local           Only this computer; no phones / LAN remotes
                              --peer <host>     Another Orchard computer to find directly (IP or name; repeatable).
                                                Tailscale devices are found automatically via the tailscale CLI.
                              --no-browser      Run the server only (no playback on this machine)
                              --engine-window   Run Apple Music in its own (minimized) window instead
                                                of hidden inside the Orchard window
                              --console         Open the log window at startup (Windows; otherwise
                                                Ctrl+Shift+T in the Orchard window opens/closes it)
                              --debug           Verbose logging
                            """);
                    ConsoleWindow.exitShowing(0);
                }
                default -> {
                    Log.err("Unknown option: " + a + " (try --help)");
                    ConsoleWindow.exitShowing(2);
                }
            }
        }
        return o;
    }

    private static String next(String[] args, int i, String flag) {
        if (i >= args.length) {
            Log.err("Missing value for " + flag);
            ConsoleWindow.exitShowing(2);
        }
        return args[i];
    }

    private static Path defaultDataDir(int port, List<String> notes) {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String home = System.getProperty("user.home");
        if (os.contains("win")) {
            String local = System.getenv("LOCALAPPDATA");
            Path base = Path.of(local != null ? local : home);
            return adoptLegacyDataDir(base.resolve("Juice"), base.resolve("Orchard"), port, notes);
        }
        if (os.contains("mac")) {
            Path base = Path.of(home, "Library", "Application Support");
            return adoptLegacyDataDir(base.resolve("Juice"), base.resolve("Orchard"), port, notes);
        }
        String xdg = System.getenv("XDG_DATA_HOME");
        Path base = xdg != null && !xdg.isBlank() ? Path.of(xdg) : Path.of(home, ".local", "share");
        return adoptLegacyDataDir(base.resolve("juice"), base.resolve("orchard"), port, notes);
    }

    /**
     * Orchard used to be called Juice and kept its data (the browser profile holding the Apple Music sign-in, the
     * speaker id, playlist pictures) in a "Juice" folder. Moves that folder to the new name once. The sign-in must
     * never be lost, so: never while a copy of the app may still be using it (something answers on our port), never
     * onto an existing folder, and if the move fails (files still open), keep using the old folder and try again on
     * the next start. Nothing is ever deleted.
     */
    static Path adoptLegacyDataDir(Path legacy, Path target, int port, List<String> notes) {
        if (Files.exists(target) || !Files.isDirectory(legacy)) return target;
        if (portAnswers(port)) {
            notes.add("Still using " + legacy + ": another copy of the app is running. It moves to " + target
                    + " on a start when no other copy is running.");
            return legacy;
        }
        // A browser left running by an old session still has its profile open; close it first.
        try (var dirs = Files.newDirectoryStream(legacy, "browser-*")) {
            for (Path d : dirs) if (Files.isDirectory(d)) BrowserLauncher.closeLeftoverBrowser(d.resolve("DevToolsActivePort"));
        } catch (IOException ignored) {
            // nothing to close
        }
        try {
            Files.move(legacy, target);
            notes.add("Moved your data (with your Apple Music sign-in) from " + legacy + " to " + target + ".");
            return target;
        } catch (IOException e) {
            notes.add("Could not move " + legacy + " to " + target + " (" + e
                    + "); still using the old folder. Orchard tries again on its next start.");
            return legacy;
        }
    }

    private static boolean portAnswers(int port) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), port), 400);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static String loadOrCreateId(Path dataDir) throws IOException {
        Path f = dataDir.resolve("speaker-id");
        if (Files.exists(f)) {
            String id = Files.readString(f).trim();
            if (!id.isEmpty()) return id;
        }
        String id = UUID.randomUUID().toString();
        Files.writeString(f, id);
        return id;
    }

    static String resource(String path) throws IOException {
        try (InputStream in = Main.class.getResourceAsStream(path)) {
            if (in == null) throw new IOException("Missing resource " + path);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
