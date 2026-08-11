// options.js — load and persist settings in chrome.storage.sync.

const DEFAULTS = {
  ytdlpPath: "yt-dlp.exe",
  outputDir: "%USERPROFILE%\\Downloads",
  template: '"{ytdlp}" -N 16 --recode-video mp4 --cookies "{cookies}" -P "{output}" -f "bv*[height>1080][ext=webm]+ba/bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" "{url}"',
  premiereTemplate: "",
  claudePrompt: "A video was just downloaded into this folder by the yt-dlp downloader. Read the .metadata.md and .srt files here, then follow the CLAUDE.md in the parent folder: decide whether this is a Mode A (clip discovery) or Mode B (hook + on-screen caption) job using its mode-selection rules, or ask me first if it is genuinely unclear. Then begin.",
};

const fields = ["ytdlpPath", "outputDir", "template", "premiereTemplate", "claudePrompt"];

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const id of fields) {
    document.getElementById(id).value = stored[id] ?? DEFAULTS[id];
  }
}

async function save() {
  const values = {};
  for (const id of fields) {
    values[id] = document.getElementById(id).value.trim() || DEFAULTS[id];
  }
  await chrome.storage.sync.set(values);
  const saved = document.getElementById("saved");
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 1500);
}

async function update() {
  const btn = document.getElementById("update");
  const status = document.getElementById("updateStatus");
  const ytdlpPath = document.getElementById("ytdlpPath").value.trim() || DEFAULTS.ytdlpPath;
  btn.disabled = true;
  status.className = "run";
  status.textContent = "Updating…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "updateYtdlp", ytdlpPath });
    if (!resp) {
      status.className = "err";
      status.textContent = "No response from the native host (is it installed?).";
    } else if (resp.ok && resp.returncode === 0) {
      status.className = "ok";
      status.textContent = (resp.stdout || "Updated.").trim().split("\n").slice(-1)[0] || "Updated ✓";
    } else if (resp.ok) {
      status.className = "err";
      status.textContent = ((resp.stderr || resp.stdout || "").trim().split("\n").slice(-1)[0]) ||
        ("yt-dlp exited with code " + resp.returncode);
    } else {
      status.className = "err";
      status.textContent = resp.error || "Update failed.";
    }
  } catch (e) {
    status.className = "err";
    status.textContent = "Error: " + (e && e.message ? e.message : String(e));
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("update").addEventListener("click", update);
load();
