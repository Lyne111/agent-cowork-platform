@echo off
setlocal DisableDelayedExpansion
title Agent Cowork - Install and Start
cd /d "%~dp0"
if errorlevel 1 goto failed

if not exist "package-lock.json" (
  echo Extract the complete ZIP first. This file must be beside package.json.
  goto failed
)
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 24.22.1 or a newer Node 24 release, then reopen this installer.
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm.cmd was not found. Install Node.js with npm, then reopen this installer.
  goto failed
)
node scripts\check-prerequisites.mjs
if errorlevel 1 goto failed

echo.
echo [1/4] Installing locked dependencies...
call npm.cmd ci
if errorlevel 1 goto failed
echo.
echo [2/4] Building the application...
call npm.cmd run build
if errorlevel 1 goto failed
echo.
echo [3/4] Checking agent tools...
call npm.cmd run doctor
if errorlevel 1 goto failed
echo.
echo [4/4] Starting the local service...
echo Open the local address shown by the service in your browser.
echo Keep this window open while using the application. Press Ctrl+C to stop.
call npm.cmd start
if errorlevel 1 goto failed
endlocal
exit /b 0

:failed
echo.
echo Installation or startup did not complete. Read the error above.
echo This installer does not install Node.js or Git automatically.
pause
endlocal
exit /b 1
