#!/usr/bin/env python3
"""Native messaging host for the yt-dlp Downloader Chrome extension.

Protocol (Chrome native messaging): each message is a 4-byte little-endian
length prefix followed by that many bytes of UTF-8 JSON, on stdin/stdout.

The host runs as a read loop, so it works both for one-shot `sendNativeMessage`
calls (one message, then EOF) and long-lived `connectNative` ports (the download
streams several `progress` messages, then one `result`).

Message types:
  "download"   {url, cookiesText, template, ytdlpPath, outputDir, transcript,
                newFolder, transcriptLang}
               -> streams {kind:"progress", percent, phase} while running, then
                  {kind:"result", ok, returncode, videoPath, transcriptPath,
                   folder, title, note, stdout, stderr}.
  "pickFolder" {current}    -> {ok, path}
  "open"       {path}       -> opens the file with its default app -> {ok}
  "reveal"     {path}       -> shows the file selected in Explorer -> {ok}
  "readText"   {path}       -> {ok, text} (capped) for the transcript drag
"""

import sys
import os
import re
import json
import glob
import gzip
import struct
import shlex
import tempfile
import subprocess
from datetime import datetime

# Sentinel filename the user gives the placeholder video in their Premiere
# template project; write_prproj swaps it for the real file. Keep in sync
# with the README template instructions.
PRPROJ_VIDEO_SENTINEL = "__YTDLP_VIDEO__.mp4"

# Keep responses comfortably under Chrome's 1 MB host->extension message cap.
MAX_OUTPUT = 12000
MAX_TEXT = 200000  # cap for readText (transcript drag payload)

CREATIONFLAGS = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW on Windows

PROGRESS_RE = re.compile(r"DLPCT\s+([\d.]+)%")
PHASE_MARKERS = ("[Merger]", "[VideoConvertor]", "[ExtractAudio]", "[Fixup")


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None  # stdin closed
    msg_len = struct.unpack("<I", raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def run_proc(argv):
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATIONFLAGS,
    )


def build_argv(template, values):
    """Tokenize the template (keeping Windows backslashes intact) and replace
    placeholder tokens with concrete values as single argv elements."""
    argv = []
    for tok in shlex.split(template, posix=False):
        if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "\"'":
            tok = tok[1:-1]
        for key, val in values.items():
            tok = tok.replace("{" + key + "}", val)
        argv.append(tok)
    return argv


def sanitize_stem(title):
    """Make a Windows-safe file/folder name from a video title."""
    s = re.sub(r'[\\/:*?"<>|]', "", title or "")
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(". ")  # Windows components cannot end with a dot or space
    return s[:120] or "video"


def fetch_stem(ytdlp, cookie_path, url):
    """Ask yt-dlp for the video title and return a sanitized filename stem."""
    proc = run_proc([ytdlp, "--cookies", cookie_path, "--skip-download",
                     "--no-warnings", "--print", "%(title)s", url])
    if proc.returncode == 0 and proc.stdout:
        first = proc.stdout.strip().splitlines()
        if first:
            return sanitize_stem(first[0])
    return None


def fmt_ts(seconds):
    """Seconds -> 'H:MM:SS' (or 'M:SS' under an hour)."""
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return ("%d:%02d:%02d" % (h, m, sec)) if h else ("%d:%02d" % (m, sec))


def clip_label(start, end):
    """Filesystem-safe clip range label, e.g. '[1m03s-2m30s]' / '[1h02m03s-...]'."""
    def part(sec):
        s = int(round(sec))
        h, rem = divmod(s, 3600)
        m, ss = divmod(rem, 60)
        if h:
            return "%dh%02dm%02ds" % (h, m, ss)
        if m:
            return "%dm%02ds" % (m, ss)
        return "%ds" % ss
    return "[%s-%s]" % (part(start), part(end))


def fetch_info(ytdlp, cookie_path, url):
    """Fetch the full metadata for a URL as a dict (or None on failure).
    Works for any yt-dlp-supported site; fields vary by extractor."""
    proc = run_proc([ytdlp, "--cookies", cookie_path, "--skip-download",
                     "--no-warnings", "--dump-single-json", url])
    if proc.returncode == 0 and proc.stdout:
        try:
            return json.loads(proc.stdout)
        except (ValueError, TypeError):
            return None
    return None


def curate_metadata(info, source_url, tab_title):
    """Pick the useful fields from a yt-dlp info dict into a clean, ordered dict.
    Universal fields are always present; extractor fields are included only when
    available (so non-YouTube files stay tidy)."""
    info = info or {}
    meta = {
        "source_url": source_url,
        "tab_title": tab_title,
        "downloaded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    upload_date = info.get("upload_date")  # yt-dlp format: YYYYMMDD
    if isinstance(upload_date, str) and len(upload_date) == 8 and upload_date.isdigit():
        upload_date = "%s-%s-%s" % (upload_date[0:4], upload_date[4:6], upload_date[6:8])

    duration = info.get("duration")
    duration = fmt_ts(duration) if isinstance(duration, (int, float)) else None

    # (key in output, value) — appended only when the value is meaningful.
    candidates = [
        ("title", info.get("title")),
        ("webpage_url", info.get("webpage_url")),
        ("id", info.get("id")),
        ("site", info.get("extractor_key")),
        ("channel", info.get("channel") or info.get("uploader")),
        ("channel_url", info.get("channel_url") or info.get("uploader_url")),
        ("channel_id", info.get("channel_id") or info.get("uploader_id")),
        ("upload_date", upload_date),
        ("duration", duration),
        ("view_count", info.get("view_count")),
        ("like_count", info.get("like_count")),
        ("comment_count", info.get("comment_count")),
        ("categories", info.get("categories")),
        ("tags", info.get("tags")),
        ("resolution", info.get("resolution")),
        ("fps", info.get("fps")),
        ("description", info.get("description")),
    ]
    for key, value in candidates:
        if value is None:
            continue
        if isinstance(value, (list, str)) and len(value) == 0:
            continue
        meta[key] = value
    return meta


def build_metadata_md(info, source_url, tab_title):
    """A combined Markdown doc: readable summary on top, fenced JSON block below."""
    meta = curate_metadata(info, source_url, tab_title)

    def num(n):
        return "{:,}".format(n) if isinstance(n, (int, float)) else str(n)

    lines = ["# " + str(meta.get("title") or tab_title or "Untitled"), ""]
    lines.append("- **Source:** " + str(meta.get("source_url", "")))
    if meta.get("channel"):
        ch = meta["channel"]
        if meta.get("channel_url"):
            ch += " (" + meta["channel_url"] + ")"
        lines.append("- **Channel:** " + ch)
    up = []
    if meta.get("upload_date"):
        up.append("**Uploaded:** " + meta["upload_date"])
    if meta.get("duration"):
        up.append("**Duration:** " + meta["duration"])
    if up:
        lines.append("- " + " · ".join(up))
    stats = []
    for label, key in (("Views", "view_count"), ("Likes", "like_count"), ("Comments", "comment_count")):
        if meta.get(key) is not None:
            stats.append("**%s:** %s" % (label, num(meta[key])))
    if stats:
        lines.append("- " + " · ".join(stats))
    if meta.get("tags"):
        lines.append("- **Tags:** " + ", ".join(str(t) for t in meta["tags"][:30]))
    lines.append("- **Downloaded:** " + meta["downloaded_at"])

    if meta.get("description"):
        lines += ["", "## Description", "", str(meta["description"])]

    lines += ["", "```json", json.dumps(meta, indent=2, ensure_ascii=False), "```", ""]
    return "\n".join(lines)


def write_metadata(base, stem, info, source_url, tab_title):
    """Write <stem>.metadata.md into base. Returns a short status note."""
    try:
        path = os.path.join(base, stem + ".metadata.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(build_metadata_md(info, source_url, tab_title))
        return "Metadata: " + os.path.basename(path)
    except OSError as e:
        return "Metadata: error (" + str(e) + ")"


def write_prproj(base, stem, template_path, video_path):
    """Generate <stem>.prproj into base from the user's template project by
    swapping the sentinel placeholder VIDEO for the real downloaded file.

    Only the video is wired up — captions can't be updated by a file swap
    (Premiere embeds caption text at import), so the transcript is left as a
    sidecar .srt to drag in manually.

    The .prproj is gzipped XML; we decompress, string-replace the sentinel
    filename (and the template's placeholder directory, to reduce relink
    prompts), then recompress. Premiere also auto-relinks by filename from the
    project's own folder, so a filename match is enough even if a path form we
    don't rewrite lingers. Returns a short status note; never raises."""
    try:
        if not template_path or not os.path.exists(template_path):
            return "Premiere: template not found"
        if not video_path:
            return "Premiere: no video to reference"

        with open(template_path, "rb") as f:
            raw = f.read()
        try:
            xml = gzip.decompress(raw).decode("utf-8", "replace")
            gzipped = True
        except (OSError, EOFError):
            xml = raw.decode("utf-8", "replace")  # allow an uncompressed template
            gzipped = False

        xml = xml.replace(PRPROJ_VIDEO_SENTINEL, os.path.basename(video_path))

        # Point the placeholder directory at this video's folder (the user keeps
        # the placeholder media alongside template.prproj).
        tdir = os.path.dirname(os.path.abspath(template_path))
        if tdir:
            xml = xml.replace(tdir, base)

        out_path = os.path.join(base, stem + ".prproj")
        data = xml.encode("utf-8")
        if gzipped:
            data = gzip.compress(data)
        with open(out_path, "wb") as f:
            f.write(data)
        return "Premiere: " + os.path.basename(out_path)
    except Exception as e:
        return "Premiere: error (" + type(e).__name__ + ": " + str(e) + ")"


def max_stem_len(output, new_folder):
    """Longest filename stem that keeps the deepest output path under Windows'
    260-char MAX_PATH limit. With New Folder on, the stem appears twice (once as
    the folder name, once as the file name) so it must be budgeted for both.
    Reserves room for yt-dlp's temp suffixes like '.f251-15.webm.part'."""
    ceiling = 255           # leave a small margin under the 260 hard limit
    suffix = 20             # e.g. "\" + ".f251-15.webm.part"
    if new_folder:
        return max(10, (ceiling - len(output) - 2 - suffix) // 2)
    return max(10, ceiling - len(output) - 1 - suffix)


def clean_srt(content):
    """Clean an SRT: strip inline tags, collapse whitespace, drop consecutive
    cues whose text is identical (auto-captions repeat heavily), and renumber.
    Keeps each cue's original timestamp range so it stays a valid, importable
    SRT (e.g. for Premiere captions) while reading cleanly for an LLM."""
    cues = []
    last_text = None
    for block in re.split(r"\n\s*\n", content.strip()):
        ts_line = None
        texts = []
        for ln in block.splitlines():
            s = ln.strip()
            if not s or s.isdigit():
                continue
            if "-->" in s:
                ts_line = s
                continue
            s = re.sub(r"<[^>]+>", "", s)
            s = re.sub(r"\s+", " ", s).strip()
            if s:
                texts.append(s)
        text = " ".join(texts).strip()
        if not ts_line or not text or text == last_text:
            continue
        last_text = text
        cues.append((ts_line, text))
    if not cues:
        return ""
    return "\n".join("%d\n%s\n%s\n" % (i, ts, text) for i, (ts, text) in enumerate(cues, 1)) + "\n"


def write_transcript(base, stem):
    """Clean the produced subtitle file(s) into a single cleaned SRT named
    <stem>.srt. Returns (transcript_path_or_None, note)."""
    produced = sorted(glob.glob(os.path.join(base, stem + "*.srt")))
    if not produced:
        return None, "Transcript: none available"
    written = []
    for i, srt in enumerate(produced):
        try:
            with open(srt, "r", encoding="utf-8", errors="replace") as f:
                cleaned = clean_srt(f.read())
            if len(produced) == 1:
                out_path = os.path.join(base, stem + ".srt")
            else:
                tag = os.path.basename(srt)[len(stem):][:-4].strip(".") or str(i)
                out_path = os.path.join(base, stem + "." + tag + ".srt")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(cleaned)
            if os.path.normpath(srt) != os.path.normpath(out_path):
                os.remove(srt)
            written.append(out_path)
        except OSError as e:
            return None, "Transcript: error (" + str(e) + ")"
    return written[0], "Transcript: " + ", ".join(os.path.basename(p) for p in written)


def handle_download(msg):
    template = msg.get("template") or '"{ytdlp}" -N 16 --recode-video mp4 --cookies "{cookies}" -P "{output}" -f "bv*+ba/b" "{url}"'
    ytdlp = os.path.expandvars(msg.get("ytdlpPath") or "yt-dlp.exe")
    output = os.path.expandvars(msg.get("outputDir") or os.path.expanduser("~"))
    url = msg.get("url") or ""
    cookies_text = msg.get("cookiesText") or ""
    transcript = bool(msg.get("transcript"))
    new_folder = bool(msg.get("newFolder"))
    lang = msg.get("transcriptLang") or "en"
    section_start = msg.get("sectionStart")
    section_end = msg.get("sectionEnd")
    has_section = (isinstance(section_start, (int, float)) and
                   isinstance(section_end, (int, float)) and
                   section_end > section_start)

    if not url:
        send_message({"kind": "result", "ok": False, "error": "No URL provided."})
        return

    cookie_path = None
    path_file = None
    try:
        fd, cookie_path = tempfile.mkstemp(prefix="ytdlp_cookies_", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(cookies_text)

        output = os.path.normpath(output)

        # Name every download "<YY-MM-DD> <short title>" so files (and the
        # per-video folder) are tidy and sort chronologically in Explorer.
        date_prefix = datetime.now().strftime("%y-%m-%d")
        tab_title = msg.get("label") or ""

        # When New Folder is on we also write a metadata file, so fetch the full
        # info once and reuse its title for the stem; otherwise just the title.
        # Always sanitize — a raw yt-dlp title can contain characters illegal in
        # a Windows path (e.g. ":" "?" "*"), which would break os.makedirs.
        info = fetch_info(ytdlp, cookie_path, url) if new_folder else None
        raw_title = None
        if info and info.get("title"):
            raw_title = sanitize_stem(info["title"])
        if not raw_title:
            raw_title = fetch_stem(ytdlp, cookie_path, url) or "video"

        # Clips get a range suffix like " [1m03s-2m30s]" on the stem.
        label = (" " + clip_label(section_start, section_end)) if has_section else ""

        # Cap the title for cleanliness, but never let date+title(+label) overflow
        # Windows MAX_PATH (max_stem_len budgets the deepest resulting path).
        cap = min(60, max_stem_len(output, new_folder) - len(date_prefix) - len(label) - 1)
        title = raw_title[:max(1, cap)].strip(". ") or "video"
        stem = date_prefix + " " + title + label

        base = os.path.join(output, stem) if new_folder else output
        os.makedirs(base, exist_ok=True)

        fd2, path_file = tempfile.mkstemp(prefix="ytdlp_path_", suffix=".txt")
        os.close(fd2)

        argv = build_argv(template, {
            "ytdlp": ytdlp, "cookies": cookie_path, "output": base, "url": url,
        })
        argv += ["-o", stem + ".%(ext)s"]
        argv += ["--newline", "--color", "never",
                 "--progress-template", "DLPCT %(progress._percent_str)s",
                 "--print-to-file", "after_move:filepath", path_file]
        if has_section:
            # Fast keyframe-snap cut of just the selected range.
            argv += ["--download-sections", "*%g-%g" % (section_start, section_end)]

        # Stream progress while yt-dlp runs.
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=CREATIONFLAGS,
        )
        log_tail = []
        last_sent = (-1, None)
        for line in proc.stdout:
            log_tail.append(line)
            if len(log_tail) > 400:
                del log_tail[:200]
            m = PROGRESS_RE.search(line)
            if m:
                pct = int(float(m.group(1)))
                if (pct, "download") != last_sent:
                    last_sent = (pct, "download")
                    send_message({"kind": "progress", "percent": pct, "phase": "download"})
            elif any(mk in line for mk in PHASE_MARKERS):
                if last_sent[1] != "processing":
                    last_sent = (100, "processing")
                    send_message({"kind": "progress", "percent": 100, "phase": "processing"})
        returncode = proc.wait()

        # Resolve the final media path.
        video_path = None
        try:
            with open(path_file, "r", encoding="utf-8", errors="replace") as f:
                lines = [ln.strip() for ln in f if ln.strip()]
            if lines:
                video_path = lines[-1]
        except OSError:
            pass

        folder = os.path.dirname(video_path) if video_path else base
        title = os.path.splitext(os.path.basename(video_path))[0] if video_path else (stem or "video")

        notes = []
        if new_folder:
            notes.append("Folder: " + base)
            notes.append(write_metadata(base, stem, info, url, tab_title))

        transcript_path = None
        if transcript:
            sub_out = os.path.join(base, (stem or "video") + ".%(ext)s")
            run_proc([ytdlp, "--cookies", cookie_path, "--skip-download",
                      "--write-subs", "--write-auto-subs", "--sub-langs", lang,
                      "--convert-subs", "srt", "-o", sub_out, url])
            transcript_path, tnote = write_transcript(base, stem or "video")
            notes.append(tnote)

        if new_folder and msg.get("premiereProject") and msg.get("premiereTemplate") and video_path:
            notes.append(write_prproj(
                base, stem, os.path.expandvars(msg.get("premiereTemplate")),
                video_path))

        send_message({
            "kind": "result",
            "ok": True,
            "returncode": returncode,
            "videoPath": video_path,
            "transcriptPath": transcript_path,
            "folder": folder,
            "title": title,
            "note": " | ".join(notes),
            "stdout": ("".join(log_tail))[-MAX_OUTPUT:],
            "stderr": "",
        })
    except FileNotFoundError as e:
        send_message({"kind": "result", "ok": False, "error": "Executable not found: " + str(e)})
    except Exception as e:
        send_message({"kind": "result", "ok": False, "error": type(e).__name__ + ": " + str(e)})
    finally:
        for p in (cookie_path, path_file):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass


def handle_pick_folder(msg):
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        initial = os.path.expandvars(msg.get("current") or "") or os.path.expanduser("~")
        path = filedialog.askdirectory(initialdir=initial, parent=root)
        root.destroy()
        return {"ok": True, "path": path or ""}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__ + ": " + str(e)}


def handle_open(msg):
    path = msg.get("path") or ""
    try:
        if not path or not os.path.exists(path):
            return {"ok": False, "error": "File not found: " + path}
        if os.name == "nt":
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__ + ": " + str(e)}


def handle_reveal(msg):
    path = msg.get("path") or ""
    try:
        if not path or not os.path.exists(path):
            return {"ok": False, "error": "File not found: " + path}
        if os.name == "nt":
            # /select, must be a single argument followed by the path.
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(path)])
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__ + ": " + str(e)}


def handle_read_text(msg):
    path = msg.get("path") or ""
    try:
        if not path or not os.path.exists(path):
            return {"ok": False, "error": "File not found: " + path}
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return {"ok": True, "text": f.read(MAX_TEXT)}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__ + ": " + str(e)}


def handle_update(msg):
    """Run `yt-dlp --update` to upgrade the binary in place."""
    ytdlp = os.path.expandvars(msg.get("ytdlpPath") or "yt-dlp.exe")
    try:
        proc = run_proc([ytdlp, "--update"])
        return {
            "ok": True,
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "")[-MAX_OUTPUT:],
            "stderr": (proc.stderr or "")[-MAX_OUTPUT:],
        }
    except FileNotFoundError as e:
        return {"ok": False, "error": "Executable not found: " + str(e)}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__ + ": " + str(e)}


def dispatch(msg):
    t = msg.get("type")
    if t == "pickFolder":
        send_message(handle_pick_folder(msg))
    elif t == "open":
        send_message(handle_open(msg))
    elif t == "reveal":
        send_message(handle_reveal(msg))
    elif t == "readText":
        send_message(handle_read_text(msg))
    elif t == "updateYtdlp":
        send_message(handle_update(msg))
    else:
        handle_download(msg)  # streams its own messages


def main():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    while True:
        msg = read_message()
        if msg is None:
            return
        try:
            dispatch(msg)
        except Exception as e:
            send_message({"ok": False, "error": "host crashed: " + str(e)})


if __name__ == "__main__":
    main()
