# 6. Build and configuration files

## Requirements

- **GraalVM for JDK 21+** (provides `javac`, `jar`, `java` and `native-image`). Any JDK 21+ is enough if
  you only build/run the JAR.
- **Windows native builds** also need the Visual Studio C++ build tools ("Desktop development with C++").
  `build.cmd` finds and activates them automatically.
- To run: a Chromium-based browser with Widevine (Chrome, Edge, Brave, Vivaldi).

GraalVM cannot cross-compile: build the Windows `.exe` on Windows, the Linux binary on Linux, and so on.

---

## `build.sh` (macOS / Linux)

```bash
./build.sh          # build/orchard.jar + build/orchard (native)
./build.sh --jar    # JAR only (seconds instead of ~30 s)
```

Steps:

1. Delete and recreate `build/classes`.
2. `javac --release 21 -encoding UTF-8 -d build/classes <every .java under src/main/java>`.
3. Copy `src/main/resources/.` into `build/classes/`, so resources sit at the classpath root (`web/…`,
   `engine/…`, `META-INF/…`).
4. `jar --create --file build/orchard.jar --main-class orchard.Main -C build/classes .`
5. Unless `--jar`: `native-image -march=compatibility -jar build/orchard.jar -o build/orchard`.
   `-march=compatibility` makes the binary run on older CPUs, not just the build machine's.
6. Windows only (`build.cmd`): `editbin /subsystem:windows build\orchard.exe` marks the exe as a windowed
   program, so Windows (and Windows Terminal, when it is the default terminal) opens no terminal for it. Its
   output goes to `orchard.log` instead (see `ConsoleWindow`); Ctrl+Shift+T shows it. Run the JAR to see output in a
   terminal.

## `build.cmd` (Windows)

Same steps as `build.sh`, plus automatic tool discovery so it works from any command prompt or by
double-clicking:

1. **GraalVM**: uses `ORCHARD_GRAALVM_HOME` from `local.env` (see below) if set, then `JAVA_HOME`, otherwise
   the first folder matching `%ProgramFiles%\Java\graalvm-*`, `%ProgramFiles%\GraalVM\*` or `%USERPROFILE%\.jdks\graalvm-*` that contains
   `bin\native-image.cmd`, and puts its `bin` first on `PATH`.
2. Compiles (via a `build\sources.txt` argument file), copies resources with `xcopy`, creates the JAR.
3. **Visual Studio C++ tools**: if `cl.exe` isn't already on `PATH`, uses `vswhere.exe` to find the newest
   Visual Studio with the C++ x64 tools and calls its `vcvars64.bat`.
4. `native-image -march=compatibility -jar build\orchard.jar -o build\orchard` → `build\orchard.exe`.
5. Pauses at the end only when launched by double-click (so the window doesn't vanish).

Note: the file must keep **Windows (CRLF) line endings**. Some editors or WSL tools convert them; if `cmd`
starts printing odd errors, convert the line endings back.

### Working from WSL

If the project lives in WSL, the Windows build has to run from a copy on the Windows drive, because `cmd.exe`
can't run scripts from `\\wsl.localhost\…` paths. Set `ORCHARD_WINDOWS_DIR` in `local.env` to that copy's WSL
path (for example `/mnt/c/Users/<you>/Orchard`), then sync and build in one go from WSL:

```bash
./sync-windows.sh && (cd /mnt/c/Users/<you>/Orchard && /mnt/c/Windows/System32/cmd.exe /c build.cmd)
```

Or run `build.cmd` in that Windows folder yourself after `./sync-windows.sh`. Quit Orchard first: the build
can't replace `orchard.exe` while it is running.

### `local.env` (machine-specific paths)

Paths that differ per machine live in `local.env` at the project root, which is in `.gitignore`. Copy
`local.env.example` to `local.env` and fill in what you need; every setting is optional. The format is
`NAME=value` per line, without quotes; lines starting with `#` are comments. A real environment variable of
the same name takes precedence over the file.

| Setting | Read by | Meaning |
|---|---|---|
| `ORCHARD_WINDOWS_DIR` | `sync-windows.sh` | WSL path of the Windows copy to sync to (e.g. `/mnt/c/Users/<you>/Orchard`). |
| `ORCHARD_GRAALVM_HOME` | `build.cmd` | Windows path of the GraalVM folder to build with. |

`sync-windows.sh` copies `local.env` along with the other top-level files, so the Windows copy's `build.cmd`
sees the same settings.

---

## `src/main/resources/META-INF/native-image/orchard/orchard/native-image.properties`

`native-image` automatically reads `META-INF/native-image/<group>/<artifact>/native-image.properties` from
JARs it compiles. Ours contains:

```
Args = --no-fallback \
       --install-exit-handlers \
       --enable-http \
       --enable-https \
       -H:ResourceConfigurationResources=${.}/resource-config.json
```

- `--no-fallback`: fail rather than produce a binary that secretly needs a JVM.
- `--install-exit-handlers`: run Java shutdown hooks on Ctrl+C / console close, so Orchard closes the browser
  cleanly (a killed browser can lose a fresh Apple Music sign-in).
- `--enable-http/--enable-https`: include URL protocol handlers (used by `java.net.http`).
- `-H:ResourceConfigurationResources=…`: points at the resource list below. (GraalVM prints a warning that
  this option is "experimental"; it's harmless.)

## `…/resource-config.json`

```json
{ "resources": { "includes": [ { "pattern": "^web/.*" }, { "pattern": "^engine/.*" } ] } }
```

Native images only contain resources that are explicitly listed. Everything under `web/` and `engine/` is
embedded. **If you add a new resource folder, add a pattern here**, or the native binary won't find
the files (the JAR would, which makes this easy to miss).

No reflection configuration exists because the code uses no reflection. If you add a library that does
(most JSON or HTTP libraries), run your app once on the JVM with GraalVM's tracing agent
(`java -agentlib:native-image-agent=config-output-dir=src/main/resources/META-INF/native-image/orchard/orchard -jar build/orchard.jar`)
to generate the needed config.

---

## Other root files

| File | Purpose |
|------|---------|
| `README.md` | User-facing overview: what Orchard is, how it works (short), requirements, build, run, options, security notes, limitations. Keep it in sync when behaviour changes. |
| `.gitignore` | Ignores `build/` and `*.log`. |
| `docs/` | This documentation. |

## Version number

`Orchard.VERSION` in `Orchard.java`. Shown in the banner and `/api/info`.
