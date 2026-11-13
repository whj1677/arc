@echo off
setlocal
set "ARC_DATA_DIR=%~dp0evidence\pmreq-acceptance-20261022\acceptance-data"
call "%~dp0start-desktop.cmd"
exit /b %errorlevel%
