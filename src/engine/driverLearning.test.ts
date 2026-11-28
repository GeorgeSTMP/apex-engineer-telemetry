import test from 'node:test';
import assert from 'node:assert/strict';
import { CARS, TRACKS, buildReferenceLap, buildSampleUserLap } from '../data/circuitsAndCars';
import {
  buildAdaptiveElectronicsSuggestions,
  computeLearnedGreenLineCalibration,
  computePitStrategy,
  createDefaultDriverProfile,
  createInitialPitStrategyVoiceState,
  evaluateAutonomyAction,
  evaluatePitStrategyVoiceCallout,
  makeCornerMemoryKey,
  recordCornerLearningFromLap,
  recordDriverObservation,
} from './driverLearning';
import type { CoachCallout, TelemetryFrame } from '../types/telemetry';

function makeDummyFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    timestampMs: 10000,
    lapNumber: 4,
    lapDistPct: 0.4,
    speedKmh: 240,
    rpm: 7100,
    maxRpm: 8400,
    gear: 5,
    throttle: 1,
    brake: 0,
    steeringRad: 0,
    latG: 0.2,
    longG: 0.5,
    deltaSec: 0.4,
    fuelLiters: 24,
    tireTempC: { fl: 86, fr: 85, rl: 82, rr: 81 },
    tirePressurePsi: { fl: 26.6, fr: 26.5, rl: 26.1, rr: 26.1 },
    tireWearPct: { fl: 84, fr: 85, rl: 88, rr: 89 },
    brakeTempC: { fl: 460, fr: 455, rl: 380, rr: 375 },
    frontWheelSlip: 0.03,
    rearWheelSlip: 0.03,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0.05,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
    ...overrides,
  };
}

test('recordDriverObservation learns recurring lockups and adjusts weaknesses', () => {
  let profile = createDefaultDriverProfile(true);
  const lockupCallout: CoachCallout = {
    id: 'c1',
    timestampMs: 1000,
    lapNumber: 1,
    cornerName: 'Mulsanne',
    severity: 'urgent',
    category: 'lockup',
    message: 'Front lockup!',
    spoken: true,
    source: 'realtime-engine',
  };

  profile = recordDriverObservation(profile, lockupCallout);
  profile = recordDriverObservation(profile, lockupCallout);

  assert.equal(profile.habits.lockupCount, 2);
  assert.ok(profile.learnedWeaknesses.some((w) => /lockup/i.test(w)));
});

test('buildAdaptiveElectronicsSuggestions recommends higher TC and rearward brake bias for newcomers with lockups', () => {
  let profile = createDefaultDriverProfile(true);
  profile = {
    ...profile,
    habits: { ...profile.habits, lockupCount: 2, exitSnapCount: 1 },
  };
  const car = CARS[0];
  const suggestions = buildAdaptiveElectronicsSuggestions(profile, car.defaultSetup, car);

  const tc = suggestions.find((s) => s.parameter === 'tcLevel');
  const bias = suggestions.find((s) => s.parameter === 'brakeBiasPct');
  assert.ok(tc);
  assert.ok(bias);
  assert.ok(tc.recommendedValue > car.defaultSetup.tcLevel);
  assert.ok(bias.recommendedValue < car.defaultSetup.brakeBiasPct);
});

test('computePitStrategy computes fuel window and tire recommendation accurately', () => {
  const track = TRACKS[0]; // Le Mans
  const car = CARS[0]; // Porsche 963
  const profile = createDefaultDriverProfile(true);
  const frame = makeDummyFrame({ lapNumber: 4, fuelLiters: 21, tireWearPct: { fl: 79, fr: 81, rl: 85, rr: 86 } });

  const plan = computePitStrategy(frame, track, car, profile, car.defaultSetup, 16);
  assert.ok(plan.recommendedPitLap >= 5 && plan.recommendedPitLap <= 8);
  assert.equal(plan.tireAction, 'change_all');
  assert.ok(plan.fuelToAddLiters > 10);
});

test('evaluateAutonomyAction stays strictly advise-only when mode is advise', () => {
  const car = CARS[0];
  let profile = createDefaultDriverProfile(true);
  profile = {
    ...profile,
    habits: { ...profile.habits, lockupCount: 2, exitSnapCount: 1 },
  };
  const suggestions = buildAdaptiveElectronicsSuggestions(profile, car.defaultSetup, car);
  const res = evaluateAutonomyAction(
    'advise',
    suggestions,
    car.defaultSetup,
    0,
    50000,
    'en'
  );

  assert.equal(res.appliedAction, null);
  assert.equal(res.calloutMessage, null);
  assert.deepEqual(res.nextSetup, car.defaultSetup);
});

test('evaluateAutonomyAction auto-applies immediate electronics fix with cooldown & English radio confirmation', () => {
  const car = CARS[0];
  let profile = createDefaultDriverProfile(true);
  profile = {
    ...profile,
    habits: { ...profile.habits, lockupCount: 2, exitSnapCount: 1 },
  };
  const suggestions = buildAdaptiveElectronicsSuggestions(profile, car.defaultSetup, car);

  const enRes = evaluateAutonomyAction(
    'hands_on',
    suggestions,
    car.defaultSetup,
    0,
    50000,
    'en'
  );
  assert.ok(enRes.appliedAction);
  assert.ok(enRes.calloutMessage);
  assert.match(enRes.calloutMessage, /Auto-Apply:/i);
  assert.notEqual(
    enRes.nextSetup[enRes.appliedAction.parameter],
    car.defaultSetup[enRes.appliedAction.parameter]
  );

  // Cooldown blocks immediate second mutation within 10s
  const nextSuggestions = buildAdaptiveElectronicsSuggestions(profile, enRes.nextSetup, car);
  const cooldownBlocked = evaluateAutonomyAction(
    'hands_on',
    nextSuggestions,
    enRes.nextSetup,
    50000,
    54000,
    'en'
  );
  assert.equal(cooldownBlocked.appliedAction, null);

  // After cooldown expires, applies next immediate suggestion in English
  const secondRes = evaluateAutonomyAction(
    'hands_on',
    nextSuggestions,
    enRes.nextSetup,
    50000,
    62000,
    'en'
  );
  if (nextSuggestions.length > 0) {
    assert.ok(secondRes.appliedAction);
    assert.ok(secondRes.calloutMessage);
    assert.match(secondRes.calloutMessage, /Auto-Apply:/i);
  }
});

test('recordCornerLearningFromLap accumulates per-corner stats, slip events, and fastest world pass', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const sampleLap = buildSampleUserLap(track, car);
  const corner = track.corners[0];

  // Enrich sample lap with world coordinates & a lockup inside corner 0
  const enrichedFrames = sampleLap.frames.map((f, idx) => {
    const inCorner = f.lapDistPct >= corner.startPct && f.lapDistPct <= corner.exitPct;
    return {
      ...f,
      timestampMs: 1000 + idx * 320,
      posX: Math.sin(f.lapDistPct * Math.PI * 2) * 320,
      posZ: -Math.cos(f.lapDistPct * Math.PI * 2) * 320,
      frontWheelSlip: inCorner && f.brake > 0.4 ? 0.22 : f.frontWheelSlip,
    };
  });

  let profile = createDefaultDriverProfile(true);
  profile = recordCornerLearningFromLap({
    profile,
    track,
    lap: { ...sampleLap, valid: true, frames: enrichedFrames },
    referenceSamples: ref,
  });

  const key = makeCornerMemoryKey(track.id, corner.id);
  const mem1 = profile.cornerMemory?.[key];
  assert.ok(mem1, 'Corner memory entry should exist after first lap');
  assert.equal(mem1.attempts, 1);
  assert.ok(mem1.lockupEvents >= 1, 'Lockup inside corner should be recorded');
  assert.ok(mem1.bestPassFrames && mem1.bestPassFrames.length >= 5, 'Should store compact best pass frames');
  assert.ok(
    mem1.bestPassFrames!.some((pt) => Number.isFinite(pt.posX) && Number.isFinite(pt.posZ)),
    'Should preserve world posX/posZ coordinates in best pass frames'
  );

  const firstBestTime = mem1.bestTimeSec ?? 10;
  // Second lap: faster pass through corner with clean inputs should replace bestPassFrames and improve mastery
  const fasterFrames = enrichedFrames.map((f, idx) => ({
    ...f,
    timestampMs: 1000 + idx * 240,
    speedKmh: f.speedKmh * 1.12,
    frontWheelSlip: 0.04,
    rearWheelSlip: 0.04,
  }));
  profile = recordCornerLearningFromLap({
    profile,
    track,
    lap: { ...sampleLap, lapNumber: 2, valid: true, frames: fasterFrames },
    referenceSamples: ref,
  });

  const mem2 = profile.cornerMemory?.[key];
  assert.ok(mem2);
  assert.equal(mem2.attempts, 2);
  assert.ok((mem2.bestTimeSec ?? 99) < firstBestTime, 'Faster valid pass should lower bestTimeSec');
});

test('computeLearnedGreenLineCalibration gives newcomer safety margin and converges toward 1.0 for pro', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const corner = track.corners[0];

  const newcomer = createDefaultDriverProfile(true);
  const newcomerWithSlips = {
    ...newcomer,
    habits: { ...newcomer.habits, lockupCount: 3, exitSnapCount: 2, lateBrakeCount: 3 },
  };
  const newcomerCal = computeLearnedGreenLineCalibration({
    profile: newcomerWithSlips,
    corner,
    trackId: track.id,
    comparison: {
      cornerId: corner.id,
      cornerNumber: corner.number,
      cornerName: corner.name,
      sector: corner.sector,
      brakingDeltaMeters: 9,
      entrySpeedDeltaKmh: 6,
      minApexSpeedDeltaKmh: -6,
      exitSpeedDeltaKmh: -5,
      trailBrakingScore: 62,
      timeLostSec: 0.3,
      primaryIssue: 'Braked late & exit snap',
    },
  });

  assert.ok(newcomerCal.brakeEarlierMeters >= 4, 'Newcomer with lockups/late braking gets earlier brake target');
  assert.ok(newcomerCal.lateralMarginScale < 0.92, 'Newcomer leaves kerb safety margin');
  assert.ok(newcomerCal.exitSquareBias > 0.04, 'Newcomer with exit snaps squares off exit');

  const proProfile = {
    ...createDefaultDriverProfile(false),
    skillTier: 'pro' as const,
    habits: {
      lapsAnalyzed: 12,
      lateBrakeCount: 0,
      lockupCount: 0,
      exitSnapCount: 0,
      offTrackCount: 0,
      avgTrailBrakeScore: 93,
      avgDeltaSec: 0.1,
      brakingConsistencyPct: 96,
    },
  };
  const proCal = computeLearnedGreenLineCalibration({
    profile: proProfile,
    corner,
    trackId: track.id,
  });

  assert.ok(proCal.readiness > newcomerCal.readiness);
  assert.ok(proCal.lateralMarginScale >= 0.96);
  assert.equal(proCal.brakeEarlierMeters, 0);
});

test('computePitStrategy auto-selects optimal tires across short online newbie, practice/quali, damp, and endurance modes', () => {
  const track = TRACKS.find((t) => t.id === 'spa') ?? TRACKS[1];
  const car = CARS[0];
  const newcomer = createDefaultDriverProfile(true);
  const pro = createDefaultDriverProfile(false);

  // 1. Short Online / Beginner race with healthy tires (84%): keeps current tires (0s loss)
  const healthyShort = computePitStrategy(
    makeDummyFrame({ lapNumber: 3, fuelLiters: 18, tireWearPct: { fl: 84, fr: 85, rl: 88, rr: 89 } }),
    track,
    car,
    newcomer,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'short_online' }
  );
  assert.equal(healthyShort.resolvedRaceMode, 'short_online');
  assert.equal(healthyShort.tireAutoSelected, true);
  assert.equal(healthyShort.tireAction, 'fuel_only');
  assert.match(healthyShort.pitTireCallHeadline, /Keep Tires/i);

  // 2. Short Online / Beginner race with heavy lockups/wear: fits safe 4x Medium
  const flatSpotNewcomer = {
    ...newcomer,
    habits: { ...newcomer.habits, lockupCount: 3 },
  };
  const damagedShort = computePitStrategy(
    makeDummyFrame({ lapNumber: 4, fuelLiters: 16, tireWearPct: { fl: 68, fr: 70, rl: 76, rr: 78 } }),
    track,
    car,
    flatSpotNewcomer,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'short_online' }
  );
  assert.equal(damagedShort.tireAction, 'change_all');
  assert.equal(damagedShort.tireCompound, 'Medium');

  // 3. Damp track in ANY mode auto-selects 4x Wet
  const dampPlan = computePitStrategy(
    makeDummyFrame({ lapNumber: 2, fuelLiters: 24, tireWearPct: { fl: 96, fr: 96, rl: 96, rr: 96 } }),
    track,
    car,
    newcomer,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'short_online', trackCondition: 'damp' }
  );
  assert.equal(dampPlan.tireAction, 'change_all');
  assert.equal(dampPlan.tireCompound, 'Wet');

  // 4. Practice / Qualifying auto-selects Soft for experienced driver, Medium for newcomer
  const qualiPro = computePitStrategy(
    makeDummyFrame({ lapNumber: 2, fuelLiters: 15 }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'qualifying' }
  );
  assert.equal(qualiPro.resolvedRaceMode, 'practice_quali');
  assert.equal(qualiPro.tireCompound, 'Soft');

  const qualiNewcomer = computePitStrategy(
    makeDummyFrame({ lapNumber: 2, fuelLiters: 15 }),
    track,
    car,
    newcomer,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'qualifying' }
  );
  assert.equal(qualiNewcomer.tireCompound, 'Medium');

  // 5. Endurance hot stint for experienced driver auto-selects Hard
  const enduroHot = computePitStrategy(
    makeDummyFrame({ lapNumber: 5, fuelLiters: 35, tireWearPct: { fl: 78, fr: 79, rl: 82, rr: 83 } }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'endurance', trackCondition: 'hot' }
  );
  assert.equal(enduroHot.resolvedRaceMode, 'endurance');
  assert.equal(enduroHot.tireAction, 'change_all');
  assert.equal(enduroHot.tireCompound, 'Hard');

  // 6. Manual override respected when autoSelectPitTires is false
  const manualPlan = computePitStrategy(
    makeDummyFrame({ lapNumber: 3, fuelLiters: 22 }),
    track,
    car,
    newcomer,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: false, pitRaceMode: 'short_online', pitTireOverride: 'all_soft' }
  );
  assert.equal(manualPlan.tireAutoSelected, false);
  assert.equal(manualPlan.tireAction, 'change_all');
  assert.equal(manualPlan.tireCompound, 'Soft');
});

test('computePitStrategy detects Practice, Qualifying, Warmup, and Race sessions distinctly', () => {
  const track = TRACKS.find((t) => t.id === 'spa') ?? TRACKS[1];
  const car = CARS[0];
  const pro = createDefaultDriverProfile(false);

  const practicePlan = computePitStrategy(
    makeDummyFrame({ lapNumber: 2, fuelLiters: 20, sessionType: 'practice' }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'practice' }
  );
  assert.equal(practicePlan.detectedSessionType, 'practice');
  assert.equal(practicePlan.resolvedRaceMode, 'practice_quali');
  assert.match(practicePlan.sessionPhaseDetectedLabel, /Practice/i);
  assert.match(practicePlan.raceModeLabel, /Practice Session/i);
  assert.equal(practicePlan.tireCompound, 'Soft');

  const qualiPlan = computePitStrategy(
    makeDummyFrame({ lapNumber: 1, fuelLiters: 12, sessionType: 'qualifying' }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'qualifying' }
  );
  assert.equal(qualiPlan.detectedSessionType, 'qualifying');
  assert.match(qualiPlan.sessionPhaseDetectedLabel, /Qualifying/i);
  assert.match(qualiPlan.raceModeLabel, /Qualifying Session/i);
  assert.equal(qualiPlan.tireCompound, 'Soft');

  const warmupPlan = computePitStrategy(
    makeDummyFrame({ lapNumber: 1, fuelLiters: 38, sessionType: 'warmup' }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'warmup' }
  );
  assert.equal(warmupPlan.detectedSessionType, 'warmup');
  assert.match(warmupPlan.raceModeLabel, /Warmup/i);
  assert.equal(warmupPlan.tireCompound, 'Medium');

  const racePlan = computePitStrategy(
    makeDummyFrame({ lapNumber: 4, fuelLiters: 26, sessionType: 'race' }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'race' }
  );
  assert.equal(racePlan.detectedSessionType, 'race');
  assert.equal(racePlan.resolvedRaceMode, 'standard_online');
  assert.match(racePlan.sessionPhaseDetectedLabel, /Race/i);
  assert.match(racePlan.controlModeNote, /Read-only Pit MFD advisor/i);
});

test('computePitStrategy switches to BOX NOW with Repairs ON and fresh tires on crash_impact, flatTire, or wheelDetached', () => {
  const track = TRACKS.find((t) => t.id === 'spa') ?? TRACKS[1];
  const car = CARS[0];
  const pro = createDefaultDriverProfile(false);

  // Even in a short online race with 98% tire wear (normally Keep Tires), a crash_impact forces BOX NOW + Repairs ON + 4x Medium
  const crashPlan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 3,
      fuelLiters: 36,
      tireWearPct: { fl: 98, fr: 98, rl: 98, rr: 98 },
      sessionType: 'race',
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    {
      autoSelectPitTires: true,
      pitRaceMode: 'short_online',
      sessionType: 'race',
      recentIncidents: [
        {
          id: 'inc-crash-1',
          type: 'crash_impact',
          cornerNumber: 1,
          cornerName: 'Turn 1 (La Source)',
          lapNumber: 3,
          speedKmh: 62,
          impactDeltaKmh: 120,
          timestampMs: 10000,
        },
      ],
    }
  );
  assert.equal(crashPlan.crashAlertActive, true);
  assert.equal(crashPlan.repairsRecommended, true);
  assert.equal(crashPlan.pitCallUrgency, 'box_now_damage');
  assert.equal(crashPlan.recommendedPitLap, 3);
  assert.equal(crashPlan.tireAction, 'change_all');
  assert.equal(crashPlan.tireCompound, 'Medium');
  assert.match(crashPlan.crashReason ?? '', /Crash impact logged at Turn 1/i);
  assert.ok(crashPlan.mfdChecklist.some((line) => /Repairs MFD: ON/i.test(line)));

  // Flat tire from shared memory also forces BOX NOW + Repairs ON
  const flatPlan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 5,
      fuelLiters: 30,
      tireWearPct: { fl: 92, fr: 92, rl: 92, rr: 92 },
      flatTire: true,
      sessionType: 'race',
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'short_online', sessionType: 'race' }
  );
  assert.equal(flatPlan.crashAlertActive, true);
  assert.equal(flatPlan.repairsRecommended, true);
  assert.equal(flatPlan.tireAction, 'change_all');
  assert.match(flatPlan.crashReason ?? '', /puncture/i);

  // Detached wheel in qualifying forces BOX NOW + 4x Soft for pro
  const detachedQualiPlan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 2,
      fuelLiters: 14,
      wheelDetached: true,
      sessionType: 'qualifying',
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    undefined,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'qualifying' }
  );
  assert.equal(detachedQualiPlan.crashAlertActive, true);
  assert.equal(detachedQualiPlan.repairsRecommended, true);
  assert.equal(detachedQualiPlan.tireCompound, 'Soft');
  assert.match(detachedQualiPlan.crashReason ?? '', /Detached wheel/i);
});

test('computePitStrategy factors Hypercar Virtual Energy depletion and Preselect in LMU mode accurately', () => {
  const track = TRACKS[0]; // Le Mans
  const car = CARS[0]; // Hypercar
  const pro = createDefaultDriverProfile(false);

  // Plenty of physical fuel (60L -> ~10.3 laps), but VE at 20% (~1.8 laps) forces immediate earlier pit lap!
  const veLimitedPlan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 4,
      fuelLiters: 60,
      virtualEnergyPct: 20,
      sessionType: 'race',
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    16,
    {
      autoSelectPitTires: true,
      preselectPitTiresInLmu: true,
      sessionType: 'race',
    }
  );

  assert.equal(veLimitedPlan.stintLimitingFactor, 'virtual_energy');
  assert.ok(typeof veLimitedPlan.lapsOfVeLeft === 'number' && veLimitedPlan.lapsOfVeLeft < 3);
  assert.ok(veLimitedPlan.recommendedPitLap <= 6, `Expected VE-limited pit lap <= 6, got ${veLimitedPlan.recommendedPitLap}`);
  assert.match(veLimitedPlan.engineerSummary, /VE 20% limits stint/i);
  assert.match(veLimitedPlan.controlModeNote, /LMU Pit MFD Preselect ON/i);
});

test('computePitStrategy generates F1 Manager 24 stint timeline, Plan A/B/C options, cliff lap, and rejoin traffic forecast', () => {
  const track = TRACKS[0]; // Le Mans
  const car = CARS[0]; // Hypercar
  const pro = createDefaultDriverProfile(false);

  const plan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 4,
      fuelLiters: 18,
      virtualEnergyPct: 32,
      tireWearPct: { fl: 78, fr: 76, rl: 84, rr: 83 },
      sessionType: 'race',
      opponents: [
        {
          id: 'opp-1',
          carNumber: '51',
          driverName: 'A. Pier Guidi',
          carClass: 'Hypercar',
          carName: 'Ferrari 499P',
          lapDistPct: 0.25,
          speedKmh: 280,
          gapSeconds: -39.5,
          distanceMeters: -1950,
          closingSpeedKmh: 2,
          lateralSide: 'center',
          isAlongside: false,
          safetyRating: 'clean',
        },
      ],
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    14,
    {
      autoSelectPitTires: true,
      pitRaceMode: 'standard_online',
      sessionType: 'race',
    }
  );

  assert.equal(plan.pitNeededThisRace, true);
  assert.equal(plan.currentCompound, 'Medium');
  assert.equal(plan.activeStints.length, 2);
  assert.equal(plan.activeStints[0].isCurrent, true);
  assert.equal(plan.activeStints[1].isPitStopBefore, true);
  assert.equal(plan.activeStints[1].pitLap, plan.recommendedPitLap);
  assert.equal(plan.strategyOptions.length, 4);
  assert.deepEqual(
    plan.strategyOptions.map((o) => o.code),
    ['Plan Auto', 'Plan A', 'Plan B', 'Plan C']
  );
  const uniqueOverrides = new Set(plan.strategyOptions.map((o) => o.pitTireOverride));
  assert.equal(uniqueOverrides.size, 4);
  assert.equal(plan.strategyOptions[0].id, 'plan_auto');
  assert.equal(plan.strategyOptions[0].autoSelectPitTires, true);
  assert.ok(plan.estimatedCliffLap !== null && plan.estimatedCliffLap >= 4);
  assert.match(plan.rejoinTrafficNote, /#51 \(-39\.5s\)/i);
  assert.ok(plan.pitWindowStartLap <= plan.recommendedPitLap);
  assert.ok(plan.pitWindowEndLap >= plan.recommendedPitLap);

  // Selecting Plan B updates active call & stints while keeping Plan Auto as live dynamic baseline
  const planBOpt = plan.strategyOptions.find((o) => o.id === 'plan_b')!;
  const planBActive = computePitStrategy(
    makeDummyFrame({
      lapNumber: 4,
      fuelLiters: 18,
      virtualEnergyPct: 32,
      tireWearPct: { fl: 78, fr: 76, rl: 84, rr: 83 },
      sessionType: 'race',
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    14,
    {
      autoSelectPitTires: planBOpt.autoSelectPitTires,
      pitTireOverride: planBOpt.pitTireOverride,
      pitRaceMode: 'standard_online',
      sessionType: 'race',
    }
  );
  assert.equal(planBActive.tireAutoSelected, false);
  assert.equal(planBActive.pitTireCallHeadline, planBOpt.nextTireHeadline);
  assert.equal(planBActive.recommendedPitLap, planBOpt.pitLap);
  assert.equal(planBActive.strategyOptions[0].nextTireHeadline, plan.strategyOptions[0].nextTireHeadline);

  // Selecting Plan A sets manual 4x Medium baseline without losing Plan Auto
  const planAOpt = plan.strategyOptions.find((o) => o.id === 'plan_a')!;
  assert.equal(planAOpt.autoSelectPitTires, false);
  assert.equal(planAOpt.pitTireOverride, 'all_medium');
  const planAActive = computePitStrategy(
    makeDummyFrame({
      lapNumber: 4,
      fuelLiters: 18,
      virtualEnergyPct: 32,
      tireWearPct: { fl: 78, fr: 76, rl: 84, rr: 83 },
      sessionType: 'race',
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    14,
    {
      autoSelectPitTires: planAOpt.autoSelectPitTires,
      pitTireOverride: planAOpt.pitTireOverride,
      pitRaceMode: 'standard_online',
      sessionType: 'race',
    }
  );
  assert.equal(planAActive.tireAutoSelected, false);
  assert.equal(planAActive.pitTireCallHeadline, '4x Medium');
});

test('11-lap casual match stays No Stop cleanly unless crash/damage picks best replacement tires', () => {
  const track = TRACKS.find((t) => t.id === 'spa') ?? TRACKS[1]; // ~7km -> 3.2L/lap Hypercar fuel
  const car = CARS[0];
  const pro = createDefaultDriverProfile(false);

  // Clean 11-lap casual race with 40L fuel + 95% tires: no tire change or pit stop needed
  const lap1Frame = makeDummyFrame({
    lapNumber: 1,
    lapDistPct: 0.12,
    fuelLiters: 40,
    tireWearPct: { fl: 99, fr: 99, rl: 99, rr: 99 },
    sessionType: 'race',
    sessionTotalLaps: 11,
  });
  const casualClean = computePitStrategy(
    lap1Frame,
    track,
    car,
    pro,
    car.defaultSetup,
    11,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'race' }
  );
  assert.equal(casualClean.resolvedRaceMode, 'short_online');
  assert.equal(casualClean.raceLengthLaps, 11);
  assert.equal(casualClean.pitNeededThisRace, false);
  assert.equal(casualClean.tireAction, 'fuel_only');
  assert.match(casualClean.pitTireCallHeadline, /Keep Tires/i);
  assert.equal(casualClean.strategyOptions[0].id, 'plan_auto');
  assert.equal(casualClean.strategyOptions[0].name, 'No-Stop · 11L Match');
  assert.equal(casualClean.strategyOptions[0].pitRequired, false);
  assert.equal(new Set(casualClean.strategyOptions.map((o) => o.pitTireOverride)).size, 4);

  // Voice evaluator confirms No Stop once on Lap 1, then stays quiet on later clean laps
  let voiceState = createInitialPitStrategyVoiceState();
  const lap1Voice = evaluatePitStrategyVoiceCallout({
    strategy: casualClean,
    prevStrategy: null,
    frame: lap1Frame,
    settings: { voiceEnabled: true, pitWindowCountdownEnabled: true },
    voiceState,
    nowMs: 20000,
    carClass: car.carClass,
  });
  voiceState = lap1Voice.nextState;
  assert.equal(lap1Voice.eventType, 'no_stop_reassure');
  assert.match(lap1Voice.callout?.message ?? '', /11-lap short race/i);

  const lap6Voice = evaluatePitStrategyVoiceCallout({
    strategy: computePitStrategy(
      makeDummyFrame({
        lapNumber: 6,
        lapDistPct: 0.5,
        fuelLiters: 24,
        tireWearPct: { fl: 88, fr: 88, rl: 90, rr: 90 },
        sessionType: 'race',
        sessionTotalLaps: 11,
      }),
      track,
      car,
      pro,
      car.defaultSetup,
      11,
      { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'race' }
    ),
    prevStrategy: casualClean,
    frame: makeDummyFrame({ lapNumber: 6, lapDistPct: 0.5, sessionType: 'race' }),
    settings: { voiceEnabled: true, pitWindowCountdownEnabled: true },
    voiceState,
    nowMs: 180000,
    carClass: car.carClass,
  });
  assert.equal(lap6Voice.callout, null);

  // Crash in final 4 laps of 11-lap casual match -> BOX NOW, Repairs ON, optimal 4x Soft recovery compound
  const crashSprint = computePitStrategy(
    makeDummyFrame({
      lapNumber: 8,
      lapDistPct: 0.4,
      fuelLiters: 18,
      tireWearPct: { fl: 84, fr: 84, rl: 88, rr: 88 },
      flatTire: true,
      sessionType: 'race',
      sessionTotalLaps: 11,
    }),
    track,
    car,
    pro,
    car.defaultSetup,
    11,
    { autoSelectPitTires: true, pitRaceMode: 'auto', sessionType: 'race', trackCondition: 'optimal' }
  );
  assert.equal(crashSprint.crashAlertActive, true);
  assert.equal(crashSprint.repairsRecommended, true);
  assert.equal(crashSprint.pitCallUrgency, 'box_now_damage');
  assert.equal(crashSprint.recommendedPitLap, 8);
  assert.equal(crashSprint.tireAction, 'change_all');
  assert.equal(crashSprint.tireCompound, 'Soft');
  assert.equal(crashSprint.strategyOptions[0].id, 'plan_auto');
  assert.equal(crashSprint.strategyOptions[0].name, 'Box Now · Repair');
  assert.equal(crashSprint.strategyOptions[0].tag, 'Emergency');
  assert.equal(crashSprint.strategyOptions[0].nextCompound, 'Soft');
  assert.equal(crashSprint.strategyOptions[0].pitLap, 8);
});

test('driver learning adapts fuel/wear strategy dynamically and emits proactive pit window, box lap, and shift voice calls', () => {
  const track = TRACKS.find((t) => t.id === 'spa') ?? TRACKS[1];
  const car = CARS[0];
  let profile = createDefaultDriverProfile(false);

  const baselinePlan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 3,
      lapDistPct: 0.4,
      fuelLiters: 26,
      tireWearPct: { fl: 88, fr: 88, rl: 90, rr: 90 },
      sessionType: 'race',
    }),
    track,
    car,
    profile,
    car.defaultSetup,
    16,
    { autoSelectPitTires: true, pitRaceMode: 'standard_online', sessionType: 'race' }
  );

  // Simulate aggressive driving learned across laps: high fuel burn + heavy front lockups & high tire wear
  const lockupCallout: CoachCallout = {
    id: 'lock-1',
    timestampMs: 5000,
    lapNumber: 3,
    cornerName: 'Turn 1',
    severity: 'urgent',
    category: 'lockup',
    message: 'Lockup',
    spoken: true,
    source: 'realtime-engine',
  };
  for (let i = 0; i < 3; i++) {
    profile = recordDriverObservation(profile, lockupCallout, {
      deltaSec: 0.7,
      trailScore: 71,
      fuelBurnedLiters: 4.9,
      maxTireWearLostPct: 6.4,
    });
  }

  assert.ok((profile.habits.observedFuelPerLapLiters ?? 0) > 4.2);
  assert.ok((profile.habits.observedWearPerLapPct ?? 0) > 5.5);
  assert.equal(profile.habits.lockupCount, 3);

  const adaptedPlan = computePitStrategy(
    makeDummyFrame({
      lapNumber: 4,
      lapDistPct: 0.4,
      fuelLiters: 21,
      tireWearPct: { fl: 79, fr: 80, rl: 88, rr: 89 },
      sessionType: 'race',
    }),
    track,
    car,
    profile,
    car.defaultSetup,
    16,
    { autoSelectPitTires: true, pitRaceMode: 'standard_online', sessionType: 'race' }
  );

  assert.ok(adaptedPlan.fuelBurnPerLapLiters > baselinePlan.fuelBurnPerLapLiters);
  assert.ok(adaptedPlan.recommendedPitLap < baselinePlan.recommendedPitLap);
  assert.equal(adaptedPlan.tireAction, 'change_all');
  assert.equal(adaptedPlan.strategyOptions[0].id, 'plan_auto');
  assert.equal(adaptedPlan.strategyOptions[0].name, 'Adaptive · Re-Timed');
  assert.ok(adaptedPlan.learnedAdaptationNote && /Adapted from your driving/i.test(adaptedPlan.learnedAdaptationNote));

  // Verify proactive voice sequence: learned shift -> pit window open -> box this lap
  let voiceState = createInitialPitStrategyVoiceState();
  const shiftEval = evaluatePitStrategyVoiceCallout({
    strategy: adaptedPlan,
    prevStrategy: baselinePlan,
    frame: makeDummyFrame({ lapNumber: 4, lapDistPct: 0.25, sessionType: 'race' }),
    settings: { voiceEnabled: true, pitWindowCountdownEnabled: true },
    voiceState,
    nowMs: 40000,
    carClass: car.carClass,
  });
  voiceState = shiftEval.nextState;
  assert.equal(shiftEval.eventType, 'learned_strategy_shift');
  assert.match(shiftEval.callout?.message ?? '', /Strategy update/i);

  const windowEval = evaluatePitStrategyVoiceCallout({
    strategy: adaptedPlan,
    prevStrategy: adaptedPlan,
    frame: makeDummyFrame({ lapNumber: adaptedPlan.pitWindowStartLap, lapDistPct: 0.2, sessionType: 'race' }),
    settings: { voiceEnabled: true, pitWindowCountdownEnabled: true },
    voiceState,
    nowMs: 70000,
    carClass: car.carClass,
  });
  voiceState = windowEval.nextState;
  assert.equal(windowEval.eventType, 'pit_window_open');
  assert.match(windowEval.callout?.message ?? '', /Pit window open/i);

  const boxEval = evaluatePitStrategyVoiceCallout({
    strategy: adaptedPlan,
    prevStrategy: adaptedPlan,
    frame: makeDummyFrame({ lapNumber: adaptedPlan.recommendedPitLap, lapDistPct: 0.55, sessionType: 'race' }),
    settings: { voiceEnabled: true, pitWindowCountdownEnabled: true },
    voiceState,
    nowMs: 110000,
    carClass: car.carClass,
  });
  assert.equal(boxEval.eventType, 'box_this_lap');
  assert.match(boxEval.callout?.message ?? '', /Box this lap/i);
});






