#!/bin/sh
# install.sh — registers the yt-dlp Downloader native messaging host for Chrome on macOS.
#
#   - Generates com.ytdlp.downloader.json from the tracked template, pointing it at
#     launch_host.sh, and writes it to the folder Chrome reads native hosts from
#   - Optionally overrides the allowed extension ID (--extension-id)
#
# Usage:
#   ./install.sh
#   ./install.sh --extension-id abcd...   # if your ID differs
#   ./install.sh --uninstall
set -eu

HOST_NAME="com.ytdlp.downloader"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/$HOST_NAME.template.json"
LAUNCHER="$SCRIPT_DIR/launch_host.sh"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/$HOST_NAME.json"
# The PATH the host gets via launch_host.sh when Chrome is started from the Dock.
HOST_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

EXTENSION_ID=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --extension-id) EXTENSION_ID="${2:?--extension-id needs a value}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install.sh is for macOS. On Windows, run install.ps1." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$MANIFEST" ]; then
    rm -f "$MANIFEST"
    echo "Removed $MANIFEST"
  else
    echo "Manifest not present; nothing to remove."
  fi
  exit 0
fi

[ -f "$LAUNCHER" ] || { echo "launch_host.sh not found next to install.sh." >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "$HOST_NAME.template.json not found next to install.sh." >&2; exit 1; }

# Look a tool up the way the host will see it.
find_tool() { (PATH="$HOST_PATH"; command -v "$1") || true; }

PYTHON="$(find_tool python3)"
if [ -z "$PYTHON" ] || ! "$PYTHON" -c "import sys" >/dev/null 2>&1; then
  echo "python3 not found. Install it with:  brew install python" >&2
  exit 1
fi

chmod +x "$LAUNCHER"   # in case the repo came as a zip, which drops the bit
mkdir -p "$MANIFEST_DIR"

# Generate the manifest from the template: absolute launcher path + optional ext ID.
ALLOWED="$("$PYTHON" - "$TEMPLATE" "$MANIFEST" "$LAUNCHER" "$EXTENSION_ID" <<'EOF'
import json, sys
template, out, launcher, ext_id = sys.argv[1:5]
with open(template, encoding="utf-8") as f:
    manifest = json.load(f)
manifest["path"] = launcher
if ext_id:
    manifest["allowed_origins"] = ["chrome-extension://%s/" % ext_id]
with open(out, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(", ".join(manifest["allowed_origins"]))
EOF
)"

echo "Installed native messaging host '$HOST_NAME'."
echo "  Manifest : $MANIFEST"
echo "  Launcher : $LAUNCHER"
echo "  Python   : $PYTHON"
echo "  Allowed  : $ALLOWED"

[ -n "$(find_tool yt-dlp)" ] || echo "
Warning: yt-dlp not found in /opt/homebrew/bin or /usr/local/bin.
  Install it with 'brew install yt-dlp', or set its full path in the extension's Settings."
[ -n "$(find_tool ffmpeg)" ] || echo "
Warning: ffmpeg not found in /opt/homebrew/bin or /usr/local/bin.
  Install it with 'brew install ffmpeg' (needed for the mp4 recode and trimming)."

echo ""
echo "Quit Chrome completely (Cmd+Q) and reopen it so it picks up the host."
echo "If your extension ID differs from the one above, re-run with:"
echo "  ./install.sh --extension-id <your-id>"
