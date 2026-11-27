# 4. Web UI and engine bridge files

Everything under `src/main/resources/` is embedded in the JAR/executable and served by `WebServer`
(to the app window via interception, to phones directly). The UI is plain HTML/CSS/JavaScript ES modules:
**no build step, no framework, no npm**. Edit a file, rebuild Orchard, reload.

## Module graph and load order

`index.html` loads one module, `js/app.js`. Its imports load the rest. The browser evaluates dependencies
first, so module code runs in this order:

```
util.js  →  store.js  →  keys.js  →  components.js  →  artwork.js / playlists.js  →  lyrics.js  →  views.js
        →  player.js  →  updates.js / pairing.js  →  settings.js  →  app.js (boot)
```

```
app.js ──► util, store, components, views, player, settings, updates, keys, warmup
warmup.js ──► util, store, components, views, artwork
player.js ──► util, store, components, lyrics, views, keys
views.js ──► util, store, components, lyrics
settings.js ──► util, playlists (openDialog), keys, updates
updates.js ──► util, store
pairing.js ──► util, store, playlists (openDialog)
keys.js ──► util
components.js ──► util, store
lyrics.js ──► util, store
store.js ──► util
util.js (no imports)
```

**Shared conventions**

- **HTML is built with template strings** and assigned via `innerHTML`. Every value that came from Apple or
  the network **must go through `esc()`** (from `util.js`) to prevent HTML injection.
- **Behaviour is attached with `data-` attributes and event delegation**, not per-element listeners:
  `data-href` (navigate), `data-act` (global actions in `app.js`), `data-c` (player controls in
  `player.js`), `data-a` (page/overlay actions), `data-list`/`data-i` (track rows), `data-card` (card
  context menus). This is why freshly rendered HTML works without extra wiring.
- **Navigation is hash routing** (`#/album/123`). The page never reloads; `app.js route()` swaps `#view`.
- **All server URLs are relative or prefixed with `ROOT`** (see `store.js`). The same files must work at
  `/orchard/` in the app window and `/` on phones.

---

## `web/index.html`: page skeleton

Static containers that the scripts fill in:

| Element | Filled by | Purpose |
|---------|-----------|---------|
| `#sidebar` → `#nav`, `#libhead`, `#lib-chips`, `#lib-list` | `app.js buildShell`, `renderSidebarLibrary` | Desktop left column: Home/Search and Your Library |
| `#main` → `.topbar` (`#back`, phones only), `#view` | `app.js` (`route()` renders into `#view`) | The scrolling page area. Desktop has no back/forward buttons; phones keep Back because a home-screen app has no other one |
| `#right` | `player.js renderRight` | Desktop right panel (Queue) |
| `#player` | `player.js buildPlayer` | Desktop player bar + phone mini player + "Listening on…" banner |
| `#tabs` | `app.js buildShell` | Phone bottom tab bar |
| `#engine-host` (+ `.engine-bar`, `#engine-back`) | Java (`Engine.createFrame` adds the iframe) | Holds Apple's hidden player; becomes visible for sign-in/Ctrl+Shift+A |
| `#fullplayer` | `player.js` | Full-screen Now Playing view (all screen sizes), with lyrics |
| `#overlay` | `player.js updateOverlay` | "Starting…/Sign in" blocking card; `.pill` = small non-blocking notice during a warm start |
| `#menu`, `#popover`, `#toast` | `components.openMenu`, `player.openDevices`, `util.toast` | Context menus, Devices panel, notifications |

The `<head>` links `app.css`, `icon.svg`, `manifest.webmanifest` (relative paths) and sets mobile/PWA meta tags.

---

## `web/app.css`: all styling

One stylesheet, organised by `/* ---- section ---- */` comments in this order: design tokens (`:root`
custom properties: `--bg`, `--panel`, `--accent` (the orange), `--hero`…), base/reset, sidebar, main/hero,
track rows, shelves & cards, search, queue/lyrics, right panel, player bar & range sliders, menus/popovers/
overlay/toast, **medium widths** (`max-width: 1100px`: right panel hidden), **phones**
(`max-width: 760px`: single column, tab bar, mini player, full-screen player, bottom sheets), embedded engine
host, phone pairing, favorites hearts.

Layout is a CSS grid on `<body>` with named areas `side`, `main`, `right`, `player`, `tabs`; the media
queries redefine the areas. State-driven styling uses classes on `<body>` set by `player.js update()`:
`is-playing`, `has-item`, `shuffle-on`, `repeat-on`, `repeat-one`, `muted`, `remote`, `right-open`,
`engine-visible`, and `data-route` (set by `app.js`). The desktop bar is `--player-h` (72px, the 56px
artwork plus 8px padding) with a song and `--player-h-empty` (50px, the transport buttons only) without one.
It animates between the two only once `bar-anim` is set, which happens after the first ready state, so it
doesn't animate on load.

The hero colour comes from Apple's artwork `bgColor`: `views.setHero()` sets `--hero` on `#main`.

---

## `web/js/util.js`: helpers (no dependencies)

| Export | Purpose |
|--------|---------|
| `$`, `$$` | `querySelector` / `querySelectorAll` (as array). |
| `esc(s)` | HTML-escape. **Use for every interpolated value.** |
| `art(artwork, size)`, `artWide(artwork, width)` | Turn Apple's artwork URL template (`…/{w}x{h}bb.jpg`) into a real URL (square / keeping aspect ratio). `PLACEHOLDER` when missing. In the Orchard window (`?host`), Apple (`mzstatic.com`) URLs become `<ROOT>/api/img?u=…`, the server's disk cache; phones use Apple's URL directly. |
| `appleArt(artwork, size)`, `appleArtWide(artwork, width)` | Apple's own address for the same picture (what `art()` resolves before the cache); `warmup.js` hands these to the server. |
| `fmtTime(sec)`, `fmtTotal(sec)` | `3:45`, `1 hr 2 min`. |
| `debounce`, `throttle` | Rate limiting (search box, volume slider). |
| `toast(msg)` | Bottom notification. |
| `store(key, value?)` | `localStorage` get/set with JSON and try/catch (imported elsewhere as `persist`). |
| `greeting()` | "Good morning/afternoon/evening/night". |
| `icon(name, cls)` | Inline SVG from the `P` path table (Material icons). **Add new icons to `P`.** |
| `EQ` | The animated equaliser markup. |
| `BACKDROP`, `backdrop(el)` | Markup for the blurred-artwork background, and `update(item)` for it (cross-fades two layers on a track change). Each layer is a 64×64 `<canvas>` that the artwork is drawn into once with a canvas blur plus the layer's CSS `--fp-tone` (saturate/brightness), then stretched by CSS. Don't put a CSS `filter: blur()` on the turning layers: recomputing it every frame at full-screen size starved the page of frames. Used by the full-screen player, the lyrics page and the lyrics sidebar. |

---

## `web/js/store.js`: state, server communication, speakers

The single source of truth for the UI and the only module that talks to the server.

| Export / member | Purpose |
|-----------------|---------|
| `isHostApp` | `?host=1` in the URL: this is the app window on the computer. |
| `HOST_PROXY`, `ROOT` | True / `'/orchard'` when running at `music.apple.com` (the app window in embedded mode); otherwise false / `''`. |
| `S` | Global state: `info` (from `/api/info`), `speaker` (who we control), `speakerBase` (`''` = this server, or `http://ip:port`), `state` (player state, see [5-protocols.md](5-protocols.md#player-state-object)), `stateAt` (when it arrived), `speakers`, `devices`, `connected`, `engineUi`. |
| `subscribe(fn)` / `notify(kind)` | Tiny pub/sub. Kinds: `state`, `speaker`, `devices`, `speakers`, `connection`, `engine-ui`. `subscribe` returns an unsubscribe function. |
| `sf()` | Storefront (`us`, …) for Apple API paths. |
| `positionNow()` | Current playback position, interpolated. |
| `deviceId()`, `deviceKind()`, `deviceName()` | Identity of this UI (persisted id; name like "Android · Chrome"; `localStorage['orchard.deviceName']` overrides). |
| `am(path, {fresh})` | GET an Apple Music API path (`/v1/…`) through Orchard. Stale-while-revalidate cache in memory + IndexedDB `orchard-cache`/`api` (library copies rechecked after 30 s and once per run, catalog after 10 min; changes fire the `data-updated` DOM event; library reads after `amWrite` go to the network first; 503 "still loading" waits and retries; signing out forgets library copies; copies unused for 60 days are dropped). |
| `browsable()`, `warmStart()` | Whether pages/library can show (signed in, or signed in last time while Apple Music starts), and whether we're in that warm start. |
| `amWrite(method, path, body)` | POST/PUT/DELETE to Apple through Orchard. |
| `cmd(command)` | Send a player command to the **current speaker**; applies the returned state; toasts errors unless `{quiet:true}`. |
| `post(path, body)` | POST to the current speaker (sign-in, sign-out, transfer…). |
| `speakerRequest` (internal) | Routes a request to the current speaker: same server → `ROOT + path`; other speaker from the app window → `ROOT + path` with `X-Orchard-Peer`; other speaker from a remote → `base + path`. |
| `patchState(partial)` | Optimistic local update before the server confirms. `isPlaying`, `shuffle`, `repeat`, `volume` and `position` are then held (`holdExpected` in `setState`): reports that disagree are overridden until one agrees, then for a 1 s grace period, because a stale report (or an event overtaking the command's reply) would otherwise flash the old value. On a phone over Wi-Fi those can arrive seconds late. Command replies don't count as confirmation, since they can be taken before the player catches up. A hold that is never confirmed ends after 8 s and shows the speaker's last report. Holds are cleared when the song changes, the command fails, or the speaker is switched. |
| `handlers` (internal) | What to do with each event: `hello`, `state`, `devices`, `speakers`, `engine-ui`, `relay-lost`. |
| `toggleConsole()` | App window: POST `/orchard/__host/console`; resolves to `'shown'`, `'hidden'` or `'unavailable'` (not Windows). |
| `connect()` | App window: define `window.__orchardPush` and POST `/orchard/__host/connect`. Remote: open an `EventSource` to `<base>/api/events`. After 4 errors on another speaker, fall back to this one. In the app window, if Orchard answers `remote: false` for a saved speaker it doesn't know, switch back to this computer. |
| `selectSpeaker(sp)` | Switch speakers (transfer playback first if playing), via `useSpeaker` → `connect()`. |
| `normalizeSpeakers(list)` | Adds `base` to each speaker. |
| `init()` | Load `/api/info`, restore the chosen speaker, connect. |

---

## `web/js/components.js`: shared building blocks

| Area | Exports |
|------|---------|
| Data mapping | `toTrack(resource)`: Apple song/library-song/queue item → track object (`id, playId, catalogId, title, artist, album, artwork, duration, explicit, albumId, artistId, playable…`). `qid(track)`: the id to give MusicKit. `toCard(resource)`: album/playlist/artist/station/song → card object (`title, sub, artwork, href, play, round`). |
| Track lists | `registerList(tracks, ctx)` → key; `getList(key)`. `ctx.collection` (e.g. `{album:id}`) makes playback queue the whole album/playlist; `ctx.queueOffset` makes rows jump within the current queue. `playList(key, index, {shuffle})`, `playQueue(desc, shuffle)`. `trackRows(tracks, key, opts)` renders rows (`album`, `artwork`, `start`, `header`, `discs` options). `markPlaying(root)` highlights the current track and calls `hydrateLoves`. |
| Cards | `cardHtml(card)`, `shelf(title, resources)`, `grid(resources)`, `loading()`, `errorBox(err, what)`. |
| Library | `libraryList(kind)` (playlists/albums/artists, the whole library with no limit: first page, then the rest four at a time once the total is known; artists get their catalog artist's artwork; cached), `invalidateLibrary(kind)` (fires a `library-changed` DOM event), `addToLibrary`, `addToPlaylist`, `createPlaylist`. |
| Favorites | `hydrateLoves(root)`, `isLoved(id)`, `lovedCached(id)`, `setLoved(id, on)`, `toggleLoved(id)`, `favoritesPlaylist()`. Ratings are fetched 50 at a time and cached; changes fire a `loved-changed` DOM event. |
| Menus | `openMenu(anchor, items, title)`, `closeMenu()`. Items are `{label, icon, run}`, `{sep:true}` or `{label, icon, submenu: async () => items}`. Shown as a popup on desktop and a bottom sheet on phones. `trackMenuItems(track)`, `collectionMenuItems(card)` build the standard menus. |

---

## `web/js/artwork.js`: playlist pictures and image loading

| Item | Purpose |
|------|---------|
| `playlistArtwork(p)`, `mosaicFor(p)` | A playlist's picture: Orchard's custom one, Apple's, or a cached 2×2 mosaic of its first songs' covers; `mosaicFor` names playlists still needing one (`<img data-mosaic="p.…">`). |
| `loadMosaicCache()` | Reads saved mosaics from IndexedDB (`orchard-artwork` / `mosaics`, no size limit; older ones in localStorage `orchard.mosaics` are moved there). Startup waits at most 250 ms for it, and building waits at most 1.5 s, so slow storage never blocks anything. |
| `initMosaics()` | Watches the page for `img[data-mosaic]`. Pictures on or near the screen (IntersectionObserver) are built first, the rest of the library after, six at a time. A failed build is retried with growing waits (2 s → 2 min, then every 2 min) and never counts as "no picture". |
| Image retry | A capture-phase `error` listener: a thumbnail that fails shows the placeholder and keeps retrying in the background (1 s → 1 min, then every minute) until it loads or leaves the page. |
| `refreshMosaic(id)`, `dropMosaic(id)` | Rebuild after a playlist's songs change; forget a deleted playlist. |

## `web/js/views.js`: pages

Each page is a function `(el, match) → maybe cleanup` that renders into `el` (`#view`). The `routes` table at
the bottom maps hash patterns to pages:

| Hash | Function | Data source |
|------|----------|-------------|
| `#/`, `#/home` | `home` | recent played, recommendations, charts |
| `#/search/<q>` | `search` (+ `searchShell`, `searchIdle`, `searchRun`, `topResultHtml`) | `/v1/catalog/{sf}/search` (debounced, keeps recent searches) |
| `#/album/<id>` | `album` | catalog album or library album (`l.` ids) |
| `#/playlist/<id>` | `playlist` | catalog or library playlist (`p.` ids), infinite scroll |
| `#/artist/<id>` | `artist` (+ `libraryArtist` for `r.` ids) | artist with views (top songs, albums, singles…) |
| `#/library/<kind>` | `library` | `libraryList`. A page of its own (`.lib-page`, sharing no classes with the sidebar list): tabs, a search filter, sort (recently added / alphabetical / creator, `localStorage['orchard.libSort']`), grid or list view (`orchard.libView`), with Favorite Songs and Songs pinned first on Playlists |
| `#/favorites` | `favorites` | Apple's "Favorite Songs" playlist |
| `#/songs` | `songs` | `/v1/me/library/songs`, infinite scroll |
| `#/queue` | `queue` → `renderQueue` | `S.state.queue` (live) plus `store.queuePage` pages of 200 loaded as you scroll (any length). Pages are kept while `rev` is unchanged; after an edit they're re-read, then redrawn once. |

Helpers: `setHero(color)`, `heroHtml`, `actionsHtml` + `bindActions` (the big play / shuffle / add / more
buttons, `data-a`), `infinite(el, next, onPage)` (loads further pages when a sentinel scrolls into view),
`libraryRow` (also used by the sidebar), `fromItem` (queue item → track).

A page returning a function gets it called when the user navigates away (unsubscribe, stop timers).

---

## `web/js/player.js`: player, devices, overlay

| Area | Functions |
|------|-----------|
| Markup | `buildPlayer()` creates the desktop bar, phone mini player, "Listening on" banner and the full-screen player; `controlsHtml`, `seekHtml`. |
| Rendering | `update()` refreshes titles, artwork, body classes, volume, banner, document title and hearts on every state change; `tick()` redraws progress (every frame while playing, via `heartbeat`/`progressLoop`; every 250 ms otherwise); `setRange`; `updateLove`/`paintLove`. |
| Controls | `control(name, button)` handles every `data-c` button: `toggle, next, prev, shuffle, repeat` (Spotify order off → all → one), `mute, love, devices, queue, lyrics` (`toggleLyrics`), `lyrics-side/-page/-full/-close` (the lyrics view buttons), `seekBack`/`seekFwd` (`seekBy(±keys.seekStep())`), `open-full` (the bar's artwork), `close-full`, `fp-lyrics`/`fp-queue` (the full-screen player's panel), `fp-fullscreen` (browser full screen), `item-menu`. Esc closes the full-screen view. `playerAction(name)` is the same, exported for keyboard shortcuts. `bindControls()` wires clicks, the seek sliders (send on release) and the throttled volume slider. |
| Full-screen player | `openFull({lyrics})`, `closeFull`/`hideFull` (integrated with the back button via `history.pushState`), `setFullPanel('lyrics'|'queue'|null)` (the `.fp-panel` beside the artwork: `mountLyrics`, or `views.renderQueue` showing only what's up next; toggles `#fullplayer.panel-on` plus `lyrics-on`/`queue-on`; the move to the two-column layout is animated with `document.startViewTransition` where available), `fullBackdrop` (`util.backdrop`), `preloadNextArtwork` (fetches the next queued song's 1000 px and 120 px artwork so the picture changes with the title), `updateDevicePill` (the quiet "<speaker> · <output>" label in the header's top-right corner, which opens the device picker along the right edge; `currentOutput` shortens the output name). While lyrics show, the header also has `.fp-lyr-views` (switch to the sidebar or page lyrics). One markup for every size: `.fp-stage` is a CSS grid whose areas (`art meta progress controls bottom panel`) are rearranged by `app.css`: centred column; with a panel, that column on the left and the panel on the right; on phones, a small artwork + title above the panel. |
| Lyrics views | `toggleLyrics()` (bar button: open or close the lyrics sidebar), `showLyrics('side'|'full')` (`full` opens the full-screen player, a feature of its own that's never remembered; `side` closes the full-screen player first; under 1100 px, where there is no sidebar, lyrics open in the full-screen player), `closeLyrics()`, `markLyricsButton()`, `setMainCollapsed(on)` (`body.main-collapsed`: the middle column collapses and the lyrics sidebar spreads over it, animated like the left sidebar; wide windows only; undone by navigating, switching the panel to the queue or closing lyrics). |
| Right panel | `toggleRight('queue'|'lyrics')`, `renderRight()` (remembered in `localStorage['orchard.right']`; lyrics mode adds the blurred backdrop). |
| Devices / pairing | `openDevices`, `closeDevices`, `devicesHtml` (current speaker, its audio outputs via `outputsHtml`, other speakers, connected remotes), `pairingHtml` (address tabs + hints), `loadQr`/`renderQr` (loads `vendor/qrcode.js` on demand). |
| Apple page visibility | `hasEngineFrame()`, `setEngineVisible(show, forSignIn)`, `toggleEngine()`, `onEngineUi(msg)` (reacts to `engine-ui` events). Only the app window has the frame. |
| Overlay | `updateOverlay()` (starting / unavailable / sign-in card), `otherSpeakersHtml`, `bindOverlay` (Sign in button, choose another speaker). |
| Entry | `initPlayer()`, called once by `app.js`. |

---

## `web/js/lyrics.js`: synced lyrics

`mountLyrics(el, {compact, variant})` turns `el` into a self-updating lyrics view and returns a cleanup function
(`variant` `full`/`page`/`side` sets the text size via `.lyr-v-*`; `compact` is the phone size).
`lyricsViewButtons()` is the lyrics sidebar's header row: widen over the page / show the page again (`lyrics-widen`), full-screen player, close (handled by `player.js`).
Internals: `load(id)` (fetch + cache `/v1/catalog/{sf}/songs/{id}/lyrics`), `parseTTML` (Apple's TTML XML →
`{lines: [{t, end, text}], synced, writers}` with "gap" entries between verses, an `interlude` entry for every
break of 4 s or more (shown as three dots that fill over the break), and the songwriters for the credits line;
skips background-vocal spans), `parseTime` (`1:02.5`, `62.5s`…), a `requestAnimationFrame` loop that marks
the current line `.active` and earlier ones `.past`, and `follow(dt)`, a critically damped spring (`SPRING`) that glides the current line to a third of the way down, re-aiming every frame so lines changing height don't cause jumps.
While it follows the song the container has `.following` (other lines are blurred); scrolling by hand pauses
that for 3 s. Clicking a line seeks. Used by the full-screen player and the sidebar.

---

## `web/js/keys.js` and `web/js/settings.js`: keyboard shortcuts

`keys.js`: `ACTIONS`, every shortcut action with its group, label and default keys (play/pause K + Space,
previous J + Ctrl+←, next L + Ctrl+→, ← / → rewind / fast-forward, M mute, Esc close the full-screen player,
Ctrl+K search, Ctrl+, settings, and in the app window Ctrl+Shift+A / Ctrl+Shift+T; volume, shuffle, repeat,
favorite, lyrics, queue, full-screen player and sidebar have no key until you give them one). All of them can be
changed, and an action can have up to `MAX_KEYS` keys. `bindings()` (`{id: [combo…]}`; older single-key saves
are converted), `addBinding` (takes the key away from any other action and returns that action),
`removeBinding`, `resetBindings` (`localStorage['orchard.keys']`; each change fires a `keys-changed` event),
`firstKey(id)` for tooltips, `seekStep()`/`setSeekStep`
(`orchard.seekStep`, default 10 s), `comboOf(event)` (`"K"`, `"Shift+L"`, `"Ctrl+ArrowRight"`; Shift only counts
for letters and named keys), `actionFor(combo)`, `reserved(combo)`, `label`/`keycaps` for display.

`settings.js`: `openSettings()`, the dialog (sidebar "Settings" or its shortcut). Actions are grouped
(Playback, Views, App; App-window-only ones are hidden elsewhere). "+" records a key: it listens on `window` in
the capture phase so it runs before the dialog's Esc handler and the app's shortcuts, so Esc cancels and can't
be recorded itself. Hovering a key shows its ✕. A key already used by another action moves to the new one.

`pairing.js`: access (`Access.java`). `showPairing()` covers the app on a device that isn't paired ("Connect to
<computer>": asks with `requestAccess`, polls `accessStatus` every 2 s, saves the key and reloads once allowed).
`initPairing()` shows it whenever `store` reports `unpaired` (a 401, or `init()` finding `paired: false`), and in
the Orchard window turns `pair-requests` events into an "Allow “<device>”?" dialog. Closing that dialog counts as
Deny. `store.js` adds the key to every request (`authHeaders`, `orchardFetch`, the event stream's `?key=`), and
trades a `?pair=` QR invite for a key at startup (`claimInvite`). `player.js` puts the invite into the QR code
(`qrUrl`). `displayPosition()` (store.js) is the position for the screen: it never steps back by a fraction of a
second while playing, so lyrics don't flick back to the previous line when a speaker report lands late.

`updates.js`: automatic updates (`Updater.java`, `/api/update`), always on the Orchard that served the page, never
a speaker it controls. `initUpdates()` adds the sidebar's "Restart to update" item (shown once an update is
installed) and polls the status every 5 minutes (every 1.5 s while checking or downloading).
`updateSettingsHtml()`/`bindUpdateSettings(el)` are the Settings dialog's Updates section: the on/off switch,
`describe(status)`, Check now and Restart now.

---

## `web/js/warmup.js`: loading everything ahead of time

Orchard window only (`isHostApp`). 3 s after Apple Music is ready (and again after 12 h if the window stays open),
`run()` walks the library lists, Home, every library playlist (all track pages), album, the Songs list, every
artist (library → catalog page), then the albums/playlists on Home. Data goes through `store.prefetch(path,
12 h)` using `views.PAGE_PATHS`/`withLimit`, so it lands in the exact cache entries the pages read. Pictures (at
the sizes the pages use: rows 96, quick 120, cards 300, heroes 480, artist banners 2000 wide) are sent in batches
of 100 to `POST /api/img/warm`; artist-page shelf pictures go last. Two requests at a time with 40 ms gaps;
failures are retried after 5/20/60 s (429: at least 30 s). Stops if Apple Music signs out. Lyrics and music are
not warmed. Keep `SIZE` in step with the sizes used in views/components.

---

## `web/js/app.js`: shell, routing, global input

| Function | Purpose |
|----------|---------|
| `buildShell()` | Static parts of the sidebar, library header and tab bar. |
| `renderSidebarLibrary()`, `bindSidebar()` | Sidebar library (Favorite Songs, Songs, then playlists/albums/artists chips), "+" to create a playlist; re-renders on `library-changed`. |
| `route()` | Matches `location.hash` against `views.routes`, runs the page's cleanup, renders the new page into a hidden `.view-stage` (`stage`), waits until the pictures that will be on screen are decoded (`picturesReady`, at most `NAV_WAIT_MS` = 200 ms in total), then swaps it in (`showPage`, which also focuses `[data-autofocus]`). Still loading after 200 ms: shown anyway (loading dots), filling in as data arrives. Guards against out-of-order async renders with `routeSeq`; `routing` holds quiet redraws back meanwhile. |
| `softRefresh()`, `doSoftRefresh()` | Quiet redraw of the current page (`view-refresh` / `data-updated` events): rendered staged, pictures decoded (up to 2 s, the old page stays up), swapped in at the same scroll position. Waits while navigating, dragging a song or typing in the page. |
| `highlightNav()` | Marks the active nav/tab/library item. |
| `bindGlobalClicks()` | `data-act` actions (`play-q`, `row-play`, `row-love`, `row-menu`), `data-href` navigation, tap-to-play on touch screens, double-click to play, right-click context menus. |
| `bindKeys()`, `runAction(action)` | Every key goes through `keys.actionFor(comboOf(e))`. In a text box only Ctrl/Alt shortcuts count; with a dialog open only `apple`/`log`. `runAction` handles `apple` (toggle Apple's page), `log` (`toggleConsole`), `settings`, `search`, `sidebar`, and passes the rest to `player.playerAction`; when an action doesn't apply (e.g. Esc with no full-screen player) the key keeps its normal job. Holding a key repeats only seeking and volume. |
| `setSidebar`, `toggleSidebar` | Collapsed sidebar (`body.side-collapsed`, a 72 px rail of icons and artwork; remembered in `localStorage['orchard.sidebar']`). Button in the library header. Its CSS rules are scoped to `#sidebar`, so they never hide anything on a page. |
| `shortcutHints()` | Tooltips and the Apple-page bar show the current keys (re-run on `keys-changed`). |
| `boot()` | Startup sequence (timeline Stage 4). |

---

## `web/vendor/qrcode.js`

Third-party library **qrcode-generator 1.4.4** by Kazuhiko Arase (MIT licence, header kept in the file).
Bundled locally so pairing works offline. Exposes a global `qrcode(typeNumber, errorCorrection)`;
`player.js renderQr` uses `addData`, `make`, `createSvgTag`.

## `web/icon.svg`, `web/manifest.webmanifest`

The app icon (favicon, sidebar logo) and the Progressive Web App manifest used when a phone does "Add to
Home screen" (name, colours, standalone display).

---

## `engine/engine.js`: the bridge inside Apple's page

Injected by `Engine` into every new document of the app window (and of the separate window in window
mode) *before* the page's own scripts. Everything is inside one IIFE (an immediately-invoked function), so
nothing leaks into Apple's page except `window.__orchard`.

| Part | Purpose |
|------|---------|
| Guard | Runs only in the right place: top-level music.apple.com in window mode (not Orchard's own `/orchard` page), or the `#am-engine` iframe in embedded mode; never twice. |
| `log`, `emit` | `console.log('[orchard]', …)` (Java prints these) and `window.__orchardEmit(JSON)` (the CDP binding). |
| Listeners | `keydown`: the `apple` keys (default Ctrl+Shift+A) → `{type:'ui', action:'toggle'}`, the `log` keys (default Ctrl+Shift+T) → `{type:'ui', action:'console'}`, read from the app window's `localStorage['orchard.keys']` (same site); `pagehide` → `{type:'bye'}`. |
| `itemInfo(mediaItem)` | MusicKit media item → the compact item object in the state (id, catalogId, title, artist, album, artwork template, bgColor, duration, albumId, artistId, explicit, hasLyrics). |
| `snapshot(full)` | Builds the state object; `full` adds the queue window (15 before, 100 after the current item). |
| `schedule(full)` | Coalesces events into one emit 60 ms later; time updates at most every 5 s. |
| `attach(instance)`, `findInstance`, poll | Wait for Apple's MusicKit instance, subscribe to its events. |
| `settle(promise, ms)` | Don't wait forever for MusicKit promises (play/setQueue can hang while loading). |
| Audio output (`outputs`, `wanted`, `sinkId`, `applySink`, `refreshOutputs`, `setOutput`) | Which local device plays the sound. Wraps `HTMLMediaElement.prototype.play` so every element Apple's player starts gets `setSinkId(<picked device>)`; refreshes on `devicechange`; the choice is kept in Apple's page's `localStorage` (`orchard.audioOutput`). Device names are only visible because `Engine` grants the site microphone permission. |
| `playQueue(m, desc, startIndex, shuffle)` | `setQueue` + `changeToMediaAtIndex` fallback + `play`. |
| `cmd(c)` | **The player command switch.** Every command type is listed in [5-protocols.md](5-protocols.md#player-commands). Returns `JSON.stringify(snapshot(true))`. |
| `api(method, path, body)` | `fetch` to `https://amp-api.music.apple.com` (fallback `api.music.apple.com`) with `Authorization: Bearer <developer token>` and `Media-User-Token`/`Music-User-Token`; returns `{status, body}` as a JSON string. |
| `exportQueue()` | Catalog ids around the current item for hand-off. |
| `window.__orchard` | `{cmd, api, exportQueue, state, authorize, unauthorize}`, what Java calls via `Engine.invoke`. |

**This file depends on Apple's MusicKit API** (`MusicKit.getInstance()`, `setQueue`, `play`,
`skipToNextItem`, `seekToTime`, `queue.items`, event names…). If Apple changes music.apple.com and something
stops working, this is the first place to look. Use Ctrl+Shift+A plus the browser's DevTools on the app
window to inspect `MusicKit.getInstance()` inside the iframe.
