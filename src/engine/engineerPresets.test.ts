import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomPresetFromFactory,
  detectSettingsConflicts,
  FACTORY_ENGINEER_PRESETS,
  getAvailableModulesForPatch,
  getEnabledModulesForPatch,
  getModuleFocusConflictReason,
  matchesPresetExact,
  RADIO_MODULE_CATALOG,
  setModuleCategoryInPatch,
  setModuleInPatch,
} from './engineerPresets';
import type { CoachSettings } from '../types/telemetry';

const baseSettings: CoachSettings = {
  voiceEnabled: true,
  useGeminiTts: true,
  geminiVoiceName: 'Fenrir',
  language: 'en',
  focusMode: 'all',
  radioProtocol: 'coaching_detail',
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
  verbosity: 'balanced',
  minSpeakIntervalSec: 5,
  lateBrakeThresholdMeters: 10,
  hazardAlertsEnabled: true,
  speechRate: 1.05,
};

test('FACTORY_ENGINEER_PRESETS includes pro racing team presets with distinct protocols and modules', () => {
  assert.ok(FACTORY_ENGINEER_PRESETS.length >= 6);
  const wec = FACTORY_ENGINEER_PRESETS.find((p) => p.id === 'wec_engineer')!;
  const quali = FACTORY_ENGINEER_PRESETS.find((p) => p.id === 'quali_push')!;
  const endurance = FACTORY_ENGINEER_PRESETS.find((p) => p.id === 'endurance_stint')!;

  assert.equal(wec.patch.radioProtocol, 'pro_terse');
  assert.equal(wec.patch.gapSplitsEnabled, true);
  assert.equal(wec.patch.pitWindowCountdownEnabled, true);
  assert.equal(quali.patch.sectorSplitsEnabled, true);
  assert.equal(quali.patch.fuelSaveCallsEnabled, false);
  assert.equal(endurance.patch.fuelSaveCallsEnabled, true);
});

test('createCustomPresetFromFactory allows adding and removing individual pro modules and categories', () => {
  const wec = FACTORY_ENGINEER_PRESETS.find((p) => p.id === 'wec_engineer')!;
  const custom1 = createCustomPresetFromFactory(wec, [], 1000);
  const custom2 = createCustomPresetFromFactory(wec, [custom1.name], 2000);

  assert.equal(custom1.name, 'WEC Race Engineer Custom');
  assert.equal(custom2.name, 'WEC Race Engineer Custom (2)');

  const initialEnabled = getEnabledModulesForPatch(custom1.patch);
  const initialAvailable = getAvailableModulesForPatch(custom1.patch);
  assert.equal(initialEnabled.length + initialAvailable.length, RADIO_MODULE_CATALOG.length);

  // Remove a module (gapSplitsEnabled) and add a missing module (sectorSplitsEnabled)
  let edited = setModuleInPatch(custom1.patch, 'gapSplitsEnabled', false);
  assert.equal(edited.gapSplitsEnabled, false);
  assert.ok(getAvailableModulesForPatch(edited).some((m) => m.key === 'gapSplitsEnabled'));

  edited = setModuleInPatch(edited, 'sectorSplitsEnabled', true);
  assert.equal(edited.sectorSplitsEnabled, true);
  assert.ok(getEnabledModulesForPatch(edited).some((m) => m.key === 'sectorSplitsEnabled'));

  // Bulk add a whole category
  edited = setModuleCategoryInPatch(edited, 'driving_coach', true);
  assert.equal(edited.preCornerCuesEnabled, true);
  assert.equal(edited.tractionAlertsEnabled, true);

  // matchesPresetExact reflects module differences accurately
  const appliedSettings: CoachSettings = { ...baseSettings, ...edited };
  assert.equal(matchesPresetExact(appliedSettings, edited), true);
  assert.equal(matchesPresetExact(appliedSettings, wec.patch), false);
});

test('All factory presets have zero internal conflicts and detectSettingsConflicts resolves cross-tab issues', () => {
  for (const preset of FACTORY_ENGINEER_PRESETS) {
    const merged: CoachSettings = { ...baseSettings, ...preset.patch };
    const conflicts = detectSettingsConflicts(merged);
    assert.equal(conflicts.length, 0, `Preset ${preset.id} should have 0 conflicts`);
  }

  const conflicted: CoachSettings = {
    ...baseSettings,
    voiceEnabled: false,
    focusMode: 'apex_line',
    tractionAlertsEnabled: true,
    fuelTargetLitersPerLap: 4.5,
    pitWindowCountdownEnabled: false,
    fuelSaveCallsEnabled: false,
    urgentInterruptsRadio: false,
    minSpeakIntervalSec: 18,
    radioProtocol: 'pro_terse',
    verbosity: 'detailed',
  };

  const detected = detectSettingsConflicts(conflicted);
  assert.ok(detected.some((c) => c.id === 'voice_muted'));
  assert.ok(detected.some((c) => c.id === 'focus_pauses_braking'));
  assert.ok(detected.some((c) => c.id === 'focus_pauses_exit'));
  assert.ok(detected.some((c) => c.id === 'fuel_target_unused'));
  assert.ok(detected.some((c) => c.id === 'urgent_delayed'));
  assert.ok(detected.some((c) => c.id === 'protocol_verbosity_mismatch'));

  assert.ok(getModuleFocusConflictReason('tractionAlertsEnabled', 'braking'));
  assert.equal(getModuleFocusConflictReason('tireAlertsEnabled', 'braking'), null);
  assert.equal(getModuleFocusConflictReason('trackLimitsAlertsEnabled', 'braking'), null);

  let resolved = { ...conflicted };
  for (const c of detected) {
    resolved = { ...resolved, ...c.resolvePatch };
  }
  assert.equal(detectSettingsConflicts(resolved).length, 0);
});
