@echo off
setlocal
cd /d "%~dp0"
if not defined ARC_DATA_DIR if not exist "%APPDATA%\Arc\arc.sqlite" if not exist "%APPDATA%\arc-desktop\arc.sqlite" if exist "%~dp0evidence\pmreq-acceptance-20261022\acceptance-data\arc.sqlite" set "ARC_DATA_DIR=%~dp0evidence\pmreq-acceptance-20261022\acceptance-data"
echo Starting ARC from the current project. Building the desktop UI...
call npm start
if errorlevel 1 (
  echo ARC could not start. Check the error above, then run npm ci if dependencies are missing.
  pause
  exit /b 1
)
