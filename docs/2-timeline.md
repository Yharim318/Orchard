# 2. A session, start to finish

This follows one realistic session in the order things actually happen. Each step names the file and
function responsible, so you can open the code alongside. Java files are in `src/main/java/orchard/`, web
files in `src/main/resources/web/`, and the bridge is `src/main/resources/engine/engine.js`.

Contents:

- [Stage 0: Building](#stage-0-building)
- [Stage 1: Orchard starts (Java only)](#stage-1-orchard-starts-java-only)
- [Stage 2: The browser is launched](#stage-2-the-browser-is-launched)
- [Stage 3: The engine takes control of the app window](#stage-3-the-engine-takes-control-of-the-app-window)
- [Stage 4: The Orchard UI loads in the app window](#stage-4-the-orchard-ui-loads-in-the-app-window)
- [Stage 5: Apple's player loads inside the UI](#stage-5-apples-player-loads-inside-the-ui)
- [Stage 6: State flows to the UI](#stage-6-state-flows-to-the-ui)
- [Stage 7: Signing in](#stage-7-signing-in)
- [Stage 8: Browsing (Apple Music API calls)](#stage-8-browsing-apple-music-api-calls)
- [Stage 9: Pressing play](#stage-9-pressing-play)
- [Stage 10: A phone connects as a remote](#stage-10-a-phone-connects-as-a-remote)
- [Stage 11: Another Orchard computer appears and playback is handed over](#stage-11-another-orchard-computer-appears-and-playback-is-handed-over)
- [Stage 12: Favorites, lyrics, queue](#stage-12-favorites-lyrics-queue)
- [Stage 13: Quitting](#stage-13-quitting)
- [Stage 14: When things go wrong](#stage-14-when-things-go-wrong)

---

## Stage 0: Building

1. `build.sh` (macOS/Linux) or `build.cmd` (Windows) compiles every `.java` file with `javac --release 21`.
2. It copies everything in `src/main/resources/` next to the compiled classes, so the UI files, `engine.js`
   and the native-image settings end up *inside* `build/orchard.jar`.
3. It runs GraalVM's `native-image` on the JAR. `native-image` reads
   `META-INF/native-image/orchard/orchard/native-image.properties` from inside the JAR, which tells it to embed
   the `web/` and `engine/` resources and to enable HTTP/HTTPS. The result is a single executable,
   `build/orchard` (or `build\orchard.exe`) with the JVM, the code and all UI files baked in.

At run time, `WebServer.staticFile` and `Main.resource` read those embedded files with
`Class.getResourceAsStream`, which works the same in the JAR and in the native binary.

## Stage 1: Orchard starts (Java only)

Everything begins in **`Main.main`**:

1. **`Main.parse`** reads command-line options (`--port`, `--name`, `--browser`, `--data`, `--local`,
   `--no-browser`, `--engine-window`, `--headless`, `--debug`).
2. **`Main.defaultDataDir`** picks the data folder (Windows `%LOCALAPPDATA%\Orchard`, macOS
   `~/Library/Application Support/Orchard`, Linux `~/.local/share/orchard`). Orchard was called Juice before;
   **`Main.adoptLegacyDataDir`** moves an old `Juice` / `juice` folder (with the signed-in browser profile) to
   the new name, but only when nothing answers on the port (no other copy running) and the new folder doesn't
   exist yet. If the move fails it keeps using the old folder and tries again next start.
3. **`Main.loadOrCreateId`** reads or creates `speaker-id` in that folder: a random UUID identifying this
   computer as a speaker. The speaker name defaults to the computer's name (`Net.hostname`).
4. **`new Orchard(...)`** creates the shared application context (`Orchard.java`). It holds the id, name, port
   and references to the other components.
5. **`new Hub(...)`** creates the live-event hub. It is given three suppliers so it can build fresh
   snapshots whenever a device connects: `hello` (who this speaker is + `Orchard.info()`), `state` (the
   player state, `Orchard.state()`), and `speakers` (this computer plus discovered peers, `Orchard.speakers()`).
6. **`new Discovery(...)`** prepares LAN discovery. Its change callback broadcasts the speaker list to every
   device via `hub.broadcast("speakers", …)`.
7. **`new WebServer(app, bindAddress, port)`** creates the HTTP server on `0.0.0.0:8787` (or `127.0.0.1` with
   `--local`). It uses a *virtual-thread-per-request* executor, so slow requests (like the long-lived event
   streams) never block others. If the port is taken, Orchard prints a message and exits.
8. `server.start()` begins accepting requests; `discovery.start()` joins the multicast group and starts
   announcing (Stage 11).
9. The banner is printed, including one "Phone remote:" line per address from **`Net.remoteAddresses`**
   (Wi-Fi/LAN first, then Tailscale, then public addresses; internal VM adapters such as WSL's are skipped).
10. **`Main.startEngine`** is called (skipped with `--no-browser`, in which case `Orchard.setEngineProblem`
    records why nothing can play).
11. Finally `main` blocks forever on a latch; the program lives until something calls `System.exit`.

## Stage 2: The browser is launched

Inside **`Main.startEngine`**:

1. **`BrowserLauncher.find`** chooses the browser, in this order: `--browser` flag → `ORCHARD_BROWSER`
   environment variable → the OS default browser if it's Chromium-based (`BrowserLauncher.defaultBrowser`:
   Windows registry `UserChoiceLatest`/`UserChoice`, macOS LaunchServices, Linux `xdg-settings`) → the first
   installed of Chrome, Edge, Brave (`BrowserLauncher.fallback`). If nothing is found the UI later shows the
   reason.
2. A profile folder is chosen per browser: `<data>/browser-brave`, `<data>/browser-msedge`, … Orchard never
   touches your normal browser profile. Browsers can't share one profile folder, hence one per browser.
3. **`BrowserLauncher.launch`**:
   - **`closeLeftoverBrowser`**: if a `DevToolsActivePort` file exists from a crashed run, connect to that
     old browser and close it (otherwise the new launch would just hand off to it and exit).
   - **`prepareProfile`**: for Brave only, sets `brave.widevine_opted_in=true` in the profile's `Local State`
     and `Default/Preferences` so DRM works without Brave's prompt.
   - Starts the browser process with: `--user-data-dir=<profile>`, `--remote-debugging-port=0` (pick any free
     port), `--app=https://music.apple.com/orchard/?host=1` (a chrome-less app window), `--no-first-run`,
     `--autoplay-policy=no-user-gesture-required`, background-throttling switches, and the window size.
     The browser's own console output goes to `<data>/browser.log`.
   - Polls for the `DevToolsActivePort` file the browser writes into the profile, which holds the port and
     WebSocket path, for up to 30 s. Returns a `Running` record with the WebSocket URL.
4. **`CdpClient.connect(wsUrl)`** opens one WebSocket to the browser. All further browser control goes
   through it (see Stage 3).
5. **`new HostLink(app)`** creates the app window's private event channel (used from Stage 4 on).
6. **`new Engine(...)`** receives: the CDP client, the URL prefixes that identify the app window, the
   `engine.js` source text (`Main.resource("/engine/engine.js")`), whether to use window mode, the HostLink,
   and two callbacks: state changes → `hub.broadcast("state", …)`, show/hide requests for Apple's page →
   `hub.broadcast("engine-ui", …)`.
7. `app.setEngine(engine)`; exit hooks are registered: closing the app window → `System.exit(0)`; browser
   connection lost → exit; JVM shutdown hook → `engine.shutdown()` (sends `Browser.close`) and kills the process.
8. **`engine.start()`**.

> At this moment the app window has already started loading `https://music.apple.com/orchard/?host=1`, and
> since Orchard isn't intercepting yet, Apple answers with a 404 page. That's the brief flash you may see.
> Stage 3 replaces it.

## Stage 3: The engine takes control of the app window

**`Engine.start`**:

1. Subscribes `onCdpEvent` to every CDP event and enables target discovery (`Target.setDiscoverTargets`), so
   it hears about windows/frames being created and destroyed.
2. **`findAppTarget`** looks for the page target whose URL starts with `https://music.apple.com/orchard` or the
   localhost URL; since the app window is the only page, it falls back to the first page.
3. Normally calls **`startEmbedded`** (or `openEngineWindow` in window mode; see Stage 14).

**`Engine.startEmbedded`** sets up everything *before* reloading the window:

1. `Target.attachToTarget(flatten)` gives a **session id** for the app window. With "flattened" sessions,
   every CDP command for that window is sent over the same WebSocket with `sessionId` attached.
   `appSession` and `engineSession` are both set to it (in embedded mode Apple's player lives inside this page).
2. `hostLink.setPusher(js → Runtime.evaluate(js) in the app window)` lets HostLink push events into the page.
3. `Fetch.enable` with `APP_INTERCEPT` patterns:
   - `https://music.apple.com/orchard*` at the **Request** stage (all resource types): Orchard will answer these;
   - `https://*.apple.com/*` and `https://apple.com/*` **Documents** at the **Response** stage: Orchard will
     strip anti-framing headers from these.
4. `Page.enable`, `Runtime.enable` turn on page lifecycle and console/binding events.
5. `Runtime.addBinding("__orchardEmit")` creates a function `window.__orchardEmit(string)` in every frame of the
   window; calling it from JavaScript fires a `Runtime.bindingCalled` CDP event in Java. This is how the
   bridge reports state.
6. `Page.addScriptToEvaluateOnNewDocument(engine.js)` makes the browser run `engine.js` in every new document
   in this window *before the page's own scripts*, including frames.
7. `Target.setAutoAttach` makes Orchard auto-attach to any cross-site frames that appear (rare here; see
   `setupNestedFrame`).
8. `Page.navigate(APP_URL)` reloads the window, now with interception active.
9. A watchdog thread is started: if Apple's player isn't `ready` within 45 s, `fallBackToWindow` (Stage 14).

## Stage 4: The Orchard UI loads in the app window

1. The window requests `https://music.apple.com/orchard/?host=1`. The browser pauses it and Java receives
   **`Fetch.requestPaused`** → `Engine.onRequestPaused` → (request stage, URL under `/orchard`) →
   **`Engine.answerOrchardRequest`** on a virtual thread.
2. `answerOrchardRequest` strips the prefix (`/orchard/?host=1` → `/?host=1`) and calls
   **`HostLink.forward`**, which makes a real HTTP request to `http://127.0.0.1:8787/?host=1`, i.e. Orchard's
   own `WebServer`.
3. **`WebServer.handle`**: the Host header is `127.0.0.1` (allowed by `hostAllowed`), there's no `Origin`
   header (allowed), the path isn't `/api/…`, so **`WebServer.staticFile`** returns the embedded
   `web/index.html`.
4. Back in Engine, **`fulfill`** answers the paused request with that body (`Fetch.fulfillRequest`). Apple's
   servers are never contacted.
5. Java also receives `Page.frameNavigated` for the main frame → logs "Orchard window loaded …", calls
   `hostLink.pageGone()` (forget any previous page's channel) and marks the engine not ready.
6. The browser parses `index.html`. It references `app.css`, `icon.svg`, `manifest.webmanifest` and
   `js/app.js` with **relative** URLs, so they resolve to `/orchard/app.css` etc. and go through the same
   interception → forward → `staticFile` path. ES module imports (`./store.js` …) do too.
   *(This is why every URL in the UI must be relative or prefixed with `ROOT`; see the editing guide.)*
7. `engine.js` also runs in this top-level Orchard page (step 6 of Stage 3), but its guard sees the path
   starts with `/orchard` and exits immediately.
8. **`app.js` → `boot()`** runs:
   1. `buildShell()` fills the sidebar, library header, phone tab bar and the phone's Back button.
   2. `initPlayer()` (`player.js`) builds the player bar, mini player, full-screen player, wires controls,
      the overlay and the right panel, and starts a 250 ms `tick` timer for the progress bar.
   3. `bindSidebar()`, `bindGlobalClicks()`, `bindKeys()` attach the global event handlers.
   4. Listens for `hashchange` → `route()` (all navigation is `#/...` hash routing).
   5. Subscribes to store changes: when the engine becomes ready+signed in, reload the library and re-render
      the current page; on every state change, `markPlaying()`.
   6. `await init()` (`store.js`):
      - `HOST_PROXY` is true because `location.hostname === 'music.apple.com'`, so `ROOT = '/orchard'`.
      - `GET /orchard/api/info` → forwarded → **`WebServer.api`** → `Orchard.info()`: id, name, hostname,
        port, and the list of addresses phones can use (`remotes`). Stored in `S.info`.
      - Restores the chosen speaker (`localStorage['orchard.speaker']`, normally `''` = this computer).
      - **`connect()`**: defines `window.__orchardPush(event, data)` and POSTs `/orchard/__host/connect` with
        `{deviceId, name, kind:'app', speaker}`.
   7. `renderSidebarLibrary()` and `route()` render the first page (Home).
9. The `/orchard/__host/connect` request is intercepted like everything else, but `answerOrchardRequest` handles
   `/__host/…` paths itself: **`HostLink.handle("/__host/connect")`** creates a **`HostClient`** (a hub client
   whose `send` evaluates `window.__orchardPush(event, data)` in the page) and, since no other speaker was
   chosen, **`Hub.register`**s it. `register` immediately sends `hello`, `state` and `speakers`, then
   broadcasts the updated `devices` list to everyone. Console: "Device connected: Orchard app (…)".
10. In the page, `__orchardPush` dispatches to the `handlers` table in `store.js`: `hello` sets `S.speaker`,
    `state` calls `setState`, and so on. Each handler calls `notify(kind)`, and subscribers (player,
    overlay, app) re-render.

At this point the engine isn't ready yet, so **`player.js` → `updateOverlay`** shows "Starting Apple Music…".

## Stage 5: Apple's player loads inside the UI

1. When the Orchard page finishes loading, Java receives `Page.loadEventFired` → **`Engine.createFrame`**
   evaluates a snippet in the page that adds
   `<iframe id="am-engine" src="https://music.apple.com/" sandbox="…" allow="autoplay; encrypted-media; …">`
   inside `<div id="engine-host">` (defined in `index.html`).
   - `sandbox` has no `allow-top-navigation`, so Apple's page can never navigate the Orchard window away.
   - `allow=` grants DRM (`encrypted-media`), autoplay, passkeys and focus to Apple's frame.
   - CSS (`#engine-host` in `app.css`) keeps it full-size but `opacity: 0`, `z-index: -1` and
     click-through, so it keeps rendering at full speed but is invisible.
2. The iframe requests `https://music.apple.com/`. It's an Apple **document**, so the browser pauses it at
   the **response** stage → **`Engine.unblockFraming`**: fetch the body (`Fetch.getResponseBody`), drop
   `X-Frame-Options`, remove `frame-ancestors` from the CSP, drop encoding/length headers (the body is already
   decoded), and `Fetch.fulfillRequest` with the result. Apple redirects `/` to e.g. `/us/new`; redirects pass
   through untouched and the final document is unblocked the same way.
3. Because the iframe is same-site with the Orchard page, it runs in the same browser process and belongs to
   the same CDP session. `engine.js` runs in it before Apple's scripts (Stage 3, step 6).
4. **`engine.js`** starts:
   - The guard confirms it's the `#am-engine` frame on music.apple.com.
   - Emits `{type:'boot'}` (Java logs it with `--debug`).
   - Installs a Ctrl+Shift+A / Ctrl+Shift+T key listener (so the shortcut works while Apple's page has focus) and a
     `pagehide` listener that emits `{type:'bye'}`.
   - Polls every 300 ms for `MusicKit.getInstance()`. Apple's own code configures MusicKit as its page boots.
   - **`attach(instance)`** subscribes to MusicKit events (now-playing changes, queue changes,
     play/pause, volume, shuffle/repeat, authorization, time updates) and schedules a first full report.
   - Defines `window.__orchard = { cmd, api, exportQueue, state, authorize, unauthorize }`.

## Stage 6: State flows to the UI

This loop runs for the rest of the session, every time anything changes in the player:

```
MusicKit event (in Apple's iframe)
  → engine.js schedule(full)          coalesces bursts (60 ms); time updates at most every 5 s
  → engine.js snapshot(full)          builds the state object (see 5-protocols.md)
  → window.__orchardEmit(JSON)          the CDP binding
  → Java: Runtime.bindingCalled       Engine.onCdpEvent
  → Engine.handleEmit → mergeState    merges into Engine.state; notes sign-in changes
  → onState callback (Main)           hub.broadcast("state", fullState)
  → Hub: every client.send("state")   SSE clients write "event: state"; the HostClient
                                      evaluates window.__orchardPush('state', {...}) in the app window
  → store.js handlers.state → setState → notify('state')
  → player.js update(), app.js markPlaying(), overlay, right panel, queue view …
```

The first report has `ready: true`, so the overlay switches to the sign-in card if `authorized` is false.

The UI never asks for the position every second. `store.positionNow()` extrapolates from the last
reported `position` and the time it arrived (`S.stateAt`), and `player.js tick()` redraws the progress bar
every 250 ms.

## Stage 7: Signing in

1. The overlay (`player.js updateOverlay`) shows "Sign in to Apple Music". Clicking **Sign in**
   (`bindOverlay`):
   - `setEngineVisible(true, true)` adds `body.engine-visible`. CSS raises `#engine-host` above everything
     and shows the orange "Back to Orchard" bar. The `true` second argument means "hide again automatically
     once signed in".
   - `post('/api/signin')` → forwarded → `WebServer` → **`Engine.signIn`** sets `signInRequested` and calls
     `showEngine(true)`, which broadcasts `engine-ui {show:true}` (this is what makes a *phone's* Sign-in
     button open the page on the computer).
2. You use Apple's own page: its **Sign In** button opens Apple's login box (an `idmsa.apple.com` frame).
   Because everything in the window is on apple.com, the login box, its cookies and the final token exchange
   are all first-party.
3. MusicKit fires `authorizationStatusDidChange` → `engine.js` reports `authorized: true` → Java
   `handleEmit` logs "Signed in to Apple Music." and, since sign-in was requested, `showEngine(false)` →
   broadcasts `engine-ui {show:false}` → the UI hides Apple's page. (`player.js` also hides it itself
   when it sees `authorized` while `engineForSignIn` is set.)
4. `app.js` notices the ready+authorized transition and calls `renderSidebarLibrary()` and `route()`, so
   your library and personalised home load.
5. The browser profile remembers the login, so later launches skip this stage.

**Ctrl+Shift+A** at any time toggles Apple's page: `app.js bindKeys` → `player.js toggleEngine` when the
Orchard UI has focus, or `engine.js` key listener → `{type:'ui'}` → `Engine.handleEmit` → `showEngine(null)` →
`engine-ui {toggle:true}` when Apple's page has focus.

## Stage 8: Browsing (Apple Music API calls)

Example: the Home page.

1. `route()` (`app.js`) matches `#/` against the `routes` table in `views.js` → **`home(el)`**.
2. `home` calls `am('/v1/me/recent/played?limit=10')`, `am('/v1/me/recommendations…')` and
   `am('/v1/catalog/us/charts…')` in parallel.
3. **`store.am(path)`** → `GET /orchard/api/am?path=<encoded>` (catalog paths are also memoised in the page).
4. Intercepted → forwarded → **`WebServer.appleGet`**: validates the path (`/v1/…`, no `..`), checks the
   10-minute **catalog cache**, otherwise **`Engine.api("GET", path)`**.
5. **`Engine.invoke("api", …)`** builds a JavaScript expression that finds
   `document.getElementById('am-engine').contentWindow.__orchard` and calls `api(method, path, body)`;
   **`Engine.evaluate`** runs it with `Runtime.evaluate(awaitPromise, returnByValue, userGesture)` in the app
   window.
6. **`engine.js api()`** does `fetch('https://amp-api.music.apple.com' + path)` with Apple's developer
   token and your user token as headers (exactly what Apple's own site does), and returns
   `JSON.stringify({status, body})`.
7. The result travels back: Java parses it, `appleGet` returns Apple's JSON body with Apple's status code,
   `fulfill` hands it to the page.
8. `home` turns Apple's resources into rows and cards with **`components.js`** (`toTrack`, `toCard`,
   `trackRows`, `shelf`, …) and sets `el.innerHTML`. `markPlaying()` highlights the current song and
   `hydrateLoves()` fills in heart icons (batched ratings lookups).

Other pages work the same way. The album page, for example, fetches `/v1/catalog/{sf}/albums/{id}?include=tracks,artists`.

## Stage 9: Pressing play

Double-clicking (desktop) or tapping (touch) a track row:

1. `app.js bindGlobalClicks` → `playRow(row)` → **`components.playList(listKey, index)`**.
   Every rendered track list was registered with `registerList(tracks, ctx)`, so the row's `data-list` key
   recovers the track array and its context: for an album, `ctx.collection = {album: id}`.
2. `playList` sends **`cmd({type:'playQueue', queue:{album:id}, startIndex})`**. Albums and playlists are
   queued as collections; loose lists (search results, top songs) as `{songs:[ids…]}`.
3. **`store.cmd`** → `speakerRequest('/api/cmd')` → `POST /orchard/api/cmd` (to another speaker it would add
   the `X-Orchard-Peer` header; see Stage 11).
4. Forwarded → **`WebServer.api` "POST /api/cmd"** → **`Engine.command(body)`** → `invoke("cmd", body)`.
5. **`engine.js cmd()`** → `playQueue()` → `MusicKit.setQueue({album, startWith})` then `play()`. MusicKit
   calls can hang while media loads, so each await is wrapped in `settle()` (gives up waiting after 6–15 s;
   errors still propagate).
6. `cmd` returns a full snapshot; Java merges it and replies; `store.cmd` applies it right away (snappy UI).
7. Meanwhile MusicKit fires events (now playing, playback state…), which reach **every** device through the
   Stage 6 loop. Audio comes out of the computer: MusicKit decrypts it with the browser's Widevine module
   inside the hidden iframe.

Player-bar buttons work the same way (`player.js control` → `cmd({type:'next'})`, etc.).
`patchState` applies an optimistic change first (for example flipping the play/pause icon) so the UI never feels laggy.

## Stage 10: A phone connects as a remote

1. On the computer, the Devices button (`player.js openDevices`) shows `pairingHtml()`: one tab per entry
   in `S.info.remotes` (Wi-Fi/LAN, Tailscale, Public IP) and a QR code drawn by `vendor/qrcode.js`.
2. The phone opens e.g. `http://100.120.202.64:8787/`. **`WebServer.handle`**: the Host is an IP literal
   (allowed), no Origin on a top-level page load → `staticFile` → `index.html` and the same JS files.
3. In the phone's browser `HOST_PROXY` is false and `ROOT` is `''`. `init()` fetches `/api/info`, then
   **`connect()`** opens `new EventSource('/api/events?deviceId=…&name=Android · Chrome&kind=phone')`.
4. **`WebServer.events`** sends SSE headers, writes `retry: 2000`, and calls **`Hub.serve(new SseClient(…))`**,
   which registers the client (hello/state/speakers + devices broadcast) and then blocks that virtual
   thread until the connection breaks. Every 15 s the hub writes a `: ping` comment to detect dead clients.
5. The phone's commands are ordinary same-origin `fetch` calls to `/api/cmd` etc. `WebServer.originAllowed`
   accepts them because the `Origin` header matches the `Host` the phone used. A web page on some other
   site, by contrast, is rejected.
6. The phone layout comes from the `@media (max-width: 760px)` rules in `app.css`: bottom tab bar, mini
   player, full-screen player (`player.js openFull`), bottom-sheet menus.
7. When the phone sleeps or leaves, the stream breaks, a later write fails, `Hub.serve` returns and
   unregisters it ("Device disconnected").

## Stage 11: Another Orchard computer appears and playback is handed over

1. Every Orchard instance runs **`Discovery`**: it joins UDP multicast group `239.255.77.77:8788` on each
   physical network interface and announces `{app:'orchard', id, name, port}` every 3 s, by multicast there and
   by unicast to every online Tailscale device and `--peer` host.
2. When computer B's announcement reaches A, `Discovery.receiveLoop` records a `Peer` with URL
   `http://<B's address>:<port>`, announces back immediately, and calls the change callback →
   `hub.broadcast("speakers", Orchard.speakers())`. Peers silent for 10 s are dropped (`expire`).
3. In the UI, `handlers.speakers` → `normalizeSpeakers` gives each speaker a `base` ('' for the computer that
   served this page, otherwise its URL), and the Devices panel lists B under "Select a device".
4. Choosing B → **`store.selectSpeaker(sp)`**:
   - If music is playing, `post('/api/transfer', {to: sp.url})` goes to the **current** speaker (A).
     **`WebServer.transfer`** checks B is a known peer, calls **`Engine.exportQueue`** (the bridge returns
     up to 500 catalog ids around the current track, the index, position, repeat and playing flag),
     POSTs `{type:'load', …}` to B's `/api/cmd` (B's `engine.js` rebuilds the queue, seeks and plays),
     then pauses A.
   - **`useSpeaker(base)`** saves the choice, clears the state and calls `connect()` again:
     - on a **remote**: a new `EventSource` to `http://B/api/events`;
     - in the **app window**: `POST /orchard/__host/connect` with `speaker: B` → **`HostLink.attach`** starts a
       **relay**: Java opens B's SSE stream itself (`startRelay`) and forwards each event into the page.
       App-window commands to B carry the header `X-Orchard-Peer: http://B…`; `HostLink.forward` sends them to
       B (only if B is a known peer).
5. If the connection to B dies, the remote's `EventSource` gives up after 4 errors, or HostLink sends
   `relay-lost`, and the UI falls back to this computer (`useSpeaker('')`).

## Stage 12: Favorites, lyrics, queue

- **Favorites (heart)**: `components.setLoved(id, true)` → `amWrite('PUT', '/v1/me/ratings/songs/{id}',
  {type:'rating', attributes:{value:1}})` (Apple's "Favorite" rating) and a best-effort add to library;
  dispatches a `loved-changed` DOM event so every heart updates. Ratings are looked up in batches of 50 by
  `fetchLoved` and cached. "Favorite Songs" (`views.favorites`) finds Apple's auto-playlist by name in your
  library playlists.
- **Lyrics**: the lyrics button (or the one in the full-screen player) → `player.setFullLyrics(true)` →
  **`lyrics.mountLyrics(el)`** loads
  `/v1/catalog/{sf}/songs/{id}/lyrics`, parses Apple's TTML into timed lines (`parseTTML`), then a
  `requestAnimationFrame` loop highlights the line at `positionNow()` and scrolls to it (pausing auto-scroll for
  3 s after you scroll). Clicking a line seeks.
- **Queue**: the state's `queue` holds a window of up to 15 items before and 100 after the current one.
  `views.renderQueue` shows it; clicking an item sends `cmd({type:'jump', index})` (lists registered with
  `queueOffset` map row index → absolute queue index).

## Stage 13: Quitting

- Closing the app window → CDP `Target.targetDestroyed` for the app target → `Engine` runs the
  `onAppClosed` callback → `System.exit(0)` → the shutdown hook calls `Engine.shutdown()` (`Browser.close`)
  and destroys the browser process.
- Quitting the browser some other way → the CDP WebSocket closes → `CdpClient.closedFuture()` completes →
  `System.exit(0)`.
- Killing Orchard hard (Task Manager) can leave the browser running; the next launch cleans it up in
  `BrowserLauncher.closeLeftoverBrowser`.

## Stage 14: When things go wrong

| Situation | What happens | Where |
|-----------|--------------|-------|
| No Chromium browser found | Server still runs; UI overlay shows the reason | `Main.startEngine`, `Orchard.setEngineProblem` |
| Apple's player not ready after 45 s | Iframe removed; Apple's page opens in a separate minimized window (window mode) | `Engine.startEmbedded` watchdog → `fallBackToWindow` → `openEngineWindow` |
| `--engine-window` flag | App window is `http://localhost:8787/?host=1` (no interception needed); Apple's page in its own window | `Main.startEngine`, `Engine.openEngineWindow` |
| Separate Apple window closed by user (window mode) | Reopened after 0.5 s | `Engine.onCdpEvent` `Target.targetDestroyed` |
| Apple's page crashes | Reloaded | `Inspector.targetCrashed` |
| App window reloaded (Ctrl+R) | Old channel dropped (`pageGone`), new page reconnects, iframe recreated on load | `Page.frameNavigated`, `Page.loadEventFired` |
| A command hangs in MusicKit | Bridge stops waiting after 6–15 s; Java gives up after 30 s with HTTP 503 | `engine.js settle`, `Engine.evaluate` |
| Engine not ready yet | API/command calls return 503 "Apple Music is still loading" | `Engine.requireReady`, `Orchard.engine()` |
