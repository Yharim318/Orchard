package orchard;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.attribute.FileTime;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * Apple's artwork (covers, banners) as the Orchard window shows it, kept on disk under {@code <data>/cache/artwork}.
 * A picture seen once loads from here afterwards: instantly, on a bad connection, or with none at all. The cache
 * holds at most {@code ORCHARD_CACHE_MB} (default 1024 MB); beyond that, the pictures viewed least recently go.
 * Only https images on Apple's image CDN ({@code *.mzstatic.com}) are fetched, so this can't be used to reach
 * anything else. Music never passes through here.
 */
final class ArtCache {

    record Hit(byte[] bytes, String contentType) {}

    private static final long DEFAULT_LIMIT_MB = 1024;
    private static final int MAX_IMAGE = 20 << 20;
    /** A hit refreshes the file's date (its place in the "least recently viewed" order) at most this often. */
    private static final long TOUCH_EVERY_MS = 60 * 60_000L;

    private final Path dir;
    private final long limit;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private final Map<String, CompletableFuture<Hit>> loading = new ConcurrentHashMap<>();
    private final AtomicLong total = new AtomicLong(); // bytes on disk (counted at startup, then kept up to date)
    private final AtomicBoolean trimming = new AtomicBoolean();
    /** Pictures to download ahead of time (the Orchard window's start-up warm-up), and which are waiting. */
    private final LinkedBlockingQueue<String> warmQueue = new LinkedBlockingQueue<>();
    private final java.util.Set<String> warmWaiting = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean warmStarted = new AtomicBoolean();
    private static final int WARM_WORKERS = 3;

    ArtCache(Path dataDir) {
        dir = dataDir.resolve("cache").resolve("artwork");
        long mb = DEFAULT_LIMIT_MB;
        try {
            String v = Orchard.env("CACHE_MB");
            if (v != null && !v.isBlank()) mb = Math.max(50, Long.parseLong(v.trim()));
        } catch (NumberFormatException e) {
            Log.warn("ORCHARD_CACHE_MB must be a number of megabytes; using " + DEFAULT_LIMIT_MB);
        }
        limit = mb << 20;
        Thread.startVirtualThread(() -> {
            total.addAndGet(files().stream().mapToLong(FileInfo::size).sum());
            trimIfNeeded();
        });
    }

    /** Whether {@code url} is Apple artwork this cache may fetch. */
    static boolean allowed(String url) {
        if (url == null || url.length() > 2048) return false;
        try {
            URI u = new URI(url);
            String host = u.getHost();
            return "https".equals(u.getScheme()) && u.getRawUserInfo() == null && u.getPort() == -1 && host != null
                    && host.toLowerCase(Locale.ROOT).endsWith(".mzstatic.com");
        } catch (Exception e) {
            return false;
        }
    }

    private Path fileFor(String url) {
        String key = sha256(url);
        return dir.resolve(key.substring(0, 2)).resolve(key);
    }

    Hit get(String url) {
        if (!allowed(url)) throw new WebServer.HttpError(400, "Not an Apple artwork address");
        Path file = fileFor(url);
        String key = file.getFileName().toString();
        Hit hit = read(file);
        if (hit != null) return hit;
        // One download per picture, however many ask for it at once.
        CompletableFuture<Hit> f = loading.computeIfAbsent(key, k -> CompletableFuture.supplyAsync(
                () -> download(url, file), r -> Thread.startVirtualThread(r)));
        try {
            return f.join();
        } catch (CompletionException e) {
            if (e.getCause() instanceof WebServer.HttpError he) throw he;
            throw new WebServer.HttpError(502, "Could not load the picture: " + e.getCause());
        } finally {
            loading.remove(key, f);
        }
    }

    private Hit read(Path file) {
        try {
            byte[] bytes = Files.readAllBytes(file);
            String type = imageType(bytes);
            if (type == null) return null; // damaged: fetch again
            long now = System.currentTimeMillis();
            if (now - Files.getLastModifiedTime(file).toMillis() > TOUCH_EVERY_MS) {
                Files.setLastModifiedTime(file, FileTime.fromMillis(now));
            }
            return new Hit(bytes, type);
        } catch (IOException e) {
            return null; // not cached (or just removed)
        }
    }

    private Hit download(String url, Path file) {
        byte[] bytes;
        try {
            HttpResponse<byte[]> r = http.send(HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(60)).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
            if (r.statusCode() != 200) throw new WebServer.HttpError(r.statusCode() == 404 ? 404 : 502,
                    "Apple's image server answered " + r.statusCode());
            bytes = r.body();
        } catch (IOException e) {
            throw new WebServer.HttpError(502, "Could not reach Apple's image server: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new WebServer.HttpError(502, "Interrupted");
        }
        String type = imageType(bytes);
        if (type == null || bytes.length > MAX_IMAGE) throw new WebServer.HttpError(502, "Not a picture");
        try {
            Files.createDirectories(file.getParent());
            Path tmp = Files.createTempFile(file.getParent(), "dl-", ".tmp");
            Files.write(tmp, bytes);
            long before = Files.exists(file) ? Files.size(file) : 0;
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            total.addAndGet(bytes.length - before);
            trimIfNeeded();
        } catch (IOException e) {
            Log.debug("Could not keep a picture in the artwork cache: " + e.getMessage()); // still show it
        }
        return new Hit(bytes, type);
    }

    /**
     * Queues pictures to download in the background (those not cached yet). Warming stops adding pictures once the
     * cache is 85% full, so it never pushes out pictures that were actually looked at (trimming starts at 100%).
     */
    Map<String, Object> warm(List<String> urls) {
        boolean full = warmFull();
        int queued = 0;
        if (!full && urls != null) {
            for (String url : urls) {
                if (!allowed(url) || Files.exists(fileFor(url)) || !warmWaiting.add(url)) continue;
                warmQueue.add(url);
                queued++;
            }
        }
        if (queued > 0 && warmStarted.compareAndSet(false, true)) {
            for (int i = 0; i < WARM_WORKERS; i++) Thread.startVirtualThread(this::warmWorker);
        }
        return Json.obj("queued", queued, "pending", warmWaiting.size(), "full", full,
                "usedMB", total.get() >> 20, "limitMB", limit >> 20);
    }

    private boolean warmFull() {
        return total.get() > limit / 100 * 85;
    }

    private void warmWorker() {
        while (true) {
            String url;
            try {
                url = warmQueue.take();
            } catch (InterruptedException e) {
                return;
            }
            try {
                if (warmFull()) { // stop warming; pictures someone actually opens still load
                    warmQueue.clear();
                    warmWaiting.clear();
                    continue;
                }
                if (!Files.exists(fileFor(url))) get(url);
            } catch (RuntimeException e) {
                Log.debug("Warm-up: could not load " + url + ": " + e.getMessage());
            } finally {
                warmWaiting.remove(url);
            }
        }
    }

    /** Over the limit: remove the least recently viewed pictures until 90% of it is used. */
    private void trimIfNeeded() {
        if (total.get() <= limit || !trimming.compareAndSet(false, true)) return;
        Thread.startVirtualThread(() -> {
            try {
                List<FileInfo> all = files();
                all.sort((a, b) -> Long.compare(a.modified(), b.modified()));
                long used = all.stream().mapToLong(FileInfo::size).sum();
                long target = limit / 10 * 9;
                int removed = 0;
                for (FileInfo f : all) {
                    if (used <= target) break;
                    try {
                        Files.deleteIfExists(f.path());
                        used -= f.size();
                        removed++;
                    } catch (IOException ignored) {
                        // in use: skip it
                    }
                }
                total.set(used);
                Log.debug("Artwork cache: removed " + removed + " old pictures, " + (used >> 20) + " MB kept");
            } finally {
                trimming.set(false);
            }
        });
    }

    private record FileInfo(Path path, long size, long modified) {}

    private List<FileInfo> files() {
        List<FileInfo> out = new ArrayList<>();
        if (!Files.isDirectory(dir)) return out;
        try (Stream<Path> s = Files.walk(dir, 2)) {
            s.filter(Files::isRegularFile).forEach(p -> {
                try {
                    if (p.getFileName().toString().endsWith(".tmp")) { // left over from a crash mid-download
                        Files.deleteIfExists(p);
                        return;
                    }
                    out.add(new FileInfo(p, Files.size(p), Files.getLastModifiedTime(p).toMillis()));
                } catch (IOException ignored) {
                    // removed meanwhile
                }
            });
        } catch (IOException e) {
            Log.debug("Could not list the artwork cache: " + e.getMessage());
        }
        return out;
    }

    /** The picture's type from its first bytes, or null if it isn't a JPEG, PNG, WebP or GIF. */
    private static String imageType(byte[] b) {
        if (b.length > 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) return "image/jpeg";
        if (b.length > 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        if (b.length > 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
        return null;
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
