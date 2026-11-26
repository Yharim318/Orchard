# Orchard developer documentation

These documents explain how Orchard works, file by file and step by step, so you can change it
confidently. Read them in order the first time; afterwards use them as a reference.

| # | Document | What it gives you |
|---|----------|-------------------|
| 1 | [The big picture](1-big-picture.md) | The problem Orchard solves, the three "places" code runs, and *why* the design is the way it is. Read this first; everything else assumes it. |
| 2 | [A session, start to finish](2-timeline.md) | Chronological walkthrough: building, launching, the window appearing, signing in, pressing play, a phone connecting, handing playback to another computer, quitting. Every step names the file and function doing the work. |
| 3 | [Java files](3-java-reference.md) | Every class in `src/main/java/orchard/`: responsibility, important members, who calls it, what to watch out for when editing. |
| 4 | [Web UI and engine bridge files](4-web-reference.md) | Every file in `src/main/resources/`: the UI modules, the stylesheet, the HTML shell and the script injected into Apple's page. |
| 5 | [Protocols and data shapes](5-protocols.md) | Reference tables: HTTP API, live events, the app-window channel, player commands, the state object, DevTools calls, discovery packets, stored settings, files on disk. |
| 6 | [Build and configuration](6-build-and-config.md) | `build.sh`, `build.cmd`, the GraalVM native-image config, and the other files at the project root. |
| 7 | [Editing guide](7-editing-guide.md) | Recipes for common changes (new page, new player command, new API route, new setting), debugging techniques, and pitfalls. |

## The project at a glance

```
Orchard/
├── build.sh / build.cmd           build the JAR and the native executable (macOS/Linux / Windows)
├── local.env.example               template for local.env, the git-ignored machine-specific paths
├── README.md                       user-facing readme
├── docs/                           ← you are here
└── src/main/
    ├── java/orchard/                 the Java program (server, browser control, discovery)
    │   ├── Main.java               entry point: wires everything together
    │   ├── Orchard.java              shared application context
    │   ├── WebServer.java          HTTP server: UI files + JSON API
    │   ├── Hub.java                live-event hub ("Connect": devices, state, speakers)
    │   ├── HostLink.java           the app window's private event channel
    │   ├── Engine.java             drives Apple's web player through the browser
    │   ├── CdpClient.java          Chrome DevTools Protocol client (WebSocket)
    │   ├── BrowserLauncher.java    finds and launches the browser
    │   ├── Discovery.java          finds other Orchard computers on the network
    │   ├── Net.java                network-address helpers
    │   ├── Json.java               tiny JSON parser/writer
    │   └── Log.java                console logging
    └── resources/
        ├── engine/engine.js        script injected into music.apple.com (the "bridge")
        ├── web/                    the user interface (served to the app window and phones)
        │   ├── index.html          page skeleton
        │   ├── app.css             all styling
        │   ├── icon.svg, manifest.webmanifest
        │   ├── vendor/qrcode.js    third-party QR-code generator
        │   └── js/                 UI modules: app, store, views, components, player, lyrics, util
        └── META-INF/native-image/  GraalVM native-image settings
```

## Five-sentence summary

Orchard is a Java program that launches your Chromium-based browser and controls it remotely through the
Chrome DevTools Protocol. It opens one app window whose address is `https://music.apple.com/orchard/`, but
Orchard itself answers every request for that address, serving its own Spotify-style interface. Inside that
page sits an invisible iframe running Apple's real web player, which handles sign-in, DRM and audio. Orchard
injects a small script into Apple's player to send it commands and receive its state, and broadcasts that
state to every open Orchard interface. Phones load the same interface over the local network and act as
remote controls.

## Glossary

| Term | Meaning in this project |
|------|-------------------------|
| **App window** / **host app** | The browser window Orchard opens on the computer. Its UI runs at `https://music.apple.com/orchard/?host=1`. |
| **Remote** | Any other browser (phone, tablet, laptop) showing the Orchard UI from `http://<computer>:8787/`. |
| **Speaker** | A computer running Orchard, i.e. a place where audio can play. Several can exist on one network. |
| **Engine** | Apple's music.apple.com page running hidden inside the app window, plus the Java code driving it (`Engine.java`). |
| **Bridge** | `engine.js`, the script Orchard injects into Apple's page. It exposes `window.__orchard` and reports state. |
| **MusicKit** | Apple's JavaScript player library that music.apple.com uses. Orchard talks to its instance via the bridge. |
| **CDP** | Chrome DevTools Protocol: JSON messages over a WebSocket that let a program control a Chromium browser. |
| **Hub** | The Java component that pushes live updates (state, devices, speakers) to every UI. |
| **SSE** | Server-Sent Events: a one-way, long-lived HTTP response that streams events. Used by remotes. |
| **Storefront** | Apple's country code for the catalog (`us`, `gb`, …). Most Apple API paths include it. |
| **Catalog id / library id** | Apple ids. Catalog ids are numeric (`1440857781`); library ids have prefixes: `i.` song, `l.` album, `p.` playlist, `r.` artist. |
