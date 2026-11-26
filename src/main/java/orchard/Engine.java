package orchard;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The playback engine: Apple's own music.apple.com web player (MusicKit: sign-in, DRM, audio), driven over the
 * DevTools protocol. A helper script ({@code engine/engine.js}) is injected into Apple's page; it exposes
 * {@code window.__orchard} for commands and reports state back through a DevTools binding.
 *
 * <h2>Embedded mode (default)</h2>
 * The Orchard app window is loaded from {@code https://music.apple.com/orchard/}. That address doesn't exist on Apple's
 * side: Orchard intercepts every request under it and answers from its own server. Apple's player then runs in a
 * hidden iframe of the same site, so to the browser everything is first-party Apple: sign-in cookies, storage and
 * DRM behave exactly as on music.apple.com itself (with Apple as a third party inside a localhost page, Apple's
 * sign-in fails). Apple's pages refuse to be framed at all (X-Frame-Options: DENY), so those headers are removed
 * from Apple document responses on the way in.
 *
 * <h2>Window mode (fallback / --engine-window)</h2>
 * Apple's player runs in a separate, minimized browser window.
 */
final class Engine {

    static final class EngineException extends RuntimeException {
        final int status;

        EngineException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    enum Mode { EMBEDDED, WINDOW }

    /** Where the Orchard app window lives in embedded mode (answered by Orchard, never by Apple). */
    static final String ORCHARD_PREFIX = "https://music.apple.com/orchard";
    static final String APP_URL = ORCHARD_PREFIX + "/?host=1";

    private static final String ENGINE_URL = "https://music.apple.com/";
    private static final String BINDING = "__orchardEmit";
    private static final long EMBED_TIMEOUT_MS = 45_000;

    /** Apple documents that must have their anti-framing headers removed. */
    private static final List<Object> APPLE_DOCS = List.of(
            Json.obj("urlPattern", "https://*.apple.com/*", "resourceType", "Document", "requestStage", "Response"),
            Json.obj("urlPattern", "https://apple.com/*", "resourceType", "Document", "requestStage", "Response"));
    /** In the app window, additionally answer everything under /orchard ourselves. */
    private static final List<Object> APP_INTERCEPT;

    static {
        List<Object> l = new ArrayList<>();
        l.add(Json.obj("urlPattern", ORCHARD_PREFIX + "*", "requestStage", "Request"));
        l.addAll(APPLE_DOCS);
        APP_INTERCEPT = List.copyOf(l);
    }

    private final CdpClient cdp;
    private final List<String> appUrlPrefixes;
    private final String script;
    private final boolean preferWindow;
    private final HostLink hostLink;
    private final Consumer<Map<String, Object>> onState;
    private final Consumer<Map<String, Object>> onUi;
    private final Map<String, Object> state = new LinkedHashMap<>();

    private volatile Mode mode;
    private volatile String appTargetId;
    private volatile String appSession;
    private volatile String engineTargetId; // window mode only
    private volatile String engineSession;  // where Apple's page lives: the app page (embedded) or its own window
    private volatile boolean shuttingDown;
    private volatile boolean signInRequested;
    private volatile Runnable onAppClosed = () -> {};

    Engine(CdpClient cdp, List<String> appUrlPrefixes, String script, boolean preferWindow, HostLink hostLink,
            Consumer<Map<String, Object>> onState, Consumer<Map<String, Object>> onUi) {
        this.cdp = cdp;
        this.appUrlPrefixes = appUrlPrefixes;
        this.script = script;
        this.preferWindow = preferWindow;
        this.hostLink = hostLink;
        this.onState = onState;
        this.onUi = onUi;
        state.put("ready", false);
        state.put("authorized", false);
        state.put("message", "Starting Apple Music…");
    }

    void onAppClosed(Runnable r) {
        onAppClosed = r;
    }

    void start() {
        cdp.onEvent(this::onCdpEvent);
        cdp.call("Target.setDiscoverTargets", Json.obj("discover", true), null);
        allowOutputChoice();
        for (int i = 0; i < 100 && appTargetId == null; i++) {
            findAppTarget();
            if (appTargetId == null) sleep(100);
        }
        if (appTargetId == null) {
            Log.warn("Could not find the Orchard app window; using a separate Apple Music window.");
            openEngineWindow();
        } else if (preferWindow) {
            openEngineWindow();
        } else {
            startEmbedded();
        }
    }

    /**
     * Lets Apple's page see the computer's audio outputs by name, so the user can pick one (headphones,
     * speakers…). Chromium only names devices for sites with microphone permission; the engine never records.
     */
    private void allowOutputChoice() {
        try {
            cdp.call("Browser.grantPermissions",
                    Json.obj("origin", "https://music.apple.com", "permissions", List.of("audioCapture")), null);
        } catch (RuntimeException e) {
            Log.warn("Can't list audio outputs (sound plays on the system default): " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ public operations

    synchronized Map<String, Object> snapshot() {
        return new LinkedHashMap<>(state);
    }

    boolean isReady() {
        return Boolean.TRUE.equals(snapshot().get("ready"));
    }

    /** Runs a player command (play, pause, seek…) and returns the resulting state. */
    Map<String, Object> command(Map<String, Object> cmd) {
        requireReady();
        Map<String, Object> s = Json.map(invoke("cmd", cmd));
        if (s != null) mergeState(s);
        return snapshot();
    }

    /** Calls the Apple Music API from inside Apple's page (so Apple's own tokens and headers apply). */
    Map<String, Object> api(String method, String path, Object body) {
        requireReady();
        Map<String, Object> r = Json.map(invoke("api", method, path, body));
        if (r == null) throw new EngineException(502, "Empty response from Apple Music");
        return r;
    }

    /** A page of the queue ({@code rev, position, total, start, items}); the state only carries a window of it. */
    Map<String, Object> queueItems(int start, int count) {
        requireReady();
        Map<String, Object> r = Json.map(invoke("queueItems", start, count));
        if (r == null) throw new EngineException(500, "Could not read the queue");
        return r;
    }

    /** Current queue as plain catalog ids plus position, used to hand playback to another Orchard speaker. */
    Map<String, Object> exportQueue() {
        requireReady();
        Map<String, Object> r = Json.map(invoke("exportQueue"));
        if (r == null) throw new EngineException(500, "Could not read the queue");
        return r;
    }

    /** Shows Apple's page (inside the Orchard window when embedded) so the user can sign in there. */
    void signIn() {
        signInRequested = true;
        showEngine(true);
    }

    void signOut() {
        requireReady();
        invoke("unauthorize");
    }

    /** Shows or hides the Apple Music page (null = toggle). */
    void showEngine(Boolean show) {
        if (mode == Mode.WINDOW) {
            setWindowState(Boolean.FALSE.equals(show) ? "minimized" : "normal");
        } else {
            onUi.accept(show == null ? Json.obj("toggle", true) : Json.obj("show", show));
        }
    }

    void shutdown() {
        shuttingDown = true;
        try {
            cdp.call("Browser.close", null, null, 5);
        } catch (RuntimeException ignored) {
            // browser already gone
        }
    }

    // ------------------------------------------------------------------ embedded mode

    private void startEmbedded() {
        mode = Mode.EMBEDDED;
        mergeState(Json.obj("ready", false, "engineMode", "embedded", "message", "Starting Apple Music…"));
        Map<String, Object> attached = cdp.call("Target.attachToTarget",
                Json.obj("targetId", appTargetId, "flatten", true), null);
        String session = Json.str(attached, "sessionId");
        appSession = session;
        engineSession = session;
        hostLink.setPusher(js -> cdp.send("Runtime.evaluate", Json.obj("expression", js), session));
        cdp.call("Fetch.enable", Json.obj("patterns", APP_INTERCEPT), session);
        cdp.call("Page.enable", null, session);
        cdp.call("Runtime.enable", null, session);
        cdp.call("Runtime.addBinding", Json.obj("name", BINDING), session);
        cdp.call("Page.addScriptToEvaluateOnNewDocument", Json.obj("source", script), session);
        // Cross-site frames inside Apple's page (if any) get their own targets: unblock those too.
        cdp.call("Target.setAutoAttach",
                Json.obj("autoAttach", true, "waitForDebuggerOnStart", true, "flatten", true), session);
        // The window may already show Apple's 404 for /orchard/ (it opened before Orchard could intercept): reload it.
        cdp.call("Page.navigate", Json.obj("url", APP_URL), session);
        Log.info("Apple Music engine loading inside the Orchard window");
        Thread.startVirtualThread(() -> {
            sleep(EMBED_TIMEOUT_MS);
            if (mode == Mode.EMBEDDED && !isReady() && !shuttingDown) {
                Log.warn("Apple Music did not start inside the Orchard window; using a separate window instead.");
                fallBackToWindow();
            }
        });
    }

    /** Adds the hidden Apple Music iframe to the Orchard page (idempotent; re-run whenever the page loads). */
    private void createFrame() {
        String js = """
                new Promise((resolve) => {
                  const go = () => {
                    if (!location.pathname.startsWith('/orchard')) return resolve('not the Orchard page');
                    if (document.getElementById('am-engine')) return resolve('exists');
                    const f = document.createElement('iframe');
                    f.id = 'am-engine';
                    f.title = 'Apple Music';
                    f.allow = 'autoplay; encrypted-media; fullscreen; clipboard-write; focus-without-user-activation; '
                      + 'publickey-credentials-get; identity-credentials-get; storage-access';
                    // No allow-top-navigation: Apple's page must not navigate the Orchard window away.
                    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups '
                      + 'allow-popups-to-escape-sandbox allow-modals allow-storage-access-by-user-activation');
                    f.src = '%s';
                    (document.getElementById('engine-host') || document.body).appendChild(f);
                    resolve('created');
                  };
                  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
                })""".formatted(ENGINE_URL);
        try {
            cdp.call("Runtime.evaluate", Json.obj("expression", js, "awaitPromise", true), appSession, 15);
        } catch (RuntimeException e) {
            Log.warn("Could not add the Apple Music frame: " + e.getMessage());
        }
    }

    private void setupNestedFrame(String session, String url) {
        try {
            cdp.call("Fetch.enable", Json.obj("patterns", APPLE_DOCS), session);
            cdp.call("Target.setAutoAttach",
                    Json.obj("autoAttach", true, "waitForDebuggerOnStart", true, "flatten", true), session);
            Log.debug("Attached to nested frame " + url);
        } catch (RuntimeException e) {
            Log.debug("Could not attach to nested frame " + url + ": " + e.getMessage());
        } finally {
            cdp.send("Runtime.runIfWaitingForDebugger", null, session);
        }
    }

    private void fallBackToWindow() {
        try {
            cdp.call("Runtime.evaluate", Json.obj("expression",
                    "document.getElementById('am-engine') && document.getElementById('am-engine').remove()"), appSession);
        } catch (RuntimeException ignored) {
            // app page may be gone
        }
        openEngineWindow();
    }

    // ------------------------------------------------------------------ request interception

    private void onRequestPaused(CdpClient.Event ev) {
        Map<String, Object> p = ev.params();
        String requestId = Json.str(p, "requestId");
        String session = ev.sessionId();
        Map<String, Object> request = Json.map(p.get("request"));
        String url = String.valueOf(Json.str(request, "url"));
        boolean responseStage = p.get("responseStatusCode") != null || p.get("responseErrorReason") != null;
        if (!responseStage) {
            if (url.startsWith(ORCHARD_PREFIX)) {
                Thread.startVirtualThread(() -> answerOrchardRequest(requestId, session, request, url));
            } else {
                cdp.send("Fetch.continueRequest", Json.obj("requestId", requestId), session);
            }
            return;
        }
        Object code = p.get("responseStatusCode");
        if (!(code instanceof Number n) || n.intValue() < 200 || n.intValue() >= 300) {
            cdp.send("Fetch.continueRequest", Json.obj("requestId", requestId), session); // redirect / error
            return;
        }
        unblockFraming(requestId, session, code, Json.list(p.get("responseHeaders")));
    }

    /** Serves https://music.apple.com/orchard/... from Orchard's own server (UI files and API). */
    private void answerOrchardRequest(String requestId, String session, Map<String, Object> request, String url) {
        try {
            String rest = url.substring(ORCHARD_PREFIX.length());
            if (rest.isEmpty() || rest.startsWith("?")) rest = "/" + rest;
            Map<String, Object> headers = Json.map(request.get("headers"));
            String method = String.valueOf(Json.str(request, "method"));
            String body = Json.str(request, "postData");
            if (rest.startsWith("/__host/")) {
                String path = rest.contains("?") ? rest.substring(0, rest.indexOf('?')) : rest;
                Map<String, Object> in = body == null || body.isBlank() ? new LinkedHashMap<>() : Json.parseObject(body);
                fulfill(requestId, session, 200, "application/json",
                        Json.write(hostLink.handle(path, in)).getBytes(StandardCharsets.UTF_8));
                return;
            }
            HostLink.Response r = hostLink.forward(method, rest, header(headers, "Content-Type"), body,
                    header(headers, "X-Orchard-Peer"));
            fulfill(requestId, session, r.status(), r.contentType(), r.body());
        } catch (WebServer.HttpError e) {
            fulfill(requestId, session, e.status, "application/json",
                    Json.write(Json.obj("error", e.getMessage())).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.warn("Could not answer " + url + ": " + e);
            fulfill(requestId, session, 502, "application/json",
                    Json.write(Json.obj("error", String.valueOf(e.getMessage()))).getBytes(StandardCharsets.UTF_8));
        }
    }

    private void fulfill(String requestId, String session, int status, String contentType, byte[] body) {
        cdp.send("Fetch.fulfillRequest", Json.obj(
                "requestId", requestId,
                "responseCode", status,
                "responseHeaders", List.of(
                        Json.obj("name", "Content-Type", "value", contentType),
                        Json.obj("name", "Cache-Control", "value", "no-store")),
                "body", Base64.getEncoder().encodeToString(body)), session);
    }

    private static String header(Map<String, Object> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, Object> e : headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase(name)) return String.valueOf(e.getValue());
        }
        return null;
    }

    /**
     * Re-serves an Apple document without X-Frame-Options / CSP frame-ancestors so it can live inside the Orchard
     * window. (Editing headers with continueResponse is not enough: Chrome checks framing against the original
     * headers, so the response is fulfilled from its body.)
     */
    private void unblockFraming(String requestId, String session, Object code, List<Object> responseHeaders) {
        List<Object> headers = new ArrayList<>();
        for (Object o : responseHeaders) {
            Map<String, Object> h = Json.map(o);
            String name = Json.str(h, "name");
            if (name == null) continue;
            String lower = name.toLowerCase(Locale.ROOT);
            // The body we re-serve is already decoded, so encoding/length headers no longer apply.
            if (lower.equals("x-frame-options") || lower.equals("content-encoding") || lower.equals("content-length")) {
                continue;
            }
            if (lower.equals("content-security-policy") || lower.equals("content-security-policy-report-only")) {
                String value = String.valueOf(Json.str(h, "value")).replaceAll("(?i)frame-ancestors[^;]*;?", "").trim();
                if (value.isEmpty()) continue;
                h = Json.obj("name", name, "value", value);
            }
            headers.add(h);
        }
        Thread.startVirtualThread(() -> {
            try {
                Map<String, Object> body = cdp.call("Fetch.getResponseBody", Json.obj("requestId", requestId), session);
                String text = Json.str(body, "body");
                String b64 = Boolean.TRUE.equals(body.get("base64Encoded")) ? text
                        : Base64.getEncoder().encodeToString(String.valueOf(text).getBytes(StandardCharsets.UTF_8));
                cdp.call("Fetch.fulfillRequest", Json.obj("requestId", requestId, "responseCode", code,
                        "responseHeaders", headers, "body", b64), session);
            } catch (RuntimeException e) {
                Log.warn("Could not load an Apple page inside the Orchard window: " + e.getMessage());
                cdp.send("Fetch.continueRequest", Json.obj("requestId", requestId), session);
            }
        });
    }

    // ------------------------------------------------------------------ window mode (fallback)

    private synchronized void openEngineWindow() {
        mode = Mode.WINDOW;
        mergeState(Json.obj("ready", false, "engineMode", "window", "message", "Starting Apple Music…"));
        Map<String, Object> created = cdp.call("Target.createTarget",
                Json.obj("url", "about:blank", "newWindow", true, "background", true), null);
        engineTargetId = Json.str(created, "targetId");
        setWindowState("minimized");
        Map<String, Object> attached = cdp.call("Target.attachToTarget",
                Json.obj("targetId", engineTargetId, "flatten", true), null);
        String session = Json.str(attached, "sessionId");
        cdp.call("Runtime.enable", null, session);
        cdp.call("Page.enable", null, session);
        cdp.call("Runtime.addBinding", Json.obj("name", BINDING), session);
        cdp.call("Page.addScriptToEvaluateOnNewDocument", Json.obj("source", script), session);
        engineSession = session;
        cdp.call("Page.navigate", Json.obj("url", ENGINE_URL), session);
        Log.info("Apple Music engine loading in a separate window");
    }

    private void setWindowState(String windowState) {
        String target = engineTargetId;
        if (target == null) return;
        try {
            Map<String, Object> w = cdp.call("Browser.getWindowForTarget", Json.obj("targetId", target), null);
            cdp.call("Browser.setWindowBounds",
                    Json.obj("windowId", w.get("windowId"), "bounds", Json.obj("windowState", windowState)), null);
            if ("normal".equals(windowState) && engineSession != null) {
                cdp.call("Page.bringToFront", null, engineSession);
            }
        } catch (RuntimeException e) {
            Log.debug("Could not set window state " + windowState + ": " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ events

    private void onCdpEvent(CdpClient.Event ev) {
        String sid = ev.sessionId();
        switch (ev.method()) {
            case "Fetch.requestPaused" -> onRequestPaused(ev);
            case "Runtime.bindingCalled" -> {
                if (BINDING.equals(Json.str(ev.params(), "name")) && sid != null && sid.equals(engineSession)) {
                    handleEmit(Json.str(ev.params(), "payload"));
                }
            }
            case "Runtime.consoleAPICalled" -> {
                if (sid != null && sid.equals(engineSession)) logConsole(ev.params());
            }
            case "Target.attachedToTarget" -> {
                if (sid == null) return;
                String child = Json.str(ev.params(), "sessionId");
                Map<String, Object> info = Json.map(ev.params().get("targetInfo"));
                String type = Json.str(info, "type");
                String url = Json.str(info, "url");
                // A cross-site frame inside the app window: unblock Apple pages in it; workers just resume.
                if ("iframe".equals(type)) Thread.startVirtualThread(() -> setupNestedFrame(child, url));
                else cdp.send("Runtime.runIfWaitingForDebugger", null, child);
            }
            case "Page.frameNavigated" -> {
                Map<String, Object> frame = Json.map(ev.params().get("frame"));
                if (sid != null && sid.equals(appSession) && frame != null && frame.get("parentId") == null) {
                    Log.info("Orchard window loaded " + Json.str(frame, "url"));
                    hostLink.pageGone();
                    if (mode == Mode.EMBEDDED) mergeState(Json.obj("ready", false, "message", "Starting Apple Music…"));
                }
            }
            case "Page.loadEventFired" -> {
                if (sid != null && sid.equals(appSession) && mode == Mode.EMBEDDED) {
                    Thread.startVirtualThread(this::createFrame);
                }
            }
            case "Target.targetDestroyed" -> {
                String id = Json.str(ev.params(), "targetId");
                if (shuttingDown || id == null) return;
                if (id.equals(appTargetId)) {
                    Log.info("App window closed.");
                    Thread.startVirtualThread(onAppClosed);
                } else if (id.equals(engineTargetId) && mode == Mode.WINDOW) {
                    Log.warn("Apple Music window was closed; reopening it.");
                    engineSession = null;
                    Thread.startVirtualThread(() -> {
                        sleep(500);
                        try {
                            openEngineWindow();
                        } catch (RuntimeException e) {
                            Log.warn("Could not reopen Apple Music: " + e.getMessage());
                        }
                    });
                }
            }
            case "Inspector.targetCrashed" -> {
                if (sid != null && sid.equals(engineSession)) {
                    Log.warn("Apple Music page crashed; reloading.");
                    mergeState(Json.obj("ready", false, "message", "Reloading Apple Music…"));
                    Thread.startVirtualThread(() -> cdp.send("Page.reload", null, engineSession));
                }
            }
            default -> { }
        }
    }

    private void logConsole(Map<String, Object> params) {
        StringBuilder sb = new StringBuilder();
        for (Object arg : Json.list(params.get("args"))) {
            Map<String, Object> a = Json.map(arg);
            Object v = a == null ? null : a.get("value");
            if (v != null) sb.append(sb.isEmpty() ? "" : " ").append(v);
        }
        String text = sb.toString();
        if (text.startsWith("[orchard]")) Log.info("engine: " + text.substring("[orchard]".length()).trim());
    }

    private void handleEmit(String payload) {
        Map<String, Object> msg;
        try {
            msg = Json.parseObject(payload);
        } catch (RuntimeException e) {
            Log.warn("Bad engine message: " + e.getMessage());
            return;
        }
        switch (String.valueOf(Json.str(msg, "type"))) {
            case "state" -> {
                Map<String, Object> s = Json.map(msg.get("state"));
                if (s == null) return;
                boolean wasAuthorized = Boolean.TRUE.equals(snapshot().get("authorized"));
                mergeState(s);
                if (Boolean.TRUE.equals(s.get("authorized")) && !wasAuthorized) {
                    Log.info("Signed in to Apple Music.");
                    if (signInRequested) {
                        signInRequested = false;
                        Thread.startVirtualThread(() -> showEngine(false));
                    }
                }
            }
            case "bye" -> mergeState(Json.obj("ready", false, "message", "Reloading Apple Music…"));
            case "ui" -> { // a shortcut pressed while Apple's page had focus
                if ("console".equals(Json.str(msg, "action"))) ConsoleWindow.toggle(); // Ctrl+Shift+T
                else showEngine(null); // Ctrl+Shift+A
            }
            case "boot" -> Log.debug("Engine script running on " + Json.str(msg, "url"));
            default -> { }
        }
    }

    // ------------------------------------------------------------------ helpers

    private void requireReady() {
        if (engineSession == null || !isReady()) {
            throw new EngineException(503, "Apple Music is still loading");
        }
    }

    private void findAppTarget() {
        Map<String, Object> r = cdp.call("Target.getTargets", null, null);
        String firstPage = null;
        for (Object o : Json.list(r.get("targetInfos"))) {
            Map<String, Object> t = Json.map(o);
            if (!"page".equals(Json.str(t, "type"))) continue;
            String url = String.valueOf(Json.str(t, "url"));
            if (firstPage == null) firstPage = Json.str(t, "targetId");
            for (String prefix : appUrlPrefixes) {
                if (url.startsWith(prefix)) {
                    appTargetId = Json.str(t, "targetId");
                    return;
                }
            }
        }
        // Apple may have redirected the window before Orchard attached; it's the only page anyway.
        if (firstPage != null && r.get("targetInfos") != null) appTargetId = firstPage;
    }

    private void mergeState(Map<String, Object> partial) {
        Map<String, Object> copy;
        synchronized (this) {
            state.putAll(partial);
            if (Boolean.TRUE.equals(partial.get("ready"))) state.remove("message");
            copy = new LinkedHashMap<>(state);
        }
        onState.accept(copy);
    }

    private Object invoke(String fn, Object... args) {
        // Embedded: Apple's page is the same-origin #am-engine iframe of the Orchard page. Window: it's the page.
        String target = mode == Mode.WINDOW ? "window"
                : "(document.getElementById('am-engine') || {}).contentWindow";
        StringBuilder call = new StringBuilder("w.__orchard.").append(fn).append('(');
        for (int i = 0; i < args.length; i++) {
            if (i > 0) call.append(',');
            call.append(Json.write(args[i]));
        }
        call.append(')');
        String js = "(() => { const w = " + target + "; if (!w || !w.__orchard) "
                + "return Promise.reject(new Error('Apple Music is still loading')); "
                + "return Promise.resolve(" + call + "); })()";
        Object value = evaluate(js);
        return value instanceof String s ? Json.parse(s) : value;
    }

    private Object evaluate(String expression) {
        String session = engineSession;
        if (session == null) throw new EngineException(503, "Apple Music is not running");
        Map<String, Object> r;
        try {
            r = cdp.call("Runtime.evaluate", Json.obj(
                    "expression", expression,
                    "awaitPromise", true,
                    "returnByValue", true,
                    "userGesture", true), session, 30);
        } catch (CdpClient.CdpException e) {
            throw new EngineException(503, e.getMessage());
        }
        Map<String, Object> exception = Json.map(r.get("exceptionDetails"));
        if (exception != null) {
            Map<String, Object> ex = Json.map(exception.get("exception"));
            String message = ex == null ? null : Json.str(ex, "description");
            if (message == null && ex != null) message = Json.str(ex, "value");
            if (message == null) message = Json.str(exception, "text");
            message = message == null ? "Unknown error" : message.lines().findFirst().orElse(message);
            throw new EngineException(500, message.replaceFirst("^(Uncaught )?(Error: )?", ""));
        }
        Map<String, Object> result = Json.map(r.get("result"));
        return result == null ? null : result.get("value");
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
