# 5. Protocols and data shapes

Reference tables for every message that crosses a boundary: UI ↔ Java, Java ↔ browser, Java ↔ other Orchard
computers, plus what gets stored where.

- [HTTP API](#http-api)
- [Live events](#live-events)
- [The app-window channel](#the-app-window-channel)
- [Player commands](#player-commands)
- [Player state object](#player-state-object)
- [Bridge → Java messages](#bridge--java-messages)
- [Apple Music API paths used](#apple-music-api-paths-used)
- [DevTools (CDP) usage](#devtools-cdp-usage)
- [Speaker discovery packets](#speaker-discovery-packets)
- [Stored data](#stored-data)

---

## HTTP API

Served by `WebServer` on port 8787. Phones call these directly; the app window calls them as
`/orchard/api/...` (forwarded by `HostLink`). Errors are `{"error": "message"}` with an HTTP status
(503 = Apple Music still loading / no engine).

| Method & path | Body / query | Response | Notes |
|---------------|--------------|----------|-------|
| `GET /api/info` | | `{id, name, version, hostname, port, lanUrls[], remotes[{url, kind, adapter}]}` | `kind` is `lan`, `tailscale` or `public`. |
| `GET /api/state` | | [player state](#player-state-object) | Same as the `state` event. |
| `GET /api/speakers` | | `[{id, name, url, self}]` | `url` is null for this computer. |
| `GET /api/events` | `?deviceId=&name=&kind=` | SSE stream | See [live events](#live-events). Registers the caller as a device. |
| `POST /api/cmd` | a [player command](#player-commands) | player state after the command | |
| `GET /api/queue?start=&count=` | | `{rev, position, total, start, items[]}`: songs `start…start+count` (at most 500 per request) of the queue, for paging past the window the state carries | |
| `GET /api/am` | `?path=/v1/...` (URL-encoded) | Apple's JSON body, Apple's status | Catalog paths cached 10 min. |
| `POST /api/am` | `{method: "POST"|"PUT"|"DELETE", path, body}` | Apple's JSON body, Apple's status | Library edits, ratings, playlists. |
| `POST /api/signin` | | `{ok:true}` | Shows Apple's page for sign-in (on the computer). |
| `POST /api/signout` | | `{ok:true}` | MusicKit `unauthorize`; clears the catalog cache. |
| `POST /api/engine-window` | | `{ok:true}` | Toggles Apple's page (same as Ctrl+Shift+A). |
| `POST /api/transfer` | `{to: "http://ip:port"}` | `{ok:true, speaker}` | Hand playback to a linked computer and pause here. |
| `GET /api/update`, `POST /api/update` | `{enabled}` / `{action:"check"\|"restart"}` | updater status | See `Updater.java`. |
| `GET /api/access` | | `{paired, local, signedIn, name}` | Whether the caller's key works here. No key needed. |
| `POST /api/pair/request` | `{deviceId, name, kind}` | `{id, secret}` | A device asks for access; the Orchard window shows Allow / Deny. No key needed. |
| `GET /api/pair/status` | `?id=&secret=` | `{status: pending\|approved\|denied\|expired, key?}` | The asking device collects its key. No key needed. |
| `POST /api/pair/claim` | `{code, deviceId, name}` | `{deviceId, key}` | Trades a QR invite code for a key. No key needed. |
| `POST /api/pair/invite` | | `{code, expires}` | **This computer only.** The invite in the QR code (10 min). |
| `GET /api/pair/pending`, `POST /api/pair/decide` | `{id, allow}` | | **This computer only.** Requests waiting for an answer; answer one. |
| `POST /api/pair/reset` | | `{ok:true}` | **This computer only.** Forget every paired device and linked computer. |
| `POST /api/link/start`, `/proved`, `/finish` | see `AccountLink.java` | | Two computers proving they share the Apple Music account. No key needed. |
| `OPTIONS *` | | 204 | CORS preflight (for allowed origins). |
| `GET /anything-else` | | file from `web/` | Unknown extensionless paths → `index.html`. |

**Access rules** (`WebServer.hostAllowed` / `originAllowed`): Host header must be `localhost`, an IP, `*.local`,
`*.ts.net` or this computer's name; if an `Origin` header is present it must be the same origin as the Host,
one of our own addresses on our port, or a known Orchard peer.

**Keys** (`Access.java`): every `/api` request that doesn't come from this computer (127.0.0.1, which includes the
Orchard window) needs `X-Orchard-Device: <deviceId>` and `X-Orchard-Key: <key>` headers (event streams:
`?deviceId=&key=`), except the "no key needed" rows above and `GET /api/artwork/<id>` images. A key is
base64url(HMAC-SHA256(secret, "orchard-device-v1:" + deviceId)) under any secret in this computer's keyring
(`<data>/access.json`). Linked computers merge keyrings, so keys work on all of them. Orchard computers call each
other as device `pc:<speaker id>`. Without a valid key the answer is `401 {"error", "pair": true}`, and the UI shows
the pairing screen (`pairing.js`).

---

## Live events

Delivered as SSE (`event: <name>` / `data: <json>`) to phones, and as `window.__orchardPush(name, data)` to the
app window. Handled by the `handlers` table in `store.js`.

| Event | Data | When |
|-------|------|------|
| `hello` | `{speaker: {id, name, url, self}, info: <api/info>}` | On connect |
| `state` | [player state](#player-state-object) | On connect and on every change |
| `devices` | `[{id, name, kind, since}]` | Whenever a UI connects/disconnects. `kind`: `app`, `phone`, `tablet`, `computer` |
| `speakers` | `[{id, name, url, self}]` | On connect and when discovery changes |
| `engine-ui` | `{show: true|false}` or `{toggle: true}` | Show/hide Apple's page in the app window |
| `relay-lost` | `{}` | App window only: lost the connection to another speaker |
| `pair-requests` | `[{id, name, kind}]` | Orchard window on this computer only: devices asking for access |

SSE streams also carry `: ping` comments every 15 s and start with `retry: 2000`.

---

## The app-window channel

Only for the app window at `https://music.apple.com/orchard/?host=1` (embedded mode).

| Mechanism | Details |
|-----------|---------|
| Interception | Every request to `https://music.apple.com/orchard*` is paused by CDP `Fetch` and answered by `Engine.answerOrchardRequest`. `/orchard/X` is forwarded to `http://127.0.0.1:8787/X`. |
| `POST /orchard/__host/connect` | `{deviceId, name, kind, speaker}`: (re)registers the window as a hub client; `speaker` = `''` (this computer) or a peer URL (start a relay). Returns `{ok, remote}`; `remote: false` for a peer Orchard doesn't know means the window was attached to this computer instead, and the UI drops its saved speaker. |
| `POST /orchard/__host/speaker` | `{speaker}`: switch the relay without reconnecting; returns `{ok, remote}` like connect. (The UI currently just re-connects instead.) |
| `POST /orchard/__host/console` | (no body): Ctrl+Shift+T. Opens/closes the log window (Windows); answers `{ok, console:'shown'|'hidden'|'unavailable'}`. |
| `X-Orchard-Peer: http://ip:port` header | On any `/orchard/api/...` request: forward to that peer instead of this computer (must be a known peer). |
| Push | Java evaluates `window.__orchardPush && window.__orchardPush("event", {data})` in the window. |

---

## Player commands

Body of `POST /api/cmd`. Handled by `cmd()` in `engine.js`. All return the full state.

| `type` | Fields | Effect |
|--------|--------|--------|
| `playQueue` | `queue` (descriptor), `startIndex?`, `shuffle?` | Replace the queue and play. |
| `toggle` | | Play ↔ pause. |
| `play`, `pause`, `stop` | | |
| `next` | | Next track. |
| `prev` | | Restart the track if > 3 s in, otherwise previous track. |
| `seek` | `position` (seconds) | |
| `volume` | `value` (0–1) | |
| `shuffle` | `on` (bool) | |
| `repeat` | `mode` (0 off, 1 one, 2 all) | MusicKit's numbering. |
| `jump` | `index` (absolute queue index) | |
| `playNext`, `playLater` | `queue` (descriptor) | Insert after current / append. Starts playback if the queue is empty. |
| `remove` | `index` | Only if this MusicKit version supports `queue.remove`. |
| `load` | `songs[]`, `index`, `position`, `repeat`, `playing` | Used by hand-off between speakers. `exportQueue` leaves out music videos; ids MusicKit can't resolve on the receiving side are dropped and the queue retried. |
| `output` | `id` (from `outputs`; `''` = system default) | Send this speaker's sound to that audio device (headphones, speakers…). Remembered in Apple's page; if the device disconnects, sound goes to the default until it comes back. |

**Queue descriptors** (passed to MusicKit `setQueue`): `{song: id}`, `{songs: [ids]}`, `{album: id}`,
`{playlist: id}`, `{station: id}`. Ids can be catalog ids or library ids (`i.`, `l.`, `p.`).

---

## Player state object

Built by `snapshot()` in `engine.js`, merged by `Engine.mergeState` (which adds the Java fields).

| Field | Type | Meaning |
|-------|------|---------|
| `ready` | bool | Apple's player found and attached. Java sets false while (re)loading. |
| `authorized` | bool | Signed in to Apple Music. |
| `engineMode` | `"embedded"`/`"window"` | Java. |
| `message` | string? | Java: why not ready ("Starting Apple Music…", a launch error…). |
| `offline` | bool? | Java: there is no engine at all. |
| `storefront` | string | Catalog country, e.g. `us`. |
| `playbackState` | number | MusicKit enum: 0 none, 1 loading, 2 playing, 3 paused, 4 stopped, 5 ended, 6 seeking, 8 waiting, 9 stalled, 10 completed. |
| `isPlaying` | bool | |
| `position`, `duration` | seconds | Position as of the moment of the report (see `store.positionNow`). |
| `volume` | 0–1 | |
| `shuffle` | 0/1 | |
| `repeat` | 0/1/2 | off / one / all |
| `item` | object or null | Now playing: `{id, catalogId, kind, title, artist, album, artwork (URL template), bgColor, duration, albumId, artistId, explicit, hasLyrics}` |
| `queue` | object | `{position, offset, total, rev, items[]}`: `items` is a window (15 before the current song, 100 after) starting at absolute index `offset`; the rest is read with `GET /api/queue`. `rev` changes whenever the queue's contents change (not when it just moves on), so pages read earlier stay valid until it does; only present in "full" reports (the UI keeps the last one). |
| `outputs` | array | This computer's audio outputs `{id, label, detail?}`; the first is `{id:''}`, the system default (`detail` = which device that is). Only the default when the browser can't name devices. |
| `output` | string | `id` of the output in use. |
| `outputWanted` | string or null | Name of the picked output, even while it is disconnected (`output` is then `''`). |

---

## Bridge → Java messages

`window.__orchardEmit(JSON.stringify(msg))` in Apple's page → CDP `Runtime.bindingCalled` → `Engine.handleEmit`.

| `type` | Fields | Java reaction |
|--------|--------|---------------|
| `boot` | `url` | Debug log. |
| `state` | `state` (full or partial) | Merge + broadcast; on first `authorized:true` after a sign-in request, hide Apple's page. |
| `bye` | | Page unloading → `ready:false`. |
| `ui` | `action:'toggle'` or `'console'` | Ctrl+Shift+A pressed inside Apple's page → toggle it; Ctrl+Shift+T → `ConsoleWindow.toggle()`. |

Java → bridge is `Runtime.evaluate` of `window.__orchard.<fn>(args)`: `cmd(c)`, `api(method, path, body)`,
`exportQueue()`, `state()`, `authorize()`, `unauthorize()`; each returns a JSON string.

---

## Apple Music API paths used

All through `/api/am` → `engine.js api()` → `https://amp-api.music.apple.com`. `{sf}` = storefront.

| Purpose | Path | Used in |
|---------|------|---------|
| Search | `/v1/catalog/{sf}/search?term=&types=songs,albums,artists,playlists,stations&limit=20&with=topResults` | `views.searchRun` |
| Charts | `/v1/catalog/{sf}/charts?types=songs,albums,playlists&limit=20` | `views.home`, `searchIdle` |
| Recently played | `/v1/me/recent/played?limit=10` | `views.home` |
| Recommendations | `/v1/me/recommendations?limit=10` | `views.home` |
| Album | `/v1/catalog/{sf}/albums/{id}?include=tracks,artists`, `/v1/me/library/albums/{id}?include=tracks,artists` | `views.album` |
| Playlist | `/v1/catalog/{sf}/playlists/{id}?include=tracks`, `/v1/me/library/playlists/{id}?include=tracks`, `…/tracks?limit=100` | `views.playlist` |
| Artist | `/v1/catalog/{sf}/artists/{id}?views=top-songs,latest-release,full-albums,singles,appears-on-albums,featured-playlists,similar-artists&extend=artistBio,editorialArtwork` | `views.artist` |
| Library artist | `/v1/me/library/artists/{id}?include=catalog`, `…/albums` | `views.libraryArtist` |
| Library lists | `/v1/me/library/playlists|albums|artists?limit=100` (artists add `include=catalog` for their pictures; with `meta.total` known, the other pages load in parallel via `offset`), `/v1/me/library/songs?limit=100` | `components.libraryList`, `views.songs` |
| Add to library | `POST /v1/me/library?ids[songs|albums|playlists]=id` | `components.addToLibrary`, `setLoved` |
| Playlists | `POST /v1/me/library/playlists`, `POST /v1/me/library/playlists/{id}/tracks` | `createPlaylist`, `addToPlaylist` |
| Favorites | `GET /v1/me/ratings/songs?ids=…`, `PUT|DELETE /v1/me/ratings/songs/{id}` | `fetchLoved`, `setLoved` |
| Lyrics | `/v1/catalog/{sf}/songs/{id}/lyrics` (TTML in `data[0].attributes.ttml`) | `lyrics.load` |

Responses follow Apple's JSON:API style: `{data: [{id, type, attributes, relationships}], next?, results?}`.
Artwork URLs are templates with `{w}`/`{h}` placeholders (`util.art`).

---

## DevTools (CDP) usage

Domains/commands Orchard sends (all in `Engine`, `BrowserLauncher`, `CdpClient`):

| Command | Why |
|---------|-----|
| `Target.setDiscoverTargets`, `Target.getTargets` | Find the app window; hear about closed windows. |
| `Target.attachToTarget {flatten:true}` | Get a session for a window. |
| `Target.setAutoAttach {waitForDebuggerOnStart}` + `Runtime.runIfWaitingForDebugger` | Catch cross-site frames before they run. |
| `Target.createTarget {newWindow}` | Window mode's separate Apple window. |
| `Fetch.enable`, `Fetch.requestPaused` (event), `Fetch.fulfillRequest`, `Fetch.getResponseBody`, `Fetch.continueRequest` | Serve `/orchard`; strip anti-framing headers. |
| `Page.enable`, `Page.navigate`, `Page.reload`, `Page.addScriptToEvaluateOnNewDocument`, `Page.bringToFront`; events `Page.frameNavigated`, `Page.loadEventFired` | Load pages, inject the bridge, react to reloads. |
| `Runtime.enable`, `Runtime.evaluate`, `Runtime.addBinding`; events `Runtime.bindingCalled`, `Runtime.consoleAPICalled` | Run code in the page; receive bridge messages and logs. |
| `Browser.getWindowForTarget`, `Browser.setWindowBounds` | Minimize/restore window mode's Apple window. |
| `Browser.close` | Quit. |
| event `Target.targetDestroyed`, `Inspector.targetCrashed` | Window closed / page crashed. |

The protocol is documented at <https://chromedevtools.github.io/devtools-protocol/>.

---

## Speaker discovery packets

Every 3 s, the same packet goes to UDP port 8788 by:

- **multicast** to `239.255.77.77:8788`, TTL 1, on each physical LAN interface;
- **unicast** to each online Tailscale device (IPv4 from `tailscale status --json`, refreshed every 20 s;
  Tailscale carries no multicast) and to each `--peer` host.

A newly seen peer also gets an immediate unicast reply, so one-sided `--peer` setups work too.



```json
{"app":"orchard","id":"<speaker uuid>","name":"DESKTOP","port":8787}
```

Receivers also accept `"app":"juice"` from speakers still running a build from before the rename.

The receiver builds the peer URL from the packet's *source address* and `port`. A computer heard on both a LAN
and a Tailscale address keeps the LAN one while it is still answering (within 7 s).

---

## Stored data

**On disk** (data folder: Windows `%LOCALAPPDATA%\Orchard`, macOS `~/Library/Application Support/Orchard`,
Linux `~/.local/share/orchard`, or `--data`):

| Path | Contents |
|------|----------|
| `speaker-id` | This computer's speaker UUID. |
| `browser-<name>/` | The browser profile Orchard uses (e.g. `browser-brave`). Holds your Apple sign-in. Delete it to sign out completely / reset the browser. Contains `DevToolsActivePort` while running. |
| `browser.log` | The browser's console output (useful when the browser fails to start). |
| `access.json` | This account's secrets (keyring) and the computers proved to be on the same account. Reset on sign-out. |
| `auto-update`, `update-installed` | Updater setting and the last installed release file (`Updater.java`). |
| `browser-choice` | Path of the browser Orchard uses. Remembered so the profile (and sign-in) never switches by accident; `--browser` / `ORCHARD_BROWSER` change it. |
| `browser-profile/` | Profile from early versions. On startup Orchard moves it to `browser-<name>` if it belongs to the same browser and the current one has no Apple sign-in (a replaced profile is renamed `…replaced-<time>`, never deleted). |

**In the browser** (`localStorage`, per origin; the app window's origin is `https://music.apple.com`, a
phone's is `http://<ip>:8787`). Keys saved as `juice.*` before the rename are copied to `orchard.*` once
(`util.js` and `engine.js`; `orchard.migrated` marks it done, and the old keys are left in place):

| Key | Contents | Written by |
|-----|----------|------------|
| `orchard.deviceId` | Random id for this UI | `store.deviceId` |
| `orchard.key` | This device's key (phones and other browsers; not the Orchard window) | `store.setDeviceKey` |
| `orchard.deviceName` | Optional custom device name (set manually in DevTools) | (read by `store.deviceName`) |
| `orchard.speaker` | `''` or the URL of the speaker being controlled | `store.useSpeaker` |
| `orchard.recentSearches` | Up to 10 search terms | `views.searchRun` |
| `orchard.libKind` | Sidebar library tab | `app.js` |
| `orchard.right` | Right panel mode (`queue`/`lyrics`/null) | `player.toggleRight` |
| `orchard.keys` | Keyboard shortcuts `{action: [combo…]}` (also read by `engine.js`) | `keys.addBinding` / `removeBinding` |
| `orchard.sidebar` | `collapsed` / `open` | `app.toggleSidebar` |
| `orchard.seekStep` | Seconds the rewind / fast-forward keys move | `keys.setSeekStep` |
