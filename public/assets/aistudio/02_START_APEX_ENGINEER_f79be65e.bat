@echo off
title ApexEngineer - Desktop Race Engineer
cd /d "%~dp0"

if exist "%~dp0\.nodejs\node.exe" (
  set "PATH=%~dp0\.nodejs;%PATH%"
) else (
  where node >nul 2>nul
  if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
      set "PATH=C:\Program Files\nodejs;%PATH%"
    ) else (
      powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1"
      if %errorlevel% neq 0 (
        echo.
        echo [!] Could not download Node.js automatically. Opening https://nodejs.org/ ...
        start "" "https://nodejs.org/"
        pause
        exit /b 1
      )
      set "PATH=%~dp0\.nodejs;%PATH%"
    )
  )
)

if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
  )
)

if exist "dist\index.html" (
  if exist "dist-server\server.cjs" (
    echo [ApexEngineer] Launching Desktop App Window (http://localhost:3000)...
    echo                Built-in Sim UDP Listener active on port 5606.
    start /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-desktop.ps1" -Url "http://localhost:3000"
    set "NODE_ENV=production"
    node "dist-server\server.cjs"
    pause
    exit /b 0
  )
)

if not exist "node_modules" (
  echo [1/2] First-time dev setup: installing packages...
  call npm install
  if %errorlevel% neq 0 (
    echo [!] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo [2/2] Starting ApexEngineer Desktop App (http://localhost:3000)...
start /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-desktop.ps1" -Url "http://localhost:3000"
call npm run dev
pause
