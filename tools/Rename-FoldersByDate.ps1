<#
.SYNOPSIS
    Renames every subfolder in this script's directory to "YY-MM-DD <original name>".

.DESCRIPTION
    For each immediate subfolder next to this script, prepends a date prefix taken
    from the folder's "date modified" (LastWriteTime), formatted as YY-MM-DD.

        Before:  'Everybody should be able to participate  Advocate for open
        After:   26-07-08 'Everybody should be able to participate  Advocate for open

    The original folder name is preserved verbatim (including any unusual characters).
    Folders whose name already starts with a YY-MM-DD prefix are skipped, so the
    script is safe to run more than once. Nothing is renamed until you review the
    previewed list and confirm.

.USAGE
    1. Copy this file into the directory whose subfolders you want to rename.
    2. Right-click it -> "Run with PowerShell"
       (or run:  powershell -ExecutionPolicy Bypass -File .\Rename-FoldersByDate.ps1)
    3. Review the preview, then type Y to apply.
#>

# Use UTF-8 output so special characters in folder names display correctly.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# The directory this script lives in. When run interactively (not via -File),
# $PSScriptRoot can be empty, so fall back to the current location.
$targetDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($targetDir)) { $targetDir = (Get-Location).Path }

Write-Host "Target directory: $targetDir" -ForegroundColor Cyan
Write-Host ""

# Matches a leading "YY-MM-DD " prefix (already-dated folders).
$datePrefixRegex = '^\d{2}-\d{2}-\d{2} '

$toRename        = @()   # [pscustomobject] Folder / NewName
$skippedDated    = 0
$skippedCollision = 0

$folders = Get-ChildItem -LiteralPath $targetDir -Directory | Sort-Object Name

foreach ($folder in $folders) {
    if ($folder.Name -match $datePrefixRegex) {
        $skippedDated++
        continue
    }

    $datePrefix = $folder.LastWriteTime.ToString('yy-MM-dd')
    $newName    = "$datePrefix $($folder.Name)"
    $newPath    = Join-Path $targetDir $newName

    # Skip if a folder/file with the target name already exists.
    if (Test-Path -LiteralPath $newPath) {
        Write-Host "SKIP (name already exists): $newName" -ForegroundColor Yellow
        $skippedCollision++
        continue
    }

    $toRename += [pscustomobject]@{
        Folder  = $folder
        NewName = $newName
    }
}

Write-Host ""
Write-Host "Planned renames: $($toRename.Count)" -ForegroundColor Cyan
Write-Host "Skipped (already dated): $skippedDated"
Write-Host "Skipped (name collision): $skippedCollision"
Write-Host ""

if ($toRename.Count -eq 0) {
    Write-Host "Nothing to rename." -ForegroundColor Green
    Read-Host "Press Enter to exit"
    return
}

# Preview each planned rename.
foreach ($item in $toRename) {
    Write-Host "  $($item.Folder.Name)" -ForegroundColor Gray
    Write-Host "    -> $($item.NewName)" -ForegroundColor Green
}
Write-Host ""

$answer = Read-Host "Proceed with these $($toRename.Count) rename(s)? (Y/N)"
if ($answer -notmatch '^[Yy]') {
    Write-Host "Cancelled. No changes made." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    return
}

# Apply. -LiteralPath avoids wildcard/[ ] misinterpretation in names.
$renamed = 0
foreach ($item in $toRename) {
    try {
        Rename-Item -LiteralPath $item.Folder.FullName -NewName $item.NewName -ErrorAction Stop
        $renamed++
    }
    catch {
        Write-Host "FAILED: $($item.Folder.Name)" -ForegroundColor Red
        Write-Host "        $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Done. Renamed $renamed of $($toRename.Count) folder(s)." -ForegroundColor Green
Read-Host "Press Enter to exit"
