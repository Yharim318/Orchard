# 1. The big picture

## The problem

Orchard wants to be a Spotify-like client for Apple Music, written in Java, with phones acting as remote
controls. Three hard constraints shape the design:

1. **Apple Music audio is DRM-protected.** Full tracks are encrypted (Widevine in Chromium browsers). Only Apple's
   own player, MusicKit, running in a browser that ships the Widevine module (Chrome, Edge, Brave, Vivaldi), can
   decrypt and play them. No Java library can.
2. **No Apple developer account.** Third-party MusicKit apps need a developer token signed with a paid
   Apple key. Orchard instead reuses Apple's own web player at music.apple.com, which already carries Apple's token.
3. **Apple's web player only works properly on Apple's own site.** Apple's token is restricted to apple.com
   origins, Apple's pages refuse to be embedded in other sites, and Apple's sign-in needs first-party cookies.

So Orchard cannot play audio itself. It **remote-controls a real browser** that runs Apple's real player, and
builds its own interface around it.

## The three places code runs

```
┌──────────────────────────── the computer ("speaker") ─────────────────────────────┐
│                                                                                    │
│  ① Java process (orchard / orchard.exe)                                                │
│     Main ─ Orchard ─ WebServer (HTTP :8787) ─ Hub ─ HostLink                         │
│                  └ Engine ─ CdpClient ══WebSocket══╗      Discovery (UDP 8788)     │
│                                                    ║                               │
│  ② Browser (Brave/Chrome/Edge), launched by Orchard  ║ Chrome DevTools Protocol     │
│     ┌───────────── app window ─────────────────────╨──────────────┐                │
│     │ https://music.apple.com/orchard/?host=1   ← answered by Java  │                │
│     │  Orchard UI (web/index.html + web/js/*.js)                    │                │
│     │  ┌── hidden <iframe id="am-engine"> ─────────────────────┐  │                │
│     │  │ https://music.apple.com/  (Apple's real web player)   │  │                │
│     │  │   + engine.js bridge (window.__orchard)                 │  │                │
│     │  │   MusicKit → DRM → 🔊 audio                           │  │                │
│     │  └───────────────────────────────────────────────────────┘  │                │
│     └─────────────────────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────────────────────┘
          ▲ HTTP + Server-Sent Events (Wi-Fi / Tailscale)
          │
  ③ Remotes: phone / tablet / laptop browsers at http://<computer-ip>:8787/
     Same UI files (web/), talking to the Java server directly.
```

**① The Java process** is the brain. It serves files and a JSON API over HTTP, keeps a list of connected
devices, launches and controls the browser, and finds other Orchard computers on the network. Everything
written in Java lives in `src/main/java/orchard/`.

**② The browser** is the muscle. Java launches it with a private profile and a remote-debugging port, then
connects to it over a WebSocket (CDP). The browser shows one **app window**. That window contains:

- **The Orchard UI**, i.e. the files in `src/main/resources/web/`. It is loaded from the address
  `https://music.apple.com/orchard/?host=1`, which does *not* exist on Apple's servers: Java intercepts every
  request to `…/orchard…` and answers it itself (see "The same-site trick" below).
- **Apple's player**: an invisible iframe (`#am-engine`) showing `https://music.apple.com/`. Orchard injects
  `src/main/resources/engine/engine.js` into it, which adds `window.__orchard` (commands in) and calls
  `window.__orchardEmit` (state out).

**③ Remotes** are ordinary browsers on other devices. They load the *same* UI files from
`http://<computer-ip>:8787/` and talk to the Java server directly with `fetch` and an `EventSource` (SSE).

The UI code is shared: it detects at startup whether it runs in the app window or on a remote
(`HOST_PROXY` in `store.js`) and picks the right way to talk to Java.

## Why each odd-looking piece exists

### Why control a browser over DevTools?
CDP lets Java do things a web page cannot: inject scripts into Apple's page before Apple's own code runs,
call JavaScript inside it and get results, intercept and rewrite network responses, open/minimize windows,
and close the browser on exit. `CdpClient.java` is a small, dependency-free CDP client.

### Why is the app window at `https://music.apple.com/orchard/`? (the same-site trick)
Browsers treat a page embedded inside a *different site* as a third party, like an ad. Third parties get
restricted cookies and partitioned storage. When the Orchard window was `http://localhost:8787`, Apple's player
inside it was a third party, and Apple's sign-in failed at the final step ("Unable to sign into Apple Music").

By giving the Orchard window an address on Apple's own site, Apple's player becomes a same-site, first-party
frame. Cookies, storage and DRM then behave exactly as on music.apple.com. The `/orchard` path doesn't exist
at Apple (it would be a 404), so nothing real is shadowed. Java answers it using CDP's `Fetch` domain:
every request whose URL starts with `https://music.apple.com/orchard` is paused before it leaves the browser,
and Java supplies the response (`Engine.answerOrchardRequest`).

### Why strip headers from Apple's pages?
Apple's pages send `X-Frame-Options: DENY` and a `Content-Security-Policy: frame-ancestors …` rule, which
forbid putting them in an iframe at all. Java intercepts Apple *document* responses and re-serves them
without those headers (`Engine.unblockFraming`). Note that only editing the headers in place doesn't work:
Chrome checks framing against the original headers, so the whole response is re-fulfilled with its body.

### Why can't the app window just use `http://localhost:8787` for its API calls?
It's an `https://` page now. Browsers block (or prompt for) requests from public https sites to plain-HTTP
local addresses. So the app window never calls localhost directly:

- its HTTP requests go to `/orchard/api/...`, which Java intercepts and forwards to its own server
  (`HostLink.forward`);
- its live events are pushed into the page by Java evaluating `window.__orchardPush(event, data)` over CDP
  (`HostLink.HostClient`).

Remotes don't have this problem, so they use plain HTTP and SSE.

### Why a separate "speaker" concept?
Like Spotify Connect, several computers can each run Orchard. They find each other with UDP multicast on the LAN and unicast over Tailscale
(`Discovery.java`), any UI can choose which one to control, and playback can be handed from one to another
(`/api/transfer`). Phones can't be speakers (see the main README for why).

### Why no libraries?
Everything uses only the JDK (`com.sun.net.httpserver`, `java.net.http`, the JSON class we wrote). That keeps
GraalVM native-image compilation simple: no reflection configuration, small binary, fast startup.

## Fallback: window mode

If Apple's player can't start inside the app window within 45 seconds (or you pass `--engine-window`),
Orchard runs Apple's page in a separate, minimized browser window instead (`Engine.openEngineWindow`). Most of
the code doesn't care which mode is active; the differences are confined to `Engine.java`.

## Where to go next
Read [2-timeline.md](2-timeline.md): it walks through a whole session in the order things happen.
