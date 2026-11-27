package orchard;

import java.io.IOException;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.StandardSocketOptions;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Finds other Orchard speakers so playback can be handed between computers like Spotify Connect.
 *
 * <p>Two ways, same packet, same port:
 * <ul>
 *   <li>UDP multicast heartbeat on the physical LAN (same Wi-Fi / router);</li>
 *   <li>unicast heartbeats to every online Tailscale device (Tailscale carries no multicast) and to any
 *       {@code --peer} hosts given on the command line.</li>
 * </ul>
 */
final class Discovery {
    private static final String GROUP = "239.255.77.77";
    private static final int PORT = 8788;
    private static final long EXPIRY_MS = 10_000;
    /** A peer's current address is kept over a worse-ranked one while it was heard from this recently. */
    private static final long PREFER_MS = 7_000;
    private static final long TARGET_REFRESH_MS = 20_000;

    record Peer(String id, String name, String url, long lastSeen) {}

    private final String selfId;
    private final String selfName;
    private final int httpPort;
    private final List<String> manualPeers;
    private final Runnable onChange;
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private volatile List<InetAddress> unicastTargets = List.of();
    private long targetsRefreshedAt;
    private boolean tailscaleWarned;
    private int tailnetCount = -1;
    private MulticastSocket socket;
    private InetAddress group;
    private boolean multicast;

    Discovery(String selfId, String selfName, int httpPort, List<String> manualPeers, Runnable onChange) {
        this.selfId = selfId;
        this.selfName = selfName;
        this.httpPort = httpPort;
        this.manualPeers = List.copyOf(manualPeers);
        this.onChange = onChange;
    }

    void start() {
        try {
            group = InetAddress.getByName(GROUP);
            socket = new MulticastSocket(null);
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(PORT));
            socket.setOption(StandardSocketOptions.IP_MULTICAST_TTL, 1);
        } catch (IOException e) {
            Log.warn("Speaker discovery disabled: cannot open UDP port " + PORT + ": " + e.getMessage());
            return;
        }
        int joined = 0;
        for (NetworkInterface ni : Net.lanInterfaces()) {
            try {
                socket.joinGroup(new InetSocketAddress(group, PORT), ni);
                joined++;
            } catch (IOException ignored) {
                // interface without IPv4 multicast
            }
        }
        multicast = joined > 0;
        if (!multicast) Log.warn("LAN multicast discovery unavailable (no usable network interface); "
                + "only Tailscale / --peer discovery will work.");
        daemon("discovery-rx", this::receiveLoop);
        daemon("discovery-tx", () -> {
            while (true) {
                long now = System.currentTimeMillis();
                if (now - targetsRefreshedAt > TARGET_REFRESH_MS) {
                    targetsRefreshedAt = now;
                    refreshUnicastTargets();
                }
                announce();
                expire();
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    return;
                }
            }
        });
    }

    List<Peer> peers() {
        List<Peer> list = new ArrayList<>(peers.values());
        list.sort(Comparator.comparing(Peer::name, String.CASE_INSENSITIVE_ORDER));
        return list;
    }

    Peer peerByUrl(String url) {
        for (Peer p : peers.values()) if (p.url().equals(url)) return p;
        return null;
    }

    private byte[] packet() {
        return Json.write(Json.obj("app", "orchard", "id", selfId, "name", selfName, "port", httpPort))
                .getBytes(StandardCharsets.UTF_8);
    }

    private void announce() {
        byte[] data = packet();
        if (multicast) {
            for (NetworkInterface ni : Net.lanInterfaces()) {
                try {
                    socket.setOption(StandardSocketOptions.IP_MULTICAST_IF, ni);
                    socket.send(new DatagramPacket(data, data.length, group, PORT));
                } catch (IOException ignored) {
                    // interface cannot send multicast
                }
            }
        }
        for (InetAddress target : unicastTargets) sendTo(target, data);
    }

    private void sendTo(InetAddress target, byte[] data) {
        try {
            socket.send(new DatagramPacket(data, data.length, target, PORT));
        } catch (IOException e) {
            Log.debug("Discovery packet to " + target.getHostAddress() + " failed: " + e.getMessage());
        }
    }

    private void expire() {
        long now = System.currentTimeMillis();
        if (peers.values().removeIf(p -> now - p.lastSeen() > EXPIRY_MS)) onChange.run();
    }

    /** Lower is better: a direct LAN address beats Tailscale, which beats anything else. */
    private static int rank(InetAddress a) {
        byte[] b = a.getAddress();
        if (b.length == 4 && (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64) return 1; // Tailscale 100.64.0.0/10
        return a.isSiteLocalAddress() ? 0 : 2;
    }

    private static int rank(String url) {
        try {
            String host = url.substring("http://".length(), url.lastIndexOf(':'));
            return rank(InetAddress.getByName(host));
        } catch (Exception e) {
            return 2;
        }
    }

    private void receiveLoop() {
        byte[] buf = new byte[2048];
        while (!socket.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                socket.receive(packet);
                Map<String, Object> msg = Json.parseObject(
                        new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                String id = Json.str(msg, "id");
                String appTag = Json.str(msg, "app");
                // "juice": speakers still running a build from before the rename.
                if (!("orchard".equals(appTag) || "juice".equals(appTag)) || id == null || id.equals(selfId)) continue;
                long port = msg.get("port") instanceof Number n ? n.longValue() : 0;
                if (port <= 0 || port > 65535) continue;
                InetAddress from = packet.getAddress();
                String url = "http://" + from.getHostAddress() + ":" + port;
                // Anything on the network can send these packets: keep the name short and printable.
                String rawName = Json.str(msg, "name");
                rawName = rawName == null ? null : rawName.replaceAll("\\p{Cntrl}", "").strip();
                if (rawName != null && rawName.length() > 60) rawName = rawName.substring(0, 60);
                String name = rawName == null || rawName.isBlank() ? from.getHostAddress() : rawName;
                long now = System.currentTimeMillis();
                Peer prev = peers.get(id);
                // A computer on the same Wi-Fi *and* Tailscale is heard on both addresses: stick with the
                // better one while it keeps answering, instead of flip-flopping between them.
                if (prev != null && !prev.url().equals(url) && now - prev.lastSeen() < PREFER_MS
                        && rank(prev.url()) <= rank(from)) {
                    continue;
                }
                peers.put(id, new Peer(id, name, url, now));
                if (prev == null || !prev.url().equals(url) || !prev.name().equals(name)) {
                    Log.info("Found speaker: " + name + " at " + url);
                    onChange.run();
                    if (prev == null) {
                        announce(); // let the newcomer see us right away
                        sendTo(from, packet()); // ...even if it only knows us from its own target list
                    }
                }
            } catch (IOException e) {
                if (socket.isClosed()) return;
            } catch (RuntimeException e) {
                Log.debug("Ignoring bad discovery packet: " + e.getMessage());
            }
        }
    }

    // ------------------------------------------------------------------ unicast targets

    private void refreshUnicastTargets() {
        Set<InetAddress> out = new LinkedHashSet<>();
        for (String host : manualPeers) {
            try {
                for (InetAddress a : InetAddress.getAllByName(host)) if (a instanceof Inet4Address) out.add(a);
            } catch (IOException e) {
                Log.debug("Cannot resolve --peer " + host + ": " + e.getMessage());
            }
        }
        List<InetAddress> tailnet = tailscalePeers();
        out.addAll(tailnet);
        List<InetAddress> list = List.copyOf(out);
        if (!list.equals(unicastTargets)) {
            if (tailnet.size() != tailnetCount) {
                Log.info("Looking for speakers over Tailscale: " + tailnet.size() + " other device(s) online.");
            }
            Log.debug("Discovery unicast targets: " + list.stream().map(InetAddress::getHostAddress).toList());
        }
        tailnetCount = tailnet.size();
        unicastTargets = list;
    }

    /** IPv4 addresses of the online devices in this computer's tailnet, via the Tailscale CLI. */
    private List<InetAddress> tailscalePeers() {
        String json = runTailscaleStatus();
        if (json == null) return List.of();
        List<InetAddress> out = new ArrayList<>();
        try {
            Map<String, Object> peerMap = Json.map(Json.parseObject(json).get("Peer"));
            if (peerMap == null) return out;
            for (Object v : peerMap.values()) {
                Map<String, Object> p = Json.map(v);
                if (p == null || !Json.bool(p, "Online")) continue;
                for (Object ip : Json.list(p.get("TailscaleIPs"))) {
                    InetAddress a = InetAddress.getByName(ip.toString());
                    if (a instanceof Inet4Address) {
                        out.add(a);
                        break;
                    }
                }
            }
        } catch (Exception e) {
            Log.debug("Cannot read tailscale status: " + e.getMessage());
        }
        return out;
    }

    private String runTailscaleStatus() {
        for (String exe : tailscaleCandidates()) {
            Process proc;
            try {
                proc = new ProcessBuilder(exe, "status", "--json")
                        .redirectError(ProcessBuilder.Redirect.DISCARD)
                        .start();
            } catch (IOException e) {
                continue; // not installed here; try the next location
            }
            try (InputStream in = proc.getInputStream()) {
                CompletableFuture<byte[]> body = CompletableFuture.supplyAsync(() -> {
                    try {
                        return in.readAllBytes();
                    } catch (IOException e) {
                        return new byte[0];
                    }
                });
                byte[] bytes = body.get(5, TimeUnit.SECONDS);
                if (!proc.waitFor(2, TimeUnit.SECONDS) || proc.exitValue() != 0) {
                    if (!tailscaleWarned) {
                        tailscaleWarned = true;
                        Log.info("Tailscale is installed but 'tailscale status' failed (not running / logged out?).");
                    }
                    return null;
                }
                return new String(bytes, StandardCharsets.UTF_8);
            } catch (Exception e) {
                Log.debug("tailscale status failed: " + e);
                return null;
            } finally {
                proc.destroy();
            }
        }
        if (!tailscaleWarned) {
            tailscaleWarned = true;
            Log.info("Tailscale CLI not found, so speakers are only found on this Wi-Fi/LAN "
                    + "(set ORCHARD_TAILSCALE to tailscale.exe's path, or use --peer <address>).");
        }
        return null;
    }

    private static List<String> tailscaleCandidates() {
        List<String> out = new ArrayList<>();
        String env = Orchard.env("TAILSCALE");
        if (env != null && !env.isBlank()) out.add(env);
        String pf = System.getenv("ProgramFiles");
        if (pf != null) out.add(Path.of(pf, "Tailscale", "tailscale.exe").toString());
        out.add("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        out.add("tailscale");
        out.removeIf(p -> p.contains("/") || p.contains("\\") ? !Files.isRegularFile(Path.of(p)) : false);
        return out;
    }

    private static void daemon(String name, Runnable r) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
    }
}
