import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARS,
  TRACKS,
  buildReferenceLap,
  buildSampleUserLap,
} from '../data/circuitsAndCars';
import { createDefaultDriverProfile } from './driverLearning';
import {
  buildPostRaceReport,
  calculateProjectedGain,
  recalculateReportProjection,
} from './raceReport';

test('calculateProjectedGain computes time saved and grid positions gained cleanly', () => {
  // Best lap 102.0 vs ref 99.8; fixing 0.90s/lap over 18 laps saves 16.2s -> ~2-3 spots from P9
  const res = calculateProjectedGain(102.0, 99.8, 0.9, 18, 9);
  assert.equal(res.selectedGainPerLapSec, 0.9);
  assert.equal(res.totalRaceTimeSavedSec, 16.2);
  assert.equal(res.projectedBestLapSec, 101.1);
  assert.ok(res.positionsGained >= 2, `Expected >=2 positions gained, got ${res.positionsGained}`);
  assert.equal(res.projectedPosition, 9 - res.positionsGained);

  // Zero fixable gain yields 0 positions gained
  const zeroRes = calculateProjectedGain(102.0, 99.8, 0, 18, 9);
  assert.equal(zeroRes.positionsGained, 0);
  assert.equal(zeroRes.projectedPosition, 9);
});

test('buildPostRaceReport builds ranked mistake fixes, position projection, and English copy', () => {
  const track = TRACKS.find((t) => t.id === 'bahrain') ?? TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const lap1 = buildSampleUserLap(track, car);
  // Inject pedal overlap on sample frames to confirm overlap fix detection
  const noisyLap = {
    ...lap1,
    lapNumber: 2,
    lapTimeSec: lap1.lapTimeSec + 0.45,
    frames: lap1.frames.map((f, idx) =>
      idx < 18 ? { ...f, throttle: 0.48, brake: 0.42 } : f
    ),
  };

  const reportEn = buildPostRaceReport({
    simId: 'lmu',
    simName: 'Le Mans Ultimate',
    track,
    car,
    setup: car.defaultSetup,
    driverProfile: createDefaultDriverProfile(true),
    laps: [lap1, noisyLap],
    referenceSamples: ref,
    mistakeCounts: {
      lateBrakes: 3,
      lockups: 2,
      exitSnaps: 1,
      offTracks: 1,
    },
    sessionMode: 'live_race',
    raceDistanceLaps: 18,
    officialFinishPosition: 9,
    language: 'en',
  });

  assert.equal(reportEn.lapsCompleted, 2);
  assert.equal(reportEn.positionKnown, true);
  assert.equal(reportEn.finishPosition, 9);
  assert.ok(reportEn.mistakeFixes.length >= 2);
  assert.ok(reportEn.lapSummaries.length === 2);
  assert.ok((reportEn.compareFrames?.length ?? 0) > 10);

  // Toggle only the top 1 fix vs all fixes
  const partialProj = recalculateReportProjection(reportEn, [reportEn.mistakeFixes[0].id]);
  const fullProj = recalculateReportProjection(
    reportEn,
    reportEn.mistakeFixes.map((f) => f.id)
  );
  assert.ok(partialProj.selectedGainPerLapSec <= fullProj.selectedGainPerLapSec);
  assert.ok(partialProj.positionsGained <= fullProj.positionsGained);
});

test('buildPostRaceReport marks positionKnown=false when official position is omitted and compacts posX/posZ + proven corner passes', () => {
  const track = TRACKS.find((t) => t.id === 'bahrain') ?? TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const lap1 = buildSampleUserLap(track, car);
  const corner0 = track.corners[0];

  // Make lap1 carry posX/posZ and make lap2 slower everywhere except 2x faster through corner0
  const lap1WithPos = {
    ...lap1,
    frames: lap1.frames.map((f, idx) => ({
      ...f,
      posX: 100 + idx * 2,
      posZ: -50 - idx,
    })),
  };

  let shiftedOffsetMs = 0;
  let prevTimestampMs = lap1WithPos.frames[0]?.timestampMs ?? 0;
  const lap2WithFasterCorner0 = {
    ...lap1WithPos,
    lapNumber: 2,
    lapTimeSec: lap1.lapTimeSec + 0.6,
    frames: lap1WithPos.frames.map((f, idx) => {
      const inC0 = f.lapDistPct >= corner0.startPct && f.lapDistPct <= corner0.exitPct;
      const stepMs = idx === 0 ? 0 : Math.max(0, (f.timestampMs ?? prevTimestampMs) - prevTimestampMs);
      prevTimestampMs = f.timestampMs ?? prevTimestampMs;
      if (inC0 && idx > 0) {
        shiftedOffsetMs += stepMs * (1 - 1 / 1.35);
      }
      const nextTs = Math.round((f.timestampMs ?? 0) - shiftedOffsetMs);
      return inC0
        ? { ...f, speedKmh: f.speedKmh * 1.35, timestampMs: nextTs }
        : { ...f, timestampMs: nextTs };
    }),
  };

  const report = buildPostRaceReport({
    simId: 'lmu',
    simName: 'Le Mans Ultimate',
    track,
    car,
    setup: car.defaultSetup,
    driverProfile: createDefaultDriverProfile(true),
    laps: [lap1WithPos, lap2WithFasterCorner0],
    referenceSamples: ref,
    mistakeCounts: { lateBrakes: 1, lockups: 0, exitSnaps: 0, offTracks: 0 },
    sessionMode: 'practice_stint',
    raceDistanceLaps: 14,
  });

  assert.equal(report.positionKnown, false);
  assert.equal(report.finishPosition, 0);
  assert.equal(report.projectedPosition, 0);
  assert.equal(report.positionsGained, 0);
  assert.ok(Number.isFinite(report.provenBestLapSec));
  assert.ok((report.provenGainSec ?? 0) > 0);
  assert.ok((report.bestCornerPasses?.length ?? 0) >= 1);
  assert.ok(report.representativeFrames?.every((pt) => Number.isFinite(pt.posX) && Number.isFinite(pt.posZ)));
});
