package orchard;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Application context shared by the web server, hub and engine. */
final class Orchard {
    static final String VERSION = "0.1.0";
    /**
     * True only in builds made by the GitHub release workflow (.github/workflows/release.yml sets it, together with
     * VERSION). Builds made with build.cmd never replace themselves with a release on their own.
     */
    static final boolean RELEASE_BUILD = false;

    /** Environment setting {@code ORCHARD_<name>}, or {@code JUICE_<name>} from before the app was renamed. */
    static String env(String name) {
        String v = System.getenv("ORCHARD_" + name);
        return v != null ? v : System.getenv("JUICE_" + name);
    }

    private final String id;
    private final String name;
    private final int port;
    private final String hostname = Net.hostname();
    private final boolean lan;
    private volatile Engine engine;
    private volatile String engineProblem = "Starting Apple Music…";
    private Hub hub;
    private Discovery discovery;
    private Updater updater;
    private Access access;
    private AccountLink link;
    private volatile boolean wasAuthorized;
    private volatile long signedOutSince;

    Orchard(String id, String name, int port, boolean lan) {
        this.id = id;
        this.name = name;
        this.port = port;
        this.lan = lan;
    }

    void init(Hub hub, Discovery discovery) {
        this.hub = hub;
        this.discovery = discovery;
    }

    void setAccess(Access a, AccountLink l) {
        access = a;
        link = l;
    }

    Access access() {
        return access;
    }

    AccountLink link() {
        return link;
    }

    String id() {
        return id;
    }

    String name() {
        return name;
    }

    /** True while this computer is signed in to Apple Music (needed before devices can be paired or linked). */
    boolean signedIn() {
        Engine e = engine;
        return e != null && Boolean.TRUE.equals(e.snapshot().get("authorized"));
    }

    /**
     * Watches the engine state for a sign-out: once Apple Music has stayed signed out for 30 s (not just reloading),
     * every paired device and linked computer loses access, since they belonged to the account that was here.
     */
    void observeSignIn(Map<String, Object> state) {
        boolean ready = Boolean.TRUE.equals(state.get("ready"));
        if (Boolean.TRUE.equals(state.get("authorized"))) {
            wasAuthorized = true;
            signedOutSince = 0;
            return;
        }
        if (!ready || !wasAuthorized || signedOutSince != 0) return;
        long since = System.currentTimeMillis();
        signedOutSince = since;
        Thread.startVirtualThread(() -> {
            try {
                Thread.sleep(30_000);
            } catch (InterruptedException e) {
                return;
            }
            if (signedOutSince == since && !signedIn()) signedOut();
        });
    }

    /** Signed out of Apple Music (here or in Apple's page): forget every device and computer. */
    void signedOut() {
        wasAuthorized = false;
        signedOutSince = 0;
        if (access != null) access.reset("signed out of Apple Music");
        if (hub != null) hub.dropRemote();
    }

    void setUpdater(Updater u) {
        updater = u;
    }

    Updater updater() {
        return updater;
    }

    Hub hub() {
        return hub;
    }

    Discovery discovery() {
        return discovery;
    }

    int port() {
        return port;
    }

    String hostname() {
        return hostname;
    }

    /** Addresses phones can use to reach us (re-read each time: Wi-Fi/VPN can change while running). */
    List<Net.Address> remoteAddresses() {
        return lan ? Net.remoteAddresses() : List.of();
    }

    List<String> lanAddresses() {
        List<String> out = new ArrayList<>();
        for (Net.Address a : remoteAddresses()) out.add(a.ip());
        return out;
    }

    void setEngine(Engine e) {
        engine = e;
    }

    /** Records why there is no engine (no browser found, browser failed…) and tells every device. */
    void setEngineProblem(String problem) {
        engineProblem = problem;
        if (hub != null) hub.broadcast("state", state());
    }

    Engine engine() {
        Engine e = engine;
        if (e == null) throw new Engine.EngineException(503, engineProblem);
        return e;
    }

    Map<String, Object> state() {
        Engine e = engine;
        if (e != null) return e.snapshot();
        return Json.obj("ready", false, "authorized", false, "offline", true, "message", engineProblem);
    }

    Map<String, Object> self() {
        return Json.obj("id", id, "name", name, "url", null, "self", true);
    }

    Map<String, Object> info() {
        List<String> urls = new ArrayList<>();
        List<Map<String, Object>> remotes = new ArrayList<>();
        for (Net.Address a : remoteAddresses()) {
            String url = "http://" + a.ip() + ":" + port + "/";
            urls.add(url);
            remotes.add(Json.obj("url", url, "kind", a.kind().name().toLowerCase(java.util.Locale.ROOT),
                    "adapter", a.adapter()));
        }
        return Json.obj("id", id, "name", name, "version", VERSION, "hostname", hostname, "port", port,
                "lanUrls", urls, "remotes", remotes);
    }

    /** This speaker plus every other Orchard computer on the network that proved it uses the same Apple Music account. */
    List<Map<String, Object>> speakers() {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(self());
        for (Discovery.Peer p : linkedPeers()) {
            out.add(Json.obj("id", p.id(), "name", p.name(), "url", p.url(), "self", false));
        }
        return out;
    }

    /** Computers heard on the network that are linked (same Apple Music account). */
    List<Discovery.Peer> linkedPeers() {
        List<Discovery.Peer> out = new ArrayList<>();
        if (discovery == null || access == null) return out;
        for (Discovery.Peer p : discovery.peers()) if (access.isLinked(p.id())) out.add(p);
        return out;
    }

    /** A linked computer by its address, or null (unknown, or not proved to be on this account). */
    Discovery.Peer linkedPeer(String url) {
        if (discovery == null || access == null || url == null) return null;
        Discovery.Peer p = discovery.peerByUrl(url);
        return p != null && access.isLinked(p.id()) ? p : null;
    }

    /** Adds this computer's key to a request to another Orchard computer. */
    java.net.http.HttpRequest.Builder authorize(java.net.http.HttpRequest.Builder b) {
        String device = "pc:" + id;
        return b.header(Access.DEVICE_HEADER, device).header(Access.KEY_HEADER, access.keyFor(device));
    }
}
