package orchard;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Custom playlist artwork chosen in Orchard. Apple Music's web API has no way to upload playlist artwork
 * (only Apple's own iPhone/Mac apps can), so Orchard keeps the picture itself, in {@code <dataDir>/artwork},
 * and shows it on every device that uses this Orchard. It does not appear in Apple's apps.
 *
 * <p>Uploads arrive base64-encoded in several small parts: the app window reaches Orchard through DevTools
 * request interception, which only passes small request bodies along reliably.
 */
final class ArtworkStore {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9._-]{1,80}");
    private static final int MAX_BYTES = 2 << 20;            // decoded image
    private static final int MAX_CHARS = (MAX_BYTES / 3 + 1) * 4 + 64;
    private static final int MAX_PARTS = 200;
    private static final long UPLOAD_TTL_MS = 2 * 60_000;
    private static final String[] EXTS = {"jpg", "png", "webp"};

    record Image(byte[] bytes, String contentType) {}

    private record Upload(StringBuilder data, int parts, long started, int[] next) {}

    private final Path dir;
    private final Map<String, Upload> uploads = new ConcurrentHashMap<>();

    ArtworkStore(Path dataDir) {
        this.dir = dataDir.resolve("artwork");
    }

    /** id → version (last-modified millis) of every playlist with custom artwork. */
    Map<String, Object> list() throws IOException {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!Files.isDirectory(dir)) return out;
        try (Stream<Path> files = Files.list(dir)) {
            for (Path p : (Iterable<Path>) files::iterator) {
                String name = p.getFileName().toString();
                int dot = name.lastIndexOf('.');
                if (dot <= 0 || !isExt(name.substring(dot + 1))) continue;
                out.put(name.substring(0, dot), Files.getLastModifiedTime(p).toMillis());
            }
        }
        return out;
    }

    Image get(String id) throws IOException {
        Path p = find(checkId(id));
        if (p == null) return null;
        String name = p.getFileName().toString();
        return new Image(Files.readAllBytes(p), contentType(name.substring(name.lastIndexOf('.') + 1)));
    }

    /**
     * Adds one part of an upload; returns the new version once the last part has arrived, otherwise null.
     * {@code data} parts concatenate to a data URL ({@code data:image/jpeg;base64,...}) or plain base64.
     */
    Long put(String id, String upload, int part, int parts, String data) throws IOException {
        checkId(id);
        if (upload == null || upload.isBlank() || upload.length() > 64) throw new WebServer.HttpError(400, "Missing upload id");
        if (parts < 1 || parts > MAX_PARTS || part < 0 || part >= parts) throw new WebServer.HttpError(400, "Bad upload part");
        if (data == null) throw new WebServer.HttpError(400, "Missing data");
        long now = System.currentTimeMillis();
        uploads.values().removeIf(u -> now - u.started() > UPLOAD_TTL_MS);
        String key = id + "\n" + upload;
        Upload u = part == 0 ? new Upload(new StringBuilder(), parts, now, new int[] {0}) : uploads.get(key);
        if (part == 0) {
            if (uploads.size() > 16) throw new WebServer.HttpError(429, "Too many uploads at once");
            uploads.put(key, u);
        }
        if (u == null || u.parts() != parts || u.next()[0] != part) {
            uploads.remove(key);
            throw new WebServer.HttpError(400, "Upload parts arrived out of order; please try again");
        }
        if (u.data().length() + data.length() > MAX_CHARS) {
            uploads.remove(key);
            throw new WebServer.HttpError(413, "That picture is too large (max 2 MB)");
        }
        u.data().append(data);
        u.next()[0]++;
        if (part < parts - 1) return null;
        uploads.remove(key);
        return save(id, decode(u.data().toString()));
    }

    void delete(String id) throws IOException {
        checkId(id);
        for (String ext : EXTS) Files.deleteIfExists(dir.resolve(id + "." + ext));
    }

    // ------------------------------------------------------------------ helpers

    private long save(String id, byte[] bytes) throws IOException {
        String ext = sniff(bytes);
        if (ext == null) throw new WebServer.HttpError(415, "Only JPEG, PNG or WebP pictures can be used");
        Files.createDirectories(dir);
        Path target = dir.resolve(id + "." + ext);
        Path tmp = dir.resolve(id + "." + ext + ".tmp");
        Files.write(tmp, bytes);
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
        for (String other : EXTS) if (!other.equals(ext)) Files.deleteIfExists(dir.resolve(id + "." + other));
        return Files.getLastModifiedTime(target).toMillis();
    }

    private static byte[] decode(String data) {
        int comma = data.startsWith("data:") ? data.indexOf(',') : -1;
        String b64 = comma >= 0 ? data.substring(comma + 1) : data;
        try {
            byte[] bytes = Base64.getMimeDecoder().decode(b64);
            if (bytes.length == 0 || bytes.length > MAX_BYTES) throw new WebServer.HttpError(413, "That picture is too large (max 2 MB)");
            return bytes;
        } catch (IllegalArgumentException e) {
            throw new WebServer.HttpError(400, "The picture data was damaged; please try again");
        }
    }

    /** File type from the first bytes, so only real images are stored and served. */
    private static String sniff(byte[] b) {
        if (b.length > 3 && (b[0] & 0xff) == 0xFF && (b[1] & 0xff) == 0xD8 && (b[2] & 0xff) == 0xFF) return "jpg";
        if (b.length > 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "png";
        if (b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null;
    }

    private Path find(String id) {
        for (String ext : EXTS) {
            Path p = dir.resolve(id + "." + ext);
            if (Files.isRegularFile(p)) return p;
        }
        return null;
    }

    private static String checkId(String id) {
        if (id == null || !ID.matcher(id).matches()) throw new WebServer.HttpError(400, "Bad playlist id");
        return id;
    }

    private static boolean isExt(String ext) {
        for (String e : EXTS) if (e.equals(ext)) return true;
        return false;
    }

    private static String contentType(String ext) {
        return switch (ext) {
            case "png" -> "image/png";
            case "webp" -> "image/webp";
            default -> "image/jpeg";
        };
    }
}
