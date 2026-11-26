import type { RadioProtocol, SimSessionType } from '../types/telemetry';

export type LmuCarClass = 'Hypercar' | 'LMP2' | 'LMGT3';

export interface LmuCarClassRules {
  carClass: LmuCarClass;
  hasAbs: boolean;
  hasVirtualEnergy: boolean;
  hasHybridBattery: boolean;
  hasBrakeMigration: boolean;
  hasDualTractionControl: boolean;
  optimalTireTempRangeC: [number, number];
  lockupPreventionRule: string;
  stintEnergyRule: string;
}

export const LMU_CAR_CLASS_RULES: Record<LmuCarClass, LmuCarClassRules> = {
  Hypercar: {
    carClass: 'Hypercar',
    hasAbs: false,
    hasVirtualEnergy: true,
    hasHybridBattery: true,
    hasBrakeMigration: true,
    hasDualTractionControl: true,
    optimalTireTempRangeC: [78, 98],
    lockupPreventionRule:
      'NO ABS on Hypercar (LMH/LMDh). Fix front lockups ONLY via Brake Bias rearward (-0.5% to -1.5%), Brake Migration forward/bleed, and progressive pedal release — NEVER recommend ABS.',
    stintEnergyRule:
      'Tracks both Fuel and Virtual Energy (VE 0-100%). Hitting 0% VE triggers a harsh Stop-and-Go penalty; refill BOTH Fuel and VE in the Pit MFD, and watch LMDh MGU battery depletion on pit exit.',
  },
  LMP2: {
    carClass: 'LMP2',
    hasAbs: false,
    hasVirtualEnergy: false,
    hasHybridBattery: false,
    hasBrakeMigration: true,
    hasDualTractionControl: true,
    optimalTireTempRangeC: [78, 95],
    lockupPreventionRule:
      'NO ABS on LMP2 (Oreca 07 Gibson). Fix lockups via Brake Bias rearward, Brake Migration, and threshold pedal bleed — NEVER recommend ABS.',
    stintEnergyRule:
      'Pure fuel-limited stint (no Virtual Energy tank, no hybrid). Manage lift-and-coast for stint length.',
  },
  LMGT3: {
    carClass: 'LMGT3',
    hasAbs: true,
    hasVirtualEnergy: false,
    hasHybridBattery: false,
    hasBrakeMigration: false,
    hasDualTractionControl: true,
    optimalTireTempRangeC: [75, 92],
    lockupPreventionRule:
      'LMGT3 HAS adjustable ABS (Map 1-10) plus TC1/TC2 and Brake Bias. Higher ABS protects cold or bumpy braking zones; lower ABS gives shorter dry threshold stops.',
    stintEnergyRule:
      'Fuel-limited stint (no Virtual Energy). Manage TC1 power cut and TC2 slip for rear tire life.',
  },
};

export function normalizeCarClass(raw?: string | null): LmuCarClass {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.includes('lmp2') || s.includes('oreca')) return 'LMP2';
  if (s.includes('gt3') || s.includes('gte')) return 'LMGT3';
  return 'Hypercar';
}

export function getLmuCarClassRules(rawClass?: string | null): LmuCarClassRules {
  return LMU_CAR_CLASS_RULES[normalizeCarClass(rawClass)];
}

export interface VoiceProfileMeta {
  id: RadioProtocol;
  label: string;
  shortLabel: string;
  hint: string;
  maxWordsGuide: string;
  ttsCadenceHint: string;
}

export const VOICE_PROFILE_DEFS: Record<RadioProtocol, VoiceProfileMeta> = {
  pro_terse: {
    id: 'pro_terse',
    label: 'Race Direct (Immediate)',
    shortLabel: 'Race Direct',
    hint: 'Immediate 3–9 word cockpit radio, zero filler, action first for total focus',
    maxWordsGuide: '3 to 9 words max (single direct phrase)',
    ttsCadenceHint: 'Immediate, clipped, urgent-focus pit-wall radio with zero small talk',
  },
  endurance_calm: {
    id: 'endurance_calm',
    label: 'Endurance Calm',
    shortLabel: 'Endurance',
    hint: 'Steady stint updates, fuel/VE targets, traffic & brake preservation',
    maxWordsGuide: '1 to 2 concise sentences',
    ttsCadenceHint: 'Calm, confident, steady endurance race engineer over pit radio',
  },
  coaching_detail: {
    id: 'coaching_detail',
    label: 'Coaching Detail',
    shortLabel: 'Coach',
    hint: 'Explains braking markers, trail-off release & exit technique',
    maxWordsGuide: '2 to 3 clear coaching sentences',
    ttsCadenceHint: 'Clear, constructive British motorsport driver coach over pit radio',
  },
};

export function buildVoiceProfilePromptDirective(protocol?: RadioProtocol | null): string {
  const mode: RadioProtocol = protocol ?? 'coaching_detail';
  if (mode === 'pro_terse') {
    return (
      'VOICE PROFILE — RACE DIRECT (IMMEDIATE FOCUS): ' +
      'The driver is actively driving at race speed and needs zero distraction. ' +
      'Respond IMMEDIATELY in 3 to 10 words MAX (1 ultra-short clipped phrase). ' +
      'NEVER say "Copy that", "Hello", "Sure", "Watch out", or repeat their question. ' +
      'State ONLY the critical fact + single cockpit action first. ' +
      'Examples: "T5 lockup — bias 1% rear.", "Box this lap, 4L left.", "Tires cold — smooth turn-in.", "Clear left. Push.", "Car right — hold inside." ' +
      'Only expand beyond 10 words if a complex setup/strategy breakdown is explicitly requested.'
    );
  }
  if (mode === 'endurance_calm') {
    return (
      'VOICE PROFILE — ENDURANCE CALM: ' +
      'Keep calls steady, brief, and low-stress (1 to 2 concise sentences), prioritizing fuel/Virtual Energy targets, tire preservation, pit window, and clean multiclass traffic.'
    );
  }
  return (
    'VOICE PROFILE — COACHING DETAIL: ' +
    'Give clear, actionable coaching in 2 to 3 crisp sentences explaining exact braking markers, trail-brake release, apex speed, and exit throttle technique.'
  );
}

export function buildLmuSessionPhaseRule(sessionPhase?: SimSessionType | string | null): string {
  const phase = String(sessionPhase ?? 'unknown').toLowerCase();
  switch (phase) {
    case 'practice':
      return 'CURRENT PHASE — PRACTICE: Focus on tire warmup (no tire blankets in LMU), track rubbering/grip evolution, braking markers, and verifying Fuel/Virtual Energy burn per lap.';
    case 'qualifying':
      return 'CURRENT PHASE — QUALIFYING / HYPERPOLE: NO tire warmers in LMU — slicks start cold out of pit lane! Spend the out-lap building brake and tire temperature progressively, leave a clean-air gap before starting the timed flyer, and watch exit track limits (instant lap deletion).';
    case 'warmup':
      return 'CURRENT PHASE — WARMUP: Verify full-tank race brake bias, traction maps, cold-tire T1 turn-in balance, and pre-set Pit MFD strategy before the race grid.';
    case 'race':
      return 'CURRENT PHASE — RACE: Rolling/formation start runs by class order (Hypercar -> LMP2 -> LMGT3) — weave gently under ~50°C and drag brakes/throttle progressively above ~50°C, no passing in class before green S/F line. Manage Fuel & Virtual Energy, pit limiter before white line, MFD 2-tire (~7s) vs 4-tire (~12s) + repair toggle OFF unless structural damage, track-limit penalty points, and multiclass blue flags.';
    default:
      return 'WEEKEND FLOW: Respect Practice, Qualifying (cold out-lap, no tire warmers), Formation/Rolling Start, Pit MFD (fuel + VE%, 2 vs 4 tires, repairs OFF if unnecessary, pit limiter), Track Limits, and Multiclass Traffic.';
  }
}

export function buildLmuSystemKnowledgeBlock(params: {
  carClass?: string | null;
  carName?: string | null;
  trackName?: string | null;
  sessionPhase?: SimSessionType | string | null;
  virtualEnergyPct?: number | null;
}): string {
  const rules = getLmuCarClassRules(params.carClass);
  const veNote =
    rules.hasVirtualEnergy && typeof params.virtualEnergyPct === 'number' && Number.isFinite(params.virtualEnergyPct)
      ? ` Live Virtual Energy: ${Math.round(params.virtualEnergyPct)}%.`
      : '';

  return [
    `LE MANS ULTIMATE (LMU) VERIFIED GAMEPLAY & CLASS RULES (${params.carName || 'Car'} — Class: ${rules.carClass}, Track: ${params.trackName || 'Circuit'}):`,
    `1. HARDWARE RULE: ${rules.lockupPreventionRule}`,
    `2. ENERGY & FUEL RULE: ${rules.stintEnergyRule}${veNote}`,
    `3. TIRES (NO TIRE WARMERS): LMU starts on cold slicks (~50°C). Do not push 100% into Turn 1 on an out-lap or race start. Optimal core window for ${rules.carClass} is ${rules.optimalTireTempRangeC[0]}–${rules.optimalTireTempRangeC[1]}°C. Under 50°C gentle weaving helps; above 50°C use heavy braking/acceleration loading.`,
    `4. PIT STOP & MFD FLOW: Always configure fuel + Virtual Energy (for Hypercar), tire swap (2 fronts ~7s vs 4 tires ~12s), and turn bodywork repair OFF unless structural aero/suspension damage in the Pit MFD BEFORE entering pit lane. Engage pit speed limiter before the white entry line and hit the exact pit stall box.`,
    `5. TRACK LIMITS & FLAGS: Off-tracks accumulate penalty points leading to a Drive-Through or time penalty — cut throttle cleanly if running wide. Under Full Course Yellow / slow car ahead, respect speed delta.`,
    `6. MULTICLASS RACECRAFT (Hypercar > LMP2 > LMGT3): Faster prototypes pass off-line cleanly; slower LMGT3/LMP2 cars MUST stay on the predictable racing line (never swerve suddenly to yield).`,
    buildLmuSessionPhaseRule(params.sessionPhase),
  ].join(' ');
}

export const STRICT_ENGLISH_ONLY_RULE =
  'STRICT ENGLISH-ONLY LANGUAGE LOCK: Speak, write, and output ONLY in English at all times. NEVER speak, reply, or switch into Greek or any other language—even if the driver speaks or writes in Greek or another language, uses non-English words, or has a foreign accent. Always understand their intent and respond strictly in crisp, natural motorsport English.';

export const ALLOWED_GEMINI_LIVE_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'] as const;
export type AllowedGeminiLiveVoice = (typeof ALLOWED_GEMINI_LIVE_VOICES)[number];

export function normalizeGeminiLiveVoiceName(rawVoice?: string | null): AllowedGeminiLiveVoice {
  return (ALLOWED_GEMINI_LIVE_VOICES as readonly string[]).includes(rawVoice ?? '')
    ? (rawVoice as AllowedGeminiLiveVoice)
    : 'Fenrir';
}

export function buildEnglishOnlyPromptDirective(
  context: 'live_voice' | 'pit_radio' | 'analysis' | 'debrief' | 'setup' = 'pit_radio'
): string {
  const cornerRule =
    'Always specify corners using both turn number and corner name (e.g., "T5 Daytona Chicane").';
  switch (context) {
    case 'live_voice':
      return `${STRICT_ENGLISH_ONLY_RULE} ${cornerRule}`;
    case 'pit_radio':
      return `${STRICT_ENGLISH_ONLY_RULE} ${cornerRule}`;
    case 'debrief':
      return `${STRICT_ENGLISH_ONLY_RULE} Write ALL JSON text fields exclusively in authoritative motorsport English. ${cornerRule}`;
    case 'analysis':
      return `${STRICT_ENGLISH_ONLY_RULE} Write ALL JSON diagnosis, fix, spokenSummary, and setup fields exclusively in motorsport English. ${cornerRule}`;
    case 'setup':
      return `${STRICT_ENGLISH_ONLY_RULE} Write all setup engineering explanations exclusively in crisp motorsport English.`;
  }
}

export function buildLiveVoiceSpeechConfig(voiceName?: string | null, includeLanguageCode = true) {
  const resolvedVoice = normalizeGeminiLiveVoiceName(voiceName);
  return includeLanguageCode
    ? {
        languageCode: 'en-US',
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: resolvedVoice },
        },
      }
    : {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: resolvedVoice },
        },
      };
}

export function buildLiveOutputTranscriptionConfig(includeLanguageCodes = true) {
  return includeLanguageCodes
    ? { languageCodes: ['en-US', 'en-GB'] }
    : {};
}

