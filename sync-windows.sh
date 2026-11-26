#!/usr/bin/env bash
# Copies this project (from WSL) to the Windows copy that build.cmd builds, so the next Windows build uses
# the latest code.
#   ./sync-windows.sh                 copy to ORCHARD_WINDOWS_DIR (set in local.env or the environment;
#                                     JUICE_WINDOWS_DIR also works)
#   ./sync-windows.sh /mnt/c/other    copy somewhere else
# (The app is called Orchard now; the project folders kept their old "Juice" names.)
# src/ and docs/ are mirrored exactly (files deleted here are deleted there too). The Windows build/ folder is
# never touched.
set -euo pipefail
cd "$(dirname "$0")"

# Machine-specific settings from local.env (NAME=value lines); real environment variables win.
if [[ -f local.env ]]; then
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    key="${key//[[:space:]]/}"
    value="${value%$'\r'}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!key:-}" ]] || printf -v "$key" '%s' "$value"
  done < local.env
fi

DEST="${1:-${ORCHARD_WINDOWS_DIR:-${JUICE_WINDOWS_DIR:-}}}"
if [[ -z "$DEST" ]]; then
  echo "No destination. Set ORCHARD_WINDOWS_DIR in local.env (see local.env.example) or pass a folder." >&2
  exit 1
fi
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
for f in README.md build.sh build.cmd .gitignore sync-windows.sh local.env local.env.example; do
  [[ -f "$f" ]] && rsync --checksum --itemize-changes "$f" "$DEST/$f" | sed "s|^|  |"
done

# Guard against the earlier mix-up where a copy landed in a nested Juice\Juice folder.
for nested in Juice Orchard; do
  if [[ -d "$DEST/$nested/src" ]]; then
    echo "Warning: $DEST/$nested also contains a project; build.cmd builds $DEST, not that one." >&2
  fi
done

echo "Synced to $DEST"
