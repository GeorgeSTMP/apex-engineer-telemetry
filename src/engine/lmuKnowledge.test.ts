import test from 'node:test';
import assert from 'node:assert/strict';
import { CARS, TRACKS } from '../data/circuitsAndCars';
import { createInitialCooldowns, evaluateLiveTelemetry } from './coachRules';
import { buildAdaptiveElectronicsSuggestions, createDefaultDriverProfile } from './driverLearning';
import {
  buildEnglishOnlyPromptDirective,
  buildLiveOutputTranscriptionConfig,
  buildLiveVoiceSpeechConfig,
  buildLmuSystemKnowledgeBlock,
  buildVoiceProfilePromptDirective,
  getLmuCarClassRules,
  normalizeCarClass,
  normalizeGeminiLiveVoiceName,
  STRICT_ENGLISH_ONLY_RULE,
} from './lmuKnowledge';
import { recommendLmuPresets } from './lmuProPresets';
import { buildSessionTransitionMessage } from './sessionPhase';
import { diagnoseAndRecommendSetup, exportSetupToLmuText } from './setupPhysics';
import type { CoachSettings, TelemetryFrame } from '../types/telemetry';

const baseDirectSettings: CoachSettings = {
  voiceEnabled: true,
  useGeminiTts: true,
  geminiVoiceName: 'Fenrir',
  language: 'en',
  focusMode: 'all',
  radioProtocol: 'pro_terse',
  preCornerCuesEnabled: true,
  racecraftAlertsEnabled: true,
  multiclassTrafficEnabled: true,
  tireAlertsEnabled: true,
  tirePressureAlertsEnabled: true,
  brakeTempAlertsEnabled: true,
  fuelAlertsEnabled: true,
  pitWindowCountdownEnabled: true,
  fuelSaveCallsEnabled: false,
  fuelTargetLitersPerLap: 0,
  gapSplitsEnabled: true,
  sectorSplitsEnabled: true,
  electronicsCheckEnabled: true,
  trackLimitsAlertsEnabled: true,
  tractionAlertsEnabled: true,
  lapPaceAlertsEnabled: true,
  urgentInterruptsRadio: true,
  autonomyMode: 'advise',
  radioSquelchFx: true,
  verbosity: 'minimal',
  minSpeakIntervalSec: 4,
  lateBrakeThresholdMeters: 10,
  hazardAlertsEnabled: true,
  speechRate: 1.06,
  voiceVolume: 0.95,
};

function makeFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    timestampMs: 100_000,
    lapNumber: 3,
    lapDistPct: 0.25,
    speedKmh: 210,
    rpm: 7100,
    maxRpm: 8500,
    gear: 5,
    throttle: 0.8,
    brake: 0,
    clutch: 0,
    steeringRad: 0,
    latG: 0.5,
    longG: 0.1,
    deltaSec: -0.12,
    fuelLiters: 40,
    virtualEnergyPct: 80,
    tireTempC: { fl: 86, fr: 86, rl: 84, rr: 84 },
    tirePressurePsi: { fl: 26.5, fr: 26.5, rl: 26.1, rr: 26.1 },
    tireWearPct: { fl: 92, fr: 92, rl: 93, rr: 93 },
    brakeTempC: { fl: 460, fr: 460, rl: 390, rr: 390 },
    frontWheelSlip: 0.04,
    rearWheelSlip: 0.04,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
    opponents: [],
    ...overrides,
  };
}

const dummyDriverProfile = {
  ...createDefaultDriverProfile(false),
  habits: {
    ...createDefaultDriverProfile(false).habits,
    lateBrakeCount: 6,
    lockupCount: 5,
    exitSnapCount: 2,
    offTrackCount: 1,
    avgTrailBrakeScore: 78,
  },
};

test('All Hypercar and LMP2 profiles strictly have No ABS while LMGT3 profiles have ABS', () => {
  const hypercars = CARS.filter((c) => c.carClass === 'Hypercar');
  const lmp2s = CARS.filter((c) => c.carClass === 'LMP2');
  const gt3s = CARS.filter((c) => c.carClass === 'LMGT3');

  assert.ok(hypercars.length >= 4);
  assert.ok(gt3s.length >= 2);

  const sampleFrame = makeFrame();

  for (const hc of [...hypercars, ...lmp2s]) {
    assert.equal(hc.defaultSetup.absLevel, 0, `${hc.name} must default absLevel to 0`);
    const rules = getLmuCarClassRules(hc.carClass);
    assert.equal(rules.hasAbs, false);

    const diag = diagnoseAndRecommendSetup(hc.defaultSetup, 'late_brake_lockup', hc, TRACKS[0]);
    assert.equal(
      diag.adjustments.some((a) => a.parameterKey === 'absLevel'),
      false,
      `${hc.name} must not get absLevel setup adjustment`
    );

    const presets = recommendLmuPresets(hc, TRACKS[0], dummyDriverProfile, [], sampleFrame);
    for (const rec of presets) {
      assert.equal(rec.preset.setup.absLevel, 0, `${hc.name} preset ${rec.preset.id} must have absLevel 0`);
    }

    const eSugg = buildAdaptiveElectronicsSuggestions(
      dummyDriverProfile,
      hc.defaultSetup,
      hc
    );
    assert.equal(
      eSugg.some((s) => s.parameter === 'absLevel'),
      false,
      `${hc.name} must not suggest ABS electronics click`
    );
  }

  for (const gt3 of gt3s) {
    assert.ok(gt3.defaultSetup.absLevel >= 1, `${gt3.name} should have active ABS`);
    assert.equal(getLmuCarClassRules(gt3.carClass).hasAbs, true);
    const diag = diagnoseAndRecommendSetup(gt3.defaultSetup, 'late_brake_lockup', gt3, TRACKS[0]);
    assert.ok(
      diag.adjustments.some((a) => a.parameterKey === 'absLevel'),
      `${gt3.name} should include absLevel advice for lockup`
    );
    assert.equal(
      diag.adjustments.some((a) => a.parameterKey === 'brakeMigrationPct'),
      false,
      `${gt3.name} (LMGT3) must not suggest Brake Migration`
    );
  }

  assert.equal(normalizeCarClass('Oreca 07 LMP2'), 'LMP2');
  assert.equal(normalizeCarClass('LMGT3'), 'LMGT3');
  assert.equal(normalizeCarClass('LMH'), 'Hypercar');
});

test('LMU system knowledge covers full weekend flow, VE%, No Tire Warmers, MFD pits, and multiclass rules', () => {
  const block = buildLmuSystemKnowledgeBlock({
    carClass: 'Hypercar',
    carName: 'Porsche 963 LMDh',
    trackName: 'Circuit de la Sarthe',
    sessionPhase: 'qualifying',
    virtualEnergyPct: 44,
  });

  assert.match(block, /NO ABS/i);
  assert.match(block, /Virtual Energy/i);
  assert.match(block, /Stop-and-Go/i);
  assert.match(block, /NO TIRE WARMERS/i);
  assert.match(block, /Pit MFD/i);
  assert.match(block, /MULTICLASS/i);
  assert.match(block, /QUALIFYING/i);

  const hypercar = CARS[0];
  const lmuIni = exportSetupToLmuText(hypercar.defaultSetup, hypercar, TRACKS[0]);
  assert.match(lmuIni, /ABSSetting=N\/A \(No ABS on Hypercar\)/);
  assert.match(lmuIni, /VirtualEnergyPitTarget=100%/);
});

test('Race Direct (pro_terse) keeps telemetry callouts immediate, <= 12 words, with zero filler', () => {
  const track = TRACKS[0];
  const hypercar = CARS.find((c) => c.carClass === 'Hypercar')!;
  const corner = track.corners[2];

  const scenarios: Array<{ name: string; frame: TelemetryFrame; prev: TelemetryFrame | null; cornerMatch?: boolean }> = [
    {
      name: 'hazard ahead',
      frame: makeFrame({ hazardAhead: true, hazardDistanceM: 120 }),
      prev: null,
    },
    {
      name: 'front lockup',
      frame: makeFrame({ brake: 0.9, frontWheelSlip: 0.25, speedKmh: 150, lapDistPct: corner.brakeMarkerPct }),
      prev: null,
      cornerMatch: true,
    },
    {
      name: 'car alongside left',
      frame: makeFrame({
        opponents: [
          {
            id: 'opp-1',
            carNumber: '8',
            driverName: 'Buemi',
            carClass: 'Hypercar',
            carName: 'Toyota GR010',
            lapDistPct: 0.25,
            speedKmh: 210,
            gapSeconds: 0,
            distanceMeters: 0,
            closingSpeedKmh: 5,
            lateralSide: 'left',
            isAlongside: true,
            safetyRating: 'clean',
          },
        ],
      }),
      prev: null,
    },
    {
      name: 'hypercar critical virtual energy',
      frame: makeFrame({ fuelLiters: 25, virtualEnergyPct: 12 }),
      prev: null,
    },
    {
      name: 'cold tires warmup',
      frame: makeFrame({ tireTempC: { fl: 58, fr: 59, rl: 57, rr: 57 } }),
      prev: null,
    },
  ];

  for (const s of scenarios) {
    const { callout } = evaluateLiveTelemetry(
      s.frame,
      s.prev,
      track,
      s.cornerMatch ? corner : null,
      null,
      baseDirectSettings,
      createInitialCooldowns(),
      dummyDriverProfile,
      hypercar
    );
    assert.ok(callout, `${s.name} should trigger a callout`);
    const words = callout.message.trim().split(/\s+/);
    assert.ok(
      words.length <= 12,
      `${s.name} callout "${callout.message}" has ${words.length} words (expected <= 12)`
    );
    assert.doesNotMatch(callout.message, /^(Copy that|Watch out|Okay)/i);
  }

  const promptDir = buildVoiceProfilePromptDirective('pro_terse');
  assert.match(promptDir, /3 to 10 words MAX/i);

  const qualiDirect = buildSessionTransitionMessage('qualifying', 'practice', 'pro_terse');
  assert.ok(qualiDirect);
  assert.match(qualiDirect.message, /out-lap/i);
  assert.ok(qualiDirect.message.split(/\s+/).length <= 12);

  const qualiDetail = buildSessionTransitionMessage('qualifying', 'practice', 'coaching_detail');
  assert.ok(qualiDetail);
  assert.match(qualiDetail.message, /no tire warmers/i);
});

test('LMU Penalty Active triggers urgent drive-through / limiter callout in Race Direct and Detailed modes', () => {
  const track = TRACKS[0];
  const hypercar = CARS.find((c) => c.carClass === 'Hypercar')!;
  const penaltyFrame = makeFrame({ penaltyActive: true });

  const direct = evaluateLiveTelemetry(
    penaltyFrame,
    null,
    track,
    null,
    null,
    baseDirectSettings,
    createInitialCooldowns(),
    dummyDriverProfile,
    hypercar
  );
  assert.ok(direct.callout);
  assert.equal(direct.callout.severity, 'urgent');
  assert.match(direct.callout.message, /Penalty active/i);
  assert.match(direct.callout.message, /limiter/i);
  assert.ok(direct.callout.message.split(/\s+/).length <= 12);

  const detail = evaluateLiveTelemetry(
    penaltyFrame,
    null,
    track,
    null,
    null,
    { ...baseDirectSettings, radioProtocol: 'coaching_detail' },
    createInitialCooldowns(),
    dummyDriverProfile,
    hypercar
  );
  assert.ok(detail.callout);
  assert.match(detail.callout.message, /Stewards penalty active/i);
});

test('LMU Formation Lap coaches <50C weaving vs >=50C brake/throttle drag and suppresses normal chatter', () => {
  const track = TRACKS[0];
  const hypercar = CARS.find((c) => c.carClass === 'Hypercar')!;

  const coldForm = makeFrame({
    inFormationLap: true,
    speedKmh: 95,
    tireTempC: { fl: 42, fr: 43, rl: 41, rr: 42 },
  });
  const coldRes = evaluateLiveTelemetry(
    coldForm,
    null,
    track,
    null,
    null,
    baseDirectSettings,
    createInitialCooldowns(),
    dummyDriverProfile,
    hypercar
  );
  assert.ok(coldRes.callout);
  assert.match(coldRes.callout.message, /weave gently under 50°C/i);
  assert.match(coldRes.callout.message, /class lane/i);

  const warmForm = makeFrame({
    inFormationLap: true,
    speedKmh: 110,
    tireTempC: { fl: 56, fr: 55, rl: 54, rr: 54 },
  });
  const warmRes = evaluateLiveTelemetry(
    warmForm,
    null,
    track,
    null,
    null,
    baseDirectSettings,
    createInitialCooldowns(),
    dummyDriverProfile,
    hypercar
  );
  assert.ok(warmRes.callout);
  assert.match(warmRes.callout.message, /drag brake & throttle/i);

  // During cooldown on formation lap, normal cold-tire warning is suppressed
  const suppressedRes = evaluateLiveTelemetry(
    { ...coldForm, timestampMs: coldForm.timestampMs + 2000 },
    coldForm,
    track,
    null,
    null,
    baseDirectSettings,
    coldRes.nextCooldowns,
    dummyDriverProfile,
    hypercar
  );
  assert.equal(suppressedRes.callout, null);
});

test('Pit exit cold slicks reminder triggers on garage/pit transition and Pit Window calls MFD fuel/VE + repairs OFF', () => {
  const track = TRACKS[0];
  const hypercar = CARS.find((c) => c.carClass === 'Hypercar')!;
  const gt3 = CARS.find((c) => c.carClass === 'LMGT3')!;

  const inPitPrev = makeFrame({ inPitOrGarage: true, speedKmh: 60 });
  const pitExitFrame = makeFrame({
    inPitOrGarage: false,
    speedKmh: 95,
    tireTempC: { fl: 48, fr: 48, rl: 46, rr: 46 },
  });
  const pitExitRes = evaluateLiveTelemetry(
    pitExitFrame,
    inPitPrev,
    track,
    null,
    null,
    baseDirectSettings,
    createInitialCooldowns(),
    dummyDriverProfile,
    hypercar
  );
  assert.ok(pitExitRes.callout);
  assert.match(pitExitRes.callout.message, /Pit exit: cold slicks/i);
  assert.match(pitExitRes.callout.message, /zero warmers/i);

  const hypercarPitFrame = makeFrame({ fuelLiters: 9.2, virtualEnergyPct: 24 });
  const hcPitRes = evaluateLiveTelemetry(
    hypercarPitFrame,
    null,
    track,
    null,
    null,
    baseDirectSettings,
    createInitialCooldowns(),
    dummyDriverProfile,
    hypercar
  );
  assert.ok(hcPitRes.callout);
  assert.match(hcPitRes.callout.message, /Pit window open/i);
  assert.match(hcPitRes.callout.message, /MFD fuel \+ VE, repairs OFF/i);

  const gt3PitRes = evaluateLiveTelemetry(
    makeFrame({ fuelLiters: 9.2, carClass: 'LMGT3' }),
    null,
    track,
    null,
    null,
    baseDirectSettings,
    createInitialCooldowns(),
    dummyDriverProfile,
    gt3
  );
  assert.ok(gt3PitRes.callout);
  assert.match(gt3PitRes.callout.message, /Pit window open/i);
  assert.match(gt3PitRes.callout.message, /MFD fuel, repairs OFF/i);
});

test('Strict English-only directives and Live Voice/TTS speech configs lock AI output to English', () => {
  assert.match(STRICT_ENGLISH_ONLY_RULE, /ONLY in English/i);
  assert.match(STRICT_ENGLISH_ONLY_RULE, /NEVER speak, reply, or switch into Greek/i);

  for (const ctx of ['live_voice', 'pit_radio', 'analysis', 'debrief', 'setup'] as const) {
    const dir = buildEnglishOnlyPromptDirective(ctx);
    assert.match(dir, /ONLY in English/i);
    assert.match(dir, /Greek/i);
  }

  assert.equal(normalizeGeminiLiveVoiceName('Charon'), 'Charon');
  assert.equal(normalizeGeminiLiveVoiceName('Stefanos'), 'Fenrir');

  const strictSpeech = buildLiveVoiceSpeechConfig('Kore', true);
  assert.equal((strictSpeech as { languageCode?: string }).languageCode, 'en-US');
  assert.equal(strictSpeech.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');

  const fallbackSpeech = buildLiveVoiceSpeechConfig('invalid', false);
  assert.equal('languageCode' in fallbackSpeech, false);
  assert.equal(fallbackSpeech.voiceConfig.prebuiltVoiceConfig.voiceName, 'Fenrir');

  assert.deepEqual(buildLiveOutputTranscriptionConfig(true), { languageCodes: ['en-US', 'en-GB'] });
  assert.deepEqual(buildLiveOutputTranscriptionConfig(false), {});
});


