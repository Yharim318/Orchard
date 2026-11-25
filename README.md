# Orchard

A Spotify-style client for **Apple Music**, written in Java 21 and compiled to a native executable with
**GraalVM native-image**. It needs nothing but an Apple Music subscription: no Apple developer account or keys.

- Spotify-like UI: Home, Search, album/artist/playlist pages, Your Library, queue, synced lyrics,
  shuffle/repeat, add to library or playlist, right-click menus, keyboard shortcuts.
- **Favorites sync with Apple Music.** The heart is Apple Music's *Favorite* (formerly *Love*): hearted songs
  land in Apple's **Favorite Songs** playlist on all your devices and are added to your library, as Apple's apps
  do. Orchard's *Favorite Songs* entry shows that playlist.
- **Connect-style remote control.** Once Orchard is running, any phone, tablet or laptop on the same Wi-Fi that
  opens the Orchard URL (or scans the QR code under the **Devices** button) becomes a remote automatically. Play
  state, queue, volume and lyrics stay in sync on every device in real time.
- **Multiple speakers.** Run Orchard on more than one computer and they find each other on the network. Pick a
  speaker in the Devices menu to move playback, including the current queue and position, like Spotify Connect.

## How it works

Apple Music audio is DRM-protected (FairPlay/Widevine), and Apple only lets its own **MusicKit** web player decode
it, so no Java library can play it directly. Orchard runs Apple's real web player and drives it:

```
 phone / tablet / laptop ──┐   SSE + HTTP (LAN / Tailscale)
 (browser = remote)        │
                           ▼
 ┌─────────── orchard (Java / GraalVM native) ───────────┐
 │ HTTP server · live event hub · Apple Music API proxy │
 │ LAN speaker discovery (UDP multicast)                 │
 └────────────────────┬─────────────────────────────────┘
                      │ Chrome DevTools Protocol
                      ▼
   your browser ── one app window: Orchard UI, served at https://music.apple.com/orchard/ by Orchard itself
                     └─ hidden iframe: music.apple.com  ← MusicKit: sign-in, DRM, audio
```

1. `orchard` launches your browser with its own profile and opens a single app window.
2. The window's address is `https://music.apple.com/orchard/`, but that page never comes from Apple: Orchard
   intercepts every request under `/orchard` and answers it from its own server. Because the Orchard page is then
   on Apple's site, Apple's player can run inside it as a same-site, first-party frame: sign-in cookies,
   storage and DRM work exactly as on music.apple.com. (Embedded under a foreign page such as `localhost`,
   Apple treats itself as a third party and sign-in fails.)
3. Apple's pages refuse to be framed (`X-Frame-Options: DENY`), so Orchard removes that header from Apple page
   responses on the way in. You never see Apple's page unless you need to sign in, or press **Ctrl+Shift+A**.
4. Orchard injects a small bridge script (`src/main/resources/engine/engine.js`) into Apple's page. Player
   commands (play, seek, queue…) and Apple Music API calls go through Apple's own MusicKit instance and tokens,
   and player events flow back to Java.
5. Java streams that state to every connected UI: phones get Server-Sent Events over HTTP; the app window has
   events pushed into it over DevTools (`HostLink.java`), since an `https://` page can't reach a plain-HTTP server.

If the hidden frame ever fails to start, Orchard falls back to running Apple Music in a separate minimized
window (or force that with `--engine-window`).

> **Heads-up:** this automates Apple's web player instead of using an official public API. It's fine for
> personal use, but it isn't endorsed by Apple, and a change on music.apple.com could break it until the
> bridge script is updated.

## Requirements

- A **Chromium-based browser** on the computer that plays the music. Orchard uses your **default browser** if
  it's Chromium-based (Chrome, Edge, Brave, Vivaldi…); otherwise it falls back to Chrome, Edge or Brave,
  whichever is installed. Firefox and Safari can't be used: Orchard drives the browser through Chrome's DevTools
  protocol. Plain open-source Chromium lacks the Widevine DRM module and only plays previews.
  Orchard runs the browser with its own separate profile, so your normal browsing data isn't touched. For Brave,
  Orchard switches on Widevine in that profile automatically.
- **GraalVM for JDK 21+** to build. Any JDK 21+ works if you only need the JAR.
- An **Apple Music subscription** (sign in once; the profile remembers you).

## Build

**Windows** (recommended if that's where your speakers/headphones are). Install GraalVM for JDK 21 and the
Visual Studio C++ build tools, then from an *x64 Native Tools Command Prompt*:

```bat
build.cmd            :: build\orchard.jar + build\orchard.exe
build.cmd --jar      :: JAR only
```

**macOS / Linux:**

```bash
./build.sh           # build/orchard.jar + build/orchard (native)
./build.sh --jar     # JAR only
```

> GraalVM can't cross-compile, so build on the OS you'll run it on. A binary built inside WSL is a Linux
> binary: it needs a Linux Chrome inside WSL, and with WSL's default NAT networking your phone can't reach
> it. For a Windows PC, build with `build.cmd` on Windows.

## Run

```bash
build/orchard                 # or: java -jar build/orchard.jar
```

1. The Orchard window opens. Click **Sign in**: Apple's page appears inside the Orchard window. Click its
   **Sign In** button and log in. Orchard hides the page again once you're signed in, and remembers you.
   The sign-in lives in the browser profile in Orchard's data folder (`%LOCALAPPDATA%\Orchard\browser-<browser>`),
   not in `build/`, so rebuilding never signs you out. Orchard remembers which browser it uses (`browser-choice`)
   so the profile can't silently switch; only `--browser` changes it.
   *Upgrading from Juice (Orchard's old name):* on its first start Orchard moves `%LOCALAPPDATA%\Juice` to
   `%LOCALAPPDATA%\Orchard`, sign-in included, as long as Juice isn't still running. Saved settings and the old
   `JUICE_*` environment variables carry over too.
2. Connect your phone: click the **Devices** button (bottom right) and scan the QR code. There is no app to
   install; the remote opens in your phone's browser (use *Add to Home screen* for an icon).
   The panel lists every address your phone might reach the computer on:
   - **Wi-Fi / LAN**: phone on the same home/office network.
   - **Tailscale**: install the Tailscale app on the phone, sign in to the same account, and it works from
     anywhere. Best choice on campus/work networks, which usually block devices from reaching each other.
   - **Public IP**: only if your network allows incoming connections.
3. On Windows, allow `orchard.exe` through the firewall when asked. Windows labels many networks (campus
   Ethernet, for example) as *Public*, so tick that box too if your phone connects over that network.

**Ctrl+Shift+A** shows/hides Apple's page (handy for troubleshooting). On Windows, Orchard runs without a terminal window;
**Ctrl+Shift+T** in the Orchard window opens/closes a window with its log (`%LOCALAPPDATA%\Orchard\orchard.log`). Closing the Orchard window quits Orchard.

| Option | Meaning |
| --- | --- |
| `--port <n>` | HTTP port (default `8787`) |
| `--name <text>` | Speaker name shown on other devices (default: the computer's name) |
| `--browser <path>` | Browser executable to use (also `ORCHARD_BROWSER`) |
| `--data <dir>` | Where the browser profile and speaker id live |
| `--local` | This computer only: no LAN remotes, no discovery |
| `--peer <host>` | Another Orchard computer to find directly (IP or name, repeatable). Tailscale devices are found automatically if the `tailscale` CLI is available (override its path with `ORCHARD_TAILSCALE`) |
| `--no-browser` | Run the server without playback (handy for UI work) |
| `--engine-window` | Run Apple Music in its own minimized window instead of hidden inside Orchard |
| `--console` | Windows: open the log window at startup (otherwise Ctrl+Shift+T opens/closes it) |
| `--debug` | Verbose logging (also `ORCHARD_DEBUG=1`) |

### Shortcuts

`K` or `Space` play/pause · `J` or `Ctrl/⌘ ←` previous · `L` or `Ctrl/⌘ →` next · `M` mute ·
`←` / `→` back / forward 10 s · `Esc` close the full-screen player · `Ctrl/⌘ K` search · `Ctrl/⌘ ,` settings ·
`Ctrl+Shift+A` show Apple's page · `Ctrl+Shift+T` show/hide the log window (Windows). Every shortcut (and the
10 s step) can be changed in Settings, where volume, shuffle, repeat, lyrics, queue and more can get keys too.
Double-click a track to play
it · right-click a track/album/playlist for more.

## Security notes

- The server listens on your LAN so phones can connect. Anyone on the same network can control playback and
  browse your library through it, as with Spotify Connect. Use `--local` on untrusted networks.
- Browser requests from other websites are rejected (Origin check), and requests addressed to unexpected host
  names are rejected (DNS-rebinding protection). Apple tokens never leave the Apple Music page.

## Developer documentation

The [`docs/`](docs/README.md) folder explains how every file works and how they interact, in the order
things happen at run time, plus protocol references and editing recipes. Start with
[docs/README.md](docs/README.md).

## Project layout

```
src/main/java/orchard/
  Main.java             startup, CLI options
  Orchard.java            app context (speaker identity, state)
  WebServer.java        HTTP routes, static UI, Apple API proxy, transfer, origin/host checks
  Hub.java              Server-Sent-Events hub ("Connect" devices)
  Engine.java           drives music.apple.com / MusicKit over DevTools; serves the /orchard app window
  HostLink.java         the app window's event channel (and relay to other speakers)
  CdpClient.java        Chrome DevTools Protocol client (java.net.http WebSocket)
  BrowserLauncher.java  finds and launches Chrome/Edge/Brave
  Discovery.java        finds other Orchard speakers (LAN multicast + Tailscale/--peer unicast)
  Net.java, Json.java, Log.java
src/main/resources/
  engine/engine.js      bridge injected into music.apple.com
  web/                  the UI (vanilla JS modules, no build step)
  META-INF/native-image native-image config (resources, flags)
```

No third-party Java dependencies: just the JDK, which keeps `native-image` simple and the binary small.

## Known limitations

- Audio plays on computers running Orchard. Phones are remotes; they can't be speakers themselves, because
  Apple's DRM can't be proxied to another browser.
- When not signed in, MusicKit only plays previews, and only for some queue types.
- Removing individual queue items depends on the MusicKit version on music.apple.com.
- Built and smoke-tested on Linux with a headless Chrome (catalog, search, queue, commands, previews, speaker
  discovery/transfer, native binary). Full-length signed-in playback needs a real Chrome/Edge with Widevine
  and your Apple ID, so it hasn't been run end to end yet.
