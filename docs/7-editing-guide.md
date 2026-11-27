# 7. Editing guide

Practical recipes, debugging techniques and the mistakes that are easy to make in this codebase.

## The edit–build–run loop

The UI files are embedded in the program, so **every change, even to CSS, needs a rebuild**. For fast
iteration build only the JAR and run it on the JVM:

```bash
./build.sh --jar && java -jar build/orchard.jar --debug          # macOS/Linux/WSL
```
```bat
build.cmd --jar && java -jar build\orchard.jar --debug
```
(On Windows, use `<GraalVM folder>\bin\java` if `java` isn't on your `PATH`.)

Editing in WSL but building on Windows? `./sync-windows.sh` copies `src/`, `docs/` and the top-level files to
the Windows folder set as `ORCHARD_WINDOWS_DIR` in `local.env` (or given as an argument), mirroring deletions. It never
touches the Windows `build\` folder.

Build the native executable when you're done. Close any running Orchard first (port 8787 and the `.exe` file
are in use while it runs), or run a second copy with `--port 8790 --data <other folder>`.

---

## Recipes

### Add a new page

1. **`views.js`**: write `async function mypage(el, match) { … el.innerHTML = … }`. Use `am()` for Apple
   data, `esc()` for every value, `loading()`/`errorBox()` for states, `registerList` + `trackRows` for
   songs, `shelf`/`grid` for cards. Return a cleanup function if you subscribe to anything.
2. **`views.js` `routes`**: add `[/^#\/mypage$/, mypage]` (capture groups arrive in `match[1]`, …).
3. Link to it: `href="#/mypage"` anywhere, or add it to the sidebar/tab bar in `app.js buildShell`
   (with `data-nav` if it should highlight; see `highlightNav`).
4. Style it in `app.css` (desktop rules first, phone overrides inside `@media (max-width: 760px)`).

### Add a player command (e.g. "set playback rate")

1. **`engine.js` `cmd()`**: add `case 'rate': m.playbackRate = c.value; break;` (MusicKit API).
2. **UI**: call `cmd({ type: 'rate', value: 1.5 })` from wherever the control lives (usually
   `player.js control()` for a `data-c` button).
3. Nothing in Java changes: `/api/cmd` passes any command object through.
4. If the command changes state that should be shown, add the field to `snapshot()` in `engine.js` and
   use it in `player.js update()`.
5. Document it in `docs/5-protocols.md`.

### Use another Apple Music API endpoint

Only UI code: `const r = await am('/v1/…')` (GET) or `await amWrite('POST', '/v1/…', body)`. The path must
start with `/v1/`. Every GET is cached in the UI (memory + IndexedDB, shown at once and refreshed in the
background; a changed answer fires `data-updated`), and catalog GETs are also cached for 10 min in Java. Library
reads after an `amWrite` go to Apple first. Pass `{ fresh: true }` to `am()` to skip the cache. Apple's API reference is at
<https://developer.apple.com/documentation/applemusicapi>.

### Add a Java API endpoint

1. **`WebServer.api`**: add a case, e.g. `case "GET /api/hello" -> sendJson(ex, 200, Json.obj("hi", true));`.
   Read JSON bodies with `body(ex)`, query strings with the `q` map; throw `new HttpError(400, "…")` for bad input.
2. **UI**: for data about *this computer*, `http(ROOT + '/api/hello')` (add an exported helper in
   `store.js`); for something that should follow the **selected speaker**, use `speakerRequest` /
   `post`.
3. It works in the app window automatically (`HostLink.forward` forwards any `/orchard/api/...`).

### Push a new live event to every UI

1. Java: `app.hub().broadcast("myevent", data)` (or add a callback in `Main` like the existing ones).
2. **`store.js` `handlers`**: `myevent: (d) => { S.something = d; notify('myevent'); }`.
3. UI: `subscribe((kind) => { if (kind === 'myevent') … })`.
4. If it must be sent to new clients immediately, also send it in `Hub.register`.

### Add a command-line option

`Main.Options` (field) → `Main.parse` (case + help text) → use it in `main`/`startEngine`. Document it in
the README options table.

### Change the look

- Colours and sizes: the `:root` custom properties at the top of `app.css` (`--accent` is the orange).
- Desktop layout: the `body` grid (`grid-template-columns/areas`); phones: the `@media (max-width: 760px)`
  block; mid-size: `@media (max-width: 1100px)`.
- Icons: add a 24×24 SVG path to the `P` table in `util.js`, use `icon('name')`.

### Add a context-menu item or keyboard shortcut

- Track menu: `components.trackMenuItems`; album/playlist menu: `collectionMenuItems`. Items are
  `{label, icon, run}`.
- Shortcuts: add an entry to `ACTIONS` in `keys.js` (it appears in Settings) and handle its `id` in
  `app.runAction` or `player.playerAction`. (For a shortcut that must also work while Apple's page has focus,
  handle it in `engine.js`'s `keydown` listener too, as the `apple` and `log` actions are.)

### Support another browser

`BrowserLauncher`: add the executable name to `CHROMIUM_EXES`, install paths to `fallback()`, macOS bundle
id to `macDefault()`. It must be Chromium-based and ship Widevine.

### Add files under `web/` with a new extension

Add the MIME type to `WebServer.TYPES`. (Everything under `web/` is already embedded in native builds.)

---

## Debugging

| Tool | How |
|------|-----|
| Verbose Java log | `--debug` (or `ORCHARD_DEBUG=1`). Shows engine script boots, frame attachments, browser launch command. |
| Bridge log | In `engine.js`, `log('something', value)` prints in Orchard's console as `engine: something value`. |
| See Apple's page | **Ctrl+Shift+A** in the Orchard window. |
| See the Java log (Windows exe) | **Ctrl+Shift+T** in the Orchard window opens/closes the log window (or start with `--console`). The log is `%LOCALAPPDATA%\Orchard\orchard.log`. |
| Browser DevTools on the app window | Press **F12** or **Ctrl+Shift+I** in the Orchard window. In the Console's context dropdown, pick the `am-engine` frame to poke at `MusicKit.getInstance()` or `window.__orchard`. |
| DevTools for a phone | Android: enable USB debugging, connect, open `chrome://inspect` on the computer. |
| Browser startup problems | `<data>/browser.log`. |
| Isolate the embedding | Run with `--engine-window`: if things work there, the problem is in embedded-mode code (`Engine.startEmbedded`, interception, `createFrame`). |
| API by hand | `curl http://localhost:8787/api/state`, `curl -X POST -d '{"type":"next"}' http://localhost:8787/api/cmd`, `curl -N "http://localhost:8787/api/events?deviceId=x&name=curl&kind=computer"`. |
| Automated/headless | `--headless --browser <chrome path>` runs without a visible window; the browser's DevTools port is in `<profile>/DevToolsActivePort`, so scripts can drive and screenshot it. |

---

## Pitfalls

1. **Absolute URLs in the UI break the app window.** The app window lives under `/orchard/`. Use relative paths
   (`app.css`, `vendor/qrcode.js`) for files and `ROOT + '/api/…'` (or the `store.js` helpers) for the API.
   A leading `/` would request Apple's real site.
2. **Never call `http://localhost…` or a speaker URL directly from the UI.** The https app window can't. Go
   through `store.js` (`speakerRequest` adds `X-Orchard-Peer` for other speakers).
3. **Escape everything.** `innerHTML` + unescaped Apple data = broken pages (or script injection). Use `esc()`.
4. **Don't block the CDP event thread.** `CdpClient` delivers events one at a time on one thread; a listener
   that waits on something blocks every other event. Do slow work in `Thread.startVirtualThread`, as
   `Engine` does.
5. **`Fetch` interception must answer every paused request.** In `Engine.onRequestPaused`, every code
   path must end in `fulfillRequest` or `continueRequest`, or that request hangs forever. If you widen the
   interception patterns, handle the new cases.
6. **MusicKit promises can hang.** Wrap awaits in `settle()` in `engine.js`.
7. **`userGesture: true`** in `Engine.evaluate` is what lets `play()` start audio. Keep it.
8. **Native image specifics.** No reflection, no dynamic class loading; new resource folders need a pattern
   in `resource-config.json`. Test the native binary, not just the JAR, before relying on a change.
9. **Everything is reachable from the network.** Validate inputs in new endpoints; only contact other
   machines via `Discovery` peers (`HostLink.peerBase`, `WebServer.transfer` pattern).
10. **Apple can change music.apple.com.** Breakage there shows up in `engine.js` (MusicKit API, event names,
    the token headers in `api()`), in `Engine.unblockFraming` (new framing protections), or in the sign-in
    flow. Use Ctrl+Shift+A and DevTools to see what Apple's page is doing.
11. **`localStorage` in the app window belongs to `https://music.apple.com`**, shared with Apple's site.
    Keep keys prefixed with `orchard.`.
12. **Keep the docs in step.** When you add a route, command, event or file, update the matching table in
    `docs/`.
