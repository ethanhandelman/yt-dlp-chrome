<#
  install.ps1 — registers the yt-dlp Downloader native messaging host for Chrome.

  - Generates com.ytdlp.downloader.json from the tracked template, filling in the
    absolute path to launch_host.bat (the generated file is git-ignored so pulls
    never conflict with your machine-specific paths)
  - Optionally overrides the allowed extension ID (-ExtensionId)
  - Creates the HKCU registry key Chrome reads to find the host

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId abcd...   # if your ID differs
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#>
param(
  [string]$ExtensionId,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$HostName     = "com.ytdlp.downloader"
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplatePath = Join-Path $ScriptDir "$HostName.template.json"
$ManifestPath = Join-Path $ScriptDir "$HostName.json"   # generated (git-ignored)
$RegPath      = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if ($Uninstall) {
  if (Test-Path $RegPath) {
    Remove-Item $RegPath -Force
    Write-Host "Removed registry key $RegPath"
  } else {
    Write-Host "Registry key not present; nothing to remove."
  }
  return
}

$BatPath = Join-Path $ScriptDir "launch_host.bat"
if (-not (Test-Path $BatPath)) { throw "launch_host.bat not found next to install.ps1." }
if (-not (Test-Path $TemplatePath)) { throw "$HostName.template.json not found next to install.ps1." }

# Generate the manifest from the template: absolute launcher path + optional ext ID.
$manifest = Get-Content $TemplatePath -Raw | ConvertFrom-Json
$manifest.path = $BatPath
if ($ExtensionId) {
  $manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

# Register: the key's (default) value must be the full path to the manifest JSON.
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(default)" -Value $ManifestPath

Write-Host "Installed native messaging host '$HostName'."
Write-Host "  Manifest : $ManifestPath"
Write-Host "  Launcher : $BatPath"
Write-Host "  Allowed  : $($manifest.allowed_origins -join ', ')"
Write-Host ""
Write-Host "If your extension ID differs from the one above, re-run with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <your-id>"
