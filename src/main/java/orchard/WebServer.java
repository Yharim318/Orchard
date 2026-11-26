package orchard;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/** HTTP front door: the web UI, the Apple Music API proxy, player commands and the live event stream. */
final class WebServer {

    static final class HttpError extends RuntimeException {
        final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private record Cached(long expires, int status, String body) {}

    private static final Map<String, String> TYPES = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("ico", "image/x-icon"),
            Map.entry("json", "application/json"),
            Map.entry("webmanifest", "application/manifest+json"));
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private static final long CATALOG_TTL_MS = 10 * 60_000;
    private static final int MAX_BODY = 1 << 20;

    private final Orchard app;
    private final ArtworkStore artwork;
    private final HttpServer server;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();

    WebServer(Orchard app, String bindAddress, int port, Path dataDir) throws IOException {
        this.app = app;
        this.artwork = new ArtworkStore(dataDir);
        server = HttpServer.create(new InetSocketAddress(bindAddress, port), 64);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", this::handle);
    }

    void start() {
        server.start();
    }

    // ------------------------------------------------------------------ dispatch

    private void handle(HttpExchange ex) {
        try {
            String method = ex.getRequestMethod().toUpperCase(Locale.ROOT);
            String path = ex.getRequestURI().getPath();
            if (!hostAllowed(ex.getRequestHeaders().getFirst("Host"))) throw new HttpError(403, "Host not allowed");
            String origin = ex.getRequestHeaders().getFirst("Origin");
            if (origin != null) {
                if (!originAllowed(origin, ex.getRequestHeaders().getFirst("Host"))) {
                    throw new HttpError(403, "Origin not allowed");
                }
                ex.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
                ex.getResponseHeaders().set("Vary", "Origin");
            }
            if (method.equals("OPTIONS")) {
                Headers h = ex.getResponseHeaders();
                h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                h.set("Access-Control-Allow-Headers", "Content-Type");
                h.set("Access-Control-Max-Age", "600");
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (path.startsWith("/api/")) api(ex, method, path);
            else staticFile(ex, path);
        } catch (HttpError e) {
            sendJson(ex, e.status, Json.obj("error", e.getMessage()));
        } catch (Engine.EngineException e) {
            sendJson(ex, e.status, Json.obj("error", e.getMessage()));
        } catch (Exception e) {
            Log.warn("Request failed " + ex.getRequestURI() + ": " + e);
            sendJson(ex, 500, Json.obj("error", String.valueOf(e.getMessage())));
        } finally {
            ex.close();
        }
    }

    private void api(HttpExchange ex, String method, String path) throws Exception {
        Map<String, String> q = query(ex.getRequestURI());
        if (method.equals("GET") && path.startsWith("/api/artwork/")) {
            artworkImage(ex, path.substring("/api/artwork/".length()));
            return;
        }
        switch (method + " " + path) {
            case "GET /api/info" -> sendJson(ex, 200, app.info());
            case "GET /api/state" -> sendJson(ex, 200, app.state());
            case "GET /api/speakers" -> sendJson(ex, 200, app.speakers());
            case "GET /api/events" -> events(ex, q);
            case "POST /api/cmd" -> sendJson(ex, 200, app.engine().command(body(ex)));
            case "GET /api/queue" -> sendJson(ex, 200, app.engine().queueItems(
                    intQuery(q, "start", 0), intQuery(q, "count", 200)));
            case "GET /api/am" -> appleGet(ex, q.get("path"));
            case "POST /api/am" -> appleWrite(ex, body(ex));
            case "GET /api/artwork" -> sendJson(ex, 200, Json.obj("items", artwork.list()));
            case "POST /api/artwork" -> artworkWrite(ex, body(ex));
            case "POST /api/signin" -> {
                app.engine().signIn();
                sendJson(ex, 200, Json.obj("ok", true));
            }
            case "POST /api/signout" -> {
                app.engine().signOut();
                cache.clear();
                sendJson(ex, 200, Json.obj("ok", true));
            }
            case "POST /api/engine-window" -> {
                app.engine().showEngine(null);
                sendJson(ex, 200, Json.obj("ok", true));
            }
            case "POST /api/transfer" -> transfer(ex, body(ex));
            default -> throw new HttpError(404, "Not found");
        }
    }

    // ------------------------------------------------------------------ endpoints

    private void events(HttpExchange ex, Map<String, String> q) throws IOException, InterruptedException {
        String deviceId = limit(q.getOrDefault("deviceId", "unknown"), 64);
        String name = limit(q.getOrDefault("name", "Browser"), 60);
        String kind = limit(q.getOrDefault("kind", "browser"), 20);
        Headers h = ex.getResponseHeaders();
        h.set("Content-Type", "text/event-stream; charset=utf-8");
        h.set("Cache-Control", "no-cache");
        h.set("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0);
        try (OutputStream out = ex.getResponseBody()) {
            out.write("retry: 2000\n\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            app.hub().serve(new Hub.SseClient(deviceId, name, kind, out));
        }
    }

    private void appleGet(HttpExchange ex, String path) throws IOException {
        validateApplePath(path);
        boolean cacheable = path.startsWith("/v1/catalog/");
        if (cacheable) {
            Cached c = cache.get(path);
            if (c != null && c.expires() > System.currentTimeMillis()) {
                send(ex, c.status(), "application/json; charset=utf-8", c.body());
                return;
            }
        }
        Map<String, Object> r = app.engine().api("GET", path, null);
        int status = r.get("status") instanceof Number n ? n.intValue() : 502;
        String body = Json.str(r, "body");
        if (body == null || body.isEmpty()) body = "{}";
        if (cacheable && status == 200) {
            if (cache.size() > 400) cache.clear();
            cache.put(path, new Cached(System.currentTimeMillis() + CATALOG_TTL_MS, status, body));
        }
        send(ex, status, "application/json; charset=utf-8", body);
    }

    private void appleWrite(HttpExchange ex, Map<String, Object> req) throws IOException {
        String method = String.valueOf(req.get("method")).toUpperCase(Locale.ROOT);
        String path = Json.str(req, "path");
        if (!WRITE_METHODS.contains(method)) throw new HttpError(400, "Unsupported method");
        validateApplePath(path);
        Map<String, Object> r = app.engine().api(method, path, req.get("body"));
        int status = r.get("status") instanceof Number n ? n.intValue() : 502;
        String body = Json.str(r, "body");
        // Edits and deletes usually answer "204 No Content", which must not carry a body.
        if (status == 204) body = "";
        else if (body == null || body.isEmpty()) body = "{}";
        send(ex, status, "application/json; charset=utf-8", body);
    }

    /** Custom playlist artwork (see {@link ArtworkStore}). URLs carry ?v=version, so they can be cached for long. */
    private void artworkImage(HttpExchange ex, String id) throws IOException {
        ArtworkStore.Image img = artwork.get(id);
        if (img == null) throw new HttpError(404, "No custom artwork");
        ex.getResponseHeaders().set("Content-Type", img.contentType());
        ex.getResponseHeaders().set("Cache-Control", "public, max-age=31536000, immutable");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.sendResponseHeaders(200, img.bytes().length);
        ex.getResponseBody().write(img.bytes());
    }

    private void artworkWrite(HttpExchange ex, Map<String, Object> req) throws IOException {
        String op = Json.str(req, "op");
        String id = Json.str(req, "id");
        if ("delete".equals(op)) {
            artwork.delete(id);
            sendJson(ex, 200, Json.obj("ok", true));
        } else if ("put".equals(op)) {
            Long version = artwork.put(id, Json.str(req, "upload"), intArg(req, "part"), intArg(req, "parts"), Json.str(req, "data"));
            sendJson(ex, 200, version == null ? Json.obj("ok", true) : Json.obj("ok", true, "version", version));
        } else {
            throw new HttpError(400, "Unknown artwork operation");
        }
    }

    private static int intQuery(Map<String, String> q, String key, int def) {
        try {
            String v = q.get(key);
            return v == null ? def : Math.max(0, Integer.parseInt(v.trim()));
        } catch (NumberFormatException e) {
            throw new HttpError(400, "Invalid " + key);
        }
    }

    private static int intArg(Map<String, Object> m, String key) {
        return m.get(key) instanceof Number n ? n.intValue() : -1;
    }

    private static void validateApplePath(String path) {
        if (path == null || !path.startsWith("/v1/") || path.length() > 4000
                || path.contains("..") || path.chars().anyMatch(c -> c < 0x20)) {
            throw new HttpError(400, "Invalid Apple Music API path");
        }
    }

    /** Hands playback to another Orchard speaker on the network, then pauses here. */
    private void transfer(HttpExchange ex, Map<String, Object> req) throws Exception {
        String to = Json.str(req, "to");
        Discovery.Peer peer = to == null ? null : app.discovery().peerByUrl(to);
        if (peer == null) throw new HttpError(400, "Unknown speaker");
        Map<String, Object> load = app.engine().exportQueue();
        load.put("type", "load");
        HttpRequest request = HttpRequest.newBuilder(URI.create(peer.url() + "/api/cmd"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(Json.write(load)))
                .build();
        HttpResponse<String> resp = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            String msg = "The other speaker could not start playback";
            try {
                msg = Json.str(Json.parseObject(resp.body()), "error");
            } catch (RuntimeException ignored) {
                // keep generic message
            }
            throw new HttpError(502, msg);
        }
        try {
            app.engine().command(Json.obj("type", "pause"));
        } catch (RuntimeException e) {
            Log.warn("Transferred playback but could not pause locally: " + e.getMessage());
        }
        sendJson(ex, 200, Json.obj("ok", true, "speaker", Json.obj("id", peer.id(), "name", peer.name(), "url", peer.url())));
    }

    private void staticFile(HttpExchange ex, String path) throws IOException {
        if (path.contains("..")) throw new HttpError(400, "Bad path");
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        InputStream in = WebServer.class.getResourceAsStream("/web" + path);
        if (in == null && !path.substring(path.lastIndexOf('/') + 1).contains(".")) {
            path = "/index.html";
            in = WebServer.class.getResourceAsStream("/web/index.html");
        }
        if (in == null) throw new HttpError(404, "Not found");
        byte[] bytes;
        try (InputStream stream = in) {
            bytes = stream.readAllBytes();
        }
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        ex.getResponseHeaders().set("Content-Type", TYPES.getOrDefault(ext, "application/octet-stream"));
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.sendResponseHeaders(200, bytes.length);
        ex.getResponseBody().write(bytes);
    }

    // ------------------------------------------------------------------ security

    /** Blocks DNS-rebinding: only accept requests addressed to an IP, localhost, our hostname or *.local. */
    private boolean hostAllowed(String hostHeader) {
        if (hostHeader == null) return true;
        String host = stripPort(hostHeader).toLowerCase(Locale.ROOT);
        return host.equals("localhost") || Net.isIpLiteral(host) || host.endsWith(".local")
                || host.endsWith(".ts.net") || host.equalsIgnoreCase(app.hostname());
    }

    /** Only our own UI (any of our addresses) and other Orchard speakers may call the API from a browser. */
    private boolean originAllowed(String origin, String hostHeader) {
        try {
            URI u = URI.create(origin);
            if (!"http".equals(u.getScheme()) || u.getHost() == null) return false;
            String host = u.getHost().toLowerCase(Locale.ROOT);
            int port = u.getPort() == -1 ? 80 : u.getPort();
            // Same-origin requests (the page this server served, under whatever address the device used).
            // The Host header itself already passed the DNS-rebinding check.
            if (hostHeader != null && (host + ":" + port).equalsIgnoreCase(hostHeader.contains(":")
                    ? hostHeader : hostHeader + ":80")) {
                return true;
            }
            if (port == app.port() && (host.equals("localhost") || host.equals("127.0.0.1")
                    || host.equals("[::1]") || host.equalsIgnoreCase(app.hostname())
                    || host.equalsIgnoreCase(app.hostname() + ".local")
                    || app.lanAddresses().contains(host))) {
                return true;
            }
            String normalized = "http://" + u.getHost() + ":" + port;
            return app.discovery().peerByUrl(normalized) != null;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static String stripPort(String host) {
        if (host.startsWith("[")) {
            int end = host.indexOf(']');
            return end > 0 ? host.substring(0, end + 1) : host;
        }
        int colon = host.lastIndexOf(':');
        return colon > 0 ? host.substring(0, colon) : host;
    }

    // ------------------------------------------------------------------ helpers

    private static Map<String, Object> body(HttpExchange ex) throws IOException {
        byte[] bytes = ex.getRequestBody().readNBytes(MAX_BODY + 1);
        if (bytes.length > MAX_BODY) throw new HttpError(413, "Request too large");
        String text = new String(bytes, StandardCharsets.UTF_8);
        if (text.isBlank()) return new LinkedHashMap<>();
        try {
            return Json.parseObject(text);
        } catch (IllegalArgumentException e) {
            throw new HttpError(400, "Invalid JSON: " + e.getMessage());
        }
    }

    private static Map<String, String> query(URI uri) {
        Map<String, String> out = new LinkedHashMap<>();
        String raw = uri.getRawQuery();
        if (raw == null) return out;
        for (String part : raw.split("&")) {
            int eq = part.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
            out.put(k, v);
        }
        return out;
    }

    private static String limit(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static void sendJson(HttpExchange ex, int status, Object body) {
        send(ex, status, "application/json; charset=utf-8", Json.write(body));
    }

    private static void send(HttpExchange ex, int status, String type, String body) {
        try {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", type);
            ex.getResponseHeaders().set("Cache-Control", "no-store");
            ex.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
            if (bytes.length > 0) ex.getResponseBody().write(bytes);
        } catch (IOException e) {
            Log.debug("Client went away: " + e.getMessage());
        }
    }
}
