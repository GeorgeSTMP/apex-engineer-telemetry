$ErrorActionPreference = 'SilentlyContinue'

function Read-Utf16NullTerminated([byte[]]$bytes, [int]$offset, [int]$charLen) {
  $maxBytes = [Math]::Min($charLen * 2, $bytes.Length - $offset)
  if ($maxBytes -le 0) { return '' }
  $str = [System.Text.Encoding]::Unicode.GetString($bytes, $offset, $maxBytes)
  $nullIdx = $str.IndexOf([char]0)
  if ($nullIdx -ge 0) { return $str.Substring(0, $nullIdx).Trim() }
  return $str.Trim()
}

function Read-AsciiNullTerminated([byte[]]$bytes, [int]$offset, [int]$maxLen) {
  $len = [Math]::Min($maxLen, $bytes.Length - $offset)
  if ($len -le 0) { return '' }
  $str = [System.Text.Encoding]::ASCII.GetString($bytes, $offset, $len)
  $nullIdx = $str.IndexOf([char]0)
  if ($nullIdx -ge 0) { return $str.Substring(0, $nullIdx).Trim() }
  return $str.Trim()
}

function Try-OpenMemoryMap([string]$name) {
  try {
    return [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($name)
  } catch {
    return $null
  }
}

$lastProcessCheck = [DateTime]::MinValue
$lastProcessJson = ''
$lastAccPacket = -1

while ($true) {
  $now = [DateTime]::UtcNow
  if (($now - $lastProcessCheck).TotalMilliseconds -ge 1800) {
    $lastProcessCheck = $now
    $simId = $null
    $gameName = $null
    $runningNames = @()

    try {
      $procs = Get-Process | Where-Object {
        $_.ProcessName -match 'Le Mans Ultimate|LeMansUltimate|LMU|rFactor2|AC2-Win64-Shipping|ACC|iRacingSim64DX11'
      }
      foreach ($p in $procs) {
        $runningNames += $p.ProcessName
        if (-not $simId) {
          if ($p.ProcessName -match 'Le Mans Ultimate|LeMansUltimate|^LMU') {
            $simId = 'lmu'; $gameName = 'Le Mans Ultimate'
          } elseif ($p.ProcessName -match 'AC2-Win64-Shipping|^ACC') {
            $simId = 'acc'; $gameName = 'Assetto Corsa Competizione'
          } elseif ($p.ProcessName -match 'rFactor2') {
            $simId = 'rf2'; $gameName = 'rFactor 2'
          } elseif ($p.ProcessName -match 'iRacingSim64') {
            $simId = 'iracing'; $gameName = 'iRacing'
          }
        }
      }
    } catch {}

    $hasLmuShm = $false
    $hasRf2Shm = $false
    $hasAccShm = $false

    $mLmu = Try-OpenMemoryMap '$LMU_Data$'
    if (-not $mLmu) { $mLmu = Try-OpenMemoryMap 'LMU_Data' }
    if ($mLmu) { $hasLmuShm = $true; $mLmu.Dispose() }

    $mRf2 = Try-OpenMemoryMap '$rFactor2SMMP_Telemetry$'
    if ($mRf2) { $hasRf2Shm = $true; $mRf2.Dispose() }

    $mAcc = Try-OpenMemoryMap 'Local\acpmf_physics'
    if ($mAcc) { $hasAccShm = $true; $mAcc.Dispose() }

    $procPayload = @{
      type = 'process_status'
      simId = $simId
      gameName = $gameName
      gameRunning = ($null -ne $simId)
      hasLmuShm = $hasLmuShm
      hasRf2Shm = $hasRf2Shm
      hasAccShm = $hasAccShm
      processes = $runningNames
    } | ConvertTo-Json -Compress

    if ($procPayload -ne $lastProcessJson) {
      $lastProcessJson = $procPayload
      [Console]::Out.WriteLine($procPayload)
      [Console]::Out.Flush()
    }

    # Extra status when game is running but no full shared memory is available
    if ($simId -eq 'lmu' -and -not $hasLmuShm -and -not $hasRf2Shm) {
      $note = @{
        type = 'shm_note'
        message = 'LMU is running but native shared memory map was not found. Full pedals/tires require the built-in LMU_Data map or the optional rF2 SharedMemoryMapPlugin. REST fallback will still provide session state.'
      } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine($note)
      [Console]::Out.Flush()
    }
  }

  # Read ACC Native Shared Memory when running ACC
  $accPhys = Try-OpenMemoryMap 'Local\acpmf_physics'
  if ($accPhys) {
    try {
      $accGraph = Try-OpenMemoryMap 'Local\acpmf_graphics'
      $accStatic = Try-OpenMemoryMap 'Local\acpmf_static'
      $pAcc = $accPhys.CreateViewAccessor(0, 300, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
      $pBuf = New-Object byte[] 300
      $pAcc.ReadArray(0, $pBuf, 0, 300) | Out-Null
      $pAcc.Dispose()

      $pktId = [BitConverter]::ToInt32($pBuf, 0)
      if ($pktId -ne $lastAccPacket -and $pktId -gt 0) {
        $lastAccPacket = $pktId
        $gas = [BitConverter]::ToSingle($pBuf, 4)
        $brake = [BitConverter]::ToSingle($pBuf, 8)
        $fuel = [BitConverter]::ToSingle($pBuf, 12)
        $gearRaw = [BitConverter]::ToInt32($pBuf, 16)
        $rpms = [BitConverter]::ToInt32($pBuf, 20)
        $steerAngle = [BitConverter]::ToSingle($pBuf, 24)
        $speedKmh = [BitConverter]::ToSingle($pBuf, 28)
        $latG = [BitConverter]::ToSingle($pBuf, 44)
        $longG = [BitConverter]::ToSingle($pBuf, 52)
        $slipFL = [BitConverter]::ToSingle($pBuf, 56)
        $slipFR = [BitConverter]::ToSingle($pBuf, 60)
        $slipRL = [BitConverter]::ToSingle($pBuf, 64)
        $slipRR = [BitConverter]::ToSingle($pBuf, 68)
        $psiFL = [BitConverter]::ToSingle($pBuf, 88)
        $psiFR = [BitConverter]::ToSingle($pBuf, 92)
        $psiRL = [BitConverter]::ToSingle($pBuf, 96)
        $psiRR = [BitConverter]::ToSingle($pBuf, 100)
        $tempFL = [BitConverter]::ToSingle($pBuf, 136)
        $tempFR = [BitConverter]::ToSingle($pBuf, 140)
        $tempRL = [BitConverter]::ToSingle($pBuf, 144)
        $tempRR = [BitConverter]::ToSingle($pBuf, 148)
        $brkFL = [BitConverter]::ToSingle($pBuf, 260)
        $brkFR = [BitConverter]::ToSingle($pBuf, 264)
        $brkRL = [BitConverter]::ToSingle($pBuf, 268)
        $brkRR = [BitConverter]::ToSingle($pBuf, 272)
        $clutch = [BitConverter]::ToSingle($pBuf, 276)

        $carModel = ''
        $trackName = ''
        $maxRpm = 8500
        if ($accStatic) {
          $sAcc = $accStatic.CreateViewAccessor(0, 320, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
          $sBuf = New-Object byte[] 320
          $sAcc.ReadArray(0, $sBuf, 0, 320) | Out-Null
          $sAcc.Dispose()
          $carModel = Read-Utf16NullTerminated $sBuf 68 33
          $trackName = Read-Utf16NullTerminated $sBuf 134 33
          $mRpm = [BitConverter]::ToInt32($sBuf, 284)
          if ($mRpm -gt 3000 -and $mRpm -lt 20000) { $maxRpm = $mRpm }
        }

        $completedLaps = 0
        $normPos = 0.0
        $statusCode = 2
        $sessionCode = -1
        $isInPit = 0
        if ($accGraph) {
          $gAcc = $accGraph.CreateViewAccessor(0, 260, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
          $gBuf = New-Object byte[] 260
          $gAcc.ReadArray(0, $gBuf, 0, 260) | Out-Null
          $gAcc.Dispose()
          $statusCode = [BitConverter]::ToInt32($gBuf, 4)
          $sessionCode = [BitConverter]::ToInt32($gBuf, 8)
          $completedLaps = [BitConverter]::ToInt32($gBuf, 132)
          $isInPit = [BitConverter]::ToInt32($gBuf, 160)
          $normPos = [BitConverter]::ToSingle($gBuf, 248)
          if ([Single]::IsNaN($normPos) -or $normPos -lt 0 -or $normPos -gt 1) {
            $normPos = [BitConverter]::ToSingle($gBuf, 212)
          }
        }

        $accSessionType = switch ($sessionCode) {
          0 { 'practice' }
          1 { 'qualifying' }
          2 { 'race' }
          3 { 'practice' }
          4 { 'practice' }
          7 { 'practice' }
          8 { 'qualifying' }
          default { 'unknown' }
        }
        $accSessionRaw = switch ($sessionCode) {
          0 { 'PRACTICE' }
          1 { 'QUALIFY' }
          2 { 'RACE' }
          3 { 'HOTLAP' }
          4 { 'TIME_ATTACK' }
          7 { 'HOTSTINT' }
          8 { 'SUPERPOLE' }
          default { '' }
        }

        if ($statusCode -eq 2 -or $statusCode -eq 3) {
          $inGarageOrPit = ($isInPit -eq 1) -or ($statusCode -eq 3)
          $frameObj = @{
            type = 'telemetry_frame'
            frame = @{
              timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
              simId = 'acc'
              trackName = $trackName
              carName = $carModel
              carClass = 'LMGT3'
              sessionType = $accSessionType
              rawSessionName = $accSessionRaw
              lapNumber = [Math]::Max(1, $completedLaps + 1)
              lapDistPct = [Math]::Max(0, [Math]::Min(1, $normPos))
              speedKmh = [Math]::Max(0, $speedKmh)
              rpm = [Math]::Max(0, $rpms)
              maxRpm = $maxRpm
              gear = [Math]::Max(0, $gearRaw - 1)
              throttle = [Math]::Max(0, [Math]::Min(1, $gas))
              brake = [Math]::Max(0, [Math]::Min(1, $brake))
              clutch = [Math]::Max(0, [Math]::Min(1, $clutch))
              steeringRad = $steerAngle
              latG = $latG
              longG = $longG
              deltaSec = 0
              fuelLiters = [Math]::Max(0, $fuel)
              tireTempC = @{ fl = $tempFL; fr = $tempFR; rl = $tempRL; rr = $tempRR }
              tirePressurePsi = @{ fl = $psiFL; fr = $psiFR; rl = $psiRL; rr = $psiRR }
              tireWearPct = @{ fl = 98; fr = 98; rl = 98; rr = 98 }
              brakeTempC = @{ fl = $brkFL; fr = $brkFR; rl = $brkRL; rr = $brkRR }
              frontWheelSlip = [Math]::Max($slipFL, $slipFR)
              rearWheelSlip = [Math]::Max($slipRL, $slipRR)
              absActive = $false
              tcActive = $false
              offTrackRisk = 0
              hazardAhead = $false
              hazardDistanceM = 999
              hazardDescription = ''
              flagState = 'green'
              inPitOrGarage = $inGarageOrPit
              isPaused = ($statusCode -eq 3)
              telemetrySource = 'shared-memory'
              sensorCaps = @{ pedals = $true; tires = $true; brakes = $true; rpmGear = $true }
            }
          } | ConvertTo-Json -Depth 4 -Compress
          [Console]::Out.WriteLine($frameObj)
          [Console]::Out.Flush()
        }
      }
      if ($accGraph) { $accGraph.Dispose() }
      if ($accStatic) { $accStatic.Dispose() }
    } catch {}
    $accPhys.Dispose()
  }


  # Full native LMU shared memory (LMU_Data / $LMU_Data$) — 324820 bytes
  $lmuMap = Try-OpenMemoryMap '$LMU_Data$'
  if (-not $lmuMap) { $lmuMap = Try-OpenMemoryMap 'LMU_Data' }
  if ($lmuMap) {
    try {
      $view = $lmuMap.CreateViewAccessor(0, 324820, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
      $buf = New-Object byte[] 324820
      $view.ReadArray(0, $buf, 0, 324820) | Out-Null
      $view.Dispose()
      $b64 = [Convert]::ToBase64String($buf)
      $payload = @{
        type = 'shm_raw'
        simId = 'lmu'
        bufferB64 = $b64
        timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine($payload)
      [Console]::Out.Flush()
    } catch {}
    $lmuMap.Dispose()
  }

  # rFactor 2 / Legacy LMU SharedMemoryMapPlugin
  $rf2Tele = Try-OpenMemoryMap '$rFactor2SMMP_Telemetry$'
  $rf2Scor = Try-OpenMemoryMap '$rFactor2SMMP_Scoring$'
  if ($rf2Tele -and $rf2Scor) {
    try {
      $tView = $rf2Tele.CreateViewAccessor(0, 241680, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
      $tBuf = New-Object byte[] 241680
      $tView.ReadArray(0, $tBuf, 0, 241680) | Out-Null
      $tView.Dispose()

      $sView = $rf2Scor.CreateViewAccessor(0, 75312, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
      $sBuf = New-Object byte[] 75312
      $sView.ReadArray(0, $sBuf, 0, 75312) | Out-Null
      $sView.Dispose()

      $payload = @{
        type = 'shm_raw'
        simId = 'rf2'
        teleB64 = [Convert]::ToBase64String($tBuf)
        scorB64 = [Convert]::ToBase64String($sBuf)
        timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine($payload)
      [Console]::Out.Flush()
    } catch {}
    $rf2Tele.Dispose()
    $rf2Scor.Dispose()
  }

  Start-Sleep -Milliseconds 80
}
