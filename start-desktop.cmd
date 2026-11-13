@echo off
setlocal
cd /d "%~dp0"
echo Starting ARC from the current project. Building the desktop UI...
call npm start
if errorlevel 1 (
  echo ARC could not start. Check the error above, then run npm ci if dependencies are missing.
  pause
  exit /b 1
)
