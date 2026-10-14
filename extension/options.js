// options.js — load and persist settings (settings.js decides where each lives).

const fields = ["ytdlpPath", "outputDir", "template", "premiereTemplate", "claudePrompt"];
const $claudeEnabled = document.getElementById("claudeEnabled");
const $claudePrompt = document.getElementById("claudePrompt");

const PLACEHOLDERS = {
  win: {
    ytdlpPath: "yt-dlp.exe or C:\\tools\\yt-dlp.exe",
    outputDir: "%USERPROFILE%\\Downloads",
    premiereTemplate: "C:\\ytdlp-premiere-template\\template.prproj",
  },
  mac: {
    ytdlpPath: "yt-dlp or /opt/homebrew/bin/yt-dlp",
    outputDir: "~/Downloads",
    premiereTemplate: "~/ytdlp-premiere-template/template.prproj",
  },
};

// The prompt only matters while the Claude features are on.
function syncClaudeUi() {
  $claudePrompt.disabled = !$claudeEnabled.checked;
}

async function load() {
  const stored = await getSettings();
  const ph = (await getOs()) === "win" ? PLACEHOLDERS.win : PLACEHOLDERS.mac;
  for (const id of fields) {
    const el = document.getElementById(id);
    el.value = stored[id];
    if (ph[id]) el.placeholder = ph[id];
  }
  $claudeEnabled.checked = !!stored.claudeEnabled;
  syncClaudeUi();
}

async function save() {
  const defaults = await settingsDefaults();
  const values = { claudeEnabled: $claudeEnabled.checked };
  for (const id of fields) {
    values[id] = document.getElementById(id).value.trim() || defaults[id];
  }
  await saveSettings(values);
  const saved = document.getElementById("saved");
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 1500);
}

async function update() {
  const btn = document.getElementById("update");
  const status = document.getElementById("updateStatus");
  const ytdlpPath = document.getElementById("ytdlpPath").value.trim() || (await settingsDefaults()).ytdlpPath;
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
$claudeEnabled.addEventListener("change", syncClaudeUi);
document.getElementById("update").addEventListener("click", update);
load();
