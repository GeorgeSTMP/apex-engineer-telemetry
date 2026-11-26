import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LMU_SHM_LAYOUT,
  RF2_COMMON_STRUCTS,
  RF2_SHM_LAYOUT,
  compute3dLateralSide,
  computeWheelSlipFraction,
  kelvinToCelsius,
  kpaToPsi,
  parseLmuObjectOutBuffer,
  parseRf2SharedMemoryBuffers,
} from './lmuSharedMemory.ts';

function writeAscii(buf: Uint8Array, offset: number, maxLen: number, str: string): void {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < str.length ? str.charCodeAt(i) & 0x7f : 0;
  }
}

function buildMockLmuObjectOut(options?: {
  activeVehicles?: number;
  playerHasVehicle?: boolean;
  sessionCode?: number;
  gamePhase?: number;
  inRealtime?: boolean;
  brake?: number;
  throttle?: number;
  speedMs?: number;
  frontGripSlip?: number;
  surfaceTypeFl?: number;
  withStoppedOpponent?: boolean;
  virtualEnergyFraction?: number;
  numPenalties?: number;
  carClass?: string;
  flatWheelIndex?: number;
  detachedWheelIndex?: number;
}): Uint8Array {
  const buf = new Uint8Array(LMU_SHM_LAYOUT.TOTAL_SIZE);
  const view = new DataView(buf.buffer);
  const C = RF2_COMMON_STRUCTS;

  const activeVehicles = options?.activeVehicles ?? (options?.withStoppedOpponent ? 2 : 1);
  const playerHasVehicle = options?.playerHasVehicle ?? true;

  // ScoringInfo
  const si = LMU_SHM_LAYOUT.SCORING_INFO_OFFSET;
  writeAscii(buf, si + C.SCOR_TRACK_NAME_OFF, 64, 'Circuit de la Sarthe');
  view.setInt32(si + C.SCOR_SESSION_OFF, options?.sessionCode ?? 10, true); // 10 = Race
  view.setFloat64(si + C.SCOR_LAP_DIST_OFF, 13626, true);
  view.setInt32(si + C.SCOR_NUM_VEHICLES_OFF, activeVehicles, true);
  view.setUint8(si + C.SCOR_GAME_PHASE_OFF, options?.gamePhase ?? 5); // Green flag
  view.setUint8(si + C.SCOR_IN_REALTIME_OFF, (options?.inRealtime ?? true) ? 1 : 0);

  // Telemetry header
  view.setUint8(LMU_SHM_LAYOUT.TELEM_ACTIVE_VEHICLES_OFFSET, activeVehicles);
  view.setUint8(LMU_SHM_LAYOUT.TELEM_PLAYER_IDX_OFFSET, 0);
  view.setUint8(LMU_SHM_LAYOUT.TELEM_PLAYER_HAS_VEH_OFFSET, playerHasVehicle ? 1 : 0);

  if (activeVehicles > 0) {
    // Player scoring[0]
    const ps = LMU_SHM_LAYOUT.VEH_SCORING_OFFSET;
    view.setInt32(ps + C.VSCOR_ID_OFF, 7, true);
    writeAscii(buf, ps + C.VSCOR_DRIVER_NAME_OFF, 32, 'Player Driver');
    writeAscii(buf, ps + C.VSCOR_VEHICLE_NAME_OFF, 64, 'Porsche Penske Motorsport #6');
    view.setInt16(ps + C.VSCOR_TOTAL_LAPS_OFF, 2, true);
    view.setFloat64(ps + C.VSCOR_LAP_DIST_OFF, 3406.5, true);
    view.setUint8(ps + C.VSCOR_IS_PLAYER_OFF, 1);
    view.setInt8(ps + C.VSCOR_CONTROL_OFF, 0);
    view.setInt16(ps + C.VSCOR_NUM_PENALTIES_OFF, options?.numPenalties ?? 0, true);
    view.setUint8(ps + C.VSCOR_PLACE_OFF, 4);
    writeAscii(buf, ps + C.VSCOR_VEHICLE_CLASS_OFF, 32, options?.carClass ?? 'Hypercar');
    // Identity orientation matrix: local +X = world +X (Left), -Z = forward
    view.setFloat64(ps + C.VSCOR_ORI_OFF + 0, 1, true);
    view.setFloat64(ps + C.VSCOR_ORI_OFF + 32, 1, true);
    view.setFloat64(ps + C.VSCOR_ORI_OFF + 64, 1, true);

    // Player telemetry[0]
    const pt = LMU_SHM_LAYOUT.TELEM_INFO_OFFSET;
    view.setInt32(pt + C.VTELEM_ID_OFF, 7, true);
    view.setInt32(pt + C.VTELEM_LAP_NUMBER_OFF, 2, true);
    writeAscii(buf, pt + C.VTELEM_VEHICLE_NAME_OFF, 64, 'Porsche Penske Motorsport #6');
    writeAscii(buf, pt + C.VTELEM_VEHICLE_MODEL_OFF, 30, 'Porsche 963');
    view.setFloat64(pt + C.VTELEM_POS_OFF + 0, 142.35, true);
    view.setFloat64(pt + C.VTELEM_POS_OFF + 16, -518.8, true);
    const speedMs = options?.speedMs ?? 60; // 216 km/h
    view.setFloat64(pt + C.VTELEM_LOCAL_VEL_OFF + 16, -speedMs, true);
    view.setFloat64(pt + C.VTELEM_LOCAL_ACCEL_OFF + 0, 14.71, true); // ~1.5G lat
    view.setFloat64(pt + C.VTELEM_LOCAL_ACCEL_OFF + 16, 19.61, true); // +Z backward => braking (-2.0G long)
    view.setInt32(pt + C.VTELEM_GEAR_OFF, 4, true);
    view.setFloat64(pt + C.VTELEM_RPM_OFF, 7420, true);
    view.setFloat64(pt + C.VTELEM_MAX_RPM_OFF, 8400, true);
    view.setFloat64(pt + C.VTELEM_UNFILTERED_THROTTLE_OFF, options?.throttle ?? 0.0, true);
    view.setFloat64(pt + C.VTELEM_UNFILTERED_BRAKE_OFF, options?.brake ?? 0.94, true);
    view.setFloat64(pt + C.VTELEM_UNFILTERED_STEER_OFF, -0.2, true);
    view.setFloat64(pt + C.VTELEM_UNFILTERED_CLUTCH_OFF, 0.0, true);
    view.setFloat64(pt + C.VTELEM_FUEL_OFF, 41.5, true);
    view.setFloat64(pt + C.VTELEM_DELTA_BEST_OFF, -0.342, true);
    view.setUint8(pt + C.VTELEM_ABS_ACTIVE_OFF, 1);
    if (options?.virtualEnergyFraction !== undefined) {
      view.setFloat32(pt + C.VTELEM_VIRTUAL_ENERGY_OFF, options.virtualEnergyFraction, true);
    }

    for (let w = 0; w < 4; w++) {
      const wb = pt + C.VTELEM_WHEELS_OFF + w * C.WHEEL_SIZE;
      view.setFloat64(wb + C.WHEEL_BRAKE_TEMP_OFF, w < 2 ? 973.15 : 673.15, true); // 700C / 400C
      view.setFloat64(wb + C.WHEEL_PRESSURE_KPA_OFF, 185, true); // ~26.8 psi
      const tempK = w < 2 ? 363.15 : 358.15; // 90C / 85C
      view.setFloat64(wb + C.WHEEL_TEMP_ICO_OFF, tempK - 2, true);
      view.setFloat64(wb + C.WHEEL_TEMP_ICO_OFF + 8, tempK, true);
      view.setFloat64(wb + C.WHEEL_TEMP_ICO_OFF + 16, tempK + 2, true);
      view.setFloat64(wb + C.WHEEL_WEAR_OFF, 0.92, true);
      view.setFloat64(wb + C.WHEEL_GRIP_FRACT_OFF, w < 2 ? (options?.frontGripSlip ?? 0.24) : 0.02, true);
      view.setFloat64(wb + C.WHEEL_LONG_GROUND_VEL_OFF, speedMs, true);
      view.setUint8(wb + C.WHEEL_SURFACE_TYPE_OFF, w === 0 ? (options?.surfaceTypeFl ?? 0) : 0);
      view.setUint8(wb + C.WHEEL_FLAT_OFF, options?.flatWheelIndex === w ? 1 : 0);
      view.setUint8(wb + C.WHEEL_DETACHED_OFF, options?.detachedWheelIndex === w ? 1 : 0);
    }
  }

  if (options?.withStoppedOpponent && activeVehicles >= 2) {
    const os = LMU_SHM_LAYOUT.VEH_SCORING_OFFSET + C.VEH_SCOR_SIZE;
    view.setInt32(os + C.VSCOR_ID_OFF, 51, true);
    writeAscii(buf, os + C.VSCOR_DRIVER_NAME_OFF, 32, 'A. Pier Guidi');
    writeAscii(buf, os + C.VSCOR_VEHICLE_NAME_OFF, 64, 'AF Corse Ferrari 499P #51');
    view.setFloat64(os + C.VSCOR_LAP_DIST_OFF, 3406.5 + 110, true); // 110m ahead
    writeAscii(buf, os + C.VSCOR_VEHICLE_CLASS_OFF, 32, 'Hypercar');
    // Left (+3m X) of player
    view.setFloat64(os + C.VSCOR_POS_OFF + 0, 3.2, true);
    view.setFloat64(os + C.VSCOR_LOCAL_VEL_OFF + 16, -5, true); // 18 km/h stopped/spinning car
  }

  return buf;
}

test('unit conversions convert Kelvin->Celsius, kPa->PSI, and slip accurately', () => {
  assert.equal(kelvinToCelsius(363.15), 90);
  assert.equal(kpaToPsi(185), 26.8);
  assert.equal(computeWheelSlipFraction(0.22, 0, 0, 0, 50, 180), 0.22);
  assert.equal(computeWheelSlipFraction(0.02, 0, 12, 0, 40, 144), 0.3);
  assert.equal(computeWheelSlipFraction(0.5, 0, 5, 0, 5, 5), 0); // parked in pit -> 0
  assert.equal(
    compute3dLateralSide(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 2.5, y: 0, z: -10 }
    ),
    'left'
  );
  assert.equal(
    compute3dLateralSide(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: -2.8, y: 0, z: -10 }
    ),
    'right'
  );
});

test('parseLmuObjectOutBuffer extracts full LMU native pedals, tires, brakes, slip, and session phase', () => {
  const buf = buildMockLmuObjectOut({
    sessionCode: 10,
    brake: 0.94,
    throttle: 0.0,
    speedMs: 60,
    frontGripSlip: 0.24,
  });
  const parsed = parseLmuObjectOutBuffer(buf, 123456789);
  assert.equal(parsed.active, true);
  assert.equal(parsed.sessionType, 'race');
  assert.ok(parsed.frame);
  const f = parsed.frame!;
  assert.equal(f.simId, 'lmu');
  assert.equal(f.trackName, 'Circuit de la Sarthe');
  assert.equal(f.trackLengthKm, 13.626);
  assert.equal(f.carName, 'Porsche 963 Porsche Penske Motorsport #6');
  assert.equal(f.lapNumber, 3);
  assert.equal(f.speedKmh, 216);
  assert.equal(f.gear, 4);
  assert.equal(f.rpm, 7420);
  assert.equal(f.maxRpm, 8400);
  assert.equal(f.throttle, 0);
  assert.equal(f.brake, 0.94);
  assert.equal(f.longG, -2);
  assert.equal(f.latG, 1.5);
  assert.equal(f.deltaSec, -0.342);
  assert.equal(f.fuelLiters, 41.5);
  assert.equal(f.tireTempC.fl, 90);
  assert.equal(f.tireTempC.rl, 85);
  assert.equal(f.tirePressurePsi.fl, 26.8);
  assert.equal(f.tireWearPct.fl, 92);
  assert.equal(f.brakeTempC.fl, 700);
  assert.equal(f.brakeTempC.rl, 400);
  assert.equal(f.frontWheelSlip, 0.24);
  assert.equal(f.absActive, true);
  assert.equal(f.posX, 142.35);
  assert.equal(f.posZ, -518.8);
  assert.equal(f.playerPosition, 4);
  assert.equal(f.fieldSize, 1);
  assert.equal(f.telemetrySource, 'shared-memory');
  assert.deepEqual(f.sensorCaps, { pedals: true, tires: true, brakes: true, rpmGear: true });
});

test('parseLmuObjectOutBuffer detects stopped car hazards ahead and off-track wheels', () => {
  const buf = buildMockLmuObjectOut({
    sessionCode: 6, // Qualifying
    withStoppedOpponent: true,
    surfaceTypeFl: 3, // dirt/offroad
  });
  const parsed = parseLmuObjectOutBuffer(buf, 5000);
  assert.equal(parsed.active, true);
  assert.equal(parsed.sessionType, 'qualifying');
  assert.ok(parsed.frame);
  assert.equal(parsed.frame!.hazardAhead, true);
  assert.equal(parsed.frame!.flagState, 'yellow');
  assert.equal(parsed.frame!.hazardDistanceM, 110);
  assert.equal(parsed.frame!.opponents?.[0].lateralSide, 'left');
  assert.equal(parsed.frame!.offTrackRisk, 0.45);
});

test('parseLmuObjectOutBuffer ignores inactive menu buffers with 0 active vehicles', () => {
  const buf = buildMockLmuObjectOut({ activeVehicles: 0, playerHasVehicle: false });
  const parsed = parseLmuObjectOutBuffer(buf);
  assert.equal(parsed.active, false);
  assert.equal(parsed.frame, undefined);
});

test('parseRf2SharedMemoryBuffers parses legacy rFactor2/LMU plugin buffers accurately', () => {
  const tele = new Uint8Array(RF2_SHM_LAYOUT.TELEMETRY_TOTAL_SIZE);
  const scor = new Uint8Array(RF2_SHM_LAYOUT.SCORING_TOTAL_SIZE);
  const tView = new DataView(tele.buffer);
  const sView = new DataView(scor.buffer);
  const C = RF2_COMMON_STRUCTS;

  sView.setInt32(RF2_SHM_LAYOUT.SCORING_INFO_OFFSET + C.SCOR_SESSION_OFF, 1, true); // Practice 1
  sView.setFloat64(RF2_SHM_LAYOUT.SCORING_INFO_OFFSET + C.SCOR_LAP_DIST_OFF, 6019, true);
  sView.setInt32(RF2_SHM_LAYOUT.SCORING_INFO_OFFSET + C.SCOR_NUM_VEHICLES_OFF, 1, true);
  sView.setUint8(RF2_SHM_LAYOUT.SCORING_INFO_OFFSET + C.SCOR_IN_REALTIME_OFF, 1);
  writeAscii(scor, RF2_SHM_LAYOUT.SCORING_INFO_OFFSET + C.SCOR_TRACK_NAME_OFF, 64, 'Sebring');

  const ps = RF2_SHM_LAYOUT.VEH_SCORING_OFFSET;
  sView.setInt32(ps + C.VSCOR_ID_OFF, 12, true);
  sView.setUint8(ps + C.VSCOR_IS_PLAYER_OFF, 1);
  writeAscii(scor, ps + C.VSCOR_VEHICLE_CLASS_OFF, 32, 'LMP2');

  tView.setInt32(RF2_SHM_LAYOUT.TELEM_NUM_VEHICLES_OFFSET, 1, true);
  const pt = RF2_SHM_LAYOUT.TELEM_VEHICLES_OFFSET;
  tView.setInt32(pt + C.VTELEM_ID_OFF, 12, true);
  writeAscii(tele, pt + C.VTELEM_VEHICLE_NAME_OFF, 64, 'Oreca 07 Gibson');
  tView.setFloat64(pt + C.VTELEM_LOCAL_VEL_OFF + 16, -50, true); // 180 km/h
  tView.setFloat64(pt + C.VTELEM_UNFILTERED_THROTTLE_OFF, 0.85, true);
  tView.setInt32(pt + C.VTELEM_GEAR_OFF, 5, true);
  tView.setFloat64(pt + C.VTELEM_RPM_OFF, 8100, true);
  tView.setFloat64(pt + C.VTELEM_MAX_RPM_OFF, 8900, true);

  const parsed = parseRf2SharedMemoryBuffers(tele, scor, 'rf2', 9999);
  assert.equal(parsed.active, true);
  assert.equal(parsed.sessionType, 'practice');
  assert.equal(parsed.frame!.simId, 'rf2');
  assert.equal(parsed.frame!.trackName, 'Sebring');
  assert.equal(parsed.frame!.carName, 'Oreca 07 Gibson');
  assert.equal(parsed.frame!.speedKmh, 180);
  assert.equal(parsed.frame!.throttle, 0.85);
  assert.equal(parsed.frame!.gear, 5);
  assert.equal(parsed.frame!.rpm, 8100);
});

test('parseLmuObjectOutBuffer extracts Hypercar Virtual Energy %, Formation Lap, and Penalties', () => {
  const buf = buildMockLmuObjectOut({
    sessionCode: 10,
    gamePhase: 3, // Formation lap
    virtualEnergyFraction: 0.642,
    numPenalties: 1,
    carClass: 'Hypercar',
  });
  const parsed = parseLmuObjectOutBuffer(buf, 8888);
  assert.equal(parsed.active, true);
  assert.equal(parsed.frame!.virtualEnergyPct, 64.2);
  assert.equal(parsed.frame!.inFormationLap, true);
  assert.equal(parsed.frame!.penaltyActive, true);

  // Non-Hypercar LMGT3 does not emit Hypercar virtualEnergyPct even if offset is non-zero
  const gt3Buf = buildMockLmuObjectOut({
    sessionCode: 10,
    gamePhase: 5,
    virtualEnergyFraction: 0.5,
    numPenalties: 0,
    carClass: 'LMGT3',
  });
  const parsedGt3 = parseLmuObjectOutBuffer(gt3Buf, 8889);
  assert.equal(parsedGt3.frame!.virtualEnergyPct, undefined);
  assert.equal(parsedGt3.frame!.inFormationLap, undefined);
  assert.equal(parsedGt3.frame!.penaltyActive, undefined);
});

test('parseLmuObjectOutBuffer exposes flatTire and wheelDetached when wheel damage flags are set', () => {
  const flatBuf = buildMockLmuObjectOut({ flatWheelIndex: 0 });
  const parsedFlat = parseLmuObjectOutBuffer(flatBuf, 9001);
  assert.equal(parsedFlat.frame!.flatTire, true);
  assert.equal(parsedFlat.frame!.wheelDetached, undefined);

  const detachedBuf = buildMockLmuObjectOut({ detachedWheelIndex: 1 });
  const parsedDetached = parseLmuObjectOutBuffer(detachedBuf, 9002);
  assert.equal(parsedDetached.frame!.wheelDetached, true);
});

