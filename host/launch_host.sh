#!/bin/sh
# Wrapper Chrome invokes for the native messaging host on macOS.
# Chrome launched from the Dock gives the host launchd's bare PATH
# (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew's python3, yt-dlp and ffmpeg
# wouldn't be found -- and yt-dlp finds ffmpeg via PATH (needed for the mp4
# recode and trimming).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec python3 "$(dirname "$0")/yt_dlp_host.py" "$@"
