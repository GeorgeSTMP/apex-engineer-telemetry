@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0ApexEngineer.exe" (
  echo [!] ApexEngineer.exe not found next to this script. Extract all files from the ZIP first.
  pause
  exit /b 1
)

"%~dp0ApexEngineer.exe" --install-shortcut
echo [ApexEngineer] Desktop and Start Menu shortcuts created with the ApexEngineer icon!
timeout /t 3 >nul
