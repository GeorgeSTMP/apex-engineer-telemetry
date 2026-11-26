import { parseLmuNumericSession } from './sessionPhase.ts';
import type { OpponentCar, SimGameId, SimSessionType, TelemetryFrame } from '../types/telemetry.ts';

/**
 * Verified 4-byte packed (#pragma pack(4)) binary layout constants for:
 * 1) Le Mans Ultimate native shared memory (`LMU_Data`, LMUObjectOut = 324,820 bytes)
 * 2) rFactor 2 / Legacy LMU SharedMemoryMapPlugin (`$rFactor2SMMP_Telemetry$` = 241,680 bytes, `$rFactor2SMMP_Scoring$` = 75,312 bytes)
 */
export const LMU_SHM_LAYOUT = {
  TOTAL_SIZE: 324820,
  MAX_VEHICLES: 104,
  SCORING_OFFSET: 1632,
  SCORING_INFO_OFFSET: 1632,
  VEH_SCORING_OFFSET: 2192, // 1632 + 560
  TELEMETRY_OFFSET: 128464,
  TELEM_ACTIVE_VEHICLES_OFFSET: 128464,
  TELEM_PLAYER_IDX_OFFSET: 128465,
  TELEM_PLAYER_HAS_VEH_OFFSET: 128466,
  TELEM_INFO_OFFSET: 128468, // 128464 + 4
} as const;

export const RF2_SHM_LAYOUT = {
  TELEMETRY_TOTAL_SIZE: 241680,
  SCORING_TOTAL_SIZE: 75312,
  MAX_VEHICLES: 128,
  TELEM_VER_BEGIN_OFFSET: 0,
  TELEM_VER_END_OFFSET: 4,
  TELEM_NUM_VEHICLES_OFFSET: 12,
  TELEM_VEHICLES_OFFSET: 16,
  SCORING_VER_BEGIN_OFFSET: 0,
  SCORING_VER_END_OFFSET: 4,
  SCORING_INFO_OFFSET: 12,
  VEH_SCORING_OFFSET: 560,
} as const;

export const RF2_COMMON_STRUCTS = {
  SCORING_INFO_SIZE: 548,
  SCOR_TRACK_NAME_OFF: 0,
  SCOR_SESSION_OFF: 64,
  SCOR_CURRENT_ET_OFF: 68,
  SCOR_LAP_DIST_OFF: 88,
  SCOR_NUM_VEHICLES_OFF: 104,
  SCOR_GAME_PHASE_OFF: 108,
  SCOR_YELLOW_FLAG_OFF: 109,
  SCOR_SECTOR_FLAG_OFF: 110, // 3 bytes
  SCOR_IN_REALTIME_OFF: 115,

  VEH_SCOR_SIZE: 584,
  VSCOR_ID_OFF: 0,
  VSCOR_DRIVER_NAME_OFF: 4,
  VSCOR_VEHICLE_NAME_OFF: 36,
  VSCOR_TOTAL_LAPS_OFF: 100,
  VSCOR_FINISH_STATUS_OFF: 103,
  VSCOR_LAP_DIST_OFF: 104,
  VSCOR_NUM_PENALTIES_OFF: 194,
  VSCOR_IS_PLAYER_OFF: 196,
  VSCOR_CONTROL_OFF: 197,
  VSCOR_IN_PITS_OFF: 198,
  VSCOR_PLACE_OFF: 199,
  VSCOR_VEHICLE_CLASS_OFF: 200,
  VSCOR_POS_OFF: 264, // 3x double
  VSCOR_LOCAL_VEL_OFF: 288, // 3x double
  VSCOR_ORI_OFF: 336, // 9x double
  VSCOR_PIT_STATE_OFF: 457,
  VSCOR_FLAG_OFF: 504,
  VSCOR_IN_GARAGE_STALL_OFF: 507,

  VEH_TELEM_SIZE: 1888,
  VTELEM_ID_OFF: 0,
  VTELEM_LAP_NUMBER_OFF: 20,
  VTELEM_VEHICLE_NAME_OFF: 32,
  VTELEM_TRACK_NAME_OFF: 96,
  VTELEM_POS_OFF: 160,
  VTELEM_LOCAL_VEL_OFF: 184, // 3x double
  VTELEM_LOCAL_ACCEL_OFF: 208, // 3x double
  VTELEM_ORI_OFF: 232, // 9x double
  VTELEM_GEAR_OFF: 352, // int32
  VTELEM_RPM_OFF: 356, // double
  VTELEM_UNFILTERED_THROTTLE_OFF: 388,
  VTELEM_UNFILTERED_BRAKE_OFF: 396,
  VTELEM_UNFILTERED_STEER_OFF: 404,
  VTELEM_UNFILTERED_CLUTCH_OFF: 412,
  VTELEM_FUEL_OFF: 524,
  VTELEM_MAX_RPM_OFF: 532,
  VTELEM_DELTA_BEST_OFF: 696,
  VTELEM_LAP_INVALIDATED_OFF: 745,
  VTELEM_ABS_ACTIVE_OFF: 746,
  VTELEM_TC_ACTIVE_OFF: 747,
  VTELEM_VIRTUAL_ENERGY_OFF: 776, // float32
  VTELEM_VEHICLE_MODEL_OFF: 796, // 30 bytes
  VTELEM_WHEELS_OFF: 848, // 4 * 260 bytes

  WHEEL_SIZE: 260,
  WHEEL_BRAKE_TEMP_OFF: 24,
  WHEEL_LAT_PATCH_VEL_OFF: 48,
  WHEEL_LONG_PATCH_VEL_OFF: 56,
  WHEEL_LAT_GROUND_VEL_OFF: 64,
  WHEEL_LONG_GROUND_VEL_OFF: 72,
  WHEEL_GRIP_FRACT_OFF: 112,
  WHEEL_PRESSURE_KPA_OFF: 120,
  WHEEL_TEMP_ICO_OFF: 128, // 3x double (Kelvin)
  WHEEL_WEAR_OFF: 152, // double (0..1)
  WHEEL_SURFACE_TYPE_OFF: 176, // uint8 (2..4 = off-road)
  WHEEL_FLAT_OFF: 177,
  WHEEL_DETACHED_OFF: 178,
} as const;

export function kelvinToCelsius(kelvin: number, fallback = 82): number {
  if (!Number.isFinite(kelvin) || kelvin <= 100) return fallback;
  return Math.round((kelvin - 273.15) * 10) / 10;
}

export function kpaToPsi(kpa: number, fallback = 26.2): number {
  if (!Number.isFinite(kpa) || kpa <= 0) return fallback;
  return Math.round(kpa * 0.1450377377 * 10) / 10;
}

export function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

export function normalizeLmuClass(raw?: string): 'Hypercar' | 'LMP2' | 'LMGT3' {
  const s = String(raw || '').toLowerCase();
  if (s.includes('lmp2') || s.includes('oreca')) return 'LMP2';
  if (s.includes('gt3') || s.includes('gte') || s.includes('lmgt3')) return 'LMGT3';
  return 'Hypercar';
}

export function computeWheelSlipFraction(
  gripFract: number,
  latPatchVel: number,
  longPatchVel: number,
  latGroundVel: number,
  longGroundVel: number,
  speedKmh: number
): number {
  if (!Number.isFinite(speedKmh) || speedKmh < 12) return 0;
  const patchVel = Math.hypot(
    Number.isFinite(latPatchVel) ? latPatchVel : 0,
    Number.isFinite(longPatchVel) ? longPatchVel : 0
  );
  const groundVel = Math.max(
    10,
    Math.hypot(
      Number.isFinite(latGroundVel) ? latGroundVel : 0,
      Number.isFinite(longGroundVel) ? longGroundVel : 0
    )
  );
  const ratioSlip = clamp01(patchVel / groundVel);
  const gripSlip = Number.isFinite(gripFract) && gripFract >= 0 && gripFract <= 1 ? gripFract : 0;
  return Math.round(Math.max(ratioSlip, gripSlip) * 1000) / 1000;
}

export function compute3dLateralSide(
  playerPos: { x: number; y: number; z: number },
  playerOriRow0: { x: number; y: number; z: number },
  playerOriRow1: { x: number; y: number; z: number },
  playerOriRow2: { x: number; y: number; z: number },
  oppPos: { x: number; y: number; z: number }
): 'left' | 'right' | 'center' {
  const dx = oppPos.x - playerPos.x;
  const dy = oppPos.y - playerPos.y;
  const dz = oppPos.z - playerPos.z;
  // In rF2/LMU local basis, +X points Left; column 0 of mOri transforms world delta into local Left
  const localLeftM = dx * playerOriRow0.x + dy * playerOriRow1.x + dz * playerOriRow2.x;
  if (!Number.isFinite(localLeftM) || Math.abs(localLeftM) < 1.1) return 'center';
  return localLeftM > 0 ? 'left' : 'right';
}

function readAsciiCString(view: DataView, offset: number, maxLen: number): string {
  let out = '';
  const end = Math.min(view.byteLength, offset + maxLen);
  for (let i = offset; i < end; i++) {
    const code = view.getUint8(i);
    if (code === 0) break;
    if (code >= 32 && code <= 126) {
      out += String.fromCharCode(code);
    }
  }
  return out.trim();
}

function readF64(view: DataView, offset: number, fallback = 0): number {
  if (offset + 8 > view.byteLength) return fallback;
  const v = view.getFloat64(offset, true);
  return Number.isFinite(v) ? v : fallback;
}

function readF32(view: DataView, offset: number, fallback = 0): number {
  if (offset + 4 > view.byteLength) return fallback;
  const v = view.getFloat32(offset, true);
  return Number.isFinite(v) ? v : fallback;
}

function readI32(view: DataView, offset: number, fallback = 0): number {
  if (offset + 4 > view.byteLength) return fallback;
  return view.getInt32(offset, true);
}

function readI16(view: DataView, offset: number, fallback = 0): number {
  if (offset + 2 > view.byteLength) return fallback;
  return view.getInt16(offset, true);
}

function readU8(view: DataView, offset: number, fallback = 0): number {
  if (offset + 1 > view.byteLength) return fallback;
  return view.getUint8(offset);
}

function readI8(view: DataView, offset: number, fallback = 0): number {
  if (offset + 1 > view.byteLength) return fallback;
  return view.getInt8(offset);
}

interface ParsedWheel {
  tempC: number;
  pressurePsi: number;
  wearPct: number;
  brakeTempC: number;
  slip: number;
  offRoad: boolean;
  flat: boolean;
  detached: boolean;
}

function parseWheelBlock(view: DataView, wBase: number, speedKmh: number): ParsedWheel {
  const C = RF2_COMMON_STRUCTS;
  const t0 = readF64(view, wBase + C.WHEEL_TEMP_ICO_OFF, 355.15);
  const t1 = readF64(view, wBase + C.WHEEL_TEMP_ICO_OFF + 8, 355.15);
  const t2 = readF64(view, wBase + C.WHEEL_TEMP_ICO_OFF + 16, 355.15);
  const avgTempK = (t0 + t1 + t2) / 3;

  const pressureKpa = readF64(view, wBase + C.WHEEL_PRESSURE_KPA_OFF, 180);
  const wear = readF64(view, wBase + C.WHEEL_WEAR_OFF, 1);
  const brakeTempK = readF64(view, wBase + C.WHEEL_BRAKE_TEMP_OFF, 690);
  const gripFract = readF64(view, wBase + C.WHEEL_GRIP_FRACT_OFF, 0);
  const latPatch = readF64(view, wBase + C.WHEEL_LAT_PATCH_VEL_OFF, 0);
  const longPatch = readF64(view, wBase + C.WHEEL_LONG_PATCH_VEL_OFF, 0);
  const latGround = readF64(view, wBase + C.WHEEL_LAT_GROUND_VEL_OFF, 0);
  const longGround = readF64(view, wBase + C.WHEEL_LONG_GROUND_VEL_OFF, 0);
  const surfaceType = readU8(view, wBase + C.WHEEL_SURFACE_TYPE_OFF, 0);
  const flat = readU8(view, wBase + C.WHEEL_FLAT_OFF, 0) === 1;
  const detached = readU8(view, wBase + C.WHEEL_DETACHED_OFF, 0) === 1;

  return {
    tempC: kelvinToCelsius(avgTempK, 82),
    pressurePsi: kpaToPsi(pressureKpa, 26.2),
    wearPct:
      Number.isFinite(wear) && wear >= 0 && wear <= 1.05
        ? Math.round(Math.max(0, Math.min(100, wear * 100)) * 10) / 10
        : 98,
    brakeTempC: Math.max(20, Math.round(kelvinToCelsius(brakeTempK, 420))),
    slip: computeWheelSlipFraction(gripFract, latPatch, longPatch, latGround, longGround, speedKmh),
    offRoad: surfaceType >= 2 && surfaceType <= 4,
    flat,
    detached,
  };
}

export interface ParsedShmResult {
  active: boolean;
  frame?: TelemetryFrame;
  sessionType: SimSessionType;
  rawSessionName: string | null;
}

function parseVehicleAndScoringCore(params: {
  simId: SimGameId;
  telemView: DataView;
  telemCount: number;
  telemArrayOffset: number;
  playerTelemIdxHint: number | null;
  playerHasVehicleHint: boolean | null;
  scorView: DataView;
  scorInfoOffset: number;
  vehScorArrayOffset: number;
  maxVehicles: number;
  timestampMs: number;
}): ParsedShmResult {
  const C = RF2_COMMON_STRUCTS;
  const {
    simId,
    telemView,
    telemCount,
    telemArrayOffset,
    playerTelemIdxHint,
    playerHasVehicleHint,
    scorView,
    scorInfoOffset,
    vehScorArrayOffset,
    maxVehicles,
    timestampMs,
  } = params;

  const trackName = readAsciiCString(scorView, scorInfoOffset + C.SCOR_TRACK_NAME_OFF, 64);
  const sessionCode = readI32(scorView, scorInfoOffset + C.SCOR_SESSION_OFF, -1);
  const trackDistM = readF64(scorView, scorInfoOffset + C.SCOR_LAP_DIST_OFF, 0);
  const numScorVehicles = Math.min(
    maxVehicles,
    Math.max(0, readI32(scorView, scorInfoOffset + C.SCOR_NUM_VEHICLES_OFF, 0))
  );
  const gamePhase = readU8(scorView, scorInfoOffset + C.SCOR_GAME_PHASE_OFF, 0);
  const yellowFlagState = readI8(scorView, scorInfoOffset + C.SCOR_YELLOW_FLAG_OFF, 0);
  const secFlag0 = readI8(scorView, scorInfoOffset + C.SCOR_SECTOR_FLAG_OFF, 0);
  const secFlag1 = readI8(scorView, scorInfoOffset + C.SCOR_SECTOR_FLAG_OFF + 1, 0);
  const secFlag2 = readI8(scorView, scorInfoOffset + C.SCOR_SECTOR_FLAG_OFF + 2, 0);
  const inRealtime = readU8(scorView, scorInfoOffset + C.SCOR_IN_REALTIME_OFF, 0) === 1;

  let sessionType = parseLmuNumericSession(sessionCode);
  let rawSessionName: string | null =
    sessionCode >= 0 ? String(sessionCode) : null;
  if (sessionType === 'unknown' && gamePhase >= 1 && gamePhase <= 4) {
    sessionType = 'race';
    rawSessionName = 'FORMATION';
  }

  const safeTelemCount = Math.min(maxVehicles, Math.max(0, telemCount));
  if (safeTelemCount === 0 || numScorVehicles === 0) {
    return { active: false, sessionType, rawSessionName };
  }

  if (playerHasVehicleHint === false && numScorVehicles > 1) {
    return { active: false, sessionType, rawSessionName };
  }

  // Locate player in Scoring array
  let playerScorIdx = -1;
  for (let i = 0; i < numScorVehicles; i++) {
    const sBase = vehScorArrayOffset + i * C.VEH_SCOR_SIZE;
    const isPlayer = readU8(scorView, sBase + C.VSCOR_IS_PLAYER_OFF, 0) === 1;
    const control = readI8(scorView, sBase + C.VSCOR_CONTROL_OFF, -1);
    if (isPlayer || control === 0) {
      playerScorIdx = i;
      break;
    }
  }
  if (playerScorIdx < 0 && numScorVehicles === 1) {
    playerScorIdx = 0;
  }
  if (playerScorIdx < 0) {
    return { active: false, sessionType, rawSessionName };
  }

  const pScorBase = vehScorArrayOffset + playerScorIdx * C.VEH_SCOR_SIZE;
  const playerId = readI32(scorView, pScorBase + C.VSCOR_ID_OFF, -1);

  // Locate player in Telemetry array
  let playerTelemIdx = -1;
  if (
    playerTelemIdxHint !== null &&
    playerTelemIdxHint >= 0 &&
    playerTelemIdxHint < safeTelemCount
  ) {
    const hintBase = telemArrayOffset + playerTelemIdxHint * C.VEH_TELEM_SIZE;
    const hintId = readI32(telemView, hintBase + C.VTELEM_ID_OFF, -1);
    if (hintId === playerId || playerId < 0) {
      playerTelemIdx = playerTelemIdxHint;
    }
  }
  if (playerTelemIdx < 0) {
    for (let i = 0; i < safeTelemCount; i++) {
      const tBase = telemArrayOffset + i * C.VEH_TELEM_SIZE;
      if (readI32(telemView, tBase + C.VTELEM_ID_OFF, -2) === playerId) {
        playerTelemIdx = i;
        break;
      }
    }
  }
  if (playerTelemIdx < 0 && safeTelemCount === 1) {
    playerTelemIdx = 0;
  }
  if (playerTelemIdx < 0) {
    return { active: false, sessionType, rawSessionName };
  }

  const tBase = telemArrayOffset + playerTelemIdx * C.VEH_TELEM_SIZE;

  const vx = readF64(telemView, tBase + C.VTELEM_LOCAL_VEL_OFF, 0);
  const vy = readF64(telemView, tBase + C.VTELEM_LOCAL_VEL_OFF + 8, 0);
  const vz = readF64(telemView, tBase + C.VTELEM_LOCAL_VEL_OFF + 16, 0);
  const speedKmh = Math.max(0, Math.min(420, Math.round(Math.hypot(vx, vy, vz) * 3.6 * 10) / 10));

  const ax = readF64(telemView, tBase + C.VTELEM_LOCAL_ACCEL_OFF, 0);
  const az = readF64(telemView, tBase + C.VTELEM_LOCAL_ACCEL_OFF + 16, 0);
  const latG = Math.round((ax / 9.80665) * 100) / 100;
  const longG = Math.round((-az / 9.80665) * 100) / 100;

  const gearRaw = readI32(telemView, tBase + C.VTELEM_GEAR_OFF, 0);
  const gear = gearRaw <= 0 ? 0 : gearRaw;
  const rpm = Math.max(0, Math.round(readF64(telemView, tBase + C.VTELEM_RPM_OFF, 1100)));
  const rawMaxRpm = readF64(telemView, tBase + C.VTELEM_MAX_RPM_OFF, 8500);
  const maxRpm = rawMaxRpm > 2000 && rawMaxRpm < 25000 ? Math.round(rawMaxRpm) : 8500;

  const throttle = clamp01(readF64(telemView, tBase + C.VTELEM_UNFILTERED_THROTTLE_OFF, 0));
  const brake = clamp01(readF64(telemView, tBase + C.VTELEM_UNFILTERED_BRAKE_OFF, 0));
  const steerNorm = Math.max(-1, Math.min(1, readF64(telemView, tBase + C.VTELEM_UNFILTERED_STEER_OFF, 0)));
  const steeringRad = Math.round(steerNorm * 0.55 * 1000) / 1000;
  const clutch = clamp01(readF64(telemView, tBase + C.VTELEM_UNFILTERED_CLUTCH_OFF, 0));
  const fuelLiters = Math.max(0, Math.round(readF64(telemView, tBase + C.VTELEM_FUEL_OFF, 50) * 100) / 100);
  const rawDeltaBest = readF64(telemView, tBase + C.VTELEM_DELTA_BEST_OFF, 0);
  const deltaSec =
    Number.isFinite(rawDeltaBest) && Math.abs(rawDeltaBest) < 60
      ? Math.round(rawDeltaBest * 1000) / 1000
      : 0;

  const lapCompletedTelem = readI32(telemView, tBase + C.VTELEM_LAP_NUMBER_OFF, 0);
  const lapCompletedScor = readI16(scorView, pScorBase + C.VSCOR_TOTAL_LAPS_OFF, 0);
  const lapNumber = Math.max(1, Math.max(lapCompletedTelem, lapCompletedScor) + 1);

  const playerLapDist = readF64(scorView, pScorBase + C.VSCOR_LAP_DIST_OFF, 0);
  const safeTrackMeters = trackDistM > 100 ? trackDistM : 5412;
  const lapDistPct =
    safeTrackMeters > 0
      ? Math.min(0.9999, Math.max(0, (((playerLapDist % safeTrackMeters) + safeTrackMeters) % safeTrackMeters) / safeTrackMeters))
      : 0;
  const trackLengthKm = trackDistM > 100 ? Math.round((trackDistM / 1000) * 1000) / 1000 : undefined;

  const inPits = readU8(scorView, pScorBase + C.VSCOR_IN_PITS_OFF, 0) === 1;
  const inGarageStall = readU8(scorView, pScorBase + C.VSCOR_IN_GARAGE_STALL_OFF, 0) === 1;
  const pitState = readU8(scorView, pScorBase + C.VSCOR_PIT_STATE_OFF, 0);
  const isPaused = gamePhase === 9;
  const inPitOrGarage = inGarageStall || inPits || pitState >= 2 || isPaused || (!inRealtime && speedKmh < 1.2);
  const inFormationLap = gamePhase === 3 || gamePhase === 4;
  const numPenalties = readI16(scorView, pScorBase + C.VSCOR_NUM_PENALTIES_OFF, 0);
  const penaltyActive = numPenalties > 0;

  const fl = parseWheelBlock(telemView, tBase + C.VTELEM_WHEELS_OFF, speedKmh);
  const fr = parseWheelBlock(telemView, tBase + C.VTELEM_WHEELS_OFF + C.WHEEL_SIZE, speedKmh);
  const rl = parseWheelBlock(telemView, tBase + C.VTELEM_WHEELS_OFF + C.WHEEL_SIZE * 2, speedKmh);
  const rr = parseWheelBlock(telemView, tBase + C.VTELEM_WHEELS_OFF + C.WHEEL_SIZE * 3, speedKmh);

  const frontWheelSlip = Math.max(fl.slip, fr.slip);
  const rearWheelSlip = Math.max(rl.slip, rr.slip);
  const offRoadWheels = [fl, fr, rl, rr].filter((w) => w.offRoad).length;
  const flatTire = fl.flat || fr.flat || rl.flat || rr.flat;
  const wheelDetached = fl.detached || fr.detached || rl.detached || rr.detached;
  const lapInvalidated = readU8(telemView, tBase + C.VTELEM_LAP_INVALIDATED_OFF, 0) === 1;
  const offTrackRisk = offRoadWheels >= 2 || lapInvalidated ? 0.92 : offRoadWheels === 1 ? 0.45 : 0;

  const absActive = readU8(telemView, tBase + C.VTELEM_ABS_ACTIVE_OFF, 0) === 1;
  const tcActive = readU8(telemView, tBase + C.VTELEM_TC_ACTIVE_OFF, 0) === 1;

  // Player world pos & orientation for opponent spotter
  const pPos = {
    x: readF64(scorView, pScorBase + C.VSCOR_POS_OFF, 0),
    y: readF64(scorView, pScorBase + C.VSCOR_POS_OFF + 8, 0),
    z: readF64(scorView, pScorBase + C.VSCOR_POS_OFF + 16, 0),
  };
  const pOri0 = {
    x: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF, 1),
    y: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 8, 0),
    z: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 16, 0),
  };
  const pOri1 = {
    x: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 24, 0),
    y: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 32, 1),
    z: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 40, 0),
  };
  const pOri2 = {
    x: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 48, 0),
    y: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 56, 0),
    z: readF64(scorView, pScorBase + C.VSCOR_ORI_OFF + 64, 1),
  };

  interface MappedOppInternal extends OpponentCar {
    oppInPits: boolean;
  }

  const mappedOpps: MappedOppInternal[] = [];
  for (let i = 0; i < numScorVehicles; i++) {
    if (i === playerScorIdx) continue;
    const sBase = vehScorArrayOffset + i * C.VEH_SCOR_SIZE;
    const oppLapDist = readF64(scorView, sBase + C.VSCOR_LAP_DIST_OFF, 0);
    const oppPct =
      safeTrackMeters > 0
        ? (((oppLapDist % safeTrackMeters) + safeTrackMeters) % safeTrackMeters) / safeTrackMeters
        : 0;
    let diffPct = oppPct - lapDistPct;
    if (diffPct > 0.5) diffPct -= 1;
    if (diffPct < -0.5) diffPct += 1;
    const distM = Math.round(diffPct * safeTrackMeters);

    const ovx = readF64(scorView, sBase + C.VSCOR_LOCAL_VEL_OFF, 0);
    const ovy = readF64(scorView, sBase + C.VSCOR_LOCAL_VEL_OFF + 8, 0);
    const ovz = readF64(scorView, sBase + C.VSCOR_LOCAL_VEL_OFF + 16, 0);
    const oppSpeedKmh = Math.round(Math.hypot(ovx, ovy, ovz) * 3.6);
    const relClosing =
      distM < 0 ? Math.max(0, oppSpeedKmh - speedKmh) : Math.max(0, speedKmh - oppSpeedKmh);

    const oppPos = {
      x: readF64(scorView, sBase + C.VSCOR_POS_OFF, 0),
      y: readF64(scorView, sBase + C.VSCOR_POS_OFF + 8, 0),
      z: readF64(scorView, sBase + C.VSCOR_POS_OFF + 16, 0),
    };
    const oppInPits =
      readU8(scorView, sBase + C.VSCOR_IN_PITS_OFF, 0) === 1 ||
      readU8(scorView, sBase + C.VSCOR_IN_GARAGE_STALL_OFF, 0) === 1;
    const oppClassRaw = readAsciiCString(scorView, sBase + C.VSCOR_VEHICLE_CLASS_OFF, 32);
    const oppVehName = readAsciiCString(scorView, sBase + C.VSCOR_VEHICLE_NAME_OFF, 64);
    const oppDriver = readAsciiCString(scorView, sBase + C.VSCOR_DRIVER_NAME_OFF, 32) || 'Driver';
    const oppId = readI32(scorView, sBase + C.VSCOR_ID_OFF, i);

    const oppPlace = readU8(scorView, sBase + C.VSCOR_PLACE_OFF, 0);
    const oppTotalLaps = readI16(scorView, sBase + C.VSCOR_TOTAL_LAPS_OFF, 0);
    const oppSector: 1 | 2 | 3 = oppPct < 1 / 3 ? 1 : oppPct < 2 / 3 ? 2 : 3;
    const hasOppWorldPos =
      Number.isFinite(oppPos.x) &&
      Number.isFinite(oppPos.z) &&
      (oppPos.x !== 0 || oppPos.z !== 0);

    mappedOpps.push({
      oppInPits,
      id: `${simId}-shm-opp-${oppId}`,
      carNumber: String(oppId > 0 ? oppId % 1000 : i + 1),
      driverName: oppDriver,
      carClass: normalizeLmuClass(oppClassRaw),
      carName: oppVehName || 'Opponent',
      lapDistPct: oppPct,
      speedKmh: oppSpeedKmh,
      gapSeconds: Math.round((distM / Math.max(25, speedKmh / 3.6)) * 10) / 10,
      distanceMeters: distM,
      closingSpeedKmh: Math.round(relClosing),
      lateralSide: compute3dLateralSide(pPos, pOri0, pOri1, pOri2, oppPos),
      isAlongside: Math.abs(distM) <= 6.5 && !oppInPits,
      safetyRating: 'clean',
      inPits: oppInPits,
      sector: oppSector,
      ...(oppPlace > 0 ? { position: oppPlace } : {}),
      ...(oppTotalLaps >= 0 ? { lapsCompleted: oppTotalLaps } : {}),
      ...(hasOppWorldPos
        ? {
            posX: Math.round(oppPos.x * 100) / 100,
            posZ: Math.round(oppPos.z * 100) / 100,
          }
        : {}),
    });
  }

  const stoppedAhead = mappedOpps
    .filter(
      (o) =>
        !o.oppInPits &&
        o.distanceMeters >= 8 &&
        o.distanceMeters <= 340 &&
        o.speedKmh < 45 &&
        speedKmh >= 60
    )
    .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];

  const playerFlag = readU8(scorView, pScorBase + C.VSCOR_FLAG_OFF, 0);
  const sectorYellow = secFlag0 === 1 || secFlag1 === 1 || secFlag2 === 1;
  const flagState: TelemetryFrame['flagState'] =
    playerFlag === 6
      ? 'blue'
      : yellowFlagState > 0 || sectorYellow || gamePhase === 6 || Boolean(stoppedAhead)
        ? 'yellow'
        : 'green';

  const hazardAhead = flagState === 'yellow';
  const hazardDistanceM = stoppedAhead ? stoppedAhead.distanceMeters : hazardAhead ? 180 : 999;
  const hazardDescription = stoppedAhead
    ? `Slow or stopped #${stoppedAhead.carNumber} (${stoppedAhead.speedKmh} km/h) on track.`
    : hazardAhead
      ? 'Yellow flag sector active.'
      : '';

  const opponents: OpponentCar[] = mappedOpps
    .map(({ oppInPits: _ignored, ...rest }) => rest)
    .sort((a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters))
    .slice(0, 48);

  const carModel = readAsciiCString(telemView, tBase + C.VTELEM_VEHICLE_MODEL_OFF, 30);
  const carTeam =
    readAsciiCString(telemView, tBase + C.VTELEM_VEHICLE_NAME_OFF, 64) ||
    readAsciiCString(scorView, pScorBase + C.VSCOR_VEHICLE_NAME_OFF, 64);
  const combinedCarName = [carModel, carTeam].filter(Boolean).join(' ') || undefined;
  const carClass = readAsciiCString(scorView, pScorBase + C.VSCOR_VEHICLE_CLASS_OFF, 32) || undefined;
  const resolvedTrackName =
    trackName || readAsciiCString(telemView, tBase + C.VTELEM_TRACK_NAME_OFF, 64) || undefined;

  const telemPosX = readF64(telemView, tBase + C.VTELEM_POS_OFF, 0);
  const telemPosZ = readF64(telemView, tBase + C.VTELEM_POS_OFF + 16, 0);
  const hasTelemPos =
    Number.isFinite(telemPosX) &&
    Number.isFinite(telemPosZ) &&
    (telemPosX !== 0 || telemPosZ !== 0);
  const hasScorPos =
    Number.isFinite(pPos.x) &&
    Number.isFinite(pPos.z) &&
    (pPos.x !== 0 || pPos.z !== 0);
  const rawPosX = hasTelemPos ? telemPosX : hasScorPos ? pPos.x : undefined;
  const rawPosZ = hasTelemPos ? telemPosZ : hasScorPos ? pPos.z : undefined;
  const posX = rawPosX !== undefined ? Math.round(rawPosX * 100) / 100 : undefined;
  const posZ = rawPosZ !== undefined ? Math.round(rawPosZ * 100) / 100 : undefined;

  const rawPlace = readU8(scorView, pScorBase + C.VSCOR_PLACE_OFF, 0);
  const playerPosition = rawPlace > 0 ? rawPlace : undefined;
  const fieldSize = numScorVehicles > 0 ? numScorVehicles : undefined;

  const rawVe = readF32(telemView, tBase + C.VTELEM_VIRTUAL_ENERGY_OFF, 0);
  const lmuClass = normalizeLmuClass(carClass || combinedCarName);
  const virtualEnergyPct =
    simId === 'lmu' && lmuClass === 'Hypercar' && Number.isFinite(rawVe) && rawVe > 0 && rawVe <= 100
      ? Math.max(0, Math.min(100, Math.round((rawVe <= 1.05 ? rawVe * 100 : rawVe) * 10) / 10))
      : undefined;

  return {
    active: true,
    sessionType,
    rawSessionName,
    frame: {
      timestampMs,
      simId,
      ...(resolvedTrackName ? { trackName: resolvedTrackName } : {}),
      ...(trackLengthKm ? { trackLengthKm } : {}),
      ...(combinedCarName ? { carName: combinedCarName } : {}),
      ...(carClass ? { carClass } : {}),
      sessionType,
      ...(rawSessionName ? { rawSessionName } : {}),
      lapNumber,
      lapDistPct,
      speedKmh,
      rpm,
      maxRpm,
      gear,
      throttle,
      brake,
      clutch,
      steeringRad,
      latG,
      longG,
      deltaSec,
      fuelLiters,
      ...(virtualEnergyPct !== undefined ? { virtualEnergyPct } : {}),
      tireTempC: { fl: fl.tempC, fr: fr.tempC, rl: rl.tempC, rr: rr.tempC },
      tirePressurePsi: {
        fl: fl.pressurePsi,
        fr: fr.pressurePsi,
        rl: rl.pressurePsi,
        rr: rr.pressurePsi,
      },
      tireWearPct: { fl: fl.wearPct, fr: fr.wearPct, rl: rl.wearPct, rr: rr.wearPct },
      brakeTempC: { fl: fl.brakeTempC, fr: fr.brakeTempC, rl: rl.brakeTempC, rr: rr.brakeTempC },
      frontWheelSlip,
      rearWheelSlip,
      absActive,
      tcActive,
      offTrackRisk,
      hazardAhead,
      hazardDistanceM,
      hazardDescription,
      flagState,
      inPitOrGarage,
      isPaused,
      ...(inFormationLap ? { inFormationLap: true } : {}),
      ...(penaltyActive ? { penaltyActive: true } : {}),
      ...(flatTire ? { flatTire: true } : {}),
      ...(wheelDetached ? { wheelDetached: true } : {}),
      ...(posX !== undefined ? { posX } : {}),
      ...(posZ !== undefined ? { posZ } : {}),
      ...(playerPosition !== undefined ? { playerPosition } : {}),
      ...(fieldSize !== undefined ? { fieldSize } : {}),
      opponents,
      telemetrySource: 'shared-memory',
      sensorCaps: {
        pedals: true,
        tires: true,
        brakes: true,
        rpmGear: true,
      },
    },
  };
}

/**
 * Parses a raw LMU `LMU_Data` (`LMUObjectOut`, 324,820 bytes) binary buffer.
 */
export function parseLmuObjectOutBuffer(
  buf: Uint8Array,
  timestampMs = Date.now()
): ParsedShmResult {
  if (!buf || buf.byteLength < LMU_SHM_LAYOUT.TELEM_INFO_OFFSET + RF2_COMMON_STRUCTS.VEH_TELEM_SIZE) {
    return { active: false, sessionType: 'unknown', rawSessionName: null };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const activeVehicles = readU8(view, LMU_SHM_LAYOUT.TELEM_ACTIVE_VEHICLES_OFFSET, 0);
  const playerVehicleIdx = readU8(view, LMU_SHM_LAYOUT.TELEM_PLAYER_IDX_OFFSET, 0);
  const playerHasVehicle = readU8(view, LMU_SHM_LAYOUT.TELEM_PLAYER_HAS_VEH_OFFSET, 0) === 1;

  return parseVehicleAndScoringCore({
    simId: 'lmu',
    telemView: view,
    telemCount: activeVehicles,
    telemArrayOffset: LMU_SHM_LAYOUT.TELEM_INFO_OFFSET,
    playerTelemIdxHint: playerVehicleIdx,
    playerHasVehicleHint: playerHasVehicle,
    scorView: view,
    scorInfoOffset: LMU_SHM_LAYOUT.SCORING_INFO_OFFSET,
    vehScorArrayOffset: LMU_SHM_LAYOUT.VEH_SCORING_OFFSET,
    maxVehicles: LMU_SHM_LAYOUT.MAX_VEHICLES,
    timestampMs,
  });
}

/**
 * Parses rFactor 2 / Legacy LMU SharedMemoryMapPlugin (`$rFactor2SMMP_Telemetry$` + `$rFactor2SMMP_Scoring$`) buffers.
 */
export function parseRf2SharedMemoryBuffers(
  teleBuf: Uint8Array,
  scorBuf: Uint8Array,
  simId: SimGameId = 'rf2',
  timestampMs = Date.now()
): ParsedShmResult {
  if (
    !teleBuf ||
    !scorBuf ||
    teleBuf.byteLength < RF2_SHM_LAYOUT.TELEM_VEHICLES_OFFSET + RF2_COMMON_STRUCTS.VEH_TELEM_SIZE ||
    scorBuf.byteLength < RF2_SHM_LAYOUT.VEH_SCORING_OFFSET + RF2_COMMON_STRUCTS.VEH_SCOR_SIZE
  ) {
    return { active: false, sessionType: 'unknown', rawSessionName: null };
  }

  const teleView = new DataView(teleBuf.buffer, teleBuf.byteOffset, teleBuf.byteLength);
  const scorView = new DataView(scorBuf.buffer, scorBuf.byteOffset, scorBuf.byteLength);

  const numVehicles = readI32(teleView, RF2_SHM_LAYOUT.TELEM_NUM_VEHICLES_OFFSET, 0);
  return parseVehicleAndScoringCore({
    simId,
    telemView: teleView,
    telemCount: numVehicles,
    telemArrayOffset: RF2_SHM_LAYOUT.TELEM_VEHICLES_OFFSET,
    playerTelemIdxHint: null,
    playerHasVehicleHint: null,
    scorView,
    scorInfoOffset: RF2_SHM_LAYOUT.SCORING_INFO_OFFSET,
    vehScorArrayOffset: RF2_SHM_LAYOUT.VEH_SCORING_OFFSET,
    maxVehicles: RF2_SHM_LAYOUT.MAX_VEHICLES,
    timestampMs,
  });
}
