import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS } from '../data/circuitsAndCars';
import type { SimConnectionStatus, TelemetryFrame } from '../types/telemetry';
import {
  detectTelemetryIncident,
  evaluateCoachRealityCheck,
  parseDriverIncidentClaim,
  resolveSessionTruthStatus,
} from './telemetryTruth';

const track = TRACKS[0]; // Le Mans
const turn1 = track.corners[0];
const turn8 = track.corners[Math.min(7, track.corners.length - 1)];

function makeFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    timestampMs: 1_000_000,
    lapNumber: 1,
    lapDistPct: 0,
    speedKmh: 0,
    rpm: 1100,
    maxRpm: 8500,
    gear: 0,
    throttle: 0,
    brake: 0,
    clutch: 0,
    steeringRad: 0,
    latG: 0,
    longG: 0,
    deltaSec: 0,
    fuelLiters: 54,
    tireTempC: { fl: 82, fr: 82, rl: 80, rr: 80 },
    tirePressurePsi: { fl: 26.5, fr: 26.5, rl: 26.1, rr: 26.1 },
    tireWearPct: { fl: 100, fr: 100, rl: 100, rr: 100 },
    brakeTempC: { fl: 420, fr: 420, rl: 360, rr: 360 },
    frontWheelSlip: 0,
    rearWheelSlip: 0,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
    ...overrides,
  };
}

const offlineStatus: SimConnectionStatus = {
  gameRunning: false,
  simId: null,
  gameName: null,
  connectionState: 'offline',
  source: 'none',
  telemetryQuality: 'none',
  lastPacketAtMs: null,
  rawTrackName: null,
  rawCarName: null,
};

test('resolveSessionTruthStatus distinguishes offline, menus, garage, on-track, and demo', () => {
  assert.equal(
    resolveSessionTruthStatus({
      externalStreamActive: false,
      isLiveRunning: false,
      simStatus: offlineStatus,
      frame: makeFrame(),
    }),
    'standby_offline'
  );

  assert.equal(
    resolveSessionTruthStatus({
      externalStreamActive: false,
      isLiveRunning: false,
      simStatus: {
        ...offlineStatus,
        gameRunning: true,
        simId: 'lmu',
        gameName: 'Le Mans Ultimate',
        connectionState: 'menus',
      },
      frame: makeFrame(),
    }),
    'game_in_menus'
  );

  assert.equal(
    resolveSessionTruthStatus({
      externalStreamActive: true,
      isLiveRunning: false,
      simStatus: {
        ...offlineStatus,
        gameRunning: true,
        simId: 'lmu',
        gameName: 'Le Mans Ultimate',
        connectionState: 'in_pit',
        source: 'lmu-rest',
      },
      frame: makeFrame({ inPitOrGarage: true }),
    }),
    'in_garage_or_pits'
  );

  assert.equal(
    resolveSessionTruthStatus({
      externalStreamActive: true,
      isLiveRunning: false,
      simStatus: {
        ...offlineStatus,
        gameRunning: true,
        simId: 'lmu',
        gameName: 'Le Mans Ultimate',
        connectionState: 'on_track',
        source: 'lmu-rest',
      },
      frame: makeFrame({ speedKmh: 245 }),
    }),
    'on_track_live'
  );

  assert.equal(
    resolveSessionTruthStatus({
      externalStreamActive: false,
      isLiveRunning: true,
      simStatus: offlineStatus,
      frame: makeFrame({ speedKmh: 210 }),
    }),
    'practice_demo'
  );
});

test('parseDriverIncidentClaim recognizes turn words and numbers in English', () => {
  const claimEn = parseDriverIncidentClaim('o i crashed in turn one', track);
  assert.equal(claimEn.claimedType, 'crash_impact');
  assert.equal(claimEn.claimedTurnNumber, 1);

  const claimSpin = parseDriverIncidentClaim('I spun out at Turn 8', track);
  assert.equal(claimSpin.claimedType, 'spin');
  assert.equal(claimSpin.claimedTurnNumber, 8);
});

test('evaluateCoachRealityCheck exposes false crash claim when not playing the game', () => {
  const check = evaluateCoachRealityCheck({
    question: 'o i crashed in turn one',
    language: 'en',
    externalStreamActive: false,
    isLiveRunning: false,
    simStatus: offlineStatus,
    frame: makeFrame(),
    track,
    activeCorner: null,
    upcomingCorner: turn1,
    incidents: [],
    nowMs: 1_000_000,
  });

  assert.equal(check.sessionStatus, 'standby_offline');
  assert.equal(check.truthStatus, 'contradicted_not_playing');
  assert.equal(check.contradicted, true);
  assert.ok(check.truthFallbackReply?.toLowerCase().includes("aren't playing"));
  assert.ok(check.truthFallbackReply?.includes('0 km/h'));
});

test('evaluateCoachRealityCheck exposes false crash claim when sitting in garage', () => {
  const check = evaluateCoachRealityCheck({
    question: 'I crashed in turn 1',
    language: 'en',
    externalStreamActive: true,
    isLiveRunning: false,
    simStatus: {
      ...offlineStatus,
      gameRunning: true,
      simId: 'lmu',
      gameName: 'Le Mans Ultimate',
      connectionState: 'in_pit',
      source: 'lmu-rest',
    },
    frame: makeFrame({ speedKmh: 0, inPitOrGarage: true }),
    track,
    activeCorner: null,
    upcomingCorner: turn1,
    incidents: [],
    nowMs: 1_000_000,
  });

  assert.equal(check.sessionStatus, 'in_garage_or_pits');
  assert.equal(check.truthStatus, 'contradicted_in_garage');
  assert.equal(check.contradicted, true);
  assert.ok(check.truthFallbackReply?.includes('Garage'));
});

test('evaluateCoachRealityCheck contradicts false crash when driving cleanly on track, and confirms real impact', () => {
  const cleanCheck = evaluateCoachRealityCheck({
    question: 'o i crashed in turn one',
    language: 'en',
    externalStreamActive: true,
    isLiveRunning: false,
    simStatus: {
      ...offlineStatus,
      gameRunning: true,
      simId: 'lmu',
      gameName: 'Le Mans Ultimate',
      connectionState: 'on_track',
      source: 'lmu-rest',
    },
    frame: makeFrame({ speedKmh: 262, lapNumber: 2, lapDistPct: turn8.apexPct }),
    track,
    activeCorner: turn8,
    upcomingCorner: turn8,
    incidents: [],
    nowMs: 1_000_000,
  });

  assert.equal(cleanCheck.sessionStatus, 'on_track_live');
  assert.equal(cleanCheck.truthStatus, 'contradicted_no_incident');
  assert.equal(cleanCheck.contradicted, true);
  assert.ok(cleanCheck.truthFallbackReply?.includes('no crash or impact'));

  const prev = makeFrame({ timestampMs: 999_800, speedKmh: 215, lapDistPct: turn1.apexPct });
  const crash = makeFrame({
    timestampMs: 1_000_000,
    speedKmh: 45,
    longG: -3.9,
    lapDistPct: turn1.apexPct,
  });
  const detected = detectTelemetryIncident({
    nextFrame: crash,
    prevFrame: prev,
    track,
    activeCorner: turn1,
    isDrivingSession: true,
    nowMs: 1_000_000,
  });
  assert.ok(detected);
  assert.equal(detected?.type, 'crash_impact');
  assert.equal(detected?.cornerNumber, 1);

  const realCrashCheck = evaluateCoachRealityCheck({
    question: 'I crashed in turn one',
    language: 'en',
    externalStreamActive: true,
    isLiveRunning: false,
    simStatus: {
      ...offlineStatus,
      gameRunning: true,
      simId: 'lmu',
      gameName: 'Le Mans Ultimate',
      connectionState: 'on_track',
      source: 'lmu-rest',
    },
    frame: crash,
    track,
    activeCorner: turn1,
    upcomingCorner: turn1,
    incidents: [{ ...detected!, id: 'inc-1' }],
    nowMs: 1_002_000,
  });

  assert.equal(realCrashCheck.truthStatus, 'confirmed');
  assert.equal(realCrashCheck.contradicted, false);
});
