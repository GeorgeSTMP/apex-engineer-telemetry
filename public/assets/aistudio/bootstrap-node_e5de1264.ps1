$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 3072
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$rootDir = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $rootDir '.nodejs'
$nodeExe = Join-Path $targetDir 'node.exe'
$marker = Join-Path $targetDir '.installed'

# Already installed — exit immediately (no download)
if (Test-Path -LiteralPath $nodeExe) {
  exit 0
}

# System Node already present — do not download a second copy
$systemNode = @(
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($systemNode) {
  exit 0
}

Write-Host '[1/2] One-time Node.js setup (will not run again)...' -ForegroundColor Cyan

$version = 'v22.14.0'
try {
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 10 -UseBasicParsing
  $lts = $releases | Where-Object { $_.lts -and $_.lts -ne $false -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
  if ($lts -and $lts.version) { $version = $lts.version }
} catch {}

$zipUrl = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"
$tmpDir = Join-Path $rootDir '.nodejs_tmp'
$zipPath = Join-Path $env:TEMP "apex-node-$version-win-x64.zip"

$downloaded = $false
$curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlCmd) {
  & $curlCmd.Source -fSL --retry 2 --connect-timeout 15 -o $zipPath $zipUrl
  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $zipPath) -and ((Get-Item -LiteralPath $zipPath).Length -gt 5MB)) {
    $downloaded = $true
  }
}
if (-not $downloaded) {
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -TimeoutSec 180 -UseBasicParsing
  if ((Test-Path -LiteralPath $zipPath) -and ((Get-Item -LiteralPath $zipPath).Length -gt 5MB)) {
    $downloaded = $true
  }
}
if (-not $downloaded) { throw 'Failed to download Node.js.' }

if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

Write-Host '      Extracting (one time)...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $tmpDir)
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

$extracted = Get-ChildItem -LiteralPath $tmpDir -Directory | Select-Object -First 1
if (-not $extracted) { throw 'Extract failed.' }

if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
Move-Item -LiteralPath $extracted.FullName -Destination $targetDir
Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'node.exe missing after extract.' }
Set-Content -LiteralPath $marker -Value $version -Encoding ASCII
Write-Host "      Runtime ready at $targetDir" -ForegroundColor Green
exit 0
