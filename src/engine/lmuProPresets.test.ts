import test from 'node:test';
import assert from 'node:assert/strict';
import { CARS, TRACKS, buildReferenceLap, buildSampleUserLap } from '../data/circuitsAndCars';
import { analyzeLapByCorners } from './coachRules';
import { createDefaultDriverProfile } from './driverLearning';
import { buildLmuProPresetsForTrackAndCar, recommendLmuPresets } from './lmuProPresets';

test('buildLmuProPresetsForTrackAndCar builds 4 LMU presets and preserves LMP2 no-ABS rule', () => {
  const lemans = TRACKS.find((t) => t.id === 'lemans')!;
  const lmp2 = CARS.find((c) => c.id === 'oreca_07_lmp2')!;
  const presets = buildLmuProPresetsForTrackAndCar(lmp2, lemans);

  assert.equal(presets.length, 4);
  for (const p of presets) {
    assert.equal(p.setup.absLevel, 0, `${p.id} must keep ABS 0 on LMP2`);
  }
});

test('recommendLmuPresets ranks Endurance Safe #1 for newcomer with lockups and late brakes', () => {
  const track = TRACKS.find((t) => t.id === 'spa')!;
  const car = CARS.find((c) => c.id === 'porsche_963')!;
  const ref = buildReferenceLap(track, car);
  const lap = buildSampleUserLap(track, car);
  const comparisons = analyzeLapByCorners(lap.frames, ref, track);

  const profile = createDefaultDriverProfile(true);
  profile.habits.lockupCount = 4;
  profile.habits.lateBrakeCount = 4;
  profile.habits.brakingConsistencyPct = 62;

  const recs = recommendLmuPresets(car, track, profile, comparisons, lap.frames[0]);
  assert.equal(recs.length, 4);
  assert.equal(recs[0].isTopPick, true);
  assert.equal(recs[0].preset.id, 'endurance_safe');
});

test('recommendLmuPresets ranks Qualifying Attack #1 for consistent pro driver', () => {
  const track = TRACKS.find((t) => t.id === 'portimao')!;
  const car = CARS.find((c) => c.id === 'ferrari_499p')!;
  const ref = buildReferenceLap(track, car);
  const lap = buildSampleUserLap(track, car);
  const comparisons = analyzeLapByCorners(lap.frames, ref, track);

  const profile = createDefaultDriverProfile(false);
  profile.skillTier = 'pro';
  profile.primaryGoal = 'pace';
  profile.habits.brakingConsistencyPct = 91;
  profile.habits.lockupCount = 0;
  profile.habits.exitSnapCount = 0;
  profile.habits.avgTrailBrakeScore = 88;

  const recs = recommendLmuPresets(car, track, profile, comparisons, lap.frames[0]);
  assert.equal(recs[0].preset.id, 'quali_attack');
  assert.ok(recs[0].matchScore >= 85);
});

test('recommendLmuPresets boosts High-Speed & Kerb Spec for exit snap & bumpy track issues', () => {
  const track = TRACKS.find((t) => t.id === 'sebring')!;
  const car = CARS.find((c) => c.id === 'porsche_911_gt3r')!;
  const ref = buildReferenceLap(track, car);
  const lap = buildSampleUserLap(track, car);
  const comparisons = analyzeLapByCorners(lap.frames, ref, track);

  const profile = createDefaultDriverProfile(false);
  profile.skillTier = 'competitive';
  profile.habits.exitSnapCount = 5;
  profile.habits.offTrackCount = 3;
  profile.habits.lockupCount = 0;
  profile.habits.brakingConsistencyPct = 76;

  const recs = recommendLmuPresets(car, track, profile, comparisons, lap.frames[0]);
  assert.equal(recs[0].preset.id, 'kerb_highspeed');
});
