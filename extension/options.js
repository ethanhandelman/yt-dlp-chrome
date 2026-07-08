// options.js — load and persist settings in chrome.storage.sync.

const DEFAULTS = {
  ytdlpPath: "yt-dlp.exe",
  outputDir: "%USERPROFILE%\\Downloads",
  template: '"{ytdlp}" -N 16 --recode-video mp4 --cookies "{cookies}" -P "{output}" -f "bv*+ba/b" "{url}"',
};

const fields = ["ytdlpPath", "outputDir", "template"];

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

document.getElementById("save").addEventListener("click", save);
load();
