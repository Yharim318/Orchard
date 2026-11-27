package orchard;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Who may use this Orchard. Only devices that belong to the Apple Music account signed in here get in:
 * <ul>
 *   <li>This computer itself (requests from 127.0.0.1, which includes the Orchard window) is always trusted.</li>
 *   <li>Other Orchard computers prove they're signed in to the same Apple Music account (see {@link AccountLink});
 *       they then share their keys, so a device paired with one of them is paired with all of them.</li>
 *   <li>Phones and browsers can't sign in to Apple Music themselves, so they are paired: by scanning the QR code in
 *       the signed-in Orchard window (an invite), or by asking and being allowed in that window.</li>
 * </ul>
 * A paired device holds a key: HMAC-SHA256 of its device id under one of this account's secrets (the keyring). It
 * sends both with every request ({@link #DEVICE_HEADER}/{@link #KEY_HEADER}, or {@code deviceId}/{@code key} query
 * parameters for event streams). Signing out of Apple Music here forgets every secret: all paired devices and
 * linked computers lose access to this computer.
 */
final class Access {

    static final String DEVICE_HEADER = "X-Orchard-Device";
    static final String KEY_HEADER = "X-Orchard-Key";
    private static final Pattern DEVICE_ID = Pattern.compile("[A-Za-z0-9:._-]{1,80}");
    private static final int MAX_KEYS = 16;
    private static final long INVITE_MS = 10 * 60_000;
    private static final long REQUEST_MS = 5 * 60_000;
    private static final int MAX_REQUESTS = 8;

    private final Path file;
    private final SecureRandom random = new SecureRandom();
    private final List<byte[]> keys = new ArrayList<>();          // [0] is the one new keys are made with
    private final Map<String, Long> linked = new LinkedHashMap<>(); // computer id -> when it proved the account
    private final Map<String, Long> invites = new LinkedHashMap<>(); // QR invite code -> expiry
    private final Map<String, Request> requests = new LinkedHashMap<>();
    private Runnable onChange = () -> {};

    /** A device asking to be let in. {@code secret} lets only that device collect the answer. */
    private static final class Request {
        String requestId;
        String secret;
        String deviceId;
        String name;
        String kind;
        long expires;
        String status = "pending"; // pending, approved, denied
    }

    Access(Path dataDir) {
        this.file = dataDir.resolve("access.json");
        load();
        if (keys.isEmpty()) {
            keys.add(newKey());
            save();
        }
    }

    /** Called after anything other devices should hear about (linked computers, pairing requests). */
    void onChange(Runnable r) {
        onChange = r;
    }

    // ------------------------------------------------------------------ keys

    /** The key a device (or "pc:&lt;id&gt;" for an Orchard computer) uses with this account's computers. */
    synchronized String keyFor(String deviceId) {
        return mac(keys.get(0), deviceId);
    }

    /** True if the key belongs to that device under any of this account's secrets. */
    synchronized boolean valid(String deviceId, String key) {
        if (deviceId == null || key == null || !DEVICE_ID.matcher(deviceId).matches() || key.length() > 100) return false;
        byte[] given = key.getBytes(StandardCharsets.UTF_8);
        for (byte[] k : keys) {
            if (MessageDigest.isEqual(given, mac(k, deviceId).getBytes(StandardCharsets.UTF_8))) return true;
        }
        return false;
    }

    static boolean validDeviceId(String id) {
        return id != null && DEVICE_ID.matcher(id).matches();
    }

    /** The secrets, for a computer that just proved it's on the same account (sent encrypted). */
    synchronized List<String> exportKeys() {
        List<String> out = new ArrayList<>();
        for (byte[] k : keys) out.add(Base64.getEncoder().encodeToString(k));
        return out;
    }

    /** Adds a linked computer's secrets to ours, so devices paired with it are paired with us too. */
    synchronized void merge(List<Object> more) {
        boolean changed = false;
        for (Object o : more) {
            byte[] k;
            try {
                k = Base64.getDecoder().decode(String.valueOf(o));
            } catch (IllegalArgumentException e) {
                continue;
            }
            if (k.length != 32 || keys.stream().anyMatch(x -> MessageDigest.isEqual(x, k))) continue;
            if (keys.size() >= MAX_KEYS) break;
            keys.add(k);
            changed = true;
        }
        if (changed) save();
    }

    /**
     * Forgets everything: new secret, no linked computers, no invites or requests. Every paired phone and linked
     * computer loses access to this one (they'd have to pair again with the account signed in here).
     */
    void reset(String why) {
        synchronized (this) {
            keys.clear();
            keys.add(newKey());
            linked.clear();
            invites.clear();
            requests.clear();
            save();
        }
        Log.info("Forgot all paired devices and linked computers (" + why + ").");
        onChange.run();
    }

    // ------------------------------------------------------------------ linked computers

    synchronized boolean isLinked(String computerId) {
        return linked.containsKey(computerId);
    }

    void markLinked(String computerId) {
        synchronized (this) {
            linked.put(computerId, System.currentTimeMillis());
            save();
        }
        onChange.run();
    }

    void unlink(String computerId) {
        boolean had;
        synchronized (this) {
            had = linked.remove(computerId) != null;
            if (had) save();
        }
        if (had) onChange.run();
    }

    // ------------------------------------------------------------------ phones: QR invites

    /** A code for the QR code in the Orchard window: whoever opens the address with it is paired (10 minutes). */
    synchronized Map<String, Object> invite() {
        long now = System.currentTimeMillis();
        invites.values().removeIf(exp -> exp < now);
        // Reuse a fresh one, so reopening the panel doesn't change the QR code every time.
        for (Map.Entry<String, Long> e : invites.entrySet()) {
            if (e.getValue() - now > INVITE_MS / 2) return Json.obj("code", e.getKey(), "expires", e.getValue());
        }
        String code = token(18);
        invites.put(code, now + INVITE_MS);
        return Json.obj("code", code, "expires", now + INVITE_MS);
    }

    /** Pairs a device that came with a QR invite; returns its key, or null if the invite isn't valid. */
    synchronized String claim(String code, String deviceId) {
        if (code == null || !validDeviceId(deviceId)) return null;
        Long exp = invites.get(code);
        if (exp == null || exp < System.currentTimeMillis()) return null;
        return keyFor(deviceId);
    }

    // ------------------------------------------------------------------ phones: asking to be let in

    /** A device without a key asks to be let in; the Orchard window shows Allow / Deny. */
    Map<String, Object> request(String deviceId, String name, String kind) {
        if (!validDeviceId(deviceId)) throw new WebServer.HttpError(400, "Bad device id");
        Request r = new Request();
        synchronized (this) {
            expireRequests();
            requests.values().removeIf(x -> x.deviceId.equals(deviceId) && "pending".equals(x.status));
            if (requests.size() >= MAX_REQUESTS) throw new WebServer.HttpError(429, "Too many devices are asking at once; try again in a few minutes.");
            r.requestId = token(9);
            r.secret = token(18);
            r.deviceId = deviceId;
            r.name = clean(name, "A device");
            r.kind = clean(kind, "browser");
            r.expires = System.currentTimeMillis() + REQUEST_MS;
            requests.put(r.requestId, r);
        }
        Log.info("Device asking for access: " + r.name);
        onChange.run();
        return Json.obj("id", r.requestId, "secret", r.secret);
    }

    /** What happened to a request (asked by the device that made it). */
    synchronized Map<String, Object> requestStatus(String id, String secret) {
        expireRequests();
        Request r = id == null ? null : requests.get(id);
        if (r == null || secret == null || !MessageDigest.isEqual(secret.getBytes(StandardCharsets.UTF_8),
                r.secret.getBytes(StandardCharsets.UTF_8))) {
            return Json.obj("status", "expired");
        }
        if ("approved".equals(r.status)) {
            requests.remove(id);
            return Json.obj("status", "approved", "deviceId", r.deviceId, "key", keyFor(r.deviceId));
        }
        if ("denied".equals(r.status)) requests.remove(id);
        return Json.obj("status", r.status);
    }

    /** Requests waiting for an answer, for the Orchard window. */
    synchronized List<Map<String, Object>> pending() {
        expireRequests();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Request r : requests.values()) {
            if ("pending".equals(r.status)) out.add(Json.obj("id", r.requestId, "name", r.name, "kind", r.kind));
        }
        return out;
    }

    void decide(String id, boolean allow) {
        String name;
        synchronized (this) {
            Request r = id == null ? null : requests.get(id);
            if (r == null || !"pending".equals(r.status)) throw new WebServer.HttpError(404, "That request has expired.");
            r.status = allow ? "approved" : "denied";
            r.expires = System.currentTimeMillis() + 60_000; // time for the device to collect the answer
            name = r.name;
        }
        Log.info((allow ? "Allowed " : "Denied ") + name + ".");
        onChange.run();
    }

    private void expireRequests() {
        long now = System.currentTimeMillis();
        requests.values().removeIf(r -> r.expires < now);
    }

    // ------------------------------------------------------------------ helpers

    private byte[] newKey() {
        byte[] k = new byte[32];
        random.nextBytes(k);
        return k;
    }

    private String token(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static String mac(byte[] key, String deviceId) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] out = m.doFinal(("orchard-device-v1:" + deviceId).getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(out);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String clean(String s, String def) {
        if (s == null) return def;
        s = s.replaceAll("\\p{Cntrl}", "").strip();
        if (s.isEmpty()) return def;
        return s.length() > 60 ? s.substring(0, 60) : s;
    }

    private void load() {
        try {
            if (!Files.exists(file)) return;
            Map<String, Object> m = Json.parseObject(Files.readString(file));
            for (Object o : Json.list(m.get("keys"))) {
                byte[] k = Base64.getDecoder().decode(String.valueOf(o));
                if (k.length == 32) keys.add(k);
            }
            Map<String, Object> l = Json.map(m.get("linked"));
            if (l != null) l.forEach((id, t) -> linked.put(id, t instanceof Number n ? n.longValue() : 0L));
        } catch (IOException | RuntimeException e) {
            // Unreadable: start over (devices pair again). Keep the broken file for a look.
            Log.warn("Could not read " + file + " (" + e.getMessage() + "); paired devices must pair again.");
            try {
                Files.move(file, file.resolveSibling("access.broken.json"), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException ignored) {
                // nothing more to do
            }
            keys.clear();
            linked.clear();
        }
    }

    private void save() {
        List<String> k = new ArrayList<>();
        for (byte[] b : keys) k.add(Base64.getEncoder().encodeToString(b));
        String json = Json.write(Json.obj("keys", k, "linked", new LinkedHashMap<>(linked)));
        try {
            Path tmp = file.resolveSibling("access.json.tmp");
            Files.writeString(tmp, json);
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            Log.warn("Could not save " + file + ": " + e.getMessage());
        }
    }
}
