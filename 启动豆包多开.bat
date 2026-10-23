@echo off
title Doubao Multi-Account Manager
REM Clear inherited env vars that force Electron into pure Node mode.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
cd /d "%~dp0"

REM Step 0: Node.js is only needed when the runtime hasn't been downloaded yet.
if not exist "node_modules\electron\dist\electron.exe" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] Node.js 18+ is required for the first run.
    echo         Download: https://nodejs.org  then double-click this file again.
    echo.
    echo         Just want to USE the app? Grab the portable build from the
    echo         Releases page instead ^(no Node.js needed, unzip and run^).
    echo.
    pause
    exit /b 1
  )
)

REM Step 1: install deps when electron binary is missing.
if not exist "node_modules\electron\dist\electron.exe" (
  echo [INFO] Dependencies not found. Running npm install...
  call npm install
)

REM Step 2: npm reports "up to date" when node_modules\electron exists, and
REM then never runs the package's postinstall, so dist\ stays empty.
REM Run install.js explicitly as a fallback.
if not exist "node_modules\electron\dist\electron.exe" (
  echo [INFO] Downloading Electron runtime...
  pushd "node_modules\electron"
  set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
  call node install.js
  popd
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime is still missing.
  echo         Run manually: cd node_modules\electron ^&^& node install.js
  pause
  exit /b 1
)

REM --no-sandbox: GPU sandbox is blocked on some machines (white screen).
REM Hardware acceleration stays enabled.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage
exit
