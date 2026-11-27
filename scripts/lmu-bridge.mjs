// ApexEngineer Local Sim Telemetry Bridge (Node.js >= 18)
// 1. Automatically polls Le Mans Ultimate's built-in WebUI REST API (http://127.0.0.1:6397) - ZERO plugins needed
// 2. Also listens for UDP :5606 telemetry packets (SimHub / custom plugins)
// 3. Forwards Track, Car, Lap Progress, Speed, Fuel, Opponents & Game Status to ApexEngineer
import dgram from 'node:dgram';

const UDP_PORT = Number(process.env.SIM_UDP_PORT || 5606);
const TARGET_ENDPOINT = process.env.APEX_ENDPOINT || 'http://localhost:3000/api/telemetry/ingest';
const STATUS_ENDPOINT = TARGET_ENDPOINT.replace(/\/api\/telemetry\/ingest$/, '/api/sim/status');
const BRIDGE_RESULT_ENDPOINT = TARGET_ENDPOINT.replace(/\/api\/telemetry\/ingest$/, '/api/lmu/pit-menu/bridge-result');
const LMU_BASES = ['http://127.0.0.1:6397', 'http://[::1]:6397'];

const socket = dgram.createSocket('udp4');
let lastSentMs = 0;
let lastUdpMs = 0;
let activeLmuBase = null;
let lastSpeedKmh = 0;
let lastSpeedMs = 0;
let lastHandledPitReqId = null;

function applyTirePlanLocal(pitMenuRaw, plan) {
  const wrapperKey = Array.isArray(pitMenuRaw)
    ? null
    : Array.isArray(pitMenuRaw?.pitMenu)
      ? 'pitMenu'
      : Array.isArray(pitMenuRaw?.items)
        ? 'items'
        : null;
  const list = Array.isArray(pitMenuRaw)
    ? pitMenuRaw
    : wrapperKey
      ? pitMenuRaw[wrapperKey]
      : null;
  if (!Array.isArray(list)) return { updatedMenu: pitMenuRaw, changedCount: 0, matched: [] };
  let changedCount = 0;
  const matched = [];
  const getText = (o) =>
    typeof o === 'string'
      ? o.trim()
      : String(o?.text ?? o?.name ?? o?.label ?? o?.value ?? '').trim();
  const nextList = list.map((rawCat) => {
    if (!rawCat || typeof rawCat !== 'object') return rawCat;
    const cat = { ...rawCat };
    const name = String(cat.name || cat.pmcName || cat.category || '').trim();
    const opts = Array.isArray(cat.settings)
      ? cat.settings
      : Array.isArray(cat.options)
        ? cat.options
        : null;
    if (!opts || /brake/i.test(name)) return cat;
    if (/(t[iy]re)/i.test(name)) {
      const isRear = /\b(rl|rr|rear|lr|back)\b/i.test(name) || /^(rl|rr|rear)/i.test(name);
      const wantKeep =
        plan.tireAction === 'fuel_only' || (plan.tireAction === 'change_fronts' && isRear);
      const rx = wantKeep
        ? /^(no\s*change|none|keep|don'?t\s*change)/i
        : new RegExp('\\b' + plan.tireCompound + '\\b', 'i');
      const idx = opts.findIndex((o) => rx.test(getText(o)));
      if (idx >= 0) {
        matched.push(name);
        if (cat.currentSetting !== idx) {
          cat.currentSetting = idx;
          changedCount++;
        }
      }
      return cat;
    }
    if (/\b(repair|damage|body)\b/i.test(name)) {
      let idx = -1;
      if (plan.repairsRecommended) {
        idx = opts.findIndex((o) => {
          const t = getText(o);
          return !/^(do\s*not|no\s*repair|none|off)/i.test(t) && /(repair\s*all|\ball\b|full)/i.test(t);
        });
        if (idx < 0) {
          idx = opts.findIndex((o) => {
            const t = getText(o);
            return !/^(do\s*not|no\s*repair|none|off)/i.test(t) && /(body|yes|on)/i.test(t);
          });
        }
      } else {
        idx = opts.findIndex((o) => /^(do\s*not|no\s*repair|none|off)/i.test(getText(o)));
      }
      if (idx >= 0) {
        matched.push(name);
        if (cat.currentSetting !== idx) {
          cat.currentSetting = idx;
          changedCount++;
        }
      }
      return cat;
    }
    return cat;
  });
  return {
    updatedMenu: wrapperKey ? { ...pitMenuRaw, [wrapperKey]: nextList } : nextList,
    changedCount,
    matched,
  };
}

async function handlePendingPitMenuSync(cmd) {
  if (!cmd || !cmd.requestId || cmd.requestId === lastHandledPitReqId) return;
  lastHandledPitReqId = cmd.requestId;
  const base = activeLmuBase || LMU_BASES[0];
  try {
    const r = await fetch(`${base}/rest/garage/PitMenu/receivePitMenu`, {
      signal: AbortSignal.timeout(900),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const menu = await r.json();
    const res = applyTirePlanLocal(menu, cmd);
    if (res.matched.length > 0 && res.changedCount > 0) {
      const w = await fetch(`${base}/rest/garage/PitMenu/loadPitMenu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(res.updatedMenu),
        signal: AbortSignal.timeout(900),
      });
      if (!w.ok) throw new Error(`loadPitMenu HTTP ${w.status}`);
    }
    await fetch(BRIDGE_RESULT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: cmd.requestId,
        ok: true,
        appliedHeadline: cmd.pitTireCallHeadline,
        message: `Pre-selected ${cmd.pitTireCallHeadline}${cmd.repairsRecommended ? ' + Repairs ON' : ''} in LMU Pit MFD.`,
      }),
    }).catch(() => {});
  } catch (err) {
    await fetch(BRIDGE_RESULT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: cmd.requestId,
        ok: false,
        message: `LMU PitMenu unavailable: ${err?.message || String(err)}`,
      }),
    }).catch(() => {});
  }
}

function pickString(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  return undefined;
}

function pickNumber(obj, keys, fallback = 0) {
  for (const k of keys) {
    if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) return obj[k];
  }
  return fallback;
}

function detectSessionPhase(raw) {
  if (raw === null || raw === undefined) return 'unknown';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 0 && raw <= 4) return 'practice';
    if (raw >= 5 && raw <= 8) return 'qualifying';
    if (raw === 9) return 'warmup';
    if (raw >= 10 && raw <= 13) return 'race';
    return 'unknown';
  }
  const s = String(raw).trim().toUpperCase();
  if (!s) return 'unknown';
  if (/PRACTICE|TEST|HOTLAP|HOTSTINT|TIME_ATTACK|^FP[1-4]?$/.test(s)) return s.includes('SUPERPOLE') ? 'qualifying' : 'practice';
  if (/QUAL|HYPERPOLE|SUPERPOLE|SHOOTOUT|^Q[1-4]$/.test(s)) return 'qualifying';
  if (/WARM/.test(s)) return 'warmup';
  if (/RACE|FORMATION|STANDING|^GRID$|SPRINT|FEATURE/.test(s)) return 'race';
  return 'unknown';
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(700) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function pollLmuRest() {
  let sessionInfo = null;
  if (activeLmuBase) {
    sessionInfo = await fetchJson(`${activeLmuBase}/rest/watch/sessionInfo`);
    if (!sessionInfo) activeLmuBase = null;
  }
  if (!activeLmuBase) {
    for (const base of LMU_BASES) {
      sessionInfo = await fetchJson(`${base}/rest/watch/sessionInfo`);
      if (sessionInfo) {
        activeLmuBase = base;
        break;
      }
      const gs = await fetchJson(`${base}/rest/sessions/GetGameState`);
      if (gs) {
        activeLmuBase = base;
        break;
      }
    }
  }

  if (!activeLmuBase) {
    await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameRunning: false,
        connectionState: 'offline',
        source: 'none',
        telemetryQuality: 'none',
      }),
    }).catch(() => {});
    return 1800;
  }

  if (Date.now() - lastUdpMs < 1500) return 500;

  const standingsRaw = await fetchJson(`${activeLmuBase}/rest/watch/standings`);
  const vehicles = Array.isArray(standingsRaw) ? standingsRaw : standingsRaw?.standings ?? [];
  const trackName = sessionInfo?.trackName || sessionInfo?.venue || undefined;
  const rawDist = Number(sessionInfo?.lapDistance || sessionInfo?.trackLength || 0);
  const trackLengthKm = rawDist > 300 ? rawDist / 1000 : rawDist > 1 ? rawDist : undefined;
  const trackMeters = trackLengthKm ? trackLengthKm * 1000 : 5412;
  const isTruthy = (val) =>
    val === true || val === 1 || (typeof val === 'string' && /^(true|1|yes)$/i.test(val.trim()));
  let player =
    vehicles.find(
      (v) =>
        isTruthy(v.player) ||
        isTruthy(v.isPlayer) ||
        isTruthy(v.localPlayer) ||
        /^(PLAYER|HUMAN|LOCAL)$/i.test(String(v.controlType ?? v.control ?? '').trim())
    ) ||
    (vehicles.length === 1 ? vehicles[0] : null) ||
    vehicles.find((v) => isTruthy(v.focus)) ||
    null;

  const rawSession =
    sessionInfo?.session ?? sessionInfo?.sessionType ?? sessionInfo?.sessionName ?? null;
  const sessionType = detectSessionPhase(rawSession);

  if (!player) {
    const [garageOverview, gameState] = await Promise.all([
      fetchJson(`${activeLmuBase}/rest/garage/UIScreen/CarSetupOverview`),
      fetchJson(`${activeLmuBase}/rest/sessions/GetGameState`),
    ]);
    const menuRawSession =
      rawSession ?? gameState?.session ?? gameState?.sessionType ?? gameState?.currentSession ?? null;
    const menuSessionType = detectSessionPhase(menuRawSession);
    const garageCar =
      garageOverview?.carName ||
      garageOverview?.vehicleName ||
      garageOverview?.carSetup?.carName ||
      null;
    const gamePhase = String(
      gameState?.gamePhase || gameState?.state || sessionInfo?.gamePhase || ''
    ).toUpperCase();
    const inGarageScreen = Boolean(
      garageCar ||
        garageOverview?.inGarage ||
        (trackName && gamePhase && !gamePhase.includes('MENU'))
    );

    const stResp = await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameRunning: true,
        simId: 'lmu',
        gameName: 'Le Mans Ultimate',
        connectionState: inGarageScreen ? 'in_pit' : 'menus',
        sessionType: menuSessionType,
        rawSessionName: menuRawSession ? String(menuRawSession) : null,
        source: 'lmu-rest',
        telemetryQuality: 'partial_rest',
        rawTrackName: trackName || null,
        rawCarName: garageCar,
        note: inGarageScreen
          ? 'LMU Garage screen active — waiting to exit pit lane.'
          : 'LMU WebUI :6397 active — game open in menus.',
      }),
    }).catch(() => null);
    if (stResp?.ok) {
      const stJson = await stResp.json().catch(() => null);
      if (stJson?.pendingPitMenuSync) await handlePendingPitMenuSync(stJson.pendingPitMenuSync);
    }
    return 900;
  }

  const now = Date.now();
  let speedKmh = 0;
  if (typeof player.speedKmh === 'number') speedKmh = player.speedKmh;
  else if (player.carVelocity) {
    speedKmh =
      Math.hypot(
        Number(player.carVelocity.x || 0),
        Number(player.carVelocity.y || 0),
        Number(player.carVelocity.z || 0)
      ) * 3.6;
  }
  speedKmh = Math.max(0, Math.min(400, Math.round(speedKmh * 10) / 10));
  const dt = lastSpeedMs > 0 ? Math.max(0.08, (now - lastSpeedMs) / 1000) : 0.25;
  const longG = Math.max(-4, Math.min(2.5, (speedKmh - lastSpeedKmh) / 3.6 / (dt * 9.81)));
  lastSpeedKmh = speedKmh;
  lastSpeedMs = now;

  const rawLapDist = Number(player.lapDistance || player.lapDist || 0);
  const lapDistPct =
    trackMeters > 0 ? (((rawLapDist % trackMeters) + trackMeters) % trackMeters) / trackMeters : 0;
  const carName = [player.vehicleName, player.carType, player.fullTeamName, player.carName]
    .filter(Boolean)
    .join(' ');
  const pitStateStr = typeof player.pitState === 'string' ? player.pitState.trim().toUpperCase() : '';
  const explicitPitStates = new Set([
    'IN_PITS',
    'IN_GARAGE',
    'GARAGE',
    'PITTING',
    'PIT_LANE',
    'PIT',
    'ENTERING',
    'EXITING',
    'STOPPED',
    'REQUESTED',
    'SERVING',
  ]);
  const isPaused =
    String(sessionInfo?.gamePhase || '').toUpperCase().includes('PAUSE') ||
    isTruthy(sessionInfo?.paused) ||
    isTruthy(sessionInfo?.isPaused);
  const inPitOrGarage = Boolean(
    isTruthy(player.inGarageStall) ||
      isTruthy(player.inGarage) ||
      isTruthy(player.inPits) ||
      isTruthy(player.pitting) ||
      (pitStateStr && explicitPitStates.has(pitStateStr)) ||
      isPaused ||
      (speedKmh < 1.2 && player.focus === false)
  );

  const pVelLen = player.carVelocity ? Math.hypot(Number(player.carVelocity.x || 0), Number(player.carVelocity.z || 0)) : 0;
  const fx = pVelLen > 2 ? Number(player.carVelocity.x || 0) / pVelLen : 0;
  const fz = pVelLen > 2 ? Number(player.carVelocity.z || 0) / pVelLen : 0;
  const mappedOpponents = vehicles
    .filter((v) => v !== player)
    .map((v, idx) => {
      const oppDist = Number(v.lapDistance || v.lapDist || 0);
      const oppPct = trackMeters > 0 ? (((oppDist % trackMeters) + trackMeters) % trackMeters) / trackMeters : 0;
      let diffPct = oppPct - lapDistPct;
      if (diffPct > 0.5) diffPct -= 1;
      if (diffPct < -0.5) diffPct += 1;
      const distM = diffPct * trackMeters;
      let oppSpeed = 0;
      if (v.carVelocity) {
        oppSpeed = Math.hypot(Number(v.carVelocity.x || 0), Number(v.carVelocity.y || 0), Number(v.carVelocity.z || 0)) * 3.6;
      }
      let lateralSide = 'center';
      if (player.carPosition && v.carPosition && pVelLen > 2) {
        const dx = Number(v.carPosition.x || 0) - Number(player.carPosition.x || 0);
        const dz = Number(v.carPosition.z || 0) - Number(player.carPosition.z || 0);
        const lateralLeftM = -fz * dx + fx * dz;
        if (Math.abs(lateralLeftM) >= 1.1) lateralSide = lateralLeftM > 0 ? 'left' : 'right';
      }
      const oppInPits = Boolean(v.inGarageStall || v.inPits || v.pitting);
      const oppPosX = v.carPosition ? Number(v.carPosition.x || 0) : 0;
      const oppPosZ = v.carPosition ? Number(v.carPosition.z || 0) : 0;
      const hasOppWorldPos = Boolean(v.carPosition) && Number.isFinite(oppPosX) && Number.isFinite(oppPosZ) && (oppPosX !== 0 || oppPosZ !== 0);
      const oppPlace = Number(v.position ?? v.place ?? 0);
      const oppLaps = Number(v.lapsCompleted ?? v.totalLaps ?? -1);
      const oppSector = oppPct < 1 / 3 ? 1 : oppPct < 2 / 3 ? 2 : 3;
      return {
        oppInPits,
        id: `lmu-opp-${v.slotID ?? idx}`,
        carNumber: String(v.carNumber ?? (idx + 1)),
        driverName: String(v.driverName || 'Driver'),
        carClass: /lmp2|oreca/i.test(String(v.carClass || v.vehicleClass || ''))
          ? 'LMP2'
          : /gt3|gte/i.test(String(v.carClass || v.vehicleClass || ''))
            ? 'LMGT3'
            : 'Hypercar',
        carName: String(v.vehicleName || v.carType || v.fullTeamName || 'Opponent'),
        lapDistPct: oppPct,
        speedKmh: Math.round(oppSpeed),
        gapSeconds: Math.round((distM / Math.max(25, speedKmh / 3.6)) * 10) / 10,
        distanceMeters: Math.round(distM),
        closingSpeedKmh: Math.round(distM < 0 ? Math.max(0, oppSpeed - speedKmh) : Math.max(0, speedKmh - oppSpeed)),
        lateralSide,
        isAlongside: Math.abs(distM) <= 6.5 && !oppInPits,
        safetyRating: 'clean',
        inPits: oppInPits,
        sector: oppSector,
        ...(Number.isFinite(oppPlace) && oppPlace > 0 ? { position: oppPlace } : {}),
        ...(Number.isFinite(oppLaps) && oppLaps >= 0 ? { lapsCompleted: oppLaps } : {}),
        ...(hasOppWorldPos
          ? { posX: Math.round(oppPosX * 100) / 100, posZ: Math.round(oppPosZ * 100) / 100 }
          : {}),
      };
    });
  const stoppedAheadCar = mappedOpponents
    .filter((o) => !o.oppInPits && o.distanceMeters >= 8 && o.distanceMeters <= 340 && o.speedKmh < 45 && speedKmh >= 60)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  const rawPhase = sessionInfo?.gamePhase;
  const gamePhaseStr = String(rawPhase ?? '').toUpperCase();
  const yellowState = String(sessionInfo?.yellowFlagState || gamePhaseStr).toUpperCase();
  const yellowActive = yellowState.includes('YELLOW') || Boolean(stoppedAheadCar);
  const rawPlayerFlag = String(player.flag ?? player.flagState ?? '').toUpperCase();
  const blueActive =
    rawPlayerFlag.includes('BLUE') ||
    rawPlayerFlag === '6' ||
    isTruthy(player.underBlueFlag) ||
    isTruthy(player.blueFlag);
  const inFormationLap =
    rawPhase === 3 ||
    rawPhase === 4 ||
    yellowState.includes('FORMATION') ||
    gamePhaseStr.includes('FORMATION') ||
    gamePhaseStr.includes('COUNTDOWN');
  const penaltyActive =
    (typeof player.numPenalties === 'number' && player.numPenalties > 0) ||
    isTruthy(player.penaltyActive);
  const lapInvalidated = Boolean(
    player.lapInvalidated || player.currentLapInvalid || player.currentLapValid === false
  );
  const rawVe =
    typeof player.virtualEnergy === 'number'
      ? player.virtualEnergy
      : typeof player.virtualEnergyFraction === 'number'
        ? player.virtualEnergyFraction
        : typeof player.energyFraction === 'number'
          ? player.energyFraction
          : undefined;
  const virtualEnergyPct =
    typeof rawVe === 'number' && Number.isFinite(rawVe) && rawVe >= 0
      ? Math.max(0, Math.min(100, Math.round((rawVe <= 1.05 ? rawVe * 100 : rawVe) * 10) / 10))
      : undefined;

  const ingResp = await fetch(TARGET_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestampMs: now,
      simId: 'lmu',
      trackName,
      ...(trackLengthKm ? { trackLengthKm } : {}),
      carName,
      carClass: player.carClass || player.vehicleClass,
      sessionType,
      ...(rawSession ? { rawSessionName: String(rawSession) } : {}),
      lapNumber: Math.max(1, Number(player.lapsCompleted || 0) + 1),
      lapDistPct,
      speedKmh,
      rpm: speedKmh < 4 ? 1150 : Math.min(8200, Math.round(2800 + (speedKmh % 52) * 95)),
      maxRpm: 8500,
      gear:
        speedKmh < 5
          ? 0
          : speedKmh < 82
            ? 1
            : speedKmh < 128
              ? 2
              : speedKmh < 174
                ? 3
                : speedKmh < 218
                  ? 4
                  : speedKmh < 264
                    ? 5
                    : 6,
      throttle: longG > 0.12 ? Math.min(1, longG * 1.4) : speedKmh > 15 ? 0.5 : 0,
      brake: longG < -0.25 ? Math.min(1, Math.abs(longG) / 2.2) : 0,
      clutch: 0,
      steeringRad: 0,
      latG: 0,
      longG: Math.round(longG * 100) / 100,
      deltaSec: 0,
      fuelLiters:
        typeof player.fuel === 'number' && player.fuel > 0
          ? player.fuel
          : typeof player.fuelFraction === 'number'
            ? Math.round(player.fuelFraction * 1000) / 10
            : 50,
      ...(virtualEnergyPct !== undefined ? { virtualEnergyPct } : {}),
      ...(inFormationLap ? { inFormationLap: true } : {}),
      ...(penaltyActive ? { penaltyActive: true } : {}),
      ...(lapInvalidated ? { lapInvalidated: true } : {}),
      tireTempC: { fl: 84, fr: 84, rl: 82, rr: 82 },
      tirePressurePsi: { fl: 26.4, fr: 26.4, rl: 26.1, rr: 26.1 },
      tireWearPct: { fl: 98, fr: 98, rl: 98, rr: 98 },
      brakeTempC: { fl: 440, fr: 440, rl: 370, rr: 370 },
      frontWheelSlip: 0,
      rearWheelSlip: 0,
      absActive: false,
      tcActive: false,
      offTrackRisk: 0,
      hazardAhead: yellowActive,
      hazardDistanceM: stoppedAheadCar ? stoppedAheadCar.distanceMeters : yellowActive ? 180 : 999,
      hazardDescription: stoppedAheadCar
        ? `Slow or stopped #${stoppedAheadCar.carNumber} (${stoppedAheadCar.speedKmh} km/h) on track.`
        : yellowActive
          ? 'Yellow flag sector active.'
          : '',
      flagState: yellowActive ? 'yellow' : blueActive ? 'blue' : 'green',
      inPitOrGarage,
      isPaused,
      opponents: mappedOpponents
        .map(({ oppInPits: _ignored, ...rest }) => rest)
        .sort((a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters))
        .slice(0, 48),
      telemetrySource: 'lmu-rest',
      sensorCaps: { pedals: false, tires: false, brakes: false, rpmGear: false },
    }),
  }).catch(() => null);
  if (ingResp?.ok) {
    const ingJson = await ingResp.json().catch(() => null);
    if (ingJson?.pendingPitMenuSync) await handlePendingPitMenuSync(ingJson.pendingPitMenuSync);
  }

  return 220;
}

const runPoll = async () => {
  const delay = await pollLmuRest();
  setTimeout(runPoll, delay);
};
runPoll();

socket.on('message', async (msg) => {
  const now = Date.now();
  if (now - lastSentMs < 100) return;
  lastSentMs = now;
  lastUdpMs = now;

  try {
    const parsed = JSON.parse(msg.toString('utf8'));

    const trackName = pickString(parsed, ['trackName', 'TrackName', 'mTrackName', 'circuit', 'track']);
    const carName = pickString(parsed, ['carName', 'CarName', 'mVehicleName', 'vehicleName', 'car', 'carModel']);
    const carClass = pickString(parsed, ['carClass', 'CarClass', 'mVehicleClass', 'vehicleClass']);
    const simId = pickString(parsed, ['simId', 'simName', 'game', 'GameName']) || 'lmu';
    const rawTrackMeters = pickNumber(parsed, ['mLapDist', 'trackLengthM', 'TrackLength'], 0);
    const trackLengthKm = pickNumber(parsed, ['trackLengthKm'], rawTrackMeters > 100 ? rawTrackMeters / 1000 : 0);

    const throttle = pickNumber(parsed, ['throttle', 'mFilteredThrottle', 'mUnfilteredThrottle', 'Throttle'], 0);
    const brake = pickNumber(parsed, ['brake', 'mFilteredBrake', 'mUnfilteredBrake', 'Brake'], 0);
    const clutch = pickNumber(parsed, ['clutch', 'mFilteredClutch', 'mUnfilteredClutch', 'Clutch'], 0);
    const steeringRad = pickNumber(parsed, ['steeringRad', 'mFilteredSteering', 'mUnfilteredSteering', 'Steering'], 0);

    await fetch(TARGET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestampMs: now,
        simId,
        trackName,
        trackLengthKm: trackLengthKm > 0 ? trackLengthKm : undefined,
        carName,
        carClass,
        sessionType: detectSessionPhase(parsed.sessionType ?? parsed.session ?? parsed.sessionName ?? parsed.mSession),
        lapNumber: pickNumber(parsed, ['lapNumber', 'mTotalLaps', 'Lap'], 1),
        lapDistPct: pickNumber(parsed, ['lapDistPct', 'LapDistPct', 'mLapDistPct'], 0),
        speedKmh: pickNumber(parsed, ['speedKmh', 'SpeedKmh', 'speed'], 0),
        rpm: pickNumber(parsed, ['rpm', 'mEngineRPM', 'Rpms'], 0),
        maxRpm: pickNumber(parsed, ['maxRpm', 'mEngineMaxRPM', 'MaxRpms'], 8500),
        gear: pickNumber(parsed, ['gear', 'mGear', 'Gear'], 1),
        throttle: throttle > 1 ? throttle / 100 : throttle,
        brake: brake > 1 ? brake / 100 : brake,
        clutch: clutch > 1 ? clutch / 100 : clutch,
        steeringRad,
        latG: pickNumber(parsed, ['latG', 'LatG'], 0),
        longG: pickNumber(parsed, ['longG', 'LongG'], 0),
        deltaSec: pickNumber(parsed, ['deltaSec', 'DeltaSec'], 0),
        fuelLiters: pickNumber(parsed, ['fuelLiters', 'mFuel', 'Fuel'], 50),
        tireTempC: parsed.tireTempC ?? { fl: 85, fr: 85, rl: 83, rr: 83 },
        tirePressurePsi: parsed.tirePressurePsi ?? { fl: 26.5, fr: 26.5, rl: 26.2, rr: 26.2 },
        tireWearPct: parsed.tireWearPct ?? { fl: 98, fr: 98, rl: 98, rr: 98 },
        brakeTempC: parsed.brakeTempC ?? { fl: 450, fr: 450, rl: 380, rr: 380 },
        frontWheelSlip: pickNumber(parsed, ['frontWheelSlip'], 0),
        rearWheelSlip: pickNumber(parsed, ['rearWheelSlip'], 0),
        absActive: Boolean(parsed.absActive),
        tcActive: Boolean(parsed.tcActive),
        offTrackRisk: pickNumber(parsed, ['offTrackRisk'], 0),
        hazardAhead: Boolean(parsed.hazardAhead),
        hazardDistanceM: pickNumber(parsed, ['hazardDistanceM'], 999),
        hazardDescription: parsed.hazardDescription ?? '',
        flagState: parsed.flagState ?? 'green',
        telemetrySource: 'udp-5606',
        sensorCaps: { pedals: true, tires: true, brakes: true, rpmGear: true },
        ...(Array.isArray(parsed.opponents) ? { opponents: parsed.opponents } : {}),
      }),
    });
  } catch (err) {
    console.error('Telemetry packet parse/forward error:', err instanceof Error ? err.message : String(err));
  }
});

socket.on('listening', () => {
  console.log(`ApexEngineer Bridge active (LMU :6397 REST + UDP :${UDP_PORT}) -> ${TARGET_ENDPOINT}`);
});

socket.bind(UDP_PORT);
