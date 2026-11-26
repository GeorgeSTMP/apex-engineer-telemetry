import test from 'node:test';
import assert from 'node:assert/strict';
import { CARS, TRACKS } from '../data/circuitsAndCars';
import {
  applyRecommendationsToSetup,
  buildSmartSetupPlan,
  DEFAULT_DRIVER_SETUP_INTAKE,
  diagnoseAndRecommendSetup,
  exportSetupToLmuText,
  parseDriverSetupFeedback,
  sanitizeAiSetupAdjustments,
} from './setupPhysics';
import type { TelemetryFrame } from '../types/telemetry';

test('diagnoseAndRecommendSetup shifts brake bias rearward on front lockup', () => {
  const car = CARS[0]; // Porsche 963 LMDh
  const track = TRACKS[0]; // Le Mans
  const baseSetup = car.defaultSetup;

  const diagnosis = diagnoseAndRecommendSetup(baseSetup, 'late_brake_lockup', car, track);
  assert.ok(diagnosis.adjustments.length >= 2);

  const biasAdj = diagnosis.adjustments.find((a) => a.parameterKey === 'brakeBiasPct');
  assert.ok(biasAdj);
  assert.ok((biasAdj.numericTarget ?? 99) < baseSetup.brakeBiasPct);

  const updated = applyRecommendationsToSetup(baseSetup, diagnosis.adjustments);
  assert.equal(updated.brakeBiasPct, biasAdj.numericTarget);
  // Original setup remains immutable
  assert.equal(baseSetup.brakeBiasPct, 56.4);
});

test('diagnoseAndRecommendSetup softens rear ARB and boosts power diff on exit snap oversteer', () => {
  const car = CARS[2]; // Porsche 911 GT3 R
  const track = TRACKS[1]; // Spa
  const diagnosis = diagnoseAndRecommendSetup(car.defaultSetup, 'exit_snap_oversteer', car, track);

  const rearArb = diagnosis.adjustments.find((a) => a.parameterKey === 'rearArbClicks');
  const diffPower = diagnosis.adjustments.find((a) => a.parameterKey === 'diffPowerPct');
  assert.ok(rearArb && diffPower);
  assert.equal(rearArb.numericTarget, car.defaultSetup.rearArbClicks - 1);
  assert.equal(diffPower.numericTarget, car.defaultSetup.diffPowerPct + 6);
});

test('exportSetupToLmuText outputs valid LMU setup configuration lines', () => {
  const car = CARS[0];
  const track = TRACKS[0];
  const text = exportSetupToLmuText(car.defaultSetup, car, track);
  assert.match(text, /BrakeBiasSetting=56\.4%/);
  assert.match(text, /FrontAntiSwaySetting=5 clicks/);
  assert.match(text, /Porsche 963 LMDh/);
});

test('parseDriverSetupFeedback extracts multiple symptoms, corner mentions, and severity', () => {
  const track = TRACKS[0]; // Circuit de la Sarthe
  const parsed = parseDriverSetupFeedback(
    'Severe rear snap on exit at Porsche Curves and fronts keep locking into T1 braking.',
    track
  );

  assert.ok(parsed.detectedSymptoms.includes('exit_snap_oversteer'));
  assert.ok(parsed.detectedSymptoms.includes('late_brake_lockup'));
  assert.equal(parsed.severityMultiplier, 1.35);
  assert.ok(parsed.mentionedCorners.some((c) => c.name.toLowerCase().includes('porsche')));
  assert.ok(parsed.mentionedCorners.some((c) => c.number === 1));
});

test('buildSmartSetupPlan synthesizes notes, conditions, telemetry, and class hardware rules', () => {
  const hypercar = CARS.find((c) => c.carClass === 'Hypercar')!;
  const gt3 = CARS.find((c) => c.carClass === 'LMGT3')!;
  const track = TRACKS[0];

  const hotFrame: TelemetryFrame = {
    timestampMs: 50_000,
    lapNumber: 4,
    lapDistPct: 0.3,
    speedKmh: 185,
    rpm: 7000,
    maxRpm: 8500,
    gear: 4,
    throttle: 0.1,
    brake: 0.85,
    steeringRad: 0.05,
    latG: 0.4,
    longG: -1.6,
    deltaSec: 0.4,
    fuelLiters: 42,
    tireTempC: { fl: 105, fr: 104, rl: 96, rr: 95 },
    tirePressurePsi: { fl: 27.9, fr: 27.8, rl: 26.8, rr: 26.8 },
    tireWearPct: { fl: 86, fr: 86, rl: 89, rr: 89 },
    brakeTempC: { fl: 520, fr: 520, rl: 400, rr: 400 },
    frontWheelSlip: 0.24,
    rearWheelSlip: 0.05,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
  };

  const hcPlan = buildSmartSetupPlan({
    setup: hypercar.defaultSetup,
    intake: {
      ...DEFAULT_DRIVER_SETUP_INTAKE,
      freeTextFeedback: 'Car snaps on throttle exit at T12 Porsche Curves and pushes slightly on entry.',
      trackCondition: 'hot',
      stintObjective: 'endurance_stability',
      brakingFeel: 'aggressive_late',
      useTelemetrySignals: true,
    },
    car: hypercar,
    track,
    latestFrame: hotFrame,
  });

  assert.ok(hcPlan.detectedSymptoms.includes('exit_snap_oversteer'));
  assert.ok(hcPlan.detectedSymptoms.includes('entry_understeer'));
  assert.ok(hcPlan.detectedSymptoms.includes('late_brake_lockup'));
  assert.ok(hcPlan.detectedSymptoms.includes('tire_overheating'));
  assert.equal(
    hcPlan.adjustments.some((a) => a.parameterKey === 'absLevel'),
    false,
    'Hypercar plan must never emit ABS adjustment'
  );
  assert.ok(hcPlan.signals.some((s) => s.source === 'telemetry'));
  assert.ok(hcPlan.signals.some((s) => s.source === 'conditions'));
  assert.ok(hcPlan.resolvedCornerLabel?.includes('12'));

  const applied = applyRecommendationsToSetup(hypercar.defaultSetup, hcPlan.adjustments);
  assert.ok(applied.brakeBiasPct < hypercar.defaultSetup.brakeBiasPct);

  const gt3Plan = buildSmartSetupPlan({
    setup: gt3.defaultSetup,
    intake: {
      ...DEFAULT_DRIVER_SETUP_INTAKE,
      primarySymptom: 'late_brake_lockup',
      useTelemetrySignals: false,
    },
    car: gt3,
    track,
  });
  assert.equal(
    gt3Plan.adjustments.some((a) => a.parameterKey === 'brakeMigrationPct'),
    false,
    'LMGT3 plan must never emit Brake Migration'
  );
  assert.ok(gt3Plan.adjustments.some((a) => a.parameterKey === 'absLevel'));
});

test('sanitizeAiSetupAdjustments enforces class rules and clamps bounds', () => {
  const hypercar = CARS.find((c) => c.carClass === 'Hypercar')!;
  const gt3 = CARS.find((c) => c.carClass === 'LMGT3')!;

  const rawAi = [
    { parameterKey: 'absLevel', numericTarget: 6, reason: 'Illegal for Hypercar' },
    { parameterKey: 'brakeBiasPct', numericTarget: 30.0, reason: 'Extreme bias should clamp' },
    { parameterKey: 'brakeMigrationPct', numericTarget: 2.0, reason: 'Legal for Hypercar, illegal for GT3' },
  ];

  const hcSanitized = sanitizeAiSetupAdjustments(rawAi, hypercar.defaultSetup, hypercar);
  assert.equal(hcSanitized.some((a) => a.parameterKey === 'absLevel'), false);
  const bias = hcSanitized.find((a) => a.parameterKey === 'brakeBiasPct');
  assert.equal(bias?.numericTarget, 48.0);
  assert.ok(hcSanitized.some((a) => a.parameterKey === 'brakeMigrationPct'));

  const gt3Sanitized = sanitizeAiSetupAdjustments(rawAi, gt3.defaultSetup, gt3);
  assert.equal(gt3Sanitized.some((a) => a.parameterKey === 'brakeMigrationPct'), false);
  assert.ok(gt3Sanitized.some((a) => a.parameterKey === 'absLevel'));
});

