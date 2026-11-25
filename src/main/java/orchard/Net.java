package orchard;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** Network helpers: addresses phones can reach us on, hostname, interfaces suitable for multicast. */
final class Net {

    /** How a phone could reach this computer at a given address. */
    enum Kind { LAN, TAILSCALE, PUBLIC }

    record Address(String ip, Kind kind, String adapter) {}

    /** Adapters that only connect to local virtual machines/containers (e.g. WSL's Hyper-V switch). */
    private static final String[] INTERNAL = {"docker", "veth", "br-", "vmnet", "virbr", "vbox", "virtualbox",
            "vethernet", "wsl", "hyper-v", "llw", "awdl", "bridge", "vmware"};
    /** VPN-style adapters: fine for remotes, useless for multicast discovery. */
    private static final String[] TUNNELS = {"tailscale", "zerotier", "utun", "wireguard", "tun", "tap"};

    private Net() {}

    static String hostname() {
        String name = System.getenv("COMPUTERNAME");
        if (name == null || name.isBlank()) name = System.getenv("HOSTNAME");
        if (name == null || name.isBlank()) {
            try {
                name = InetAddress.getLocalHost().getHostName();
            } catch (Exception e) {
                name = "this computer";
            }
        }
        int dot = name.indexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static String label(NetworkInterface ni) {
        return (ni.getName() + " " + ni.getDisplayName()).toLowerCase(Locale.ROOT);
    }

    private static boolean matches(String label, String[] words) {
        for (String w : words) if (label.contains(w)) return true;
        return false;
    }

    private static List<NetworkInterface> upInterfaces() {
        try {
            List<NetworkInterface> out = new ArrayList<>();
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (ni.isUp() && !ni.isLoopback()) out.add(ni);
            }
            return out;
        } catch (SocketException e) {
            Log.warn("Cannot list network interfaces: " + e.getMessage());
            return List.of();
        }
    }

    /** Physical-looking interfaces that support multicast (for discovering other Orchard speakers). */
    static List<NetworkInterface> lanInterfaces() {
        List<NetworkInterface> out = new ArrayList<>();
        for (NetworkInterface ni : upInterfaces()) {
            String l = label(ni);
            try {
                if (ni.isPointToPoint() || !ni.supportsMulticast()) continue;
            } catch (SocketException e) {
                continue;
            }
            if (!matches(l, INTERNAL) && !matches(l, TUNNELS)) out.add(ni);
        }
        return out;
    }

    /**
     * Every IPv4 address a phone might reach this computer on, best first:
     * home/office network addresses, then Tailscale, then public addresses (e.g. campus networks).
     */
    static List<Address> remoteAddresses() {
        List<Address> out = new ArrayList<>();
        for (NetworkInterface ni : upInterfaces()) {
            String l = label(ni);
            if (matches(l, INTERNAL)) continue;
            for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                byte[] b = a.getAddress();
                boolean cgnat = (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64; // 100.64.0.0/10
                Kind kind = l.contains("tailscale") || cgnat ? Kind.TAILSCALE
                        : a.isSiteLocalAddress() ? Kind.LAN : Kind.PUBLIC;
                out.add(new Address(a.getHostAddress(), kind, ni.getDisplayName()));
            }
        }
        out.sort(Comparator.comparing(Address::kind));
        return out;
    }

    static boolean isIpLiteral(String host) {
        return host.matches("\\d{1,3}(\\.\\d{1,3}){3}") || host.startsWith("[") || host.contains(":");
    }
}
