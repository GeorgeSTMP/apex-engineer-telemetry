$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Ensure TLS 1.2 / TLS 1.3 works on older Windows PowerShell 5.1 hosts
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 3072
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$rootDir = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $rootDir '.nodejs'
$nodeExe = Join-Path $targetDir 'node.exe'

if (Test-Path $nodeExe) {
  exit 0
}

Write-Host '[1/2] Downloading portable runtime (one-time setup)...' -ForegroundColor Cyan

$version = 'v22.14.0'
try {
  $indexUrl = 'https://nodejs.org/dist/index.json'
  $releases = Invoke-RestMethod -Uri $indexUrl -TimeoutSec 10 -UseBasicParsing
  $lts = $releases | Where-Object { $_.lts -and $_.lts -ne $false -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
  if ($lts -and $lts.version) {
    $version = $lts.version
  }
} catch {
  Write-Host "      Using pinned Node.js LTS $version..." -ForegroundColor Yellow
}

$zipUrl = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"
$tmpDir = Join-Path $rootDir '.nodejs_tmp'
$zipPath = Join-Path $env:TEMP "apex-node-$version-win-x64.zip"

$downloaded = $false
$curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlCmd) {
  Write-Host "      Fetching runtime $version via curl..."
  & $curlCmd.Source -fSL --retry 2 --connect-timeout 15 -o $zipPath $zipUrl
  if ($LASTEXITCODE -eq 0 -and (Test-Path $zipPath) -and ((Get-Item $zipPath).Length -gt 5MB)) {
    $downloaded = $true
  }
}

if (-not $downloaded) {
  try {
    Write-Host "      Fetching runtime $version via PowerShell..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -TimeoutSec 120 -UseBasicParsing
    if ((Test-Path $zipPath) -and ((Get-Item $zipPath).Length -gt 5MB)) {
      $downloaded = $true
    }
  } catch {
    $downloaded = $false
  }
}

if (-not $downloaded) {
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    Write-Host '      Direct zip blocked; trying winget OpenJS.NodeJS.LTS...' -ForegroundColor Yellow
    & $wingetCmd.Source install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
      exit 0
    }
  }
  throw 'Failed to download Node.js portable runtime.'
}

if (Test-Path $tmpDir) {
  Remove-Item -Recurse -Force $tmpDir
}

Write-Host '      Extracting runtime...'
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $tmpDir)
} catch {
  Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
}

Remove-Item -Force $zipPath -ErrorAction SilentlyContinue

$extractedFolder = Get-ChildItem -Path $tmpDir -Directory | Select-Object -First 1
if (-not $extractedFolder) {
  throw 'Failed to extract Node.js archive.'
}

if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}

Move-Item -Path $extractedFolder.FullName -Destination $targetDir
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

Write-Host "      Runtime $version ready!" -ForegroundColor Green
