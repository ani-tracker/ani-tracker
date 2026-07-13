@echo off
setlocal

set "RUN_MODE=preview"
set "SKIP_STORE_PRUNE="
set "KILL_APP="

:parse
if "%~1"=="" goto run

if /I "%~1"=="preview" (
  set "RUN_MODE=preview"
  shift
  goto parse
)

if /I "%~1"=="dev" (
  set "RUN_MODE=dev"
  shift
  goto parse
)

if /I "%~1"=="none" (
  set "RUN_MODE=none"
  shift
  goto parse
)

if /I "%~1"=="--skip-store-prune" (
  set "SKIP_STORE_PRUNE=-SkipStorePrune"
  shift
  goto parse
)

if /I "%~1"=="/skip-store-prune" (
  set "SKIP_STORE_PRUNE=-SkipStorePrune"
  shift
  goto parse
)

if /I "%~1"=="--kill-app" (
  set "KILL_APP=-KillApp"
  shift
  goto parse
)

if /I "%~1"=="/kill-app" (
  set "KILL_APP=-KillApp"
  shift
  goto parse
)

if /I "%~1"=="-h" goto help
if /I "%~1"=="--help" goto help
if /I "%~1"=="/?" goto help

echo Unknown option: %~1
echo.
goto help

:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0clean-rebuild-win.ps1" -Run "%RUN_MODE%" %SKIP_STORE_PRUNE% %KILL_APP%
exit /b %ERRORLEVEL%

:help
echo Usage: scripts\clean-rebuild-win.cmd [preview^|dev^|none] [options]
echo.
echo Modes:
echo   preview              Build, then run pnpm preview. Default.
echo   dev                  Build, then run pnpm dev.
echo   none                 Build only, do not start Electron.
echo.
echo Options:
echo   --skip-store-prune   Skip pnpm store prune.
echo   --kill-app           Stop workspace Electron processes before cleaning.
echo   -h, --help, /?       Show this help.
echo.
echo Examples:
echo   scripts\clean-rebuild-win.cmd
echo   scripts\clean-rebuild-win.cmd dev --kill-app
echo   scripts\clean-rebuild-win.cmd none --skip-store-prune
exit /b 0
