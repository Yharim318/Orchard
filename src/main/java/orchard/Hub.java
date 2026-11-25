package orchard;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * The "Connect" hub: every open Orchard UI (the desktop app window, phones, other laptops) is a client here and
 * receives live player state, the list of connected devices and the list of speakers on the network.
 * Phones and other browsers use Server-Sent Events; the app window gets events pushed in over DevTools.
 */
final class Hub {

    abstract static class Client {
        final String deviceId;
        final String name;
        final String kind;
        final long since = System.currentTimeMillis();

        Client(String deviceId, String name, String kind) {
            this.deviceId = deviceId;
            this.name = name;
            this.kind = kind;
        }

        /** Delivers one event; false if the client is gone. */
        abstract boolean send(String event, String json);

        void ping() {
            // only streaming clients need keep-alives
        }
    }

    /** A browser holding an open Server-Sent-Events stream. */
    static final class SseClient extends Client {
        private final OutputStream out;
        private final CountDownLatch done = new CountDownLatch(1);

        SseClient(String deviceId, String name, String kind, OutputStream out) {
            super(deviceId, name, kind);
            this.out = out;
        }

        private synchronized boolean write(String text) {
            if (done.getCount() == 0) return false;
            try {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.flush();
                return true;
            } catch (IOException e) {
                done.countDown();
                return false;
            }
        }

        @Override
        boolean send(String event, String json) {
            return write("event: " + event + "\ndata: " + json + "\n\n");
        }

        @Override
        void ping() {
            write(": ping\n\n");
        }
    }

    private final List<Client> clients = new CopyOnWriteArrayList<>();
    private final Supplier<Map<String, Object>> hello;
    private final Supplier<Map<String, Object>> state;
    private final Supplier<List<Map<String, Object>>> speakers;
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "sse-heartbeat");
        t.setDaemon(true);
        return t;
    });

    Hub(Supplier<Map<String, Object>> hello, Supplier<Map<String, Object>> state,
            Supplier<List<Map<String, Object>>> speakers) {
        this.hello = hello;
        this.state = state;
        this.speakers = speakers;
        heartbeat.scheduleAtFixedRate(() -> clients.forEach(Client::ping), 15, 15, TimeUnit.SECONDS);
    }

    /** Adds a client and sends it the current picture. */
    void register(Client c) {
        clients.add(c);
        Log.info("Device connected: " + c.name + " (" + c.kind + ")");
        c.send("hello", Json.write(hello.get()));
        c.send("state", Json.write(state.get()));
        c.send("speakers", Json.write(speakers.get()));
        broadcast("devices", devices());
    }

    void unregister(Client c) {
        if (clients.remove(c)) {
            Log.info("Device disconnected: " + c.name);
            broadcast("devices", devices());
        }
    }

    /** Serves one SSE connection until the client goes away. Blocks the calling (virtual) thread. */
    void serve(SseClient c) throws InterruptedException {
        register(c);
        c.done.await();
        unregister(c);
    }

    void broadcast(String event, Object data) {
        String json = Json.write(data);
        for (Client c : clients) {
            if (!c.send(event, json) && !(c instanceof SseClient)) unregister(c);
        }
    }

    List<Map<String, Object>> devices() {
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Client c : clients) {
            byId.putIfAbsent(c.deviceId, Json.obj("id", c.deviceId, "name", c.name, "kind", c.kind, "since", c.since));
        }
        return new ArrayList<>(byId.values());
    }
}
