@echo off
setlocal EnableExtensions
title ApexEngineer - Desktop Race Engineer
cd /d "%~dp0"

if exist "%~dp0ApexEngineer.exe" (
  start "" "%~dp0ApexEngineer.exe"
  exit /b 0
)

if exist "%~dp0release\ApexEngineer\ApexEngineer.exe" (
  start "" "%~dp0release\ApexEngineer\ApexEngineer.exe"
  exit /b 0
)

if not exist "%~dp0scripts\bootstrap-node.ps1" goto :missing_files

set "NODE_EXE="

if exist "%~dp0.nodejs\node.exe" goto :use_local_node
where node >nul 2>nul
if not errorlevel 1 goto :use_system_node
if exist "C:\Program Files\nodejs\node.exe" goto :use_progfiles_node
if exist "C:\Program Files (x86)\nodejs\node.exe" goto :use_progfiles86_node

echo [ApexEngineer] Setting up portable runtime (first launch only)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1"
if errorlevel 1 goto :node_failed

if exist "%~dp0.nodejs\node.exe" goto :use_local_node
if exist "C:\Program Files\nodejs\node.exe" goto :use_progfiles_node
if exist "C:\Program Files (x86)\nodejs\node.exe" goto :use_progfiles86_node
goto :node_failed

:use_local_node
set "NODE_EXE=%~dp0.nodejs\node.exe"
set "PATH=%~dp0.nodejs;%PATH%"
goto :node_ready

:use_system_node
for /f "delims=" %%I in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%I"
goto :node_ready

:use_progfiles_node
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "PATH=C:\Program Files\nodejs;%PATH%"
goto :node_ready

:use_progfiles86_node
set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
goto :node_ready

:node_ready
if not exist ".env" if exist ".env.example" copy ".env.example" ".env" >nul

if exist "dist\index.html" if exist "dist-server\server.cjs" goto :run_release_here
if exist "release\ApexEngineer\dist\index.html" if exist "release\ApexEngineer\dist-server\server.cjs" goto :run_nested_release
goto :run_dev

:run_release_here
echo [ApexEngineer] Launching Desktop App Window (http://localhost:3000)...
echo                Built-in Sim UDP Listener active on port 5606.
start /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-desktop.ps1" -Url "http://localhost:3000"
set "NODE_ENV=production"
"%NODE_EXE%" "%~dp0dist-server\server.cjs"
echo.
echo [ApexEngineer] Server stopped.
pause
exit /b 0

:run_nested_release
echo [ApexEngineer] Launching Desktop App Window (http://localhost:3000)...
echo                Built-in Sim UDP Listener active on port 5606.
if not exist "release\ApexEngineer\.env" if exist ".env" copy ".env" "release\ApexEngineer\.env" >nul
if exist "00_ADD_API_KEY_HERE.txt" copy /y "00_ADD_API_KEY_HERE.txt" "release\ApexEngineer\00_ADD_API_KEY_HERE.txt" >nul
cd /d "%~dp0release\ApexEngineer"
start /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release\ApexEngineer\scripts\launch-desktop.ps1" -Url "http://localhost:3000"
set "NODE_ENV=production"
"%NODE_EXE%" "%~dp0release\ApexEngineer\dist-server\server.cjs"
echo.
echo [ApexEngineer] Server stopped.
pause
exit /b 0

:run_dev
if exist "node_modules" goto :start_dev
echo [1/2] First-time setup: installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [!] Standard install hit a conflict; retrying with --legacy-peer-deps...
  call npm install --no-audit --no-fund --legacy-peer-deps
)
if errorlevel 1 goto :npm_failed

:start_dev
echo [2/2] Starting ApexEngineer Desktop App (http://localhost:3000)...
start /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-desktop.ps1" -Url "http://localhost:3000"
call npm run dev
echo.
echo [ApexEngineer] Server stopped.
pause
exit /b 0

:npm_failed
echo [!] npm install failed. Check your internet connection and try again.
pause
exit /b 1

:missing_files
echo.
echo [!] Cannot find the "scripts" folder next to this file.
echo     If you opened this inside a ZIP archive, please EXTRACT ALL files to a folder first!
echo.
pause
exit /b 1

:node_failed
echo.
echo [!] Could not download the runtime automatically. Opening https://nodejs.org/ ...
start "" "https://nodejs.org/"
pause
exit /b 1
