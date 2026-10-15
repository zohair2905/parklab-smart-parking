@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python is required. Install Python 3, then run this launcher again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8778 in your browser.
echo Keep this window open while using ParkLab. Press Ctrl+C to stop.
py -3 -m http.server 8778 --bind 127.0.0.1
