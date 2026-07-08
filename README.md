# yt-dlp Downloader (Chrome extension, Windows)

A toolbar button that downloads the video on the current page with
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp), using your browser's cookies for the
current site.

Because a Chrome extension can't launch programs directly, it talks to a small
**native messaging host** (a Python script) that writes a cookies file and runs
your `yt-dlp` command.

```
[toolbar button] → [service worker] → [Python host] → yt-dlp.exe
   reads cookies                       writes cookies.txt, runs command
```

## Prerequisites

- **Google Chrome** (or Chromium-based browser using the same registry path).
- **Python 3** on Windows (`py -3` or `python` on PATH).
- **yt-dlp** — [`yt-dlp.exe`](https://github.com/yt-dlp/yt-dlp/releases). Note the
  full path, or put it on your PATH. (For merging video+audio, also install
  **ffmpeg**.)

## Install

### 1. Load the extension
1. Go to `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` folder.
3. Confirm the extension **ID** shown is:
   `dmaooopfmepihdanajgcadodnmhahgli`
   (The bundled `key` in `manifest.json` pins this ID. If it differs, see step 3.)

### 2. Register the native host
In PowerShell, from the `host/` folder:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

This generates `com.ytdlp.downloader.json` from
`com.ytdlp.downloader.template.json` (filling in the absolute path to
`launch_host.bat`) and creates the registry key
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ytdlp.downloader`. The
generated file is git-ignored, so `git pull` never conflicts with it — just
**re-run `install.ps1` after pulling** if the repo location changed.

### 3. (Only if your extension ID differs)
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <your-id>
```

### 4. Configure
Right-click the toolbar icon → **Options** (or click **Settings** in the popup):
- **Path to yt-dlp** — e.g. `C:\tools\yt-dlp.exe` (or `yt-dlp.exe` if on PATH).
- **Output directory** — e.g. `%USERPROFILE%\Downloads`.
- **Command template** — defaults to:
  ```
  "{ytdlp}" -N 16 --recode-video mp4 --cookies "{cookies}" -P "{output}" -f "bv*+ba/b" "{url}"
  ```
  Placeholders: `{ytdlp}` `{cookies}` `{output}` `{url}`.

## Usage

1. Open a video page.
2. Click the toolbar button. In the popup you can set, per download:
   - **Download to** — the destination folder. Type/paste a path, or click
     **Browse…** to pick one with a native folder dialog.
   - **Transcript** — also save the video's captions as a cleaned `.srt`.
   - **New Folder** — put this video (and its transcript) in its own subfolder
     named after the video.
3. Click **Download this video**. The popup shows progress and the final output.

All three settings **persist to the next download** until you change them.

### Trim (download only a section)

Above **Download to** is a **Trim** row. Its two quick presets read the web
player's current time:

- **Start → current** — from the beginning up to where you are now.
- **Current → end** — from where you are now to the end.

Click the **Trim ▾** arrow to expand full controls: a **dual-handle slider**
(defaults to the whole video, max read from the player), **timestamp boxes** on
each side (type `1:05`, `2:03:10`, or seconds — they stay in sync with the
slider), a **Use current** button under each box (fills from the player), a clip
length readout, and **Reset**. Handles/boxes can't cross, so start is always
before end.

Downloading a section uses yt-dlp `--download-sections` (fast keyframe-snap cut —
may start slightly before your exact point) and names the file with the range,
e.g. `26-07-08 Title [1m03s-2m30s].mp4`. The full range = a normal full download.

> Needs **ffmpeg** (already required for the mp4 recode). Reading the player works
> on standard HTML5 players (YouTube, etc.); on DRM or cross-origin embedded
> players the slider/current-time buttons are disabled — type timestamps manually.
> The trim selection resets to the full video for each new download.

### Progress

While a download runs, the toolbar icon shows a **green ring** that fills with
progress (blue while yt-dlp is merging/recoding), plus a **% badge**. Progress is
tracked by the background service worker, so it keeps going (and the icon keeps
updating) **even if you close the popup** — reopen it to see the current state.

### Queue & "In Progress"

Downloads run **one at a time and queue** — trigger another download (e.g. from a
different tab) while one is running and it lines up behind it. An **In progress**
section appears in the popup (above Recent downloads) showing the current download
with its progress bar plus anything **Queued** behind it. When one finishes, the
next starts automatically.

- **Hover a queued row → ×** removes it from the queue.
- **Hover the running row → ×** stops that download (kills yt-dlp) and advances to
  the next. (A partial `.part`/temp file may be left in the output folder.)

The queue lives in memory only (download requests carry your cookies, so they are
never written to disk); an active download keeps the worker alive, but if the
browser is fully restarted any not-yet-started queued items are cleared.

### Recent downloads

The popup lists your **last 5 downloads**, each with a 🎬 video icon, a 📄
transcript icon (if a transcript was saved), and the title:

- **Click the title** → show the file selected in Explorer (drag the real file
  from there into Premiere, etc.).
- **Click 🎬** → open the video in your default player.
- **Click 📄** → open the captions `.srt`.
- **Drag 📄** → drops the captions as a `.srt` file / text into another app
  (e.g. Premiere or Claude). The video isn't draggable on purpose — browser
  drag-out only produces a temporary copy, which is bad for editing; use **click
  title → drag from Explorer** instead.

### Checkbox behavior

- Checking **Transcript** automatically checks **New Folder** (so the transcript
  lands beside the video in a folder). The reverse is not true — checking New
  Folder never changes Transcript.

### Transcript details

Transcripts use **yt-dlp's built-in subtitles** (`--write-subs --write-auto-subs
--sub-langs en`): manual captions when available, auto-generated otherwise. The
host **cleans** the result into a single `<title>.srt`: inline tags stripped,
whitespace collapsed, and consecutive duplicate-text cues removed (auto-captions
repeat heavily), with the timestamp ranges kept and cues renumbered. This stays a
valid SRT, so you can import it into Premiere as searchable captions *and* it
reads cleanly for an LLM like Claude. If a video has no captions, the popup says
"Transcript: none available" and the video still downloads.

> **Premiere tip:** Window ▸ Text ▸ Captions ▸ *Import captions from file* → pick
> the `.srt`. The Captions tab is searchable and clicking a line jumps the
> playhead — a transcript indexed to the video.

> **Browse** requires Python's `tkinter` (included with standard CPython on
> Windows). If it's missing, the popup says so — just type the path instead.

### Metadata (New Folder only)

When **New Folder** is on, the host also writes a `<title>.metadata.md` into the
folder so the video is self-describing for AI ingestion/editing. It's one combined
file: a human/LLM-readable summary on top, then a fenced ```json block with the
same fields for programmatic use.

Fields come from a single `yt-dlp --dump-single-json` call (which also supplies the
filename title, so there's no extra step). Always included: **source URL, browser
tab title, download time**. For YouTube and other supported sites it adds what the
extractor provides — **title, channel, upload date, duration, view/like/comment
counts, categories, tags, description, resolution/fps**, etc. Missing fields are
omitted, so files for non-YouTube sites stay tidy. If metadata can't be fetched,
the download still succeeds and the file keeps the universal fields.

### Premiere project (New Folder only — experimental)

Optionally, the host can drop a ready-to-open **`<title>.prproj`** into the folder
with the video on a timeline and the transcript `.srt` imported into the project
bin. Premiere has no headless/CLI project creation and almost no caption API, so
this works by **rewriting a template project you create once** — and the captions
land in the **bin** (one manual click to add as a caption track), not auto-attached.

**One-time setup:**
1. Make a folder, e.g. `C:\ytdlp-premiere-template\`, with two placeholder files
   named exactly `__YTDLP_VIDEO__.mp4` (any short clip) and `__YTDLP_SUBS__.srt`
   (any `.srt`).
2. In **your** Premiere version: new project → import both → drag the video onto a
   new **sequence** → leave the `.srt` in the bin → **Save As** `template.prproj`
   in that folder.
3. In the extension's **Settings**, set **Premiere template** to that
   `template.prproj` path. (Blank = feature off; the popup checkbox is disabled.)

**Per download:** check **Premiere** in the popup (it auto-enables New Folder). The
host copies the template, decompresses its gzipped XML, swaps the placeholder media
for your real files, recompresses, and writes `<title>.prproj`. Double-click it to
open. Premiere auto-relinks the media by filename from the project folder.

> ⚠️ **Experimental / brittle.** The `.prproj` format is undocumented and
> version-specific — always create the template in the same Premiere version you
> open with. If media shows offline on open, relink once from the folder. If the
> template is missing or generation fails, the download still completes (the popup
> notes it) — nothing else is affected.

## How cookies work

On click, the extension reads cookies applicable to the **current tab's URL**
(`chrome.cookies.getAll({ url })`), writes them to a temporary Netscape-format
`cookies.txt`, and passes that path to yt-dlp as `{cookies}`. The temp file is
deleted after the run.

> The extension deliberately exports cookies itself rather than using
> `yt-dlp --cookies-from-browser chrome`, which Chrome's App-Bound Encryption
> increasingly breaks on Windows.
>
> Scope is the **current site only**. Some YouTube logins also rely on
> `.google.com` cookies; if a private/members video fails auth, widen the scope
> in `popup.js` (`getActiveTab` / `getAll`) to also fetch `https://www.google.com`.

## Command template notes

The template is tokenized shell-style (quotes respected, backslashes preserved)
and run **without a shell**, so there's no shell-injection surface. Quote any
path that contains spaces. Examples:

- Audio only (mp3): `"{ytdlp}" --cookies "{cookies}" -P "{output}" -x --audio-format mp3 "{url}"`
- 1080p cap: `"{ytdlp}" --cookies "{cookies}" -P "{output}" -f "bv*[height<=1080]+ba/b" "{url}"`

> Note: the host names every download `<YY-MM-DD> <title>` (title capped at 60
> chars) so files sort chronologically — e.g.
> `26-07-08 Governor Wes Moore on July 4th....mp4`. When **New Folder** is on, the
> per-video folder uses the same name. To do this the host always appends its own
> `-o "<name>.%(ext)s"`, so **don't put your own `-o` in the template** — it will
> conflict. (The date is the local download date; the title is auto-shortened and
> further trimmed if needed to stay under Windows' 260-char path limit.)

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```
Then remove the extension from `chrome://extensions`.

## Troubleshooting

- **"No response from the native host"** — host not registered (re-run
  `install.ps1`), or the extension ID doesn't match `allowed_origins` in
  `com.ytdlp.downloader.template.json` (re-run `install.ps1 -ExtensionId <id>`).
- **"Executable not found"** — fix the yt-dlp path in Options.
- **Native host logging** — run `host/yt_dlp_host.py` is invoked by Chrome via
  `launch_host.bat`; to debug, check Chrome's `chrome://extensions` → service
  worker console for `lastError`, and confirm `py -3 host\yt_dlp_host.py` runs.

## Files

```
extension/   manifest.json, popup.*, background.js, options.*, icons/
host/        yt_dlp_host.py, launch_host.bat, com.ytdlp.downloader.template.json, install.ps1
```
