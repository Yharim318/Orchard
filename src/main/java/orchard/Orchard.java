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

    /** This speaker plus every other Orchard speaker discovered on the LAN. */
    List<Map<String, Object>> speakers() {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(self());
        if (discovery != null) {
            for (Discovery.Peer p : discovery.peers()) {
                out.add(Json.obj("id", p.id(), "name", p.name(), "url", p.url(), "self", false));
            }
        }
        return out;
    }
}
