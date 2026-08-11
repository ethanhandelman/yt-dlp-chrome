// popup.js — reads cookies for the active tab, builds a Netscape cookie file,
// and starts a download over a streaming port to the service worker. Also shows
// a progress bar and a recent-downloads list with open/reveal/drag actions.
// Per-download options (path, transcript, new folder) persist in storage.local.

const OPTION_DEFAULTS = {
  ytdlpPath: "yt-dlp.exe",
  outputDir: "%USERPROFILE%\\Downloads",
  template: '"{ytdlp}" -N 16 --recode-video mp4 --cookies "{cookies}" -P "{output}" -f "bv*[height>1080][ext=webm]+ba/bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" "{url}"',
  premiereTemplate: "",
  claudePrompt: "A video was just downloaded into this folder by the yt-dlp downloader. Read the .metadata.md and .srt files here, then follow the CLAUDE.md in the parent folder: decide whether this is a Mode A (clip discovery) or Mode B (hook + on-screen caption) job using its mode-selection rules, or ask me first if it is genuinely unclear. Then begin.",
};

const STATE_DEFAULTS = {
  downloadPath: "",
  transcript: false,
  newFolder: false,
  premiere: false,
};

const $url = document.getElementById("url");
const $path = document.getElementById("path");
const $browse = document.getElementById("browse");
const $transcript = document.getElementById("transcript");
const $newFolder = document.getElementById("newFolder");
const $premiere = document.getElementById("premiere");
const $premiereLabel = document.getElementById("premiereLabel");
const $btn = document.getElementById("download");
const $btnClaude = document.getElementById("downloadClaude");
const $viewTranscript = document.getElementById("viewTranscript");
const $transcriptClaude = document.getElementById("transcriptClaude");
const $transcriptView = document.getElementById("transcriptView");
const $tvSearch = document.getElementById("tvSearch");
const $tvClose = document.getElementById("tvClose");
const $transcriptList = document.getElementById("transcriptList");
const $tvStatus = document.getElementById("tvStatus");
const $tvSel = document.getElementById("tvSel");
const $tvUse = document.getElementById("tvUse");
const $status = document.getElementById("status");
const $inProgress = document.getElementById("inProgress");
const $inProgressList = document.getElementById("inProgressList");
const $recentList = document.getElementById("recentList");
const $clearRecent = document.getElementById("clearRecent");
$clearRecent.addEventListener("click", clearRecent);

// Trim controls
const $startToCurrent = document.getElementById("startToCurrent");
const $currentToEnd = document.getElementById("currentToEnd");
const $trimToggle = document.getElementById("trimToggle");
const $trimPanel = document.getElementById("trimPanel");
const $startTime = document.getElementById("startTime");
const $endTime = document.getElementById("endTime");
const $rngStart = document.getElementById("rngStart");
const $rngEnd = document.getElementById("rngEnd");
const $dualFill = document.getElementById("dualFill");
const $startCur = document.getElementById("startCur");
const $endCur = document.getElementById("endCur");
const $clipLen = document.getElementById("clipLen");
const $trimReset = document.getElementById("trimReset");

function setStatus(text, cls) {
  $status.textContent = text;
  $status.className = cls || "";
}

function renderDoneOk(result) {
  $status.className = "ok";
  $status.textContent = "✓ Download finished. ";
  const a = document.createElement("a");
  a.textContent = "View in folder";
  a.className = "folder-link";
  a.addEventListener("click", () => {
    if (result.videoPath) chrome.runtime.sendMessage({ type: "reveal", path: result.videoPath });
    else if (result.folder) chrome.runtime.sendMessage({ type: "open", path: result.folder });
  });
  $status.appendChild(a);
}

// ---- In Progress (queue) ----
function renderQueue(list) {
  const jobs = list || [];
  $inProgress.hidden = jobs.length === 0;
  $inProgressList.textContent = "";
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "job-item";

    const body = document.createElement("div");
    body.className = "jbody";

    const label = document.createElement("div");
    label.className = "jlabel";
    label.textContent = job.label || "";
    label.title = job.label || "";
    body.appendChild(label);

    if (job.status === "downloading") {
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      if (job.phase === "processing") fill.className = "processing";
      fill.style.width = Math.max(0, Math.min(100, job.percent || 0)) + "%";
      bar.appendChild(fill);
      body.appendChild(bar);

      const st = document.createElement("div");
      st.className = "jstatus";
      st.textContent = job.phase === "processing" ? "Processing…" : "Downloading " + (job.percent || 0) + "%";
      body.appendChild(st);
    } else {
      const st = document.createElement("div");
      st.className = "jstatus queued";
      st.textContent = "Queued";
      body.appendChild(st);
    }
    row.appendChild(body);

    const remove = document.createElement("span");
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = job.status === "downloading" ? "Stop this download" : "Remove from queue";
    remove.addEventListener("click", () => port.postMessage({ cmd: "cancel", id: job.id }));
    row.appendChild(remove);

    $inProgressList.appendChild(row);
  }
}

// Convert a chrome.cookies.Cookie[] into Netscape cookies.txt text that yt-dlp reads.
function toNetscape(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# Generated by yt-dlp Downloader", ""];
  for (const c of cookies) {
    const includeSub = c.hostOnly ? "FALSE" : "TRUE";
    let domain = c.domain;
    if (!c.hostOnly && !domain.startsWith(".")) domain = "." + domain;
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = Math.round(c.expirationDate || 0);
    let line = [domain, includeSub, c.path, secure, expires, c.name, c.value].join("\t");
    if (c.httpOnly) line = "#HttpOnly_" + line;
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function getOptions() {
  const stored = await chrome.storage.sync.get(OPTION_DEFAULTS);
  return { ...OPTION_DEFAULTS, ...stored };
}
function currentState() {
  return {
    downloadPath: $path.value.trim(),
    transcript: $transcript.checked,
    newFolder: $newFolder.checked,
    premiere: $premiere.checked,
  };
}
async function saveState() {
  await chrome.storage.local.set(currentState());
}

// ---- Recent list ----
const textCache = new Map(); // transcriptPath -> text (for drag)

function basename(p) {
  return (p || "").split(/[\\/]/).pop();
}
function stemOf(p) {
  return basename(p).replace(/\.[^.]+$/, "");
}

async function removeRecent(key) {
  const { recent = [] } = await chrome.storage.local.get({ recent: [] });
  const next = recent.filter((r) => (r.videoPath || r.folder) !== key);
  await chrome.storage.local.set({ recent: next });
  renderRecent(next);
}

async function clearRecent() {
  await chrome.storage.local.set({ recent: [] });
  renderRecent([]);
}

function renderRecent(recent) {
  $recentList.textContent = "";
  $clearRecent.hidden = !(recent && recent.length);
  if (!recent || !recent.length) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "No downloads yet.";
    $recentList.appendChild(empty);
    return;
  }
  for (const item of recent) {
    const row = document.createElement("div");
    row.className = "recent-item";
    const key = item.videoPath || item.folder;

    const vIcon = document.createElement("span");
    vIcon.className = "icon";
    if (item.videoPath) {
      vIcon.textContent = "🎬";
      vIcon.title = "Open video";
      vIcon.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open", path: item.videoPath }));
    } else {
      vIcon.textContent = "📁";
      vIcon.title = "Open folder";
      vIcon.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open", path: item.folder }));
    }
    row.appendChild(vIcon);

    if (item.transcriptPath) {
      const tIcon = document.createElement("span");
      tIcon.className = "icon";
      tIcon.textContent = "📄";
      tIcon.title = "Open captions (.srt) — drag into Premiere or Claude";
      tIcon.draggable = true;
      tIcon.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open", path: item.transcriptPath }));
      tIcon.addEventListener("dragstart", (e) => {
        const text = textCache.get(item.transcriptPath) || "";
        const name = stemOf(item.transcriptPath) + ".srt";
        e.dataTransfer.setData("text/plain", text);
        const dataUri = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
        e.dataTransfer.setData("DownloadURL", "application/x-subrip:" + name + ":" + dataUri);
      });
      row.appendChild(tIcon);
      // Prefetch the transcript text so dragstart can build the payload synchronously.
      if (!textCache.has(item.transcriptPath)) {
        chrome.runtime.sendMessage({ type: "readText", path: item.transcriptPath }, (resp) => {
          if (resp && resp.ok) textCache.set(item.transcriptPath, resp.text || "");
        });
      }
    }

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.title || basename(item.videoPath || item.folder);
    name.title = (item.title || "") + "\n" + (item.videoPath || item.folder || "") + "\n(click to show in folder)";
    name.addEventListener("click", () => {
      if (item.videoPath) chrome.runtime.sendMessage({ type: "reveal", path: item.videoPath });
      else if (item.folder) chrome.runtime.sendMessage({ type: "open", path: item.folder });
    });
    row.appendChild(name);

    const remove = document.createElement("span");
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "Remove from list";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRecent(key);
    });
    row.appendChild(remove);

    $recentList.appendChild(row);
  }
}

// ---- Trim / section selector ----
// duration: null until known; start/end in seconds (end null = end of video).
const trim = { duration: null, start: 0, end: null };
const MIN_GAP = 1;            // clip must be at least 1s (handles can't meet)
let trimKey = null;           // "<loadId>|<url>" — identifies this loaded video

// Persist the current selection for this loaded page (survives popup re-open;
// resets on refresh / different video via the key check). Session-scoped.
function persistTrim() {
  if (!trimKey || !currentTab) return;
  chrome.storage.session.set({
    ["trim:" + currentTab.id]: { key: trimKey, start: trim.start, end: trim.end, expanded: !$trimPanel.hidden },
  });
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Accept "SS", "M:SS", "H:MM:SS", or a decimal number of seconds.
function parseTime(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => p !== "" && isNaN(Number(p)))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (p === "" ? 0 : Number(p));
  return isFinite(sec) ? sec : null;
}

function sectionActive() {
  const end = trim.end == null ? trim.duration : trim.end;
  if (end == null) return false;                       // no upper bound known
  if (!(end > trim.start)) return false;               // empty/invalid
  const full = trim.start <= 0 && trim.duration != null && end >= trim.duration - 0.05;
  return !full;
}

function applyTrim() {
  const dur = trim.duration;
  const knownDur = dur != null && isFinite(dur) && dur > 0;
  const endVal = trim.end == null ? (knownDur ? dur : 0) : trim.end;

  // Sliders (only meaningful with a known duration).
  [$rngStart, $rngEnd].forEach((r) => (r.disabled = !knownDur));
  if (knownDur) {
    $rngStart.max = $rngEnd.max = dur;
    $rngStart.value = trim.start;
    $rngEnd.value = endVal;
    const a = (trim.start / dur) * 100, b = (endVal / dur) * 100;
    $dualFill.style.left = a + "%";
    $dualFill.style.width = Math.max(0, b - a) + "%";
  } else {
    $dualFill.style.width = "0%";
  }

  // Text boxes (don't clobber a box the user is actively typing in).
  if (document.activeElement !== $startTime) $startTime.value = fmtTime(trim.start);
  if (document.activeElement !== $endTime) $endTime.value = trim.end == null ? (knownDur ? fmtTime(dur) : "") : fmtTime(trim.end);

  // Current-time buttons need a detected video.
  $startCur.disabled = $endCur.disabled = !videoDetected;
  $currentToEnd.disabled = !knownDur || !videoDetected;  // needs both current + max
  $startToCurrent.disabled = !videoDetected;

  // Clip length readout.
  $clipLen.textContent = sectionActive() ? "Clip: " + fmtTime(endVal - trim.start) : "Full video";

  // Reset only when a real section is selected (lives in the header).
  $trimReset.hidden = !sectionActive();
}

function setStart(sec) {
  if (sec == null) return;
  sec = Math.max(0, sec);
  if (trim.duration != null) sec = Math.min(sec, trim.duration);
  // Keep at least MIN_GAP before the end (or end of video if end is unset).
  const effEnd = trim.end == null ? trim.duration : trim.end;
  const upper = effEnd == null ? Infinity : effEnd - MIN_GAP;
  trim.start = Math.max(0, Math.min(sec, upper));
  persistTrim();
  applyTrim();
}
function setEnd(sec) {
  if (sec == null) { trim.end = null; persistTrim(); applyTrim(); return; }
  sec = Math.max(0, sec);
  if (trim.duration != null) sec = Math.min(sec, trim.duration);
  // Keep at least MIN_GAP after the start.
  trim.end = Math.max(sec, trim.start + MIN_GAP);
  if (trim.duration != null) trim.end = Math.min(trim.end, trim.duration);
  persistTrim();
  applyTrim();
}

let videoDetected = false;

// Injected into the page to read the best <video>'s time/duration.
function probeVideoInPage() {
  // Per-document token: stable across SPA navigation, regenerated on reload.
  if (!window.__ytdlpLoadId) window.__ytdlpLoadId = String(Date.now()) + "-" + Math.random();
  const vids = Array.from(document.querySelectorAll("video"))
    .filter((v) => isFinite(v.duration) && v.duration > 0);
  if (!vids.length) return null;
  const v = vids.sort((a, b) => b.duration - a.duration)[0];
  return { duration: v.duration, currentTime: v.currentTime, url: location.href, loadId: window.__ytdlpLoadId };
}

async function probeVideo() {
  if (!currentTab) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: probeVideoInPage,
    });
    const found = results.map((r) => r && r.result).filter(Boolean);
    if (!found.length) return null;
    return found.sort((a, b) => b.duration - a.duration)[0];
  } catch (_e) {
    return null;   // no host access to this page, DRM, etc.
  }
}

function expandTrim(open) {
  $trimPanel.hidden = !open;
  $trimToggle.setAttribute("aria-expanded", open ? "true" : "false");
  persistTrim();  // remember open/closed state for this page (no-op until trimKey set)
}

async function initTrim() {
  applyTrim();  // render disabled/default state immediately
  const v = await probeVideo();
  if (v) {
    videoDetected = true;
    trim.duration = v.duration;
    trimKey = (v.loadId || "") + "|" + (v.url || "");
    // Restore a selection saved for this same loaded video (survives popup
    // re-open). A refresh (new loadId) or different video (new url) won't match.
    let restored = false;
    let restoreExpanded = false;
    try {
      const store = await chrome.storage.session.get("trim:" + currentTab.id);
      const saved = store["trim:" + currentTab.id];
      if (saved && saved.key === trimKey) {
        trim.start = Number(saved.start) || 0;
        trim.end = saved.end == null ? null : Number(saved.end);
        restoreExpanded = !!saved.expanded;
        restored = true;
      }
    } catch (_e) { /* session storage unavailable */ }
    if (!restored) { trim.start = 0; trim.end = null; }
    applyTrim();
    // Reopen the panel if it was open for this page last time.
    if (restoreExpanded) expandTrim(true);
    return;
  }
  applyTrim();
}

// Slider handlers — clamp so the thumbs can't cross.
$rngStart.addEventListener("input", () => setStart(Number($rngStart.value)));
$rngEnd.addEventListener("input", () => setEnd(Number($rngEnd.value)));

// Text handlers — parse on change/blur; revert to last valid on garbage.
$startTime.addEventListener("change", () => {
  const s = parseTime($startTime.value);
  if (s == null) applyTrim(); else setStart(s);
});
$endTime.addEventListener("change", () => {
  if (!$endTime.value.trim()) { setEnd(null); return; }
  const e = parseTime($endTime.value);
  if (e == null) applyTrim(); else setEnd(e);
});

// "Use current" under each box.
$startCur.addEventListener("click", async () => {
  const v = await probeVideo();
  if (v) setStart(v.currentTime);
});
$endCur.addEventListener("click", async () => {
  const v = await probeVideo();
  if (v) setEnd(v.currentTime);
});

// Header quick presets (auto-expand the panel).
$startToCurrent.addEventListener("click", async () => {
  const v = await probeVideo();
  if (!v) return;
  trim.start = 0;
  setEnd(v.currentTime);
  expandTrim(true);
});
$currentToEnd.addEventListener("click", async () => {
  const v = await probeVideo();
  if (!v || trim.duration == null) return;
  trim.end = trim.duration;
  setStart(v.currentTime);
  expandTrim(true);
});

$trimReset.addEventListener("click", () => {
  trim.start = 0;
  trim.end = null;
  persistTrim();
  applyTrim();
});
$trimToggle.addEventListener("click", () => expandTrim($trimPanel.hidden));

// ---- Service worker port (progress + state) ----
const port = chrome.runtime.connect({ name: "ui" });
port.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.ev === "state" || msg.ev === "queue") {
    renderQueue(msg.jobs);
  } else if (msg.ev === "recent") {
    renderRecent(msg.recent);
  } else if (msg.ev === "notice") {
    setStatus(msg.text || "", "run");
  } else if (msg.ev === "done") {
    const r = msg.result || {};
    if (r.ok && r.returncode === 0) {
      renderDoneOk(r);
    } else if (r.ok) {
      setStatus(`yt-dlp exited with code ${r.returncode}.\n` + (r.note || "") + "\n\n" + (r.stdout || "").slice(-1500), "err");
    } else {
      setStatus("Error: " + (r.error || "unknown"), "err");
    }
  }
});

let currentTab = null;

(async function init() {
  const state = await chrome.storage.local.get(STATE_DEFAULTS);
  const opts = await getOptions();
  $path.value = state.downloadPath || opts.outputDir;
  $transcript.checked = !!state.transcript;
  $newFolder.checked = !!state.newFolder;
  // The Premiere option only works when a template is configured in Settings.
  if (opts.premiereTemplate) {
    $premiere.checked = !!state.premiere;
  } else {
    $premiere.checked = false;
    $premiere.disabled = true;
    $premiereLabel.title = "Set a Premiere template in Settings to enable this.";
    $premiereLabel.style.opacity = "0.5";
  }

  const recent = (await chrome.storage.local.get({ recent: [] })).recent;
  renderRecent(recent);

  currentTab = await getActiveTab();
  if (!currentTab || !currentTab.url || !/^https?:/i.test(currentTab.url)) {
    $url.textContent = "No downloadable page in the active tab.";
    $btn.disabled = true;
    return;
  }
  $url.textContent = currentTab.url;
  initTrim();
})();

// Checkbox coupling: enabling Transcript also enables New Folder (one-way).
$transcript.addEventListener("change", () => {
  if ($transcript.checked) $newFolder.checked = true;
  saveState();
});
$newFolder.addEventListener("change", saveState);
$path.addEventListener("change", saveState);

// Premiere project needs a per-video folder, so enabling it enables New Folder.
$premiere.addEventListener("change", () => {
  if ($premiere.checked) $newFolder.checked = true;
  saveState();
});

document.getElementById("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

$browse.addEventListener("click", async () => {
  $browse.disabled = true;
  const prev = $browse.textContent;
  $browse.textContent = "…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "pickFolder", current: $path.value.trim() });
    if (resp && resp.ok && resp.path) {
      $path.value = resp.path;
      await saveState();
    } else if (resp && !resp.ok) {
      setStatus("Folder picker unavailable: " + (resp.error || "unknown") + "\nType the path instead.", "err");
    }
  } catch (e) {
    setStatus("Browse error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    $browse.disabled = false;
    $browse.textContent = prev;
  }
});

const ACTION_BTNS = [$btn, $btnClaude, $viewTranscript, $transcriptClaude];

// mode: {} plain download; {claude:true} download+Claude; {claude:true,noVideo:true}
// transcript-only prep → Claude.
async function doDownload(mode = {}) {
  if (!currentTab) return;
  const claude = !!mode.claude, noVideo = !!mode.noVideo;
  ACTION_BTNS.forEach((b) => (b.disabled = true)); // briefly, while we gather cookies
  setStatus("Collecting cookies…", "run");
  try {
    await saveState();
    const cookies = await chrome.cookies.getAll({ url: currentTab.url });
    const cookiesText = toNetscape(cookies);
    const opts = await getOptions();
    const state = currentState();
    setStatus(noVideo ? "Preparing transcript → Claude…" : (claude ? `Queued → Claude (${cookies.length} cookies).` : `Queued (${cookies.length} cookies).`), "run");

    const payload = {
      url: currentTab.url,
      label: currentTab.title || currentTab.url,
      cookiesText,
      template: opts.template,
      ytdlpPath: opts.ytdlpPath,
      outputDir: state.downloadPath || opts.outputDir,
      // Claude flows need a folder with transcript + metadata, so force both on
      // for this run without changing the saved checkboxes.
      transcript: (claude || noVideo) ? true : state.transcript,
      newFolder: (claude || noVideo) ? true : state.newFolder,
      transcriptLang: "en",
      premiereProject: state.premiere,
      premiereTemplate: opts.premiereTemplate || "",
    };
    if (noVideo) payload.noVideo = true;
    // A trimmed section only applies to a real video download.
    if (!noVideo && sectionActive()) {
      payload.sectionStart = trim.start;
      payload.sectionEnd = trim.end == null ? trim.duration : trim.end;
    }
    const message = { cmd: "start", payload };
    if (claude) message.opts = { sendToClaude: true, claudePrompt: opts.claudePrompt };
    port.postMessage(message);
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    ACTION_BTNS.forEach((b) => (b.disabled = false));
  }
}

$btn.addEventListener("click", () => doDownload());
$btnClaude.addEventListener("click", () => doDownload({ claude: true }));
$transcriptClaude.addEventListener("click", () => doDownload({ claude: true, noVideo: true }));
$viewTranscript.addEventListener("click", openTranscript);

// ---- Transcript viewer ----
let tvCues = [];

function srtTsToSec(ts) {
  ts = ts.trim().replace(",", ".");
  const p = ts.split(":");
  if (p.length === 3) return (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]);
  if (p.length === 2) return (+p[0]) * 60 + parseFloat(p[1]);
  return parseFloat(ts) || 0;
}

function srtToCues(srt) {
  const cues = [];
  for (const block of (srt || "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const text = lines.filter((l) => !l.includes("-->") && !/^\d+$/.test(l)).join(" ").trim();
    if (text) cues.push({ start: srtTsToSec(a), end: srtTsToSec(b), text });
  }
  return cues;
}

// Seek the active tab's video (largest <video>) to t seconds.
async function seekVideo(t) {
  if (!currentTab) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: (sec) => {
        const vids = Array.from(document.querySelectorAll("video")).filter((v) => isFinite(v.duration) && v.duration > 0);
        if (!vids.length) return;
        const v = vids.sort((a, b) => b.duration - a.duration)[0];
        v.currentTime = sec;
        if (v.play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      },
      args: [t],
    });
  } catch (_e) { /* no video / no access */ }
}

async function openTranscript() {
  if (!currentTab) return;
  $transcriptView.hidden = false;
  $tvSearch.value = "";
  $transcriptList.textContent = "";
  $tvStatus.textContent = "Loading transcript…";
  try {
    const cacheKey = "tx:" + currentTab.url;
    let srt = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (!srt) {
      const cookies = await chrome.cookies.getAll({ url: currentTab.url });
      const opts = await getOptions();
      const resp = await chrome.runtime.sendMessage({
        type: "fetchTranscript", url: currentTab.url,
        cookiesText: toNetscape(cookies), ytdlpPath: opts.ytdlpPath, transcriptLang: "en",
      });
      if (!resp || !resp.ok) {
        $tvStatus.textContent = (resp && resp.error) || "Could not load the transcript.";
        return;
      }
      srt = resp.srt;
      chrome.storage.session.set({ [cacheKey]: srt });
    }
    tvCues = srtToCues(srt);
    $tvStatus.textContent = tvCues.length ? "" : "Transcript was empty.";
    renderCues("");
    updateTvSelection();
  } catch (e) {
    $tvStatus.textContent = "Error: " + (e && e.message ? e.message : String(e));
  }
}

function renderCues(filter) {
  const f = (filter || "").toLowerCase();
  const inS = trim.start;
  const outS = trim.end == null ? (trim.duration == null ? Infinity : trim.duration) : trim.end;
  const active = sectionActive();
  $transcriptList.textContent = "";
  for (const cue of tvCues) {
    if (f && !cue.text.toLowerCase().includes(f)) continue;
    const row = document.createElement("div");
    row.className = "tv-cue";
    if (active && cue.end > inS + 0.01 && cue.start < outS - 0.01) row.classList.add("between");

    const t = document.createElement("span");
    t.className = "t";
    t.textContent = fmtTime(cue.start);

    const x = document.createElement("span");
    x.className = "x";
    x.textContent = cue.text;

    const io = document.createElement("span");
    io.className = "io";
    const bi = document.createElement("button");
    bi.textContent = "in"; bi.title = "Set clip start here";
    bi.addEventListener("click", (e) => { e.stopPropagation(); setStart(cue.start); afterSelect(); });
    const bo = document.createElement("button");
    bo.textContent = "out"; bo.title = "Set clip end here";
    bo.addEventListener("click", (e) => { e.stopPropagation(); setEnd(cue.end); afterSelect(); });
    io.append(bi, bo);

    row.append(t, x, io);
    row.addEventListener("click", () => seekVideo(cue.start));
    $transcriptList.appendChild(row);
  }
}

function updateTvSelection() {
  const active = sectionActive();
  $tvSel.textContent = active
    ? "Selected " + fmtTime(trim.start) + " – " + fmtTime(trim.end == null ? trim.duration : trim.end)
    : "No selection";
  $tvUse.disabled = !active;
}

function afterSelect() {
  renderCues($tvSearch.value);   // refresh the between-highlight
  updateTvSelection();
}

$tvSearch.addEventListener("input", () => renderCues($tvSearch.value));
$tvClose.addEventListener("click", () => { $transcriptView.hidden = true; });
$tvUse.addEventListener("click", () => { $transcriptView.hidden = true; expandTrim(true); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$transcriptView.hidden) $transcriptView.hidden = true;
});
