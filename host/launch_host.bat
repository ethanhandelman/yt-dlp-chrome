@echo off
REM Wrapper Chrome invokes for the native messaging host.
REM Uses the Python launcher if present, otherwise falls back to python on PATH.
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%~dp0yt_dlp_host.py" %*
) else (
  python "%~dp0yt_dlp_host.py" %*
)
