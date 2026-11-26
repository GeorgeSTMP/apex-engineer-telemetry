# Secure key storage helper for ApexEngineer (Windows)
# Uses DPAPI (CurrentUser scope) so the key is encrypted to the logged-in Windows account.
param(
  [Parameter(Mandatory=$true)][ValidateSet('set','get','clear')][string]$Action,
  [string]$Key = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$targetName = 'ApexEngineer_GeminiApiKey'

function Protect-Key([string]$plain) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  return [Convert]::ToBase64String($protected)
}

function Unprotect-Key([string]$b64) {
  $protected = [Convert]::FromBase64String($b64)
  $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

$storePath = Join-Path $env:LOCALAPPDATA 'ApexEngineer\secure-key.dat'

switch ($Action) {
  'set' {
    if (-not $Key) { Write-Error 'Key required'; exit 1 }
    $dir = Split-Path $storePath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $enc = Protect-Key $Key
    Set-Content -Path $storePath -Value $enc -Encoding ASCII -Force
    Write-Output 'ok'
  }
  'get' {
    if (-not (Test-Path $storePath)) { exit 0 }
    $enc = Get-Content -Path $storePath -Raw
    if (-not $enc) { exit 0 }
    try {
      $plain = Unprotect-Key $enc.Trim()
      Write-Output $plain
    } catch {
      exit 1
    }
  }
  'clear' {
    if (Test-Path $storePath) { Remove-Item $storePath -Force }
    Write-Output 'ok'
  }
}
