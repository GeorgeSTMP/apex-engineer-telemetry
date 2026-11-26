param(
  [string]$Url = 'http://localhost:3000'
)

$ErrorActionPreference = 'SilentlyContinue'

# Wait briefly until ApexEngineer HTTP server is listening
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri "$Url/api/health" -TimeoutSec 2 -UseBasicParsing
    if ($resp.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 400
  }
}

$appData = [Environment]::GetFolderPath('LocalApplicationData')
$candidates = @(
  "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$appData\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles (x86)\Google\Chrome\Application\chrome.exe",
  "$appData\Google\Chrome\Application\chrome.exe",
  "$appData\BraveSoftware\Brave-Browser\Application\brave.exe"
)

$browserExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browserExe) {
  # Launches as a clean standalone desktop app window (no address bar or browser tabs)
  Start-Process -FilePath $browserExe -ArgumentList @(
    "--app=$Url",
    '--window-size=1480,920',
    '--new-window'
  )
} else {
  Start-Process $Url
}
