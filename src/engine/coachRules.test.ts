import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARS,
  TRACKS,
  buildReferenceLap,
  buildSampleUserLap,
} from '../data/circuitsAndCars';
import {
  analyzeLapByCorners,
  createInitialCooldowns,
  evaluateDriverSkillMetrics,
  evaluateLiveTelemetry,
  formatDelta,
  formatLapTime,
} from './coachRules';
import type { CoachSettings, TelemetryFrame } from '../types/telemetry';

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

function makeFrame(overrides: Partial<TelemetryFrame>): TelemetryFrame {
  return {
    timestampMs: 20000,
    lapNumber: 2,
    lapDistPct: 0.151,
    speedKmh: 245,
    rpm: 7200,
    maxRpm: 8400,
    gear: 5,
    throttle: 0,
    brake: 0.2,
    steeringRad: 0.1,
    latG: 1.2,
    longG: -1.1,
    deltaSec: 0.12,
    fuelLiters: 54,
    tireTempC: { fl: 84, fr: 83, rl: 82, rr: 82 },
    tirePressurePsi: { fl: 26.5, fr: 26.5, rl: 26.2, rr: 26.2 },
    tireWearPct: { fl: 96, fr: 96, rl: 97, rr: 97 },
    brakeTempC: { fl: 520, fr: 515, rl: 400, rr: 400 },
    frontWheelSlip: 0.04,
    rearWheelSlip: 0.04,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0.1,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
    ...overrides,
  };
}

test('formatLapTime and formatDelta format motorsport timings cleanly', () => {
  assert.equal(formatLapTime(204.42), '3:24.420');
  assert.equal(formatLapTime(65.005), '1:05.005');
  assert.equal(formatDelta(-0.412), '-0.412s');
  assert.equal(formatDelta(0.18), '+0.180s');
});

test('evaluateLiveTelemetry immediately triggers urgent hazard callout on crash ahead', () => {
  const track = TRACKS[0];
  const corner = track.corners[4]; // Mulsanne Corner
  const frame = makeFrame({
    lapDistPct: corner.startPct,
    hazardAhead: true,
    hazardDistanceM: 185,
    hazardDescription: 'Car sideways on exit.',
    flagState: 'yellow',
  });

  const { callout } = evaluateLiveTelemetry(
    frame,
    null,
    track,
    corner,
    null,
    defaultSettings,
    createInitialCooldowns()
  );

  assert.ok(callout);
  assert.equal(callout.severity, 'urgent');
  assert.equal(callout.category, 'hazard');
  assert.match(callout.message, /Accident ahead/i);
  assert.match(callout.message, /185 meters/i);
});

test('evaluateLiveTelemetry detects late braking and advises easing brake pressure', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const corner = track.corners[1]; // Tertre Rouge (brakeMarkerPct: 0.148)
  const frame = makeFrame({
    lapDistPct: corner.brakeMarkerPct + 0.005, // ~68m past marker on 13.6km Le Mans
    speedKmh: 268,
    brake: 0.55,
  });
  const refSample = ref[Math.floor(frame.lapDistPct * ref.length)];

  const { callout, nextCooldowns } = evaluateLiveTelemetry(
    frame,
    null,
    track,
    corner,
    refSample,
    defaultSettings,
    createInitialCooldowns()
  );

  assert.ok(callout);
  assert.equal(callout.category, 'braking');
  assert.match(callout.message, /ease the brake/i);

  // Cooldown prevents spamming on immediate next tick
  const second = evaluateLiveTelemetry(
    makeFrame({ timestampMs: 20500, lapDistPct: corner.brakeMarkerPct + 0.0055, speedKmh: 264, brake: 0.6 }),
    frame,
    track,
    corner,
    refSample,
    defaultSettings,
    nextCooldowns
  );
  assert.equal(second.callout, null);
});

test('evaluateLiveTelemetry detects front lockup under heavy braking', () => {
  const track = TRACKS[0];
  const corner = track.corners[0];
  const frame = makeFrame({
    lapDistPct: corner.brakeMarkerPct + 0.002,
    speedKmh: 210,
    brake: 0.96,
    frontWheelSlip: 0.22,
  });

  const { callout } = evaluateLiveTelemetry(
    frame,
    null,
    track,
    corner,
    null,
    defaultSettings,
    createInitialCooldowns()
  );

  assert.ok(callout);
  assert.equal(callout.category, 'lockup');
  assert.equal(callout.severity, 'urgent');
  assert.match(callout.message, /Turn 1 \(Dunlop Bridge & Chicane\)/);
  assert.match(callout.message, /Ease the brake pedal/i);
});

test('evaluateLiveTelemetry outputs Turn number and name cleanly in English', () => {
  const track = TRACKS[0];
  const corner = track.corners[3]; // Turn 7 (Michelin Chicane)
  const frame = makeFrame({
    lapDistPct: corner.brakeMarkerPct + 0.002,
    speedKmh: 280,
    brake: 0.96,
    frontWheelSlip: 0.22,
  });

  const { callout } = evaluateLiveTelemetry(
    frame,
    null,
    track,
    corner,
    null,
    { ...defaultSettings, language: 'en' },
    createInitialCooldowns()
  );

  assert.ok(callout);
  assert.match(callout.message, /Turn 7 \(Michelin Chicane/);
});

test('analyzeLapByCorners returns corner-by-corner metrics with Turn number and name', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const userLap = buildSampleUserLap(track, car);
  const comparisons = analyzeLapByCorners(userLap.frames, ref, track);

  assert.equal(comparisons.length, track.corners.length);
  assert.ok(comparisons.every((c) => c.trailBrakingScore >= 25 && c.trailBrakingScore <= 99));
  assert.ok(comparisons.every((c) => c.primaryIssue.startsWith(`Turn ${c.cornerNumber} (${c.cornerName})`)));
});

test('all 30 Le Mans Ultimate & IMSA circuits have valid geometry and corner definitions', () => {
  assert.equal(TRACKS.length, 30);
  for (const track of TRACKS) {
    assert.ok(track.lengthKm > 2.4, `${track.id} lengthKm invalid`);
    assert.ok(track.referenceLapTimeSec > 40, `${track.id} referenceLapTimeSec invalid`);
    assert.ok(track.svgPath.startsWith('M '), `${track.id} missing svgPath`);
    assert.ok(track.corners.length >= 4, `${track.id} should have >= 4 corners`);
    for (const c of track.corners) {
      assert.ok(
        c.startPct >= 0 &&
          c.startPct <= c.brakeMarkerPct &&
          c.brakeMarkerPct <= c.apexPct &&
          c.apexPct <= c.exitPct &&
          c.exitPct <= 1,
        `${track.id} corner ${c.id} has invalid percentages`
      );
    }
  }
});

test('Coach Focus Mode filters out non-selected cues while preserving urgent hazards', () => {
  const track = TRACKS[0];
  const corner = track.corners[0];
  const lockupFrame = makeFrame({
    lapDistPct: corner.brakeMarkerPct + 0.002,
    speedKmh: 210,
    brake: 0.96,
    frontWheelSlip: 0.22,
  });

  // throttle_exit focus skips lockup/braking coaching
  const filtered = evaluateLiveTelemetry(
    lockupFrame,
    null,
    track,
    corner,
    null,
    { ...defaultSettings, focusMode: 'throttle_exit', preCornerCuesEnabled: false },
    createInitialCooldowns()
  );
  assert.equal(filtered.callout, null);

  // Hazard alert still fires even in throttle_exit focus mode
  const hazardRes = evaluateLiveTelemetry(
    makeFrame({
      lapDistPct: corner.startPct,
      hazardAhead: true,
      hazardDistanceM: 120,
      flagState: 'yellow',
    }),
    null,
    track,
    corner,
    null,
    { ...defaultSettings, focusMode: 'throttle_exit' },
    createInitialCooldowns()
  );
  assert.ok(hazardRes.callout);
  assert.equal(hazardRes.callout.category, 'hazard');
});

test('Pre-corner anticipation cue fires before upcoming braking point in English', () => {
  const track = TRACKS[0]; // Le Mans 13.626km
  const targetCorner = track.corners[2]; // Daytona Chicane (brakeMarkerPct: 0.288)
  const approachPct = targetCorner.brakeMarkerPct - 110 / (track.lengthKm * 1000); // ~110m before brake marker

  const frame = makeFrame({
    lapDistPct: approachPct,
    speedKmh: 315,
    brake: 0,
    throttle: 1,
  });

  const enRes = evaluateLiveTelemetry(
    frame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, focusMode: 'braking', language: 'en' },
    createInitialCooldowns()
  );
  assert.ok(enRes.callout);
  assert.equal(enRes.callout.category, 'pre_corner');
  assert.match(enRes.callout.message, /Approaching Turn 5 \(Daytona Chicane/);

  const apexRes = evaluateLiveTelemetry(
    frame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, focusMode: 'apex_line', language: 'en' },
    createInitialCooldowns()
  );
  assert.ok(apexRes.callout);
  assert.equal(apexRes.callout.category, 'pre_corner');
  assert.match(apexRes.callout.message, /Next up Turn 5 \(Daytona Chicane/);
});

test('Tire temperature alerts fire for cold, overheated, and transition into optimal window', () => {
  const track = TRACKS[0];
  const car = CARS[0]; // optimalTireTempRange: [75, 95]

  const coldFrame = makeFrame({
    timestampMs: 40000,
    lapDistPct: 0.05,
    speedKmh: 210,
    tireTempC: { fl: 63, fr: 62, rl: 64, rr: 64 },
  });
  const coldRes = evaluateLiveTelemetry(
    coldFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, language: 'en', preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(coldRes.callout);
  assert.equal(coldRes.callout.category, 'tires');
  assert.match(coldRes.callout.message, /cold/i);

  const hotFrame = makeFrame({
    timestampMs: 45000,
    lapDistPct: 0.05,
    speedKmh: 210,
    tireTempC: { fl: 108, fr: 106, rl: 94, rr: 93 },
  });
  const hotRes = evaluateLiveTelemetry(
    hotFrame,
    coldFrame,
    track,
    null,
    null,
    { ...defaultSettings, language: 'en', preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(hotRes.callout);
  assert.equal(hotRes.callout.category, 'tires');
  assert.match(hotRes.callout.message, /overheat/i);

  const optimalAfterColdFrame = makeFrame({
    timestampMs: 56000,
    lapDistPct: 0.06,
    speedKmh: 210,
    tireTempC: { fl: 84, fr: 84, rl: 82, rr: 82 },
  });
  const optRes = evaluateLiveTelemetry(
    optimalAfterColdFrame,
    coldFrame,
    track,
    null,
    null,
    { ...defaultSettings, language: 'en', preCornerCuesEnabled: false },
    coldRes.nextCooldowns,
    undefined,
    car
  );
  assert.ok(optRes.callout);
  assert.equal(optRes.callout.category, 'tires_optimal');
  assert.match(optRes.callout.message, /optimal/i);
});

test('Heavily degraded tires trigger short check-in question with quickReplies', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  const wornFrame = makeFrame({
    timestampMs: 70000,
    lapDistPct: 0.05,
    speedKmh: 210,
    tireTempC: { fl: 86, fr: 86, rl: 84, rr: 84 },
    tireWearPct: { fl: 64, fr: 66, rl: 71, rr: 72 },
  });

  const enDegrade = evaluateLiveTelemetry(
    wornFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, language: 'en', preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(enDegrade.callout);
  assert.equal(enDegrade.callout.category, 'tire_degradation');
  assert.match(enDegrade.callout.message, /How do the tires feel/i);
  assert.ok(Array.isArray(enDegrade.callout.quickReplies) && enDegrade.callout.quickReplies.length >= 3);
});

test('minSpeakIntervalSec throttles non-urgent callouts while urgentInterruptsRadio allows urgent hazards', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  const coldFrame = makeFrame({
    timestampMs: 100000,
    lapDistPct: 0.05,
    speedKmh: 210,
    tireTempC: { fl: 60, fr: 60, rl: 62, rr: 62 },
  });

  // First callout fires
  const first = evaluateLiveTelemetry(
    coldFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, minSpeakIntervalSec: 20, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(first.callout);

  // 8s later, a non-urgent off-track warning is blocked by the 20s global speak interval
  const nonUrgentBlocked = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 108000,
      lapDistPct: 0.06,
      offTrackRisk: 0.92,
    }),
    coldFrame,
    track,
    null,
    null,
    { ...defaultSettings, minSpeakIntervalSec: 20, preCornerCuesEnabled: false },
    first.nextCooldowns,
    undefined,
    car
  );
  assert.equal(nonUrgentBlocked.callout, null);

  // An urgent crash hazard still interrupts immediately when urgentInterruptsRadio=true
  const urgentAllowed = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 108000,
      lapDistPct: 0.06,
      hazardAhead: true,
      hazardDistanceM: 120,
      flagState: 'yellow',
    }),
    coldFrame,
    track,
    null,
    null,
    { ...defaultSettings, minSpeakIntervalSec: 20, urgentInterruptsRadio: true, preCornerCuesEnabled: false },
    first.nextCooldowns,
    undefined,
    car
  );
  assert.ok(urgentAllowed.callout);
  assert.equal(urgentAllowed.callout.category, 'hazard');

  // If urgentInterruptsRadio=false, even urgent calls obey minSpeakIntervalSec
  const urgentBlocked = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 108000,
      lapDistPct: 0.06,
      hazardAhead: true,
      hazardDistanceM: 120,
      flagState: 'yellow',
    }),
    coldFrame,
    track,
    null,
    null,
    { ...defaultSettings, minSpeakIntervalSec: 20, urgentInterruptsRadio: false, preCornerCuesEnabled: false },
    first.nextCooldowns,
    undefined,
    car
  );
  assert.equal(urgentBlocked.callout, null);
});

test('tireAlertsEnabled=false suppresses tire temperature and wear callouts', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const res = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 120000,
      lapDistPct: 0.05,
      tireTempC: { fl: 58, fr: 58, rl: 59, rr: 59 },
      tireWearPct: { fl: 60, fr: 60, rl: 62, rr: 62 },
    }),
    null,
    track,
    null,
    null,
    { ...defaultSettings, tireAlertsEnabled: false, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.equal(res.callout, null);
});

test('Low fuel and brake overheat alerts trigger appropriately and respect toggles', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  // Low fuel fires urgent fuel callout
  const fuelFrame = makeFrame({
    timestampMs: 140000,
    lapDistPct: 0.05,
    fuelLiters: 4.5,
  });
  const fuelRes = evaluateLiveTelemetry(
    fuelFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, language: 'en' },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(fuelRes.callout);
  assert.equal(fuelRes.callout.category, 'fuel');
  assert.equal(fuelRes.callout.severity, 'urgent');
  assert.match(fuelRes.callout.message, /fuel|box/i);

  const fuelMuted = evaluateLiveTelemetry(
    fuelFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, fuelAlertsEnabled: false, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.equal(fuelMuted.callout, null);

  // Brake disc overheat (>= 740°C) fires brakes callout
  const brakeFrame = makeFrame({
    timestampMs: 150000,
    lapDistPct: 0.05,
    brakeTempC: { fl: 790, fr: 775, rl: 560, rr: 550 },
  });
  const brakeRes = evaluateLiveTelemetry(
    brakeFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, language: 'en' },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(brakeRes.callout);
  assert.equal(brakeRes.callout.category, 'brakes');
  assert.match(brakeRes.callout.message, /brake/i);

  const brakeMuted = evaluateLiveTelemetry(
    brakeFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, brakeTempAlertsEnabled: false, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.equal(brakeMuted.callout, null);
});

test('Tire pressure drift (low PSI / high PSI) and new lap pace summary respect toggles', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  // Under-inflated / slow puncture (< 24.8 psi)
  const lowPsiFrame = makeFrame({
    timestampMs: 170000,
    lapDistPct: 0.05,
    tirePressurePsi: { fl: 23.6, fr: 26.4, rl: 26.2, rr: 26.2 },
  });
  const lowPsiRes = evaluateLiveTelemetry(
    lowPsiFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, language: 'en' },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(lowPsiRes.callout);
  assert.equal(lowPsiRes.callout.category, 'tires');
  assert.match(lowPsiRes.callout.message, /pressure|23\.6/i);

  // Over-inflated (> 28.6 psi)
  const highPsiFrame = makeFrame({
    timestampMs: 175000,
    lapDistPct: 0.05,
    tirePressurePsi: { fl: 29.1, fr: 28.9, rl: 27.0, rr: 27.0 },
  });
  const highPsiRes = evaluateLiveTelemetry(
    highPsiFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, language: 'en' },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(highPsiRes.callout);
  assert.equal(highPsiRes.callout.category, 'tires');
  assert.match(highPsiRes.callout.message, /pressure|PSI/i);

  const psiMuted = evaluateLiveTelemetry(
    lowPsiFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, tirePressureAlertsEnabled: false, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.equal(psiMuted.callout, null);

  // New lap pace debrief
  const prevLapFrame = makeFrame({
    timestampMs: 189000,
    lapNumber: 2,
    lapDistPct: 0.99,
    deltaSec: -0.35,
  });
  const newLapFrame = makeFrame({
    timestampMs: 190000,
    lapNumber: 3,
    lapDistPct: 0.01,
    deltaSec: -0.35,
  });
  const lapRes = evaluateLiveTelemetry(
    newLapFrame,
    prevLapFrame,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, language: 'en' },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(lapRes.callout);
  assert.equal(lapRes.callout.category, 'strategy');
  assert.match(lapRes.callout.message, /Lap 2/i);

  const lapMuted = evaluateLiveTelemetry(
    newLapFrame,
    prevLapFrame,
    track,
    null,
    null,
    { ...defaultSettings, lapPaceAlertsEnabled: false, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.equal(lapMuted.callout, null);
});

test('evaluateDriverSkillMetrics computes pedal overlap, smoothness, and top 3 priority corner drills', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const sample = buildSampleUserLap(track, car);
  const comparisons = analyzeLapByCorners(sample.frames, ref, track);

  // Inject simultaneous gas + brake overlap on first 10 frames
  const noisyFrames = sample.frames.map((f, idx) =>
    idx < 10 ? { ...f, throttle: 0.45, brake: 0.42 } : f
  );

  const metricsEn = evaluateDriverSkillMetrics(noisyFrames, comparisons, 'en');
  assert.ok(metricsEn.pedalOverlapPct > 0);
  assert.ok(metricsEn.trailBrakingScore >= 25 && metricsEn.trailBrakingScore <= 99);
  assert.ok(metricsEn.inputSmoothnessScore >= 35 && metricsEn.inputSmoothnessScore <= 99);
  assert.ok(metricsEn.topLossDrills.length <= 3);
  if (metricsEn.topLossDrills.length > 0) {
    assert.ok(metricsEn.topLossDrills[0].actionDrill.length > 10);
  }
});

test('Pro racing team channels fire pit window, sector splits, gap splits, multiclass traffic, and bias dial calls when enabled', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  // 1. Pit window countdown (~2 laps left before critical fuel)
  const pitRes = evaluateLiveTelemetry(
    makeFrame({ timestampMs: 210000, lapDistPct: 0.2, fuelLiters: 9.8 }),
    null,
    track,
    null,
    null,
    {
      ...defaultSettings,
      radioProtocol: 'pro_terse',
      preCornerCuesEnabled: false,
      pitWindowCountdownEnabled: true,
    },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(pitRes.callout);
  assert.equal(pitRes.callout.category, 'strategy');
  assert.match(pitRes.callout.message, /Pit window open/i);

  // 2. Sector split when crossing sector 1 (0.33)
  const prevS1 = makeFrame({ timestampMs: 220000, lapNumber: 2, lapDistPct: 0.325, deltaSec: -0.22 });
  const curS1 = makeFrame({ timestampMs: 221000, lapNumber: 2, lapDistPct: 0.335, deltaSec: -0.22 });
  const secRes = evaluateLiveTelemetry(
    curS1,
    prevS1,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, sectorSplitsEnabled: true },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(secRes.callout);
  assert.match(secRes.callout.message, /Sector 1 split/i);

  // 3. Multiclass faster Hypercar closing on GT3
  const multiFrame = makeFrame({
    timestampMs: 230000,
    lapDistPct: 0.25,
    carClass: 'LMGT3',
    opponents: [
      {
        id: 'opp-7',
        carNumber: '7',
        driverName: 'K. Kobayashi',
        carClass: 'Hypercar',
        carName: 'Toyota GR010',
        lapDistPct: 0.245,
        speedKmh: 310,
        gapSeconds: -1.1,
        distanceMeters: -55,
        closingSpeedKmh: 45,
        lateralSide: 'center',
        isAlongside: false,
        safetyRating: 'clean',
      },
    ],
  });
  const multiRes = evaluateLiveTelemetry(
    multiFrame,
    null,
    track,
    null,
    null,
    { ...defaultSettings, racecraftAlertsEnabled: false, preCornerCuesEnabled: false, multiclassTrafficEnabled: true },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(multiRes.callout);
  assert.match(multiRes.callout.message, /Hypercar #7/i);

  // 4. Electronics brake balance callout when front discs run 180C hotter than rears
  const biasRes = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 240000,
      lapDistPct: 0.25,
      brakeTempC: { fl: 660, fr: 655, rl: 460, rr: 455 },
    }),
    null,
    track,
    null,
    null,
    { ...defaultSettings, preCornerCuesEnabled: false, electronicsCheckEnabled: true },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(biasRes.callout);
  assert.match(biasRes.callout.message, /brake bias 1\.0% rearward/i);

  // 5. Fuel-save lift & coast target callout
  const saveRes = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 250000,
      lapDistPct: 0.4,
      speedKmh: 265,
      throttle: 0.98,
      fuelLiters: 18,
    }),
    null,
    track,
    null,
    null,
    {
      ...defaultSettings,
      preCornerCuesEnabled: false,
      fuelSaveCallsEnabled: true,
      fuelTargetLitersPerLap: 4.8,
    },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(saveRes.callout);
  assert.match(saveRes.callout.message, /4\.8 L\/lap.*lift and coast/i);
});

test('Enabled Alert toggles fire cleanly without silent vetoes from verbosity=minimal or focusMode, and independent channels do not starve urgent fuel', () => {
  const track = TRACKS[0];
  const car = CARS[0];

  // verbosity='minimal' still fires explicitly enabled tire temperature warnings
  const minimalCold = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 300000,
      lapDistPct: 0.05,
      tireTempC: { fl: 60, fr: 60, rl: 62, rr: 62 },
    }),
    null,
    track,
    null,
    null,
    { ...defaultSettings, verbosity: 'minimal', tireAlertsEnabled: true, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(minimalCold.callout);
  assert.equal(minimalCold.callout.category, 'tires');

  // focusMode='braking' does NOT silently suppress track limits
  const brakingTrackLimit = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 310000,
      lapDistPct: 0.05,
      offTrackRisk: 0.9,
    }),
    null,
    track,
    null,
    null,
    { ...defaultSettings, focusMode: 'braking', trackLimitsAlertsEnabled: true, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(brakingTrackLimit.callout);
  assert.equal(brakingTrackLimit.callout.category, 'track_limits');

  // Fuel-save coaching does NOT starve urgent Critical Fuel Reserve Alert 2s later
  const saveFirst = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 320000,
      lapDistPct: 0.4,
      speedKmh: 265,
      throttle: 0.95,
      fuelLiters: 18,
    }),
    null,
    track,
    null,
    null,
    { ...defaultSettings, fuelSaveCallsEnabled: true, fuelAlertsEnabled: true, preCornerCuesEnabled: false },
    createInitialCooldowns(),
    undefined,
    car
  );
  assert.ok(saveFirst.callout);
  assert.equal(saveFirst.callout.category, 'fuel');

  const urgentFuelSecond = evaluateLiveTelemetry(
    makeFrame({
      timestampMs: 322000,
      lapDistPct: 0.45,
      fuelLiters: 5.2,
    }),
    null,
    track,
    null,
    null,
    { ...defaultSettings, fuelSaveCallsEnabled: true, fuelAlertsEnabled: true, urgentInterruptsRadio: true, preCornerCuesEnabled: false },
    saveFirst.nextCooldowns,
    undefined,
    car
  );
  assert.ok(urgentFuelSecond.callout);
  assert.equal(urgentFuelSecond.callout.severity, 'urgent');
  assert.equal(urgentFuelSecond.callout.category, 'fuel');
});


