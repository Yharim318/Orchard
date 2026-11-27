# 3. Java files

All Java code is in package `orchard` under `src/main/java/orchard/`. Classes are package-private except
`Main` and `Json`. There are no third-party dependencies: only the JDK (`java.net.http`,
`com.sun.net.httpserver`, `java.nio`, `java.util.concurrent`).

Files are listed in the order they come into play at startup.

**Dependency sketch** (arrow = "uses"):

```
Main ──► Orchard ◄── WebServer ──► Engine ──► CdpClient
  │        │  ▲         │           │  └──► HostLink ──► Hub
  │        │  │         └─► Hub     │                 └► Discovery
  │        ▼  │                     └── (callbacks) ──► Hub
  ├──► BrowserLauncher ──► CdpClient (leftover cleanup), Json (prefs)
  ├──► Discovery ──► Net, Json
  └──► Hub
Everything ──► Json, Log
```

---

## `Main.java`: entry point and wiring

**Responsibility:** parse options, create every component, connect them with callbacks, launch the browser,
keep the process alive.

| Member | What it does |
|--------|--------------|
| `Options` (inner class) | Holds parsed flags: `port`, `name`, `browser`, `dataDir`, `noBrowser`, `localOnly`, `headless`, `engineWindow`. |
| `main(String[])` | Startup sequence (timeline Stage 1): options → data dir → speaker id → `Orchard` → `Hub` → `Discovery` → `WebServer` → banner → `startEngine` → block forever. |
| `startEngine(...)` | Stage 2: `BrowserLauncher.find` → per-browser profile → `BrowserLauncher.launch` (app URL `Engine.APP_URL`, or `http://localhost:<port>/?host=1` with `--engine-window`) → `CdpClient.connect` → `HostLink` → `Engine` → exit hooks → `engine.start()`. Any failure is reported through `Orchard.setEngineProblem` instead of crashing. |
| `parse(String[])` | Command-line parsing and `--help` text. **Add new flags here** (and to the help text). |
| `defaultDataDir(port, notes)` | OS-specific data folder (`Orchard` / `orchard`). |
| `adoptLegacyDataDir(legacy, target, port, notes)` | One-time move of the pre-rename `Juice` folder to `Orchard`; never while the port answers, never onto an existing folder, falls back to the old folder on failure. Messages are logged once `orchard.log` is open. |
| `loadOrCreateId(Path)` | Persistent speaker UUID in `<data>/speaker-id`. |
| `resource(String)` | Reads a classpath resource as text (used for `engine.js`). |

**Callbacks created here** (the glue between components):

- `Hub` suppliers: `hello` = `{speaker: app.self(), info: app.info()}`, `state` = `app.state()`, `speakers` = `app.speakers()`.
- `Discovery` change → `hub.broadcast("speakers", app.speakers())`.
- `Engine` state change → `hub.broadcast("state", state)`; Engine UI request → `hub.broadcast("engine-ui", ui)`.
- `Engine.onAppClosed` → `System.exit(0)`; `cdp.closedFuture()` → `System.exit(0)`; shutdown hook → `engine.shutdown()` + destroy browser process.

---

## `Orchard.java`: application context

**Responsibility:** a small object everyone can reach, holding identity and the current components.

| Member | What it does |
|--------|--------------|
| `VERSION` | Version string shown in the banner and `/api/info`. |
| `env(name)` | `ORCHARD_<name>`, falling back to `JUICE_<name>` (the pre-rename variable names still work). |
| `init(hub, discovery)` | Late wiring (Hub and Discovery need `Orchard` to exist first). |
| `engine()` | Returns the Engine or throws `EngineException(503, engineProblem)` if there is none. Every API path that needs playback goes through this. |
| `setEngine`, `setEngineProblem` | Install the engine / record why there isn't one (also broadcasts a state update so UIs show it). |
| `state()` | The engine's state snapshot, or `{ready:false, offline:true, message}` without an engine. |
| `self()` | This speaker as `{id, name, url:null, self:true}`. |
| `info()` | `/api/info` body: `id, name, version, hostname, port, lanUrls, remotes[{url, kind, adapter}]`. |
| `speakers()` | `self()` plus every `Discovery.Peer` as `{id, name, url, self:false}`. |
| `announceChange(change, fromPeer)`, `libraryChanged(method, path, by)` | Change signals: broadcast a `change` event to every client here (deduplicated by id) and, for library changes made here, `POST /api/peer/change` to every linked computer (one hop). Called by `WebServer.appleWrite` after a successful write and by `artworkWrite`. |
| `remoteAddresses()` / `lanAddresses()` | Addresses phones can use (re-read on every call, so Wi-Fi/VPN changes are picked up). Empty with `--local`. |

---

## `WebServer.java`: HTTP front door

**Responsibility:** serve the UI files, the JSON API and the SSE event stream; enforce host/origin rules;
proxy Apple Music API calls into the engine; perform speaker hand-off.

Built on the JDK's `com.sun.net.httpserver.HttpServer` with `Executors.newVirtualThreadPerTaskExecutor()`,
so every request gets its own cheap virtual thread and long-lived SSE connections cost almost nothing.

| Member | What it does |
|--------|--------------|
| `HttpError` | Exception carrying an HTTP status; thrown anywhere in a handler, turned into `{"error": …}` JSON. (Also used by `HostLink`/`Engine`.) |
| `handle(HttpExchange)` | Single entry point for every request: host check → origin check (+ CORS headers) → `OPTIONS` preflight → `/api/…` to `api()`, everything else to `staticFile()`. Catches errors and always closes the exchange. |
| `api(...)` | **The route table** (a `switch` on `"METHOD /path"`). See [5-protocols.md](5-protocols.md#http-api) for every route. **Add new endpoints here.** |
| `events(...)` | `GET /api/events`: sets SSE headers and hands the connection to `Hub.serve(new Hub.SseClient(...))`, blocking until the client leaves. |
| `appleGet(...)` | `GET /api/am?path=…`: validates the path, serves from the 10-minute cache for `/v1/catalog/…` paths (max 400 entries, then cleared), else calls `Engine.api("GET", …)` and returns Apple's body and status. |
| `appleWrite(...)` | `POST /api/am {method, path, body}`: `POST/PUT/DELETE` to Apple via the engine (library adds, ratings, playlists). |
| `validateApplePath` | Only `/v1/…`, no `..`, no control characters, ≤ 4000 chars. |
| `transfer(...)` | `POST /api/transfer {to}`: hand playback to a known peer (export queue → POST `load` to peer → pause here). |
| `GET /api/img` (in `api()`) | Apple artwork for the Orchard window through `ArtCache`; loopback only. |
| `staticFile(...)` | Serves `web/…` from the classpath; unknown extensionless paths fall back to `index.html`. `Cache-Control: no-cache` plus an `ETag` (CRC32 + length), so repeat visits get `304`. Content types from the `TYPES` map. **Add a type there** if you add new file kinds. |
| `hostAllowed(host)` | DNS-rebinding protection: only `localhost`, IP literals, `*.local`, `*.ts.net` (Tailscale) or this computer's hostname. |
| `originAllowed(origin, host)` | Cross-site protection. Allows: same-origin requests (Origin matches Host), our own addresses on our port, and known Orchard peers. Everything else gets 403. |
| `body`, `query`, `sendJson`, `send` | Small helpers. Request bodies are capped at 1 MiB. |

**Editing notes**

- The app window never talks to `WebServer` directly; its requests arrive *forwarded* by `HostLink.forward`
  from `127.0.0.1` with no `Origin` header. So the same route code serves both the app window and phones.
- Anything you return is visible to every device on the network that can reach the port. Keep secrets
  (Apple tokens) out of responses.

---

## `ArtCache.java`: artwork on disk

**Responsibility:** keep every Apple picture the Orchard window shows (covers, banners) in `<data>/cache/artwork`,
so it loads instantly next time, even with a bad or no connection. Never touches music.

| Member | What it does |
|--------|--------------|
| `allowed(url)` | Only `https://*.mzstatic.com/…` (no user info, default port): the cache can't be used to fetch anything else. |
| `get(url)` | Disk hit → bytes (and refresh the file date at most hourly, for the LRU order). Miss → one download per picture however many ask (`loading`), checked to be JPEG/PNG/WebP/GIF, ≤ 20 MB, written via a temp file. Apple's 404 → 404, other failures → 502 (the UI keeps retrying). |
| `warm(urls)` | `POST /api/img/warm`: queue uncached pictures for 3 background workers (`warmWorker`). Refuses new ones (and drops the queue) above 85% of the limit, so warming never evicts pictures that were looked at. |
| `trimIfNeeded()` | Over the limit (`ORCHARD_CACHE_MB`, default 1024): delete the least recently viewed files until 90% of the limit is used. Also runs once at startup after counting the folder. |

---

## `Hub.java`: live events ("Connect")

**Responsibility:** know which UIs are connected and push events to all of them.

| Member | What it does |
|--------|--------------|
| `Client` (abstract) | `deviceId`, `name`, `kind` (`app`/`phone`/`tablet`/`computer`), `since`; `send(event, json)`; `ping()`. |
| `SseClient` | A browser with an open SSE response; `send` writes `event: X\ndata: {...}\n\n` and flushes; a failed write marks it done. |
| `register(Client)` | Adds a client, sends it `hello`, `state`, `speakers`, then broadcasts `devices` to everyone. |
| `unregister(Client)` | Removes it and re-broadcasts `devices`. |
| `serve(SseClient)` | register → block until the stream breaks → unregister. Called by `WebServer.events`. |
| `broadcast(event, data)` | Serialises once, sends to all clients. Non-SSE clients that fail are unregistered. |
| `devices()` | Connected clients de-duplicated by `deviceId` (a phone reconnecting doesn't appear twice). |

A heartbeat thread pings SSE clients every 15 s so dead connections are noticed.

---

## `HostLink.java`: the app window's channel

**Responsibility:** the app window lives on `https://music.apple.com/orchard/` and can't open plain-HTTP
connections to this computer, so HostLink provides its transport.

| Member | What it does |
|--------|--------------|
| `HostClient` (inner) | A `Hub.Client` whose `send` calls the *pusher* with `window.__orchardPush && window.__orchardPush("event", {...})`. |
| `setPusher(Consumer<String>)` | Set by `Engine.startEmbedded`: evaluate a JS string in the app window over CDP. |
| `handle(path, body)` | Requests to `/orchard/__host/...` (answered directly by `Engine.answerOrchardRequest`): `connect` = create a new `HostClient` (dropping the old one) and attach it; `speaker` = re-attach to another speaker; `console` = `ConsoleWindow.toggle()` (Ctrl+Shift+T, log window). |
| `attach(speaker)` | If `speaker` is a known peer → `startRelay`; otherwise register with the local `Hub`. |
| `startRelay(base, client)` | Opens the peer's `/api/events` SSE with `java.net.http` and forwards each event to the page. On failure sends `relay-lost`. |
| `pageGone()` | Called on every app-window navigation: drop the client and any relay. |
| `peerBase(url)` | Maps an address the page asked for to a known `Discovery.Peer` URL (or null). Prevents the page from making Java fetch arbitrary URLs. |
| `forward(method, path, contentType, body, peer)` | Performs the page's HTTP request against `http://127.0.0.1:<port>` (or a known peer if the page sent `X-Orchard-Peer`) and returns status/content-type/bytes as a `Response` record. |

---

## `Engine.java`: driving Apple's player

**Responsibility:** everything involving the browser after launch: set up the app window, serve
`/orchard`, unblock Apple's pages, create the hidden player frame, run commands inside Apple's page, receive
its state, show/hide it, fall back to window mode.

Read [1-big-picture.md](1-big-picture.md) first; this is the most intricate file.

**Key constants**

| Constant | Value / meaning |
|----------|-----------------|
| `ORCHARD_PREFIX`, `APP_URL` | `https://music.apple.com/orchard`, and the app window URL `…/orchard/?host=1`. |
| `ENGINE_URL` | `https://music.apple.com/`, which the hidden iframe loads. |
| `BINDING` | `__orchardEmit`, the CDP binding name the bridge calls. |
| `EMBED_TIMEOUT_MS` | 45 s before falling back to window mode. |
| `APPLE_DOCS` | Fetch patterns: Apple *Document* responses (to strip anti-framing headers). |
| `APP_INTERCEPT` | `APPLE_DOCS` + every request under `ORCHARD_PREFIX` at the request stage. |

**State held:** `mode` (`EMBEDDED`/`WINDOW`), `appTargetId`/`appSession` (the app window),
`engineTargetId` (window mode's separate window), `engineSession` (where Apple's page lives: equal to
`appSession` when embedded), `state` (merged player state), `signInRequested`, `shuttingDown`.

**Public operations** (called by `WebServer`)

| Method | What it does |
|--------|--------------|
| `start()` | `allowOutputChoice()` (CDP `Browser.grantPermissions` audioCapture for music.apple.com, so the page can see audio outputs by name), then find the app window target; `startEmbedded()` or `openEngineWindow()`. |
| `snapshot()`, `isReady()` | Copy of the merged state; `state.ready`. |
| `command(Map)` | Player command → bridge `cmd()`; merges and returns the resulting state. |
| `api(method, path, body)` | Apple Music API call through the bridge `api()`; returns `{status, body}`. |
| `exportQueue()` | Bridge `exportQueue()`, used for hand-off. |
| `signIn()`, `signOut()` | Show Apple's page for sign-in / call MusicKit `unauthorize`. |
| `showEngine(Boolean)` | Show/hide/toggle Apple's page: in embedded mode broadcasts `engine-ui`; in window mode restores/minimizes the window. |
| `shutdown()` | `Browser.close`. |

**Embedded mode internals**

| Method | What it does |
|--------|--------------|
| `startEmbedded()` | Attach to the app window; enable Fetch interception, Page/Runtime domains, the binding, the bridge script and auto-attach; reload to `APP_URL`; start the fallback watchdog. |
| `createFrame()` | Inject the `<iframe id="am-engine">` into `#engine-host` (only on `/orchard` pages, only once). Re-run on every `Page.loadEventFired`. |
| `onRequestPaused(ev)` | Dispatcher for `Fetch.requestPaused`: `/orchard` requests → `answerOrchardRequest`; other request-stage pauses continue; 2xx Apple documents → `unblockFraming`; others continue. |
| `answerOrchardRequest(...)` | `/__host/…` → `HostLink.handle`; everything else → `HostLink.forward` → `fulfill`. |
| `fulfill(...)` | `Fetch.fulfillRequest` with status, content type, `no-store`, base64 body. |
| `unblockFraming(...)` | Get body, remove `X-Frame-Options`, CSP `frame-ancestors`, `Content-Encoding`, `Content-Length`; fulfil. |
| `setupNestedFrame(...)` | For cross-site frames that get their own CDP target: enable the same unblocking, then resume them. |
| `fallBackToWindow()` | Remove the iframe and `openEngineWindow()`. |

**Window mode internals:** `openEngineWindow()` creates a new minimized window (`Target.createTarget`),
attaches, adds binding + bridge script, navigates to `ENGINE_URL`. `setWindowState()` minimizes/restores it
via `Browser.getWindowForTarget` / `Browser.setWindowBounds`.

**Events (`onCdpEvent`)**

| CDP event | Handling |
|-----------|----------|
| `Fetch.requestPaused` | `onRequestPaused` |
| `Runtime.bindingCalled` (`__orchardEmit`, from `engineSession`) | `handleEmit`: `state` → `mergeState` (+ sign-in auto-hide), `bye` → not ready, `ui` → toggle Apple's page, `boot` → debug log |
| `Runtime.consoleAPICalled` | Lines starting with `[orchard]` (the bridge's `log()`) are printed as `engine: …` |
| `Target.attachedToTarget` | Cross-site iframes → `setupNestedFrame`; workers → just resume |
| `Page.frameNavigated` (app window main frame) | Log, `hostLink.pageGone()`, not ready |
| `Page.loadEventFired` (app window) | `createFrame()` |
| `Target.targetDestroyed` | App window → quit; window-mode Apple window → reopen |
| `Inspector.targetCrashed` | Reload |

**Running code in Apple's page:** `invoke(fn, args…)` builds
`(() => { const w = <target>; …; return Promise.resolve(w.__orchard.fn(args)); })()`, where `<target>` is
`document.getElementById('am-engine').contentWindow` (embedded) or `window` (window mode). Arguments are
embedded with `Json.write` (safe: JSON is valid JavaScript, and `Json` escapes `<` and line separators).
`evaluate()` runs it with `awaitPromise`, `returnByValue`, `userGesture` (lets `play()` start audio) and a
30 s timeout, and converts JavaScript exceptions into `EngineException`s. Bridge functions return JSON
*strings*, which `invoke` parses.

---

## `CdpClient.java`: Chrome DevTools Protocol client

**Responsibility:** one WebSocket to the browser; send commands and await their results; deliver events.

| Member | What it does |
|--------|--------------|
| `connect(wsUrl)` | Opens the WebSocket (`java.net.http`). |
| `send(method, params, sessionId)` | Assigns an id, writes `{id, method, params, sessionId}`, returns a `CompletableFuture` completed when the reply with that id arrives. Writes are serialised (`sendLock`) because the JDK WebSocket allows one send at a time. |
| `call(..., timeoutSeconds)` | Blocking `send` (default 60 s). Throws `CdpException` on protocol errors/timeouts. |
| `onEvent(listener)` | Registers a listener. **Events are delivered on a single dedicated thread, in order.** Listeners must not block for long; `Engine` starts virtual threads for slow work. |
| `closedFuture()` | Completes when the connection drops (used to exit Orchard). |
| `onText` / `dispatch` | Reassembles fragmented frames, parses JSON, completes futures or queues events. |

`sessionId` selects which target (window/frame) a command goes to; `null` = the browser itself.

---

## `BrowserLauncher.java`: finding and launching the browser

| Member | What it does |
|--------|--------------|
| `find(override)` | `--browser` → `ORCHARD_BROWSER` → default browser if Chromium (`isChromium`) → `fallback()`. |
| `CHROMIUM_EXES`, `isChromium` | Executable names Orchard accepts as Chromium-with-Widevine. |
| `fallback()` | Known install paths of Chrome, Edge, Brave per OS. |
| `defaultBrowser()` | `windowsDefault()` (registry via `reg query`: `UserChoiceLatest\ProgId` first, since newer Windows 11 builds keep the real choice there, then `UserChoice`; then the ProgId's `shell\open\command`), `macDefault()` (`defaults read … LSHandlers`, bundle id → app path), `linuxDefault()` (`xdg-settings`). |
| `launch(exe, profile, appUrl, log, extraArgs)` | Clean up leftovers, prepare the profile, start the process with the flags listed in the timeline, wait for `DevToolsActivePort`. |
| `prepareProfile` / `setPref` | Brave: pre-enable Widevine in the profile's JSON preference files. |
| `closeLeftoverBrowser` | Connect to a stale browser from a previous crash and `Browser.close` it. |

To add a browser: add its executable name to `CHROMIUM_EXES`, its paths to `fallback()`, and (macOS) its
bundle id to `macDefault()`.

---

## `Discovery.java`: finding other speakers

UDP port `8788`: multicast on group `239.255.77.77`, TTL 1 (physical LAN), plus unicast to Tailscale devices and
`--peer` hosts (Tailscale carries no multicast).

| Member | What it does |
|--------|--------------|
| `Peer` record | `id, name, url, lastSeen`. |
| `start()` | Bind, join the group on every `Net.lanInterfaces()` interface (none is OK: unicast still runs), start the receive and announce threads. Failing to bind disables discovery. |
| `announce()` | Send `{app:'orchard', id, name, port}` by multicast on every LAN interface and by unicast to every target (every 3 s, and immediately when a new peer appears). |
| `refreshUnicastTargets()` | Every 20 s: resolve `--peer` hosts and read online Tailscale IPv4s from `tailscale status --json` (CLI from `ORCHARD_TAILSCALE`, `%ProgramFiles%\Tailscale`, the macOS app, or `PATH`). |
| `receiveLoop()` | Parse packets, ignore our own id, record peers with URL `http://<sender-ip>:<port>` (keeping a LAN address over a Tailscale one while it still answers), reply directly to newcomers, call `onChange` when something changes. |
| `expire()` | Drop peers not heard from for 10 s. |
| `peers()`, `peerByUrl(url)` | Used by `Orchard.speakers()`, `WebServer` (origin checks, transfer) and `HostLink`. |

Multicast doesn't cross VPNs or isolated campus Wi-Fi; that is what the Tailscale/`--peer` unicast path is for.

---

## `Net.java`: addresses

| Member | What it does |
|--------|--------------|
| `Kind`, `Address` | `LAN` / `TAILSCALE` / `PUBLIC`; `(ip, kind, adapter)`. |
| `hostname()` | `COMPUTERNAME`/`HOSTNAME`/`InetAddress`, cut at the first dot. |
| `lanInterfaces()` | Up, non-loopback, multicast-capable, not internal (Docker/WSL/Hyper-V/VMware…) and not a tunnel. Used by Discovery. |
| `remoteAddresses()` | Every IPv4 a phone might reach, skipping internal adapters; classified (Tailscale = adapter name or `100.64.0.0/10`; LAN = private ranges; otherwise public) and sorted LAN → Tailscale → public. Used by the banner and the pairing panel. |
| `isIpLiteral(host)` | Used by `WebServer.hostAllowed`. |

`INTERNAL` and `TUNNELS` are word lists matched against adapter names. Edit them if a real adapter is being
skipped or a virtual one is showing up.

---

## `Json.java`: JSON without reflection

Objects become `LinkedHashMap<String,Object>`, arrays `ArrayList<Object>`, integers `Long`, other numbers
`Double`, plus `String`/`Boolean`/`null`.

| Member | Use |
|--------|-----|
| `parse(text)`, `parseObject(text)` | Parse anything / require an object. |
| `write(obj)` | Serialise maps, iterables, arrays, strings, numbers, booleans, null. Escapes `<`, U+2028/2029 and control characters, so output is also safe inside JavaScript source. |
| `obj(k1, v1, k2, v2, …)` | Build an ordered mutable map: the idiom used everywhere for CDP params and API responses. |
| `map(o)`, `list(o)`, `str(m, k)`, `bool(m, k)` | Null-tolerant accessors for parsed data. |

Why not Jackson/Gson? They rely on reflection, which GraalVM native-image needs extra configuration for.

---

## `ConsoleWindow.java`: the log file and log window

**Responsibility:** orchard.exe on Windows is a windowed program (`build.cmd` runs `editbin /subsystem:windows`), so
no terminal opens. Everything `Log` prints also goes to `<data>/orchard.log`, and this class opens a window that
follows that file. Pure Java: the window is `conhost.exe` (the classic console, whatever the default terminal is)
running PowerShell `Get-Content -Wait`.

| Member | What it does |
|--------|--------------|
| `append(text)` | Called by every `Log` method. Before `logTo` it keeps the text in memory (max 1 MB). |
| `logTo(file)` | Called by `Main` once the port is bound (so a second Orchard can't wipe the running one's log). Truncates the file, writes what was kept, closes the log window at exit. |
| `toggle()` | From `HostLink` (`/__host/console`) or `Engine` (`{type:'ui', action:'console'}` from Apple's page). Returns `shown` / `hidden` / `unavailable` (not Windows, or no log file). |
| `show()` | `--console`, or no browser could be started (no Orchard window will open, so the log says why). |
| `exitShowing(code)` | Startup exits (`--help`, bad option, port in use). With no terminal attached, writes the text to `%TEMP%\orchard-startup.log` and opens a window that stays after Orchard exits. |

---

## `Access.java`: who may use this Orchard

**Responsibility:** keys for paired devices and linked computers. Requests from this computer (127.0.0.1, including
the Orchard window) are always trusted. Every other `/api` caller needs a key (see "Keys" in
[5-protocols.md](5-protocols.md)).

| Member | What it does |
|--------|--------------|
| `keyFor(deviceId)`, `valid(deviceId, key)` | Make a key with the primary secret / check one against every secret in the keyring (constant-time). |
| `invite()`, `claim(code, deviceId)` | QR invites (10 min, reused while fresh) and trading one for a key. |
| `request(...)`, `requestStatus(id, secret)`, `pending()`, `decide(id, allow)` | "Ask for access": max 8 waiting, 5 min each; only the asking device (holding `secret`) can collect the key. |
| `exportKeys()`, `merge(keys)`, `markLinked`/`isLinked`/`unlink` | Used by `AccountLink` when another computer proves it's on the same account. |
| `reset(why)` | New secret, nothing linked. Called on Apple Music sign-out (`Orchard.signedOut`, also after 30 s signed out in Apple's page) and by Settings > Paired devices. |

---

## `AccountLink.java`: proving the same Apple Music account

**Responsibility:** links two Orchard computers only if both are signed in to the same Apple Music account, with
Apple's library as the witness. An X25519 key exchange gives both sides K. Each side adds a private playlist named
`Orchard pairing <HMAC(K, its id)>`, and the other side must find that name in *its own* library. Only then are the
keyrings swapped, AES-GCM-encrypted with K, and the playlists deleted. Someone relaying the messages ends up with a
different K on each side, so the playlist names don't match. The class doc comment has the step-by-step.
`start()` tries every unlinked computer heard on the network (the lower id first, at most once per 10 minutes) and
re-checks linked ones every 2 minutes (`GET /api/access` with our key). Production `Library` = Apple's API through
the engine; `Transport` = HTTP. Both are interfaces so the handshake can be tested without Apple.

---

## `Updater.java`: automatic updates

**Responsibility:** keeps a release-built `orchard.exe` in step with the newest GitHub release of `Updater.REPO`
(see "Releases and automatic updates" in [6-build-and-config.md](6-build-and-config.md)). Windows exe only; on a
JVM or another OS `status()` reports `supported: false`.

| Member | What it does |
|--------|--------------|
| `start()` | Schedules the first check (30 s), a check every 6 h, cleanup of `orchard.old.exe`, and the idle-restart watch (every minute). |
| `status()` | `GET /api/update`: `supported, enabled, blocked, dev, current, latest, ready, status, message, checkedAt`. `status` is `idle/off/checking/downloading/current/ready/error/unsupported`. |
| `setEnabled(on)` | `POST /api/update {enabled}`; saved in `<data>/auto-update`. |
| `checkNow()` | `POST /api/update {action:'check'}`; checks and installs even when automatic updates are off. |
| `restartNow()` | `POST /api/update {action:'restart'}`: starts the new exe with `--wait-for <pid>` and exits. |
| `waitForExit(pid)` | Called by `Main` for `--wait-for`, before anything takes the port or the browser profile. |

---

## `Log.java`: console logging

`Log.info`, `Log.warn`, `Log.debug` print `HH:mm:ss LEVEL message`. Debug lines only appear with `--debug`
or the `ORCHARD_DEBUG` environment variable.
