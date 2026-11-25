#!/usr/bin/env bash
# Copies this project (from WSL) to the Windows copy that build.cmd builds, so the next Windows build uses
# the latest code.
#   ./sync-windows.sh                 copy to C:\Users\glika\Juice
#   ./sync-windows.sh /mnt/c/other    copy somewhere else (or set ORCHARD_WINDOWS_DIR; JUICE_WINDOWS_DIR also works)
# (The app is called Orchard now; the project folders kept their old "Juice" names.)
# src/ and docs/ are mirrored exactly (files deleted here are deleted there too). The Windows build/ folder is
# never touched.
set -euo pipefail
cd "$(dirname "$0")"

DEST="${1:-${ORCHARD_WINDOWS_DIR:-${JUICE_WINDOWS_DIR:-/mnt/c/Users/glika/Juice}}}"
DEST="${DEST%/}"

if [[ ! -d "$(dirname "$DEST")" ]]; then
  echo "Can't find $(dirname "$DEST") - is the Windows drive mounted?" >&2
  exit 1
fi
mkdir -p "$DEST"

# Folders: mirror (--delete removes files that no longer exist here). --checksum avoids re-copying unchanged
# files on the Windows drive, where timestamps are unreliable.
for dir in src docs; do
  rsync -r --checksum --delete --itemize-changes "$dir/" "$DEST/$dir/" | sed "s|^|  $dir: |"
done

# Top-level files, copied byte for byte (build.cmd keeps its CRLF line endings).
for f in README.md build.sh build.cmd .gitignore sync-windows.sh; do
  [[ -f "$f" ]] && rsync --checksum --itemize-changes "$f" "$DEST/$f" | sed "s|^|  |"
done

# Guard against the earlier mix-up where a copy landed in a nested Juice\Juice folder.
for nested in Juice Orchard; do
  if [[ -d "$DEST/$nested/src" ]]; then
    echo "Warning: $DEST/$nested also contains a project; build.cmd builds $DEST, not that one." >&2
  fi
done

echo "Synced to $DEST"
