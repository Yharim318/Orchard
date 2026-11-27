package orchard;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Proves that another Orchard computer is signed in to the same Apple Music account, then shares keys with it
 * (see {@link Access}). A name on the network proves nothing, so Apple's servers are the witness: only someone
 * signed in to this account can add a playlist to its library.
 *
 * <ol>
 *   <li>The initiator (I) and responder (R) exchange X25519 public keys ({@code /api/link/start}). Both derive the
 *       same secret K, bound to both computer ids and both public keys.</li>
 *   <li>I adds a private playlist named "Orchard pairing &lt;HMAC(K, I)&gt;" to its library and tells R
 *       ({@code /api/link/proved}). R looks for that name in <em>its</em> library. Only a computer on the same
 *       account can have put it there, and only a computer holding K can know the name, so someone relaying the
 *       messages in between (with a different K on each side) can't pass.</li>
 *   <li>Satisfied, R adds its own "Orchard pairing &lt;HMAC(K, R)&gt;"; I looks for it in its library.</li>
 *   <li>Both sides now trust each other and swap their keyrings, encrypted with K (AES-GCM)
 *       ({@code /api/link/finish}). Each deletes its own pairing playlist.</li>
 * </ol>
 * The playlists exist for a few seconds (up to a minute or two if Apple's library sync is slow). A computer is
 * linked once; links are re-proved only after one side signs out of Apple Music (which resets its keys).
 */
final class AccountLink {

    /** The signed-in Apple Music library (production: through Apple's page; tests: a fake). */
    interface Library {
        String create(String name, String description) throws Exception;

        boolean has(String name) throws Exception;

        void delete(String id) throws Exception;
    }

    /** POSTs JSON to another computer's /api/link/... and returns its JSON answer (or throws with its error). */
    interface Transport {
        Map<String, Object> post(String baseUrl, String path, Map<String, Object> body, Duration timeout) throws Exception;
    }

    record Peer(String id, String name, String url) {}

    private static final String CONTEXT = "orchard-link-v1";
    private static final String DESCRIPTION = "Orchard created this to confirm that another computer uses your Apple "
            + "Music account. It deletes itself within a minute or two.";
    /** How long to wait for a pairing playlist to show up (Apple's library sync); shorter in tests. */
    static volatile Duration searchFor = Duration.ofSeconds(90);
    static volatile long pollMs = 3000;
    private static final long SESSION_MS = 4 * 60_000;
    private static final long RETRY_MS = 10 * 60_000;
    private static final int MAX_SESSIONS = 4;

    private final String selfId;
    private final String selfName;
    private final Access access;
    private final Library library;
    private final BooleanSupplier signedIn;
    private final Transport transport;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Set<String> linking = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> lastTry = new ConcurrentHashMap<>();
    private final Map<String, Long> firstSeen = new ConcurrentHashMap<>();
    private final Map<String, Long> lastCheck = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "account-link");
        t.setDaemon(true);
        return t;
    });

    /** Responder side of one link attempt. */
    private static final class Session {
        final String peerId;
        final String peerName;
        final byte[] k;
        final long created = System.currentTimeMillis();
        volatile boolean checking;
        volatile boolean peerProved;
        volatile String ownPlaylist;

        Session(String peerId, String peerName, byte[] k) {
            this.peerId = peerId;
            this.peerName = peerName;
            this.k = k;
        }
    }

    AccountLink(String selfId, String selfName, Access access, Library library, BooleanSupplier signedIn,
            Transport transport) {
        this.selfId = selfId;
        this.selfName = selfName;
        this.access = access;
        this.library = library;
        this.signedIn = signedIn;
        this.transport = transport;
    }

    /**
     * Keeps linking: every few seconds, every computer heard on the network that isn't linked yet gets a link
     * attempt (at most one per 10 minutes each); linked ones are re-checked every few minutes.
     * {@code checkStillLinked} answers whether that computer still accepts our key.
     */
    void start(Supplier<List<Peer>> peers, java.util.function.Predicate<Peer> checkStillLinked) {
        timer.scheduleWithFixedDelay(() -> {
            try {
                tick(peers.get(), checkStillLinked);
            } catch (RuntimeException e) {
                Log.debug("Link check failed: " + e);
            }
        }, 3, 5, TimeUnit.SECONDS);
    }

    private void tick(List<Peer> peers, java.util.function.Predicate<Peer> checkStillLinked) {
        long now = System.currentTimeMillis();
        sweep();
        Set<String> present = ConcurrentHashMap.newKeySet();
        for (Peer p : peers) {
            present.add(p.id());
            firstSeen.putIfAbsent(p.id(), now);
            if (access.isLinked(p.id())) {
                if (now - lastCheck.getOrDefault(p.id(), 0L) > 2 * 60_000) {
                    lastCheck.put(p.id(), now);
                    Thread.startVirtualThread(() -> {
                        if (!checkStillLinked.test(p)) {
                            Log.info(p.name() + " no longer accepts this computer (signed out of Apple Music?); "
                                    + "checking the account again.");
                            access.unlink(p.id());
                        }
                    });
                }
                continue;
            }
            if (!signedIn.getAsBoolean() || linking.contains(p.id())) continue;
            if (now - lastTry.getOrDefault(p.id(), 0L) < RETRY_MS) continue;
            // One side starts (the lower id), so two computers don't both add playlists at once; the other side
            // starts too if nothing has happened after a while (e.g. the lower one isn't signed in).
            boolean first = selfId.compareTo(p.id()) < 0;
            if (!first && now - firstSeen.get(p.id()) < 45_000) continue;
            if (!first && sessions.values().stream().anyMatch(s -> s.peerId.equals(p.id()))) continue;
            lastTry.put(p.id(), now);
            Thread.startVirtualThread(() -> link(p));
        }
        firstSeen.keySet().retainAll(present);
    }

    // ------------------------------------------------------------------ initiator

    /** Runs one link attempt with another computer. True if it ended linked. */
    boolean link(Peer peer) {
        if (!linking.add(peer.id())) return false;
        String ownPlaylist = null;
        try {
            if (peer.id().equals(selfId) || !Access.validDeviceId(peer.id())) return false;
            Log.info("Checking whether " + peer.name() + " uses this Apple Music account…");
            KeyPair mine = keyPair();
            String myPub = b64(mine.getPublic().getEncoded());
            Map<String, Object> r = transport.post(peer.url(), "/api/link/start",
                    Json.obj("id", selfId, "name", selfName, "pub", myPub), Duration.ofSeconds(15));
            if (!peer.id().equals(Json.str(r, "id"))) throw new IllegalStateException("it answered as another computer");
            String sid = Json.str(r, "sid");
            String theirPub = Json.str(r, "pub");
            byte[] k = deriveK(mine, theirPub, selfId, peer.id(), myPub, theirPub);

            ownPlaylist = library.create(playlistName(k, selfId), DESCRIPTION);
            Map<String, Object> proved = transport.post(peer.url(), "/api/link/proved", Json.obj("sid", sid),
                    searchFor.plusSeconds(30));
            if (!Boolean.TRUE.equals(proved.get("ok"))) {
                throw new IllegalStateException(String.valueOf(Json.str(proved, "error")));
            }
            deleteQuietly(ownPlaylist);
            ownPlaylist = null;
            if (!find(playlistName(k, peer.id()))) {
                throw new IllegalStateException("its pairing playlist never showed up in this library, so it isn't "
                        + "signed in to the same Apple Music account");
            }
            Map<String, Object> done = transport.post(peer.url(), "/api/link/finish",
                    Json.obj("sid", sid, "box", seal(k, Json.obj("keys", access.exportKeys()))), Duration.ofSeconds(30));
            Map<String, Object> theirs = Json.parseObject(open(k, Json.str(done, "box")));
            access.merge(Json.list(theirs.get("keys")));
            access.markLinked(peer.id());
            lastCheck.put(peer.id(), System.currentTimeMillis());
            Log.info("Linked with " + peer.name() + ": it uses the same Apple Music account.");
            return true;
        } catch (Exception e) {
            Log.info("Not linked with " + peer.name() + ": " + message(e) + ". Trying again in 10 minutes.");
            return false;
        } finally {
            if (ownPlaylist != null) deleteQuietly(ownPlaylist);
            linking.remove(peer.id());
        }
    }

    // ------------------------------------------------------------------ responder

    /** {@code /api/link/...} requests from another computer (no key needed: this is how it gets one). */
    Map<String, Object> handle(String path, Map<String, Object> body) throws Exception {
        sweep();
        return switch (path) {
            case "/api/link/start" -> start(body);
            case "/api/link/proved" -> proved(body);
            case "/api/link/finish" -> finish(body);
            default -> throw new WebServer.HttpError(404, "Not found");
        };
    }

    private Map<String, Object> start(Map<String, Object> body) throws Exception {
        if (!signedIn.getAsBoolean()) throw new WebServer.HttpError(409, "this computer isn't signed in to Apple Music");
        String peerId = Json.str(body, "id");
        String theirPub = Json.str(body, "pub");
        if (!Access.validDeviceId(peerId) || peerId.equals(selfId) || theirPub == null || theirPub.length() > 200) {
            throw new WebServer.HttpError(400, "Bad link request");
        }
        if (sessions.size() >= MAX_SESSIONS) throw new WebServer.HttpError(429, "Busy linking; try again shortly");
        String peerName = clean(Json.str(body, "name"));
        KeyPair mine = keyPair();
        String myPub = b64(mine.getPublic().getEncoded());
        byte[] k = deriveK(mine, theirPub, peerId, selfId, theirPub, myPub);
        String sid = b64(bytes(18));
        sessions.put(sid, new Session(peerId, peerName, k));
        return Json.obj("sid", sid, "id", selfId, "pub", myPub);
    }

    private Map<String, Object> proved(Map<String, Object> body) throws Exception {
        Session s = session(body);
        synchronized (s) {
            if (s.checking || s.peerProved) throw new WebServer.HttpError(409, "Already checked");
            s.checking = true;
        }
        try {
            if (!find(playlistName(s.k, s.peerId))) {
                sessions.values().remove(s);
                Log.info("Not linking with " + s.peerName + ": its pairing playlist never showed up in this library.");
                return Json.obj("ok", false, "error", "its pairing playlist never showed up on the other computer, "
                        + "so the two aren't signed in to the same Apple Music account");
            }
            s.peerProved = true;
            s.ownPlaylist = library.create(playlistName(s.k, selfId), DESCRIPTION);
            return Json.obj("ok", true);
        } finally {
            s.checking = false;
        }
    }

    private Map<String, Object> finish(Map<String, Object> body) throws Exception {
        Session s = session(body);
        if (!s.peerProved) throw new WebServer.HttpError(403, "Not proved");
        sessions.values().remove(s);
        try {
            Map<String, Object> theirs = Json.parseObject(open(s.k, Json.str(body, "box")));
            String reply = seal(s.k, Json.obj("keys", access.exportKeys()));
            access.merge(Json.list(theirs.get("keys")));
            access.markLinked(s.peerId);
            lastCheck.put(s.peerId, System.currentTimeMillis());
            Log.info("Linked with " + s.peerName + ": it uses the same Apple Music account.");
            return Json.obj("box", reply);
        } finally {
            if (s.ownPlaylist != null) deleteQuietly(s.ownPlaylist);
        }
    }

    private Session session(Map<String, Object> body) {
        Session s = sessions.get(String.valueOf(Json.str(body, "sid")));
        if (s == null) throw new WebServer.HttpError(404, "Unknown or expired link attempt");
        return s;
    }

    /** Ends link attempts that never finished, removing their pairing playlists. */
    private void sweep() {
        long now = System.currentTimeMillis();
        sessions.values().removeIf(s -> {
            if (now - s.created < SESSION_MS) return false;
            if (s.ownPlaylist != null) Thread.startVirtualThread(() -> deleteQuietly(s.ownPlaylist));
            return true;
        });
    }

    // ------------------------------------------------------------------ library

    /** Waits for a playlist with that name to appear in this account's library (Apple syncs within seconds). */
    private boolean find(String name) throws Exception {
        long until = System.currentTimeMillis() + searchFor.toMillis();
        while (true) {
            if (library.has(name)) return true;
            if (System.currentTimeMillis() > until) return false;
            Thread.sleep(pollMs);
        }
    }

    private void deleteQuietly(String playlistId) {
        try {
            library.delete(playlistId);
        } catch (Exception e) {
            Log.warn("Couldn't delete Orchard's pairing playlist " + playlistId + " (" + message(e)
                    + "); you can delete \"Orchard pairing …\" from your library yourself.");
        }
    }

    /** The production library: Apple's API through the engine (Apple's own page and tokens). */
    static Library appleLibrary(Supplier<Engine> engine) {
        return new Library() {
            @Override
            public String create(String name, String description) {
                Map<String, Object> r = engine.get().api("POST", "/v1/me/library/playlists", Json.obj("attributes",
                        Json.obj("name", name, "description", description, "isPublic", false)));
                int status = r.get("status") instanceof Number n ? n.intValue() : 0;
                if (status < 200 || status >= 300) throw new IllegalStateException("Apple Music refused to create a playlist (" + status + ")");
                Map<String, Object> first = Json.map(Json.list(Json.parseObject(Json.str(r, "body")).get("data")).get(0));
                return Json.str(first, "id");
            }

            @Override
            public boolean has(String name) {
                String next = "/v1/me/library/playlists?limit=100";
                for (int page = 0; next != null && page < 100; page++) {
                    Map<String, Object> r = engine.get().api("GET", next, null);
                    int status = r.get("status") instanceof Number n ? n.intValue() : 0;
                    if (status != 200) throw new IllegalStateException("Apple Music didn't list the library (" + status + ")");
                    Map<String, Object> body = Json.parseObject(Json.str(r, "body"));
                    for (Object o : Json.list(body.get("data"))) {
                        if (name.equals(Json.str(Json.map(Json.map(o).get("attributes")), "name"))) return true;
                    }
                    next = Json.str(body, "next");
                    if (next != null && !next.startsWith("/v1/")) next = null;
                }
                return false;
            }

            @Override
            public void delete(String id) {
                if (id == null || !id.matches("[A-Za-z0-9._-]{1,80}")) return;
                Map<String, Object> r = engine.get().api("DELETE", "/v1/me/library/playlists/" + id, null);
                int status = r.get("status") instanceof Number n ? n.intValue() : 0;
                if (status >= 300 && status != 404) throw new IllegalStateException("HTTP " + status);
            }
        };
    }

    /** The production transport: plain HTTP to the other computer's Orchard. */
    static Transport httpTransport() {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        return (base, path, body, timeout) -> {
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + path)).timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(Json.write(body))).build();
            HttpResponse<String> r = http.send(req, HttpResponse.BodyHandlers.ofString());
            Map<String, Object> out;
            try {
                out = Json.parseObject(r.body());
            } catch (RuntimeException e) {
                throw new IllegalStateException("unexpected answer (HTTP " + r.statusCode() + ")");
            }
            if (r.statusCode() != 200) throw new IllegalStateException(String.valueOf(Json.str(out, "error")));
            return out;
        };
    }

    // ------------------------------------------------------------------ crypto

    private static KeyPair keyPair() throws Exception {
        return KeyPairGenerator.getInstance("X25519").generateKeyPair();
    }

    /** K = HMAC(X25519 shared secret, SHA-256 of both ids and both public keys, initiator first). */
    private static byte[] deriveK(KeyPair mine, String theirPub, String initiatorId, String responderId,
            String initiatorPub, String responderPub) throws Exception {
        PublicKey their = KeyFactory.getInstance("X25519").generatePublic(new X509EncodedKeySpec(unb64(theirPub)));
        KeyAgreement ka = KeyAgreement.getInstance("X25519");
        ka.init(mine.getPrivate());
        ka.doPhase(their, true);
        byte[] shared = ka.generateSecret();
        byte[] transcript = MessageDigest.getInstance("SHA-256").digest(String.join("|", CONTEXT, initiatorId,
                responderId, initiatorPub, responderPub).getBytes(StandardCharsets.UTF_8));
        return hmac(shared, transcript);
    }

    /** The pairing playlist name a computer must add to prove it's on the account. */
    static String playlistName(byte[] k, String proverId) {
        byte[] h = hmac(k, ("proof:" + proverId).getBytes(StandardCharsets.UTF_8));
        return "Orchard pairing " + HexFormat.of().formatHex(h, 0, 6);
    }

    private String seal(byte[] k, Map<String, Object> payload) throws Exception {
        byte[] iv = bytes(12);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(hmac(k, "box".getBytes(StandardCharsets.UTF_8)), "AES"),
                new GCMParameterSpec(128, iv));
        c.updateAAD(CONTEXT.getBytes(StandardCharsets.UTF_8));
        byte[] ct = c.doFinal(Json.write(payload).getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return b64(out);
    }

    private static String open(byte[] k, String box) throws Exception {
        byte[] in = unb64(box);
        if (in.length < 29) throw new IllegalStateException("bad key exchange");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(hmac(k, "box".getBytes(StandardCharsets.UTF_8)), "AES"),
                new GCMParameterSpec(128, in, 0, 12));
        c.updateAAD(CONTEXT.getBytes(StandardCharsets.UTF_8));
        return new String(c.doFinal(in, 12, in.length - 12), StandardCharsets.UTF_8);
    }

    private static byte[] hmac(byte[] key, byte[] data) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            return m.doFinal(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private byte[] bytes(int n) {
        byte[] b = new byte[n];
        random.nextBytes(b);
        return b;
    }

    private static String b64(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }

    private static byte[] unb64(String s) {
        if (s == null) throw new IllegalStateException("missing data");
        return Base64.getDecoder().decode(s);
    }

    private static String clean(String s) {
        if (s == null || s.isBlank()) return "another computer";
        s = s.replaceAll("\\p{Cntrl}", "").strip();
        return s.length() > 60 ? s.substring(0, 60) : s;
    }

    private static String message(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }
}
