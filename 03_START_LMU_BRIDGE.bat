@echo off
setlocal EnableExtensions
title ApexEngineer - LMU / ACC / rF2 Telemetry Bridge
cd /d "%~dp0"

if not exist "%~dp0scripts\lmu-bridge.mjs" goto :missing_files

set "NODE_EXE="

if exist "%~dp0.nodejs\node.exe" (
  set "NODE_EXE=%~dp0.nodejs\node.exe"
  goto :run_bridge
)

where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%I"
  )
  goto :run_bridge
)

if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE_EXE=C:\Program Files\nodejs\node.exe"
  goto :run_bridge
)

if exist "C:\Program Files (x86)\nodejs\node.exe" (
  set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
  goto :run_bridge
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1"
if errorlevel 1 goto :node_failed

if exist "%~dp0.nodejs\node.exe" (
  set "NODE_EXE=%~dp0.nodejs\node.exe"
  goto :run_bridge
)

if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE_EXE=C:\Program Files\nodejs\node.exe"
  goto :run_bridge
)

goto :node_failed

:run_bridge
echo Starting ApexEngineer UDP Bridge on port 5606 -^> http://localhost:3000 ...
echo Make sure 02_START_APEX_ENGINEER.bat is already running!
echo.
"%NODE_EXE%" "%~dp0scripts\lmu-bridge.mjs"
pause
exit /b 0

:missing_files
echo.
echo [!] Cannot find scripts\lmu-bridge.mjs. Please extract all files from the ZIP first!
echo.
pause
exit /b 1

:node_failed
echo.
echo [!] Could not set up Node.js automatically. Please run 02_START_APEX_ENGINEER.bat first.
echo.
pause
exit /b 1
