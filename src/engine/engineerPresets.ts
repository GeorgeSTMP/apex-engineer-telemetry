import type { CoachFocusMode, CoachSettings, RadioProtocol } from '../types/telemetry';

export type RadioModuleKey =
  | 'hazardAlertsEnabled'
  | 'racecraftAlertsEnabled'
  | 'multiclassTrafficEnabled'
  | 'gapSplitsEnabled'
  | 'sectorSplitsEnabled'
  | 'fuelAlertsEnabled'
  | 'pitWindowCountdownEnabled'
  | 'fuelSaveCallsEnabled'
  | 'electronicsCheckEnabled'
  | 'tireAlertsEnabled'
  | 'tirePressureAlertsEnabled'
  | 'brakeTempAlertsEnabled'
  | 'preCornerCuesEnabled'
  | 'trackLimitsAlertsEnabled'
  | 'tractionAlertsEnabled'
  | 'lapPaceAlertsEnabled';

export type RadioModuleCategory =
  | 'pit_wall'
  | 'car_electronics'
  | 'traffic_safety'
  | 'driving_coach';

export interface RadioModuleDefinition {
  key: RadioModuleKey;
  label: string;
  proTag: string;
  category: RadioModuleCategory;
  description: string;
}

export const RADIO_MODULE_CATEGORY_LABELS: Record<RadioModuleCategory, string> = {
  pit_wall: 'Pit Wall & Strategy',
  car_electronics: 'Car, Tires & Electronics',
  traffic_safety: 'Traffic & Race Control',
  driving_coach: 'Driving & Technique',
};

export const RADIO_MODULE_CATALOG: RadioModuleDefinition[] = [
  {
    key: 'gapSplitsEnabled',
    label: 'Rival Gap & Closing Splits',
    proTag: 'Pit Wall',
    category: 'pit_wall',
    description: 'Live gaps ahead/behind and closing rate on straights.',
  },
  {
    key: 'sectorSplitsEnabled',
    label: 'Sector Splits (Green / Loss)',
    proTag: 'Timing',
    category: 'pit_wall',
    description: 'Calls sector 1 & 2 delta immediately at timing loops.',
  },
  {
    key: 'pitWindowCountdownEnabled',
    label: 'Pit Window & Box Countdown',
    proTag: 'Strategy',
    category: 'pit_wall',
    description: 'Opens pit window ~2 laps before dry and preps limiter.',
  },
  {
    key: 'fuelAlertsEnabled',
    label: 'Critical Fuel Reserve Alert',
    proTag: 'Emergency',
    category: 'pit_wall',
    description: 'Urgent box call when tank drops below critical reserve.',
  },
  {
    key: 'fuelSaveCallsEnabled',
    label: 'Lift & Coast Fuel Target',
    proTag: 'Endurance',
    category: 'pit_wall',
    description: 'Endurance fuel-burn target and lift-and-coast reminders.',
  },
  {
    key: 'electronicsCheckEnabled',
    label: 'Brake Bias & TC Dial Calls',
    proTag: 'Electronics',
    category: 'car_electronics',
    description: 'Advises rearward brake bias or TC map clicks from telemetry.',
  },
  {
    key: 'tireAlertsEnabled',
    label: 'Tire Temp Window & Wear',
    proTag: 'Tires',
    category: 'car_electronics',
    description: 'Cold warmup, overheat alerts, optimal window & wear check-in.',
  },
  {
    key: 'tirePressureAlertsEnabled',
    label: 'Tire Pressure (PSI) Monitor',
    proTag: 'Tires',
    category: 'car_electronics',
    description: 'Slow-puncture under-inflation and high-PSI grip loss calls.',
  },
  {
    key: 'brakeTempAlertsEnabled',
    label: 'Brake Disc Overheat',
    proTag: 'Brakes',
    category: 'car_electronics',
    description: 'High brake disc temperature warnings (>740°C) & cooling.',
  },
  {
    key: 'hazardAlertsEnabled',
    label: 'Yellow Flags & Crash Ahead',
    proTag: 'Race Control',
    category: 'traffic_safety',
    description: 'Immediate hazard distance & stopped-car warnings.',
  },
  {
    key: 'racecraftAlertsEnabled',
    label: 'Wheel-to-Wheel Spotter',
    proTag: 'Spotter',
    category: 'traffic_safety',
    description: 'Car left / right, three-wide, clear calls, attack/defend.',
  },
  {
    key: 'multiclassTrafficEnabled',
    label: 'Multiclass Closing Traffic',
    proTag: 'WEC / IMSA',
    category: 'traffic_safety',
    description: 'Calls faster Hypercar/LMP2 closing from behind on approach.',
  },
  {
    key: 'preCornerCuesEnabled',
    label: 'Pre-Corner Brake & Gear Cues',
    proTag: 'Track Walk',
    category: 'driving_coach',
    description: 'Upcoming turn brake marker distance, gear & apex speed.',
  },
  {
    key: 'trackLimitsAlertsEnabled',
    label: 'Track Limits & Off-Track',
    proTag: 'Stewards',
    category: 'driving_coach',
    description: 'Exit kerb track-limit warnings to protect valid laps.',
  },
  {
    key: 'tractionAlertsEnabled',
    label: 'Corner Exit Wheelspin / Snap',
    proTag: 'Telemetry',
    category: 'driving_coach',
    description: 'Detects rear wheelspin and snap oversteer on throttle.',
  },
  {
    key: 'lapPaceAlertsEnabled',
    label: 'Start/Finish Lap Debrief',
    proTag: 'Pace',
    category: 'driving_coach',
    description: 'Cross-line lap delta and concise pace feedback.',
  },
];

export interface FactoryEngineerPreset {
  id: string;
  label: string;
  teamTag: string;
  hint: string;
  patch: Partial<CoachSettings>;
}

export interface CustomEngineerPreset {
  id: string;
  name: string;
  description?: string;
  patch: Partial<CoachSettings>;
}

export const FACTORY_ENGINEER_PRESETS: FactoryEngineerPreset[] = [
  {
    id: 'wec_engineer',
    label: 'WEC Race Engineer',
    teamTag: 'Pro Pit Wall',
    hint: 'Gaps, pit window, multiclass & terse dials.',
    patch: {
      radioProtocol: 'pro_terse',
      verbosity: 'minimal',
      minSpeakIntervalSec: 10,
      focusMode: 'all',
      urgentInterruptsRadio: true,
      lateBrakeThresholdMeters: 10,
      autonomyMode: 'advise',
      hazardAlertsEnabled: true,
      racecraftAlertsEnabled: true,
      multiclassTrafficEnabled: true,
      gapSplitsEnabled: true,
      sectorSplitsEnabled: false,
      fuelAlertsEnabled: true,
      pitWindowCountdownEnabled: true,
      fuelSaveCallsEnabled: true,
      electronicsCheckEnabled: true,
      tireAlertsEnabled: true,
      tirePressureAlertsEnabled: true,
      brakeTempAlertsEnabled: true,
      preCornerCuesEnabled: false,
      trackLimitsAlertsEnabled: true,
      tractionAlertsEnabled: false,
      lapPaceAlertsEnabled: true,
    },
  },
  {
    id: 'quali_push',
    label: 'Qualifying Push',
    teamTag: 'Time Attack',
    hint: 'Sector splits, tire window, track limits only.',
    patch: {
      radioProtocol: 'pro_terse',
      verbosity: 'balanced',
      minSpeakIntervalSec: 6,
      focusMode: 'all',
      urgentInterruptsRadio: true,
      lateBrakeThresholdMeters: 8,
      autonomyMode: 'advise',
      hazardAlertsEnabled: true,
      racecraftAlertsEnabled: true,
      multiclassTrafficEnabled: true,
      gapSplitsEnabled: false,
      sectorSplitsEnabled: true,
      fuelAlertsEnabled: false,
      pitWindowCountdownEnabled: false,
      fuelSaveCallsEnabled: false,
      electronicsCheckEnabled: false,
      tireAlertsEnabled: true,
      tirePressureAlertsEnabled: true,
      brakeTempAlertsEnabled: false,
      preCornerCuesEnabled: false,
      trackLimitsAlertsEnabled: true,
      tractionAlertsEnabled: true,
      lapPaceAlertsEnabled: true,
    },
  },
  {
    id: 'endurance_stint',
    label: 'Endurance Stint',
    teamTag: '24H Strategy',
    hint: 'Fuel save, lift & coast, wear & brake temps.',
    patch: {
      radioProtocol: 'endurance_calm',
      verbosity: 'balanced',
      minSpeakIntervalSec: 12,
      focusMode: 'all',
      urgentInterruptsRadio: true,
      lateBrakeThresholdMeters: 12,
      autonomyMode: 'advise',
      hazardAlertsEnabled: true,
      racecraftAlertsEnabled: true,
      multiclassTrafficEnabled: true,
      gapSplitsEnabled: true,
      sectorSplitsEnabled: false,
      fuelAlertsEnabled: true,
      pitWindowCountdownEnabled: true,
      fuelSaveCallsEnabled: true,
      electronicsCheckEnabled: true,
      tireAlertsEnabled: true,
      tirePressureAlertsEnabled: true,
      brakeTempAlertsEnabled: true,
      preCornerCuesEnabled: false,
      trackLimitsAlertsEnabled: true,
      tractionAlertsEnabled: false,
      lapPaceAlertsEnabled: false,
    },
  },
  {
    id: 'track_coach',
    label: 'Track Coach',
    teamTag: 'Driver Dev',
    hint: 'Full braking, corner cues, apex & exit coaching.',
    patch: {
      radioProtocol: 'coaching_detail',
      verbosity: 'detailed',
      minSpeakIntervalSec: 4,
      focusMode: 'all',
      urgentInterruptsRadio: true,
      lateBrakeThresholdMeters: 9,
      autonomyMode: 'advise',
      hazardAlertsEnabled: true,
      racecraftAlertsEnabled: true,
      multiclassTrafficEnabled: false,
      gapSplitsEnabled: false,
      sectorSplitsEnabled: true,
      fuelAlertsEnabled: true,
      pitWindowCountdownEnabled: false,
      fuelSaveCallsEnabled: false,
      electronicsCheckEnabled: true,
      tireAlertsEnabled: true,
      tirePressureAlertsEnabled: true,
      brakeTempAlertsEnabled: true,
      preCornerCuesEnabled: true,
      trackLimitsAlertsEnabled: true,
      tractionAlertsEnabled: true,
      lapPaceAlertsEnabled: true,
    },
  },
  {
    id: 'spotter_only',
    label: 'Pro Spotter Only',
    teamTag: 'Traffic Only',
    hint: 'Alongside calls, multiclass & yellow flags.',
    patch: {
      radioProtocol: 'pro_terse',
      verbosity: 'minimal',
      minSpeakIntervalSec: 6,
      focusMode: 'all',
      urgentInterruptsRadio: true,
      lateBrakeThresholdMeters: 12,
      autonomyMode: 'advise',
      hazardAlertsEnabled: true,
      racecraftAlertsEnabled: true,
      multiclassTrafficEnabled: true,
      gapSplitsEnabled: true,
      sectorSplitsEnabled: false,
      fuelAlertsEnabled: true,
      pitWindowCountdownEnabled: false,
      fuelSaveCallsEnabled: false,
      electronicsCheckEnabled: false,
      tireAlertsEnabled: false,
      tirePressureAlertsEnabled: false,
      brakeTempAlertsEnabled: false,
      preCornerCuesEnabled: false,
      trackLimitsAlertsEnabled: false,
      tractionAlertsEnabled: false,
      lapPaceAlertsEnabled: false,
    },
  },
  {
    id: 'silent_critical',
    label: 'Silent / Critical',
    teamTag: 'Minimal Radio',
    hint: 'Emergency hazards & critical fuel only.',
    patch: {
      radioProtocol: 'pro_terse',
      verbosity: 'minimal',
      minSpeakIntervalSec: 25,
      focusMode: 'all',
      urgentInterruptsRadio: true,
      lateBrakeThresholdMeters: 14,
      autonomyMode: 'advise',
      hazardAlertsEnabled: true,
      racecraftAlertsEnabled: false,
      multiclassTrafficEnabled: false,
      gapSplitsEnabled: false,
      sectorSplitsEnabled: false,
      fuelAlertsEnabled: true,
      pitWindowCountdownEnabled: false,
      fuelSaveCallsEnabled: false,
      electronicsCheckEnabled: false,
      tireAlertsEnabled: false,
      tirePressureAlertsEnabled: false,
      brakeTempAlertsEnabled: false,
      preCornerCuesEnabled: false,
      trackLimitsAlertsEnabled: true,
      tractionAlertsEnabled: false,
      lapPaceAlertsEnabled: false,
    },
  },
];

export const RADIO_PROTOCOL_META: Record<
  RadioProtocol,
  { label: string; hint: string }
> = {
  pro_terse: {
    label: 'Race Direct (Immediate)',
    hint: 'Immediate 3–9 word cockpit radio, zero filler, action first for maximum driving focus',
  },
  endurance_calm: {
    label: 'Endurance Calm',
    hint: 'Steady stint updates, fuel/VE preservation & traffic',
  },
  coaching_detail: {
    label: 'Coaching Detail',
    hint: 'Explains braking markers, trail-off & exit technique',
  },
};

export function isModuleEnabledInPatch(
  patch: Partial<CoachSettings>,
  key: RadioModuleKey
): boolean {
  return Boolean(patch[key]);
}

export function getEnabledModulesForPatch(
  patch: Partial<CoachSettings>
): RadioModuleDefinition[] {
  return RADIO_MODULE_CATALOG.filter((m) => isModuleEnabledInPatch(patch, m.key));
}

export function getAvailableModulesForPatch(
  patch: Partial<CoachSettings>
): RadioModuleDefinition[] {
  return RADIO_MODULE_CATALOG.filter((m) => !isModuleEnabledInPatch(patch, m.key));
}

export function setModuleInPatch(
  patch: Partial<CoachSettings>,
  key: RadioModuleKey,
  enabled: boolean
): Partial<CoachSettings> {
  return {
    ...patch,
    [key]: enabled,
  };
}

export function setModuleCategoryInPatch(
  patch: Partial<CoachSettings>,
  category: RadioModuleCategory,
  enabled: boolean
): Partial<CoachSettings> {
  const next = { ...patch };
  for (const mod of RADIO_MODULE_CATALOG) {
    if (mod.category === category) {
      next[mod.key] = enabled;
    }
  }
  return next;
}

export function extractPresetPatch(settings: CoachSettings): Partial<CoachSettings> {
  return {
    radioProtocol: settings.radioProtocol ?? 'coaching_detail',
    verbosity: settings.verbosity,
    minSpeakIntervalSec: settings.minSpeakIntervalSec ?? 5,
    focusMode: settings.focusMode,
    urgentInterruptsRadio: settings.urgentInterruptsRadio ?? true,
    lateBrakeThresholdMeters: settings.lateBrakeThresholdMeters,
    autonomyMode: settings.autonomyMode,
    geminiVoiceName: settings.geminiVoiceName,
    speechRate: settings.speechRate,
    voiceVolume: settings.voiceVolume ?? 0.95,
    fuelTargetLitersPerLap: settings.fuelTargetLitersPerLap ?? 0,
    hazardAlertsEnabled: settings.hazardAlertsEnabled,
    racecraftAlertsEnabled: settings.racecraftAlertsEnabled,
    multiclassTrafficEnabled: settings.multiclassTrafficEnabled ?? false,
    gapSplitsEnabled: settings.gapSplitsEnabled ?? false,
    sectorSplitsEnabled: settings.sectorSplitsEnabled ?? false,
    fuelAlertsEnabled: settings.fuelAlertsEnabled ?? true,
    pitWindowCountdownEnabled: settings.pitWindowCountdownEnabled ?? false,
    fuelSaveCallsEnabled: settings.fuelSaveCallsEnabled ?? false,
    electronicsCheckEnabled: settings.electronicsCheckEnabled ?? false,
    tireAlertsEnabled: settings.tireAlertsEnabled ?? true,
    tirePressureAlertsEnabled: settings.tirePressureAlertsEnabled ?? true,
    brakeTempAlertsEnabled: settings.brakeTempAlertsEnabled ?? true,
    preCornerCuesEnabled: settings.preCornerCuesEnabled,
    trackLimitsAlertsEnabled: settings.trackLimitsAlertsEnabled ?? true,
    tractionAlertsEnabled: settings.tractionAlertsEnabled ?? true,
    lapPaceAlertsEnabled: settings.lapPaceAlertsEnabled ?? true,
  };
}

export function matchesPresetExact(
  settings: CoachSettings,
  patch: Partial<CoachSettings>
): boolean {
  if ((settings.verbosity ?? 'balanced') !== (patch.verbosity ?? 'balanced')) return false;
  if ((settings.minSpeakIntervalSec ?? 5) !== (patch.minSpeakIntervalSec ?? 5)) return false;
  if ((settings.focusMode ?? 'all') !== (patch.focusMode ?? 'all')) return false;
  if (
    patch.radioProtocol &&
    (settings.radioProtocol ?? 'coaching_detail') !== patch.radioProtocol
  ) {
    return false;
  }
  for (const mod of RADIO_MODULE_CATALOG) {
    if (patch[mod.key] !== undefined && Boolean(settings[mod.key]) !== Boolean(patch[mod.key])) {
      return false;
    }
  }
  return true;
}

export function makeUniquePresetName(base: string, existingNames: string[]): string {
  const trimmed = base.trim() || 'Custom Team Radio';
  const lowerSet = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  if (!lowerSet.has(trimmed.toLowerCase())) return trimmed;
  let counter = 2;
  while (lowerSet.has(`${trimmed} (${counter})`.toLowerCase())) {
    counter += 1;
  }
  return `${trimmed} (${counter})`;
}

export function createCustomPresetFromFactory(
  factory: FactoryEngineerPreset,
  existingNames: string[],
  nowMs = Date.now()
): CustomEngineerPreset {
  const name = makeUniquePresetName(`${factory.label} Custom`, existingNames);
  return {
    id: `custom-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    description: factory.hint,
    patch: { ...factory.patch },
  };
}

export function createCustomPresetFromSettings(
  name: string,
  settings: CoachSettings,
  existingNames: string[],
  nowMs = Date.now()
): CustomEngineerPreset {
  return {
    id: `custom-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
    name: makeUniquePresetName(name, existingNames),
    patch: extractPresetPatch(settings),
  };
}

export type SettingsConflictId =
  | 'voice_muted'
  | 'focus_pauses_braking'
  | 'focus_pauses_exit'
  | 'fuel_target_unused'
  | 'urgent_delayed'
  | 'protocol_verbosity_mismatch';

export interface SettingsConflictNotice {
  id: SettingsConflictId;
  severity: 'info' | 'warning';
  message: string;
  fixLabel: string;
  resolvePatch: Partial<CoachSettings>;
}

const FOCUS_LABELS: Record<CoachFocusMode, string> = {
  all: 'All Areas',
  braking: 'Braking & Lockups Only',
  apex_line: 'Racing Line & Apex Speed',
  throttle_exit: 'Throttle & Exit Traction',
};

export function getModuleFocusConflictReason(
  key: RadioModuleKey,
  focusMode: CoachFocusMode = 'all'
): string | null {
  if (focusMode === 'all') return null;
  if (key === 'tractionAlertsEnabled' && focusMode !== 'throttle_exit') {
    return `Paused by Focus Mode (${FOCUS_LABELS[focusMode]})`;
  }
  return null;
}

export function detectSettingsConflicts(settings: CoachSettings): SettingsConflictNotice[] {
  const notices: SettingsConflictNotice[] = [];
  const focusMode = settings.focusMode ?? 'all';
  const focusLabel = FOCUS_LABELS[focusMode];

  if (!settings.voiceEnabled) {
    notices.push({
      id: 'voice_muted',
      severity: 'info',
      message:
        'Spoken Pit Radio is OFF — callouts still log in text, while Voice tab audio controls are muted.',
      fixLabel: 'Unmute Radio',
      resolvePatch: { voiceEnabled: true },
    });
  }

  if (focusMode !== 'all' && focusMode !== 'braking') {
    notices.push({
      id: 'focus_pauses_braking',
      severity: 'warning',
      message: `Coaching Focus "${focusLabel}" pauses lockup/braking coaching and Late Braking Threshold.`,
      fixLabel: 'Set Focus: All Areas',
      resolvePatch: { focusMode: 'all' },
    });
  }

  if (focusMode !== 'all' && focusMode !== 'throttle_exit' && (settings.tractionAlertsEnabled ?? true)) {
    notices.push({
      id: 'focus_pauses_exit',
      severity: 'warning',
      message: `Coaching Focus "${focusLabel}" pauses Corner Exit Wheelspin / Snap even though it is checked in Alerts.`,
      fixLabel: 'Set Focus: All Areas',
      resolvePatch: { focusMode: 'all' },
    });
  }

  const fuelTarget = settings.fuelTargetLitersPerLap ?? 0;
  if (fuelTarget > 0 && !settings.pitWindowCountdownEnabled && !settings.fuelSaveCallsEnabled) {
    notices.push({
      id: 'fuel_target_unused',
      severity: 'warning',
      message: `Fuel Target (${fuelTarget.toFixed(1)} L/lap) is configured, but Pit Window & Lift/Coast alerts are both OFF.`,
      fixLabel: 'Enable Fuel Strategy',
      resolvePatch: { pitWindowCountdownEnabled: true, fuelSaveCallsEnabled: true },
    });
  }

  const speakGap = settings.minSpeakIntervalSec ?? 5;
  if (settings.urgentInterruptsRadio === false && speakGap >= 12) {
    notices.push({
      id: 'urgent_delayed',
      severity: 'warning',
      message: `Urgent Warnings Interrupt is OFF with a ${speakGap}s gap — crash, lockup, and car-alongside calls wait up to ${speakGap}s.`,
      fixLabel: 'Allow Urgent Interrupts',
      resolvePatch: { urgentInterruptsRadio: true },
    });
  }

  if (settings.radioProtocol === 'pro_terse' && settings.verbosity === 'detailed') {
    notices.push({
      id: 'protocol_verbosity_mismatch',
      severity: 'warning',
      message:
        'Race Direct (Immediate) Voice Profile is active, while Extra Commentary is set to Detailed corner-entry tips.',
      fixLabel: 'Set Alerts Only',
      resolvePatch: { verbosity: 'minimal' },
    });
  }

  return notices;
}

