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

const uiPorts = new Set();
let active = null;        // { percent, phase } while downloading, else null
let nativePort = null;
let baseBitmap = null;

// ---- UI port (popup) ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ui") return;
  uiPorts.add(port);
  port.postMessage({ ev: "state", active });
  port.onMessage.addListener((msg) => {
    if (msg && msg.cmd === "start") startDownload(msg.payload);
  });
  port.onDisconnect.addListener(() => uiPorts.delete(port));
});

function broadcast(message) {
  for (const p of uiPorts) {
    try { p.postMessage(message); } catch (_e) { /* port gone */ }
  }
}

// ---- Download streaming ----
function startDownload(payload) {
  if (nativePort) return; // one at a time
  active = { percent: 0, phase: "starting" };
  broadcast({ ev: "progress", percent: 0, phase: "starting" });
  drawRing(0, "starting");

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    finishWithError("Native host unavailable. Did you run install.ps1?");
    return;
  }

  let gotResult = false;
  nativePort.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.kind === "progress") {
      active = { percent: msg.percent, phase: msg.phase };
      drawRing(msg.percent, msg.phase);
      chrome.action.setBadgeText({ text: msg.percent + "%" });
      broadcast({ ev: "progress", percent: msg.percent, phase: msg.phase });
    } else if (msg.kind === "result") {
      gotResult = true;
      if (msg.ok && msg.videoPath) addRecent(msg);
      broadcast({ ev: "done", result: msg });
      resetIcon();
      active = null;
      if (nativePort) { try { nativePort.disconnect(); } catch (_e) {} }
      nativePort = null;
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
    nativePort = null;
    if (!gotResult) finishWithError(err || "Download host disconnected.");
  });

  nativePort.postMessage(payload);
}

function finishWithError(error) {
  broadcast({ ev: "done", result: { ok: false, error } });
  resetIcon();
  active = null;
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
  if (!msg || !["open", "reveal", "readText", "pickFolder"].includes(msg.type)) return;
  chrome.runtime.sendNativeMessage(HOST_NAME, msg, (response) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message || "Native host unavailable." });
      return;
    }
    sendResponse(response);
  });
  return true; // async
});
