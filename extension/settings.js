// settings.js — settings shared by the popup and the options page.
//
// Machine-specific settings (paths, the Claude toggle) live in storage.local so a
// Chrome profile synced between a Windows PC and a Mac doesn't carry C:\ paths
// onto the Mac (or vice versa). Portable ones (command template, Claude prompt)
// stay in storage.sync.

const SYNC_DEFAULTS = {
  template: '"{ytdlp}" -N 16 --recode-video mp4 --cookies "{cookies}" -P "{output}" -f "bv*[height>1080][ext=webm]+ba/bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" "{url}"',
  claudePrompt: "A video was just downloaded into this folder by the yt-dlp downloader. Read the .metadata.md and .srt files here, then follow the CLAUDE.md in the parent folder: decide whether this is a Mode A (clip discovery) or Mode B (hook + on-screen caption) job using its mode-selection rules, or ask me first if it is genuinely unclear. Then begin.",
};

// Path settings that older (Windows-only) versions kept in storage.sync.
const LEGACY_SYNC_KEYS = ["ytdlpPath", "outputDir", "premiereTemplate"];

let platformOs = null;
async function getOs() {
  if (!platformOs) platformOs = (await chrome.runtime.getPlatformInfo()).os;
  return platformOs;
}

async function localDefaults() {
  const win = (await getOs()) === "win";
  return {
    ytdlpPath: win ? "yt-dlp.exe" : "yt-dlp",
    outputDir: win ? "%USERPROFILE%\\Downloads" : "~/Downloads",
    premiereTemplate: "",
    claudeEnabled: true,
  };
}

async function settingsDefaults() {
  return { ...SYNC_DEFAULTS, ...(await localDefaults()) };
}

// Carry path settings saved by an older version over to storage.local. Windows
// only: that version ran nowhere else, so any synced paths are Windows paths.
// The synced copies are left in place for other Windows machines on the profile.
async function migrateLegacySync() {
  if ((await getOs()) !== "win") return;
  const synced = await chrome.storage.sync.get(LEGACY_SYNC_KEYS);
  const local = await chrome.storage.local.get(LEGACY_SYNC_KEYS);
  const missing = {};
  for (const k of Object.keys(synced)) if (!(k in local)) missing[k] = synced[k];
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
}

async function getSettings() {
  await migrateLegacySync();
  const localDef = await localDefaults();
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(localDef),
  ]);
  return { ...SYNC_DEFAULTS, ...synced, ...localDef, ...local };
}

async function saveSettings(values) {
  const localDef = await localDefaults();
  const toLocal = {}, toSync = {};
  for (const [k, v] of Object.entries(values)) (k in localDef ? toLocal : toSync)[k] = v;
  await Promise.all([chrome.storage.local.set(toLocal), chrome.storage.sync.set(toSync)]);
}
