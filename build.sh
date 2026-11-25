#!/usr/bin/env bash
# Builds Orchard: plain JAR (build/orchard.jar) and a GraalVM native executable (build/orchard).
#   ./build.sh            JAR + native executable
#   ./build.sh --jar      JAR only (run with: java -jar build/orchard.jar)
set -euo pipefail
cd "$(dirname "$0")"

rm -rf build/classes
mkdir -p build/classes
echo "==> Compiling"
javac --release 21 -encoding UTF-8 -d build/classes $(find src/main/java -name '*.java')
cp -R src/main/resources/. build/classes/
jar --create --file build/orchard.jar --main-class orchard.Main -C build/classes .
echo "    build/orchard.jar"

if [[ "${1:-}" == "--jar" ]]; then exit 0; fi

if ! command -v native-image >/dev/null 2>&1; then
  echo "native-image not found. Install GraalVM for JDK 21+ (e.g. 'sdk install java 21-graal') or run: java -jar build/orchard.jar" >&2
  exit 1
fi
echo "==> Building native executable (takes a minute or two)"
native-image -march=compatibility -jar build/orchard.jar -o build/orchard
echo "    build/orchard"
