// background.js — service worker.
// - Downloads run over a long-lived connectNative port so progress can stream
//   and continue even if the popup closes; progress is drawn as a ring on the
//   toolbar icon (+ a % badge).
// - Light commands (open/reveal/readText/pickFolder) use one-shot
//   sendNativeMessage.
// - Finished downloads are recorded in a "recent" list (max 5) in storage.local.

const HOST_NAME = "com.ytdlp.downloader";
const MAX_RECENT = 5;
const DEFAULT_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };

const QUEUE_KEY = "queue"; // chrome.storage.session slot for the persisted queue

const uiPorts = new Set();
let jobs = [];            // [{ id, label, status:"downloading"|"queued", percent, phase, payload }]
let nativePort = null;
let runningId = null;     // id of the job currently downloading (null if idle)
let jobSeq = 0;
let baseBitmap = null;

// ---- UI port (popup) ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ui") return;
  uiPorts.add(port);
  port.postMessage({ ev: "state", jobs: snapshot() });
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.cmd === "start") startDownload(msg.payload, msg.opts);
    else if (msg.cmd === "cancel") cancel(msg.id);
  });
  port.onDisconnect.addListener(() => uiPorts.delete(port));
});

function broadcast(message) {
  for (const p of uiPorts) {
    try { p.postMessage(message); } catch (_e) { /* port gone */ }
  }
}

// Public view of the queue — never expose payloads (they carry cookies).
function snapshot() {
  return jobs.map(({ id, label, status, percent, phase }) => ({ id, label, status, percent, phase }));
}
function broadcastQueue() {
  broadcast({ ev: "queue", jobs: snapshot() });
}

// Persist the queue so it survives a service-worker restart (MV3 workers are
// killed after ~30s idle). Stored in storage.session — in memory, not exposed
// to content scripts, and cleared when the browser closes — so payloads (which
// carry cookies) never touch disk. Called on structural changes only, not on
// every progress tick. Payloads are kept because they're needed to resume a job.
function persistQueue() {
  chrome.storage.session.set({ [QUEUE_KEY]: { jobs, jobSeq } }).catch(() => {});
}

// Restore the queue after the worker restarts. A job left "downloading" was
// running when the worker died: its native port is gone and can't be reattached
// (the orphaned host usually finishes writing the file on its own), so we drop
// it with a notice rather than restart it — restarting would race the orphan
// writing the same file. Remaining "queued" jobs resume normally.
async function rehydrate() {
  let saved;
  try {
    saved = (await chrome.storage.session.get(QUEUE_KEY))[QUEUE_KEY];
  } catch (_e) { return; }
  if (!saved || !Array.isArray(saved.jobs) || !saved.jobs.length) return;

  jobs = saved.jobs;
  jobSeq = saved.jobSeq || jobs.reduce((m, j) => Math.max(m, j.id), 0);
  nativePort = null;
  runningId = null;

  const interrupted = jobs.find((j) => j.status === "downloading");
  if (interrupted) {
    jobs = jobs.filter((j) => j.id !== interrupted.id);
    broadcast({
      ev: "notice",
      text: "A download was interrupted and may have finished in the background — check your folder. Resuming the queue…",
    });
  }

  persistQueue();
  broadcastQueue();
  pump();
}
rehydrate();

// ---- Download queue ----
function startDownload(payload, opts) {
  opts = opts || {};
  jobs.push({
    id: ++jobSeq,
    label: payload.label || payload.url,
    status: "queued",
    percent: 0,
    phase: "queued",
    payload,
    sendToClaude: !!opts.sendToClaude,
    claudePrompt: opts.claudePrompt || "",
  });
  broadcastQueue();
  persistQueue();
  pump();
}

// Launch Claude Code (Desktop app) on the finished download's folder so it reads
// the .srt + .metadata.md and the CLAUDE.md in the parent (Download-to) folder.
function launchClaudeCode(folder, prompt) {
  const uri = "claude://code/new?folder=" + encodeURIComponent(folder) +
    (prompt ? "&q=" + encodeURIComponent(prompt) : "");
  chrome.runtime.sendNativeMessage(HOST_NAME, { type: "launchUri", uri }, () => {
    void chrome.runtime.lastError; // best-effort; ignore
  });
}

// Start the next queued job if nothing is currently running.
function pump() {
  if (nativePort) return;
  const job = jobs.find((j) => j.status !== "downloading");
  if (!job) return;

  job.status = "downloading";
  job.phase = "starting";
  job.percent = 0;
  runningId = job.id;
  broadcastQueue();
  persistQueue();
  drawRing(0, "starting");
  chrome.action.setBadgeText({ text: "0%" });

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    finishRunning({ ok: false, error: "Native host unavailable. Did you run install.ps1?" });
    return;
  }

  nativePort.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.kind === "progress") {
      job.percent = msg.percent;
      job.phase = msg.phase;
      drawRing(msg.percent, msg.phase);
      chrome.action.setBadgeText({ text: msg.percent + "%" });
      broadcastQueue();
    } else if (msg.kind === "heartbeat") {
      // Keepalive from the host during quiet stretches. Receiving it already
      // reset the service-worker idle timer; redraw so the ring stays fresh.
      drawRing(job.percent, job.phase);
    } else if (msg.kind === "result") {
      if (job.sendToClaude && msg.ok && msg.folder) {
        launchClaudeCode(msg.folder, job.claudePrompt);
      }
      finishRunning(msg);
    }
  });

  // The host stays alive after a result (its read loop blocks), and Chrome does
  // NOT fire onDisconnect when we call disconnect() ourselves — so onDisconnect
  // means the host died unexpectedly. The runningId guard makes this a no-op if
  // we already finished this job.
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
    if (runningId === job.id) {
      finishRunning({ ok: false, error: err || "Download host disconnected." });
    }
  });

  nativePort.postMessage(job.payload);
}

// Finish the currently-running job. Idempotent via the runningId guard.
// result: a download result to report (done event); null to finish silently
// (used by cancel — no success/error message).
function finishRunning(result) {
  if (runningId === null) return;
  const id = runningId;
  runningId = null;
  if (nativePort) { try { nativePort.disconnect(); } catch (_e) {} nativePort = null; }
  removeJob(id);
  resetIcon();
  if (result) {
    if (result.ok && result.videoPath) addRecent(result);
    broadcast({ ev: "done", result });
  }
  broadcastQueue();
  persistQueue();
  pump();
}

function removeJob(id) {
  jobs = jobs.filter((j) => j.id !== id);
}

function cancel(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.status === "downloading") {
    finishRunning(null); // kill the host process, advance, no done message
  } else {
    removeJob(id);
    broadcastQueue();
    persistQueue();
  }
}

// ---- Recent list ----
async function addRecent(result) {
  const { recent = [] } = await chrome.storage.local.get({ recent: [] });
  const entry = {
    title: result.title || "video",
    videoPath: result.videoPath,
    transcriptPath: result.transcriptPath || null,
    folder: result.folder || null,
    ts: Date.now(),
  };
  const next = [entry, ...recent.filter((r) => r.videoPath !== entry.videoPath)].slice(0, MAX_RECENT);
  await chrome.storage.local.set({ recent: next });
  broadcast({ ev: "recent", recent: next });
}

// ---- Icon ring ----
async function getBase() {
  if (baseBitmap) return baseBitmap;
  const resp = await fetch(chrome.runtime.getURL("icons/icon128.png"));
  baseBitmap = await createImageBitmap(await resp.blob());
  return baseBitmap;
}

async function drawRing(percent, phase) {
  try {
    const size = 32;
    const base = await getBase();
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(base, 2, 2, size - 4, size - 4);

    const cx = size / 2, cy = size / 2, r = size / 2 - 1.5;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();

    const pct = Math.max(0, Math.min(100, percent)) / 100;
    ctx.strokeStyle = phase === "processing" ? "#1a73e8" : "#1db954";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * pct);
    ctx.stroke();

    chrome.action.setIcon({ imageData: ctx.getImageData(0, 0, size, size) });
  } catch (_e) {
    // Canvas/icon failure is non-fatal; the badge still shows progress.
  }
}

function resetIcon() {
  try { chrome.action.setIcon({ path: DEFAULT_ICON }); } catch (_e) {}
  chrome.action.setBadgeText({ text: "" });
}

chrome.action.setBadgeBackgroundColor({ color: "#1db954" });

// ---- One-shot commands ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !["open", "reveal", "readText", "pickFolder", "updateYtdlp"].includes(msg.type)) return;
  chrome.runtime.sendNativeMessage(HOST_NAME, msg, (response) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message || "Native host unavailable." });
      return;
    }
    sendResponse(response);
  });
  return true; // async
});
