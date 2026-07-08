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
import struct
import shlex
import tempfile
import subprocess
from datetime import datetime

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
        title = fetch_stem(ytdlp, cookie_path, url) or "video"
        # Cap the title for cleanliness, but never let date+title overflow
        # Windows MAX_PATH (max_stem_len budgets the deepest resulting path).
        cap = min(60, max_stem_len(output, new_folder) - len(date_prefix) - 1)
        title = title[:max(1, cap)].strip(". ") or "video"
        stem = date_prefix + " " + title

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

        transcript_path = None
        if transcript:
            sub_out = os.path.join(base, (stem or "video") + ".%(ext)s")
            run_proc([ytdlp, "--cookies", cookie_path, "--skip-download",
                      "--write-subs", "--write-auto-subs", "--sub-langs", lang,
                      "--convert-subs", "srt", "-o", sub_out, url])
            transcript_path, tnote = write_transcript(base, stem or "video")
            notes.append(tnote)

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
