package orchard;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Chrome DevTools Protocol client over a single browser-level WebSocket, using flattened target sessions.
 */
final class CdpClient implements WebSocket.Listener {

    record Event(String method, Map<String, Object> params, String sessionId) {}

    static final class CdpException extends RuntimeException {
        CdpException(String message) {
            super(message);
        }
    }

    private final AtomicInteger nextId = new AtomicInteger(1);
    private final Map<Integer, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();
    private final List<Consumer<Event>> listeners = new CopyOnWriteArrayList<>();
    private final ExecutorService eventThread = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "cdp-events");
        t.setDaemon(true);
        return t;
    });
    private final StringBuilder partial = new StringBuilder();
    private final Object sendLock = new Object();
    private final CompletableFuture<String> closed = new CompletableFuture<>();
    private volatile WebSocket ws;

    private CdpClient() {}

    static CdpClient connect(String wsUrl) {
        CdpClient client = new CdpClient();
        client.ws = HttpClient.newHttpClient()
                .newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .buildAsync(URI.create(wsUrl), client)
                .join();
        return client;
    }

    /** Registers a listener for protocol events; listeners run sequentially on a dedicated thread. */
    void onEvent(Consumer<Event> listener) {
        listeners.add(listener);
    }

    /** Completes with a reason when the browser connection goes away. */
    CompletableFuture<String> closedFuture() {
        return closed;
    }

    CompletableFuture<Map<String, Object>> send(String method, Map<String, Object> params, String sessionId) {
        int id = nextId.getAndIncrement();
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        if (closed.isDone()) {
            future.completeExceptionally(new CdpException("Browser connection is closed"));
            return future;
        }
        pending.put(id, future);
        Map<String, Object> msg = Json.obj("id", id, "method", method, "params", params == null ? Map.of() : params);
        if (sessionId != null) msg.put("sessionId", sessionId);
        String text = Json.write(msg);
        try {
            synchronized (sendLock) {
                ws.sendText(text, true).join();
            }
        } catch (RuntimeException e) {
            pending.remove(id);
            future.completeExceptionally(new CdpException("Failed to send " + method + ": " + e.getMessage()));
        }
        return future;
    }

    /** Sends a command and blocks for its result. */
    Map<String, Object> call(String method, Map<String, Object> params, String sessionId) {
        return call(method, params, sessionId, 60);
    }

    Map<String, Object> call(String method, Map<String, Object> params, String sessionId, int timeoutSeconds) {
        CompletableFuture<Map<String, Object>> f = send(method, params, sessionId);
        try {
            return f.get(timeoutSeconds, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException re) throw re;
            throw new CdpException(String.valueOf(cause));
        } catch (TimeoutException e) {
            f.cancel(false);
            throw new CdpException("Timed out waiting for " + method);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CdpException("Interrupted");
        }
    }

    void close() {
        try {
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye");
        } catch (RuntimeException ignored) {
            // already gone
        }
    }

    // ------------------------------------------------------------------ WebSocket.Listener

    @Override
    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        partial.append(data);
        if (last) {
            String message = partial.toString();
            partial.setLength(0);
            dispatch(message);
        }
        webSocket.request(1);
        return null;
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        shutdown("closed (" + statusCode + ")");
        return null;
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        shutdown("error: " + error.getMessage());
    }

    private void shutdown(String reason) {
        if (closed.complete(reason)) {
            CdpException ex = new CdpException("Browser connection " + reason);
            pending.values().forEach(f -> f.completeExceptionally(ex));
            pending.clear();
            eventThread.shutdown();
        }
    }

    private void dispatch(String text) {
        Map<String, Object> msg;
        try {
            msg = Json.parseObject(text);
        } catch (RuntimeException e) {
            Log.warn("Unparseable DevTools message: " + e.getMessage());
            return;
        }
        if (msg.get("id") instanceof Number n) {
            CompletableFuture<Map<String, Object>> f = pending.remove(n.intValue());
            if (f == null) return;
            Map<String, Object> error = Json.map(msg.get("error"));
            if (error != null) {
                f.completeExceptionally(new CdpException(Json.str(error, "message")));
            } else {
                Map<String, Object> result = Json.map(msg.get("result"));
                f.complete(result == null ? new LinkedHashMap<>() : result);
            }
        } else if (msg.get("method") instanceof String method) {
            Map<String, Object> params = Json.map(msg.get("params"));
            Event ev = new Event(method, params == null ? Map.of() : params, Json.str(msg, "sessionId"));
            try {
                eventThread.execute(() -> {
                    for (Consumer<Event> l : listeners) {
                        try {
                            l.accept(ev);
                        } catch (RuntimeException e) {
                            Log.warn("DevTools event handler failed for " + method + ": " + e);
                        }
                    }
                });
            } catch (RuntimeException ignored) {
                // executor shut down during close
            }
        }
    }
}
