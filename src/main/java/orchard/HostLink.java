package orchard;

import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Stream;

/**
 * The Orchard app window's link to the hub. The window runs on https://music.apple.com/orchard/ (so Apple's player
 * inside it is same-site and sign-in works), which means it cannot open a plain-HTTP event stream to this
 * computer. Instead its events are pushed straight into the page over DevTools, and when it controls another
 * speaker, Orchard relays that speaker's event stream to it.
 */
final class HostLink {

    /** The app window as a hub client: sending = evaluating {@code __orchardPush(event, data)} in the page. */
    private final class HostClient extends Hub.Client {
        private volatile boolean closed;

        HostClient(String deviceId, String name, String kind) {
            super(deviceId, name, kind);
            local = true; // the Orchard window on this computer
        }

        @Override
        boolean send(String event, String json) {
            Consumer<String> p = pusher;
            if (closed || p == null) return false;
            p.accept("window.__orchardPush && window.__orchardPush(" + Json.write(event) + "," + json + ")");
            return true;
        }
    }

    private final Orchard app;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private volatile Consumer<String> pusher;
    private HostClient current;
    private Stream<String> relay;

    HostLink(Orchard app) {
        this.app = app;
    }

    /** How to run JavaScript in the app window (set by the engine once it is attached). */
    void setPusher(Consumer<String> pusher) {
        this.pusher = pusher;
    }

    /** Requests the app window makes to {@code /orchard/__host/...}. */
    synchronized Map<String, Object> handle(String path, Map<String, Object> body) {
        switch (path) {
            case "/__host/connect" -> {
                disconnect();
                current = new HostClient(str(body, "deviceId", "app"), str(body, "name", "App window"),
                        str(body, "kind", "app"));
                // Tell the page which speaker it ended up on: a remembered speaker may no longer be on the network.
                return Json.obj("ok", true, "remote", attach(Json.str(body, "speaker")));
            }
            case "/__host/speaker" -> {
                if (current != null) {
                    stopRelay();
                    app.hub().unregister(current);
                    return Json.obj("ok", true, "remote", attach(Json.str(body, "speaker")));
                }
            }
            case "/__host/console" -> {
                return Json.obj("ok", true, "console", ConsoleWindow.toggle());
            }
            default -> throw new WebServer.HttpError(404, "Not found");
        }
        return Json.obj("ok", true);
    }

    /** The app window navigated away or reloaded: its old client is gone. */
    synchronized void pageGone() {
        disconnect();
    }

    /** Maps a speaker address the app window asked for to a known speaker, or null. */
    String peerBase(String requested) {
        if (requested == null || requested.isBlank()) return null;
        Discovery.Peer p = app.linkedPeer(requested.replaceAll("/+$", "")); // only computers on this account
        return p == null ? null : p.url();
    }

    private void disconnect() {
        stopRelay();
        if (current != null) {
            current.closed = true;
            app.hub().unregister(current);
            current = null;
        }
    }

    /** Connects the current client to the requested speaker, or to this computer if that speaker isn't known. True = remote. */
    private boolean attach(String speaker) {
        String base = peerBase(speaker);
        if (base == null) {
            app.hub().register(current);
            return false;
        }
        startRelay(base, current);
        return true;
    }

    private void startRelay(String base, HostClient client) {
        String q = "deviceId=" + enc(client.deviceId) + "&name=" + enc(client.name) + "&kind=" + enc(client.kind);
        HttpRequest req = app.authorize(HttpRequest.newBuilder(URI.create(base + "/api/events?" + q))).GET().build();
        Thread.startVirtualThread(() -> {
            Stream<String> lines = null;
            try {
                HttpResponse<Stream<String>> resp = http.send(req, HttpResponse.BodyHandlers.ofLines());
                if (resp.statusCode() != 200) throw new IllegalStateException("HTTP " + resp.statusCode());
                lines = resp.body();
                synchronized (this) {
                    if (current != client) { lines.close(); return; }
                    relay = lines;
                }
                String event = null;
                StringBuilder data = new StringBuilder();
                for (String line : (Iterable<String>) lines::iterator) {
                    if (line.startsWith("event:")) event = line.substring(6).trim();
                    else if (line.startsWith("data:")) data.append(line.substring(5).trim());
                    else if (line.isEmpty()) {
                        if (event != null && !data.isEmpty()) relayEvent(client, event, data.toString());
                        event = null;
                        data.setLength(0);
                    }
                }
            } catch (Exception e) {
                Log.debug("Speaker relay ended: " + e.getMessage());
            }
            synchronized (this) {
                if (current == client && relay == lines) {
                    Log.warn("Lost the connection to the speaker at " + base);
                    relay = null;
                    client.send("relay-lost", "{}");
                }
            }
        });
    }

    /**
     * Passes one event from the other speaker on to the app window. Its data ends up inside JavaScript evaluated in
     * the app window (which runs as music.apple.com), so it is never passed on as raw text: it must parse as JSON
     * and is written out again by our own JSON writer. Anything else on that network could pose as a speaker.
     */
    private static void relayEvent(HostClient client, String event, String data) {
        if (!event.matches("[a-z][a-z-]{0,31}") || data.length() > 4_000_000) return;
        Object parsed;
        try {
            parsed = Json.parse(data);
        } catch (RuntimeException e) {
            Log.debug("Ignoring a malformed '" + event + "' event from the other speaker");
            return;
        }
        client.send(event, Json.write(parsed));
    }

    private void stopRelay() {
        Stream<String> r = relay;
        relay = null;
        if (r != null) {
            try {
                r.close();
            } catch (RuntimeException ignored) {
                // already closed
            }
        }
    }

    // ------------------------------------------------------------------ proxying the app window's HTTP requests

    record Response(int status, String contentType, byte[] body) {}

    /** Performs an app-window request against this computer's server (or a known speaker, for peer commands). */
    Response forward(String method, String pathAndQuery, String contentType, String body, String peer) throws Exception {
        // Must be a path: "/orchard@evil.com/x" would otherwise become http://127.0.0.1:8787@evil.com/x (host evil.com).
        if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//") || pathAndQuery.contains("\\")) {
            return new Response(400, "application/json", "{\"error\":\"Bad path\"}".getBytes(StandardCharsets.UTF_8));
        }
        String base = "http://127.0.0.1:" + app.port();
        if (peer != null && !peer.isBlank()) {
            base = peerBase(peer);
            if (base == null) return new Response(400, "application/json", "{\"error\":\"Unknown speaker\"}".getBytes(StandardCharsets.UTF_8));
        }
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + pathAndQuery)).timeout(Duration.ofSeconds(60));
        if (peer != null && !peer.isBlank()) app.authorize(b); // the other computer wants our key
        if (contentType != null) b.header("Content-Type", contentType);
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        HttpResponse<InputStream> r = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        byte[] bytes;
        try (InputStream in = r.body()) {
            bytes = in.readAllBytes();
        }
        return new Response(r.statusCode(), r.headers().firstValue("Content-Type").orElse("application/octet-stream"), bytes);
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String str(Map<String, Object> m, String k, String def) {
        String v = Json.str(m, k);
        return v == null || v.isBlank() ? def : (v.length() > 64 ? v.substring(0, 64) : v);
    }
}
