import test from 'node:test';
import assert from 'node:assert/strict';
import { CARS, TRACKS } from '../data/circuitsAndCars';
import { createInitialCooldowns, evaluateLiveTelemetry } from './coachRules';
import { computeLmuLateralSide, evaluateRacecraft } from './racecraft';
import type { CoachSettings, OpponentCar, TelemetryFrame } from '../types/telemetry';

const defaultSettings: CoachSettings = {
  voiceEnabled: true,
  useGeminiTts: true,
  geminiVoiceName: 'Fenrir',
  language: 'en',
  focusMode: 'all',
  preCornerCuesEnabled: true,
  racecraftAlertsEnabled: true,
  autonomyMode: 'advise',
  radioSquelchFx: true,
  verbosity: 'balanced',
  lateBrakeThresholdMeters: 10,
  hazardAlertsEnabled: true,
  speechRate: 1.05,
};

function makeFrame(opponents: OpponentCar[], overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    timestampMs: 40000,
    lapNumber: 3,
    lapDistPct: 0.25,
    speedKmh: 260,
    rpm: 7500,
    maxRpm: 8400,
    gear: 5,
    throttle: 1,
    brake: 0,
    steeringRad: 0,
    latG: 0.1,
    longG: 0.4,
    deltaSec: -0.1,
    fuelLiters: 42,
    tireTempC: { fl: 85, fr: 85, rl: 83, rr: 83 },
    tirePressurePsi: { fl: 26.5, fr: 26.5, rl: 26.2, rr: 26.2 },
    tireWearPct: { fl: 96, fr: 96, rl: 97, rr: 97 },
    brakeTempC: { fl: 440, fr: 435, rl: 370, rr: 365 },
    frontWheelSlip: 0.03,
    rearWheelSlip: 0.03,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0.05,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
    opponents,
    ...overrides,
  };
}

function makeOpponent(overrides: Partial<OpponentCar>): OpponentCar {
  return {
    id: 'opp-test',
    carNumber: '51',
    driverName: 'A. Pier Guidi',
    carClass: 'Hypercar',
    carName: 'Ferrari 499P',
    lapDistPct: 0.248,
    speedKmh: 274,
    gapSeconds: -0.25,
    distanceMeters: -18,
    closingSpeedKmh: 14,
    lateralSide: 'right',
    isAlongside: false,
    safetyRating: 'clean',
    ...overrides,
  };
}

test('evaluateRacecraft warns when rival behind is going for a pass and marks safe inside defense', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const corner = track.corners[2];
  const frame = makeFrame([makeOpponent({ carNumber: '51', distanceMeters: -18, closingSpeedKmh: 14 })]);

  const enAdvice = evaluateRacecraft(frame, track, car, corner, 'en');
  assert.equal(enAdvice.posture, 'defend_inside');
  assert.equal(enAdvice.safeToDefend, true);
  assert.equal(enAdvice.safeToAttack, false);
  assert.match(enAdvice.detail, /going for a pass/i);
});

test('evaluateRacecraft warns against chopping when rival makes a very late dive (<10m)', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const corner = track.corners[2];
  const frame = makeFrame([makeOpponent({ carNumber: '83', distanceMeters: -7.5, closingSpeedKmh: 16 })]);

  const advice = evaluateRacecraft(frame, track, car, corner, 'en');
  assert.equal(advice.posture, 'defend_inside');
  assert.equal(advice.safeToDefend, false);
  assert.match(advice.detail, /do not chop/i);
});

test('evaluateRacecraft identifies safe attack opportunity ahead in English', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const corner = track.corners[2];
  const frame = makeFrame([
    makeOpponent({
      carNumber: '7',
      driverName: 'K. Kobayashi',
      distanceMeters: 24,
      gapSeconds: 0.33,
      speedKmh: 247,
      closingSpeedKmh: 13,
      lateralSide: 'center',
    }),
  ]);

  const enAdvice = evaluateRacecraft(frame, track, car, corner, 'en');
  assert.equal(enAdvice.posture, 'attack_opportunity');
  assert.equal(enAdvice.safeToAttack, true);
  assert.match(enAdvice.detail, /Attack now/i);
});

test('evaluateRacecraft announces Car Left, Car Right, and Three Wide cleanly', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const corner = track.corners[2];

  const leftFrame = makeFrame([
    makeOpponent({
      carNumber: '83',
      distanceMeters: 1.5,
      gapSeconds: 0.02,
      isAlongside: true,
      lateralSide: 'left',
      closingSpeedKmh: 2,
    }),
  ]);
  const leftAdvice = evaluateRacecraft(leftFrame, track, car, corner, 'en');
  assert.equal(leftAdvice.posture, 'hold_line_car_alongside');
  assert.equal(leftAdvice.safeToAttack, false);
  assert.equal(leftAdvice.safeToDefend, false);
  assert.match(leftAdvice.headline, /Car Left!/i);
  assert.match(leftAdvice.detail, /LEFT/);

  const rightFrame = makeFrame([
    makeOpponent({
      carNumber: '51',
      distanceMeters: -1.2,
      gapSeconds: -0.02,
      isAlongside: true,
      lateralSide: 'right',
      closingSpeedKmh: 1,
    }),
  ]);
  const rightAdvice = evaluateRacecraft(rightFrame, track, car, corner, 'en');
  assert.equal(rightAdvice.posture, 'hold_line_car_alongside');
  assert.match(rightAdvice.headline, /Car Right!/i);
  assert.match(rightAdvice.detail, /RIGHT/);

  const threeWideFrame = makeFrame([
    makeOpponent({ id: 'opp-l', carNumber: '83', distanceMeters: 1.1, isAlongside: true, lateralSide: 'left' }),
    makeOpponent({ id: 'opp-r', carNumber: '51', distanceMeters: -1.0, isAlongside: true, lateralSide: 'right' }),
  ]);
  const threeWideAdvice = evaluateRacecraft(threeWideFrame, track, car, corner, 'en');
  assert.equal(threeWideAdvice.posture, 'three_wide');
  assert.match(threeWideAdvice.headline, /Three Wide!/i);
});

test('evaluateLiveTelemetry emits Car Left, Car Right, Three Wide, and Clear Left/Right spotter calls', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  const leftFrame = makeFrame(
    [makeOpponent({ carNumber: '83', distanceMeters: 1.2, isAlongside: true, lateralSide: 'left' })],
    { timestampMs: 40000 }
  );
  const leftCall = evaluateLiveTelemetry(
    leftFrame,
    null,
    track,
    null,
    null,
    defaultSettings,
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(leftCall.callout);
  assert.equal(leftCall.callout.category, 'racecraft');
  assert.equal(leftCall.callout.severity, 'urgent');
  assert.match(leftCall.callout.message, /^Car left!/i);

  // Transition to clear 2s later -> emits "Clear left — all clear"
  const clearedFrame = makeFrame(
    [makeOpponent({ carNumber: '83', distanceMeters: -18, isAlongside: false, lateralSide: 'left', closingSpeedKmh: 0 })],
    { timestampMs: 42200 }
  );
  const clearCall = evaluateLiveTelemetry(
    clearedFrame,
    leftFrame,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false },
    leftCall.nextCooldowns,
    undefined,
    car
  );
  assert.ok(clearCall.callout);
  assert.equal(clearCall.callout.category, 'racecraft');
  assert.match(clearCall.callout.message, /Clear left.*all clear/i);

  const attackFrame = makeFrame([
    makeOpponent({ carNumber: '7', distanceMeters: 22, speedKmh: 245, closingSpeedKmh: 15 }),
  ]);
  const active = evaluateLiveTelemetry(
    attackFrame,
    null,
    track,
    null,
    null,
    defaultSettings,
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(active.callout);
  assert.equal(active.callout.category, 'racecraft');
  assert.match(active.callout.message, /Attack now/i);

  const muted = evaluateLiveTelemetry(
    attackFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, racecraftAlertsEnabled: false, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.equal(muted.callout, null);
});

test('computeLmuLateralSide maps LMU left-handed 3D positions accurately across headings', () => {
  // Moving along -Z (forward in LMU local frame): +X is left, -X is right
  assert.equal(
    computeLmuLateralSide({ x: 0, z: 0 }, { x: 0, z: -50 }, { x: 3.5, z: 0 }),
    'left'
  );
  assert.equal(
    computeLmuLateralSide({ x: 0, z: 0 }, { x: 0, z: -50 }, { x: -3.5, z: 0 }),
    'right'
  );
  assert.equal(
    computeLmuLateralSide({ x: 0, z: 0 }, { x: 0, z: -50 }, { x: 0.4, z: -12 }),
    'center'
  );
  // Moving along +X (turned 90 deg left): +Z is left, -Z is right
  assert.equal(
    computeLmuLateralSide({ x: 10, z: 10 }, { x: 40, z: 0 }, { x: 10, z: 14 }),
    'left'
  );
  assert.equal(
    computeLmuLateralSide({ x: 10, z: 10 }, { x: 40, z: 0 }, { x: 10, z: 6 }),
    'right'
  );
});
