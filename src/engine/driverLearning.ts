import type {
  AutonomyActionLog,
  CarProfile,
  CarSetup,
  CoachCallout,
  CoachSettings,
  CompactTelemetryPoint,
  CornerComparison,
  CornerDefinition,
  DriverProfile,
  DriverSkillTier,
  ElectronicsSuggestion,
  EngineerAutonomyMode,
  LapRecord,
  LearnedCornerStats,
  PitRaceMode,
  PitStintSegment,
  PitStrategyOption,
  PitStrategyPlan,
  PitTireOverride,
  ReferenceSample,
  SimSessionType,
  TelemetryFrame,
  TrackCondition,
  TrackProfile,
} from '../types/telemetry';
import { analyzeLapByCorners } from './coachRules';
import type { TelemetryIncident } from './telemetryTruth';

export function createDefaultDriverProfile(isNewToGame = true): DriverProfile {
  return {
    driverName: 'Driver',
    skillTier: isNewToGame ? 'newcomer' : 'competitive',
    isNewToGame,
    primaryGoal: isNewToGame ? 'consistency' : 'pace',
    habits: {
      lapsAnalyzed: 1,
      lateBrakeCount: 0,
      lockupCount: 0,
      exitSnapCount: 0,
      offTrackCount: 0,
      avgTrailBrakeScore: isNewToGame ? 68 : 82,
      avgDeltaSec: isNewToGame ? 2.4 : 0.65,
      brakingConsistencyPct: isNewToGame ? 72 : 89,
    },
    learnedStrengths: isNewToGame
      ? ['Smooth straight-line throttle application']
      : ['Consistent apex speed in medium-speed corners'],
    learnedWeaknesses: isNewToGame
      ? ['Braking slightly deep past 100m markers', 'Carrying peak brake pressure too far into turn-in']
      : ['Occasional inside-front lockup on bumpy chicanes'],
  };
}

/**
 * Updates the persistent driver profile from live coaching callouts and telemetry state,
 * inferring skill tier, strengths, and recurring habits over time.
 */
export function recordDriverObservation(
  profile: DriverProfile,
  callout: CoachCallout | null,
  completedLap?: {
    deltaSec: number;
    trailScore: number;
    fuelBurnedLiters?: number;
    maxTireWearLostPct?: number;
  }
): DriverProfile {
  const habits = { ...profile.habits };

  if (callout) {
    if (callout.category === 'braking') habits.lateBrakeCount += 1;
    if (callout.category === 'lockup') habits.lockupCount += 1;
    if (callout.category === 'traction') habits.exitSnapCount += 1;
    if (callout.category === 'track_limits') habits.offTrackCount += 1;
  }

  if (completedLap) {
    const n = habits.lapsAnalyzed + 1;
    habits.lapsAnalyzed = n;
    habits.avgDeltaSec = Math.round(((habits.avgDeltaSec * (n - 1) + completedLap.deltaSec) / n) * 100) / 100;
    habits.avgTrailBrakeScore = Math.round((habits.avgTrailBrakeScore * (n - 1) + completedLap.trailScore) / n);
    if (
      typeof completedLap.fuelBurnedLiters === 'number' &&
      Number.isFinite(completedLap.fuelBurnedLiters) &&
      completedLap.fuelBurnedLiters > 0.3 &&
      completedLap.fuelBurnedLiters < 25
    ) {
      const prevFuel = habits.observedFuelPerLapLiters;
      const nextFuel =
        typeof prevFuel === 'number' && prevFuel > 0
          ? prevFuel * 0.55 + completedLap.fuelBurnedLiters * 0.45
          : completedLap.fuelBurnedLiters;
      habits.observedFuelPerLapLiters = Math.round(nextFuel * 100) / 100;
    }
    if (
      typeof completedLap.maxTireWearLostPct === 'number' &&
      Number.isFinite(completedLap.maxTireWearLostPct) &&
      completedLap.maxTireWearLostPct > 0.1 &&
      completedLap.maxTireWearLostPct < 25
    ) {
      const prevWear = habits.observedWearPerLapPct;
      const nextWear =
        typeof prevWear === 'number' && prevWear > 0
          ? prevWear * 0.55 + completedLap.maxTireWearLostPct * 0.45
          : completedLap.maxTireWearLostPct;
      habits.observedWearPerLapPct = Math.round(nextWear * 100) / 100;
    }
  }

  const errorDensity =
    (habits.lateBrakeCount + habits.lockupCount * 1.2 + habits.exitSnapCount + habits.offTrackCount) /
    Math.max(1, habits.lapsAnalyzed);

  habits.brakingConsistencyPct = Math.max(
    42,
    Math.min(98, Math.round(92 - errorDensity * 8))
  );

  let skillTier: DriverSkillTier = profile.skillTier;
  if (profile.isNewToGame && habits.lapsAnalyzed < 4) {
    skillTier = 'newcomer';
  } else if (habits.brakingConsistencyPct >= 90 && habits.avgTrailBrakeScore >= 85) {
    skillTier = 'pro';
  } else if (habits.brakingConsistencyPct >= 80 && habits.avgTrailBrakeScore >= 76) {
    skillTier = 'competitive';
  } else if (habits.lapsAnalyzed >= 2) {
    skillTier = 'developing';
  }

  const learnedWeaknesses: string[] = [];
  if (habits.lockupCount >= 2) {
    learnedWeaknesses.push('Repeated front lockups — brake bias too far forward or heavy initial spike');
  }
  if (habits.lateBrakeCount >= 2) {
    learnedWeaknesses.push('Late braking past marker boards in heavy deceleration zones');
  }
  if (habits.exitSnapCount >= 2) {
    learnedWeaknesses.push('Aggressive exit throttle before steering angle is unwound');
  }
  if (habits.offTrackCount >= 2) {
    learnedWeaknesses.push('Running wide across exit kerbs risking track-limit penalties');
  }
  if (learnedWeaknesses.length === 0) {
    learnedWeaknesses.push('Minor trail-braking release timing variance');
  }

  const learnedStrengths: string[] = [];
  if (habits.lockupCount === 0) learnedStrengths.push('Clean threshold braking modulation');
  if (habits.exitSnapCount === 0) learnedStrengths.push('Progressive corner-exit throttle control');
  if (habits.offTrackCount === 0) learnedStrengths.push('Disciplined track-limit awareness');
  if (learnedStrengths.length === 0) learnedStrengths.push('Good commitment on fast straights');

  return {
    ...profile,
    skillTier,
    habits,
    learnedWeaknesses,
    learnedStrengths,
  };
}

/**
 * Generates adaptive electronics & in-car dial suggestions (TC, ABS, Brake Bias)
 * tailored to whether the player is new to the game and what habits were observed.
 */
export function buildAdaptiveElectronicsSuggestions(
  profile: DriverProfile,
  setup: CarSetup,
  car: CarProfile
): ElectronicsSuggestion[] {
  const suggestions: ElectronicsSuggestion[] = [];

  // For newcomers or drivers experiencing exit snap oversteer: recommend safer TC
  if ((profile.isNewToGame || profile.habits.exitSnapCount >= 1) && setup.tcLevel < 6) {
    const targetTc = Math.min(8, profile.isNewToGame ? Math.max(setup.tcLevel + 2, 6) : setup.tcLevel + 1);
    suggestions.push({
      id: 'suggest-tc',
      title: 'Raise Traction Control',
      parameter: 'tcLevel',
      currentValue: setup.tcLevel,
      recommendedValue: targetTc,
      unit: 'step',
      reason: profile.isNewToGame
        ? `Since you are building confidence in ${car.name}, TC ${targetTc} prevents sudden rear snaps on bumpy exit kerbs.`
        : `Observed ${profile.habits.exitSnapCount} exit traction snaps — +1 TC saves rear tire life.`,
      urgency: 'immediate',
    });
  }

  // For repeated lockups or late braking: shift brake bias rearward
  if ((profile.habits.lockupCount >= 1 || profile.habits.lateBrakeCount >= 2) && setup.brakeBiasPct > 52.5) {
    const targetBias = Math.round((setup.brakeBiasPct - 1.2) * 10) / 10;
    suggestions.push({
      id: 'suggest-bias',
      title: 'Shift Brake Bias Rearward',
      parameter: 'brakeBiasPct',
      currentValue: setup.brakeBiasPct,
      recommendedValue: targetBias,
      unit: '%',
      reason: `Detected ${profile.habits.lockupCount} front lockup(s) and ${profile.habits.lateBrakeCount} late-brake event(s) — moving bias to ${targetBias}% stabilizes entry.`,
      urgency: 'immediate',
    });
  }

  // Only LMGT3 cars in LMU have ABS; Hypercar & LMP2 use Brake Bias & Brake Migration instead
  if (car.carClass === 'LMGT3' && (profile.isNewToGame || profile.habits.lockupCount >= 2) && setup.absLevel < 5) {
    const targetAbs = Math.min(7, setup.absLevel + 1);
    suggestions.push({
      id: 'suggest-abs',
      title: 'Increase ABS Intervention',
      parameter: 'absLevel',
      currentValue: setup.absLevel,
      recommendedValue: targetAbs,
      unit: 'step',
      reason: 'Prevents flat-spotting front tires during emergency avoidance or late braking.',
      urgency: 'immediate',
    });
  }

  return suggestions;
}

export interface PitStrategyOptions {
  autoSelectPitTires?: boolean;
  preselectPitTiresInLmu?: boolean;
  pitRaceMode?: PitRaceMode;
  pitTireOverride?: PitTireOverride;
  sessionType?: SimSessionType;
  sessionPhaseSource?: 'auto' | 'manual';
  trackCondition?: TrackCondition;
  recentIncidents?: TelemetryIncident[];
}

export function resolvePitRaceMode(params: {
  pitRaceMode?: PitRaceMode;
  sessionType?: SimSessionType;
  isNewToGame?: boolean;
  explicitRaceLengthLaps?: number;
}): Exclude<PitRaceMode, 'auto'> {
  const { pitRaceMode = 'auto', sessionType, isNewToGame, explicitRaceLengthLaps } = params;
  if (pitRaceMode !== 'auto') {
    return pitRaceMode;
  }
  if (sessionType === 'practice' || sessionType === 'qualifying' || sessionType === 'warmup') {
    return 'practice_quali';
  }
  if (typeof explicitRaceLengthLaps === 'number') {
    if (explicitRaceLengthLaps <= 12) return 'short_online';
    if (explicitRaceLengthLaps >= 26) return 'endurance';
    return 'standard_online';
  }
  if (isNewToGame) {
    return 'short_online';
  }
  return 'standard_online';
}

export function getDefaultRaceLengthLaps(
  mode: Exclude<PitRaceMode, 'auto'>,
  track: TrackProfile
): number {
  const isLongCircuit = track.lengthKm > 9;
  switch (mode) {
    case 'practice_quali':
      return isLongCircuit ? 4 : 6;
    case 'short_online':
      return isLongCircuit ? 6 : 10;
    case 'endurance':
      return isLongCircuit ? 26 : 40;
    case 'standard_online':
    default:
      return isLongCircuit ? 12 : 18;
  }
}

export function formatPitRaceModeLabel(
  mode: Exclude<PitRaceMode, 'auto'>,
  detectedSessionType?: SimSessionType
): string {
  if (mode === 'practice_quali') {
    if (detectedSessionType === 'practice') return 'Practice Session';
    if (detectedSessionType === 'qualifying') return 'Qualifying Session';
    if (detectedSessionType === 'warmup') return 'Warmup Session';
    return 'Practice / Quali';
  }
  switch (mode) {
    case 'short_online':
      return 'Short Online / Beginner';
    case 'standard_online':
      return 'Normal Online';
    case 'endurance':
      return 'Endurance Stint';
  }
}

export function formatDetectedSessionStrategyLabel(
  sessionType: SimSessionType,
  source: 'auto' | 'manual' = 'auto'
): string {
  const tag = source === 'manual' ? 'Manual' : 'Auto';
  switch (sessionType) {
    case 'practice':
      return `Practice (${tag})`;
    case 'qualifying':
      return `Qualifying (${tag})`;
    case 'warmup':
      return `Warmup (${tag})`;
    case 'race':
      return `Race (${tag})`;
    default:
      return 'Standby / Waiting for Sim Session';
  }
}

/**
 * Calculates live pit stop strategy & automatic optimal tire selection based on
 * game mode / race format, current fuel burn, tire wear, surface conditions,
 * and driver skill/consistency profile.
 */
export function computePitStrategy(
  frame: TelemetryFrame,
  track: TrackProfile,
  car: CarProfile,
  profile: DriverProfile,
  setup: CarSetup,
  raceLengthLaps?: number,
  options?: PitStrategyOptions
): PitStrategyPlan {
  const detectedSessionType: SimSessionType =
    options?.sessionType && options.sessionType !== 'unknown'
      ? options.sessionType
      : frame.sessionType && frame.sessionType !== 'unknown'
        ? frame.sessionType
        : 'unknown';
  const sessionPhaseDetectedLabel = formatDetectedSessionStrategyLabel(
    detectedSessionType,
    options?.sessionPhaseSource ?? 'auto'
  );

  const resolvedRaceMode = resolvePitRaceMode({
    pitRaceMode: options?.pitRaceMode ?? 'auto',
    sessionType: detectedSessionType,
    isNewToGame: profile.isNewToGame,
    explicitRaceLengthLaps: raceLengthLaps,
  });
  const effectiveRaceLengthLaps = Math.max(
    frame.lapNumber + 1,
    raceLengthLaps ?? getDefaultRaceLengthLaps(resolvedRaceMode, track)
  );
  const raceModeLabel = formatPitRaceModeLabel(resolvedRaceMode, detectedSessionType);

  const recentIncidents = options?.recentIncidents ?? [];
  const latestCrashIncident = recentIncidents.find((inc) => inc.type === 'crash_impact') ?? null;
  const activeImpactNow =
    !frame.inPitOrGarage && frame.longG <= -3.3 && frame.speedKmh >= 20;
  const crashAlertActive = Boolean(
    frame.wheelDetached ||
      frame.flatTire ||
      latestCrashIncident ||
      activeImpactNow
  );
  const crashReason = frame.wheelDetached
    ? 'Detached wheel / severe suspension damage detected — box immediately or Esc to garage if immobile.'
    : frame.flatTire
      ? 'Flat tire / puncture detected in telemetry — box this lap for fresh rubber.'
      : latestCrashIncident
        ? `Crash impact logged at ${latestCrashIncident.cornerName} (Lap ${latestCrashIncident.lapNumber}${
            latestCrashIncident.impactDeltaKmh
              ? `, -${latestCrashIncident.impactDeltaKmh} km/h drop`
              : ''
          }) — check steering alignment and box if damaged.`
        : activeImpactNow
          ? `Hard deceleration spike (${frame.longG.toFixed(1)}g) — check steering straightness and pit if damaged.`
          : null;

  const baseFuelBurnPerLapLiters =
    car.carClass === 'Hypercar'
      ? track.lengthKm > 9 ? 5.8 : 3.2
      : car.carClass === 'LMP2'
        ? track.lengthKm > 9 ? 5.1 : 2.8
        : track.lengthKm > 9 ? 4.4 : 2.4;
  const learnedFuelBurn = profile.habits.observedFuelPerLapLiters;
  const habitFuelMult =
    profile.habits.exitSnapCount >= 3 || profile.habits.brakingConsistencyPct < 75
      ? 1.04
      : profile.habits.lapsAnalyzed >= 3 &&
          profile.habits.brakingConsistencyPct >= 90 &&
          profile.habits.lockupCount === 0
        ? 0.96
        : 1.0;
  const fuelBurnPerLapLiters =
    typeof learnedFuelBurn === 'number' && learnedFuelBurn > 0.5
      ? Math.round((baseFuelBurnPerLapLiters * 0.3 + learnedFuelBurn * 0.7) * 100) / 100
      : Math.round(baseFuelBurnPerLapLiters * habitFuelMult * 100) / 100;

  const lapsOfFuelLeft = Math.max(
    0.4,
    Math.round((frame.fuelLiters / fuelBurnPerLapLiters) * 10) / 10
  );
  const isHypercar = car.carClass === 'Hypercar' || frame.carClass === 'Hypercar';
  const veBurnPctPerLap = track.lengthKm > 9 ? 11.2 : 7.8;
  const lapsOfVeLeft =
    isHypercar && typeof frame.virtualEnergyPct === 'number' && Number.isFinite(frame.virtualEnergyPct)
      ? Math.max(0.3, Math.round((frame.virtualEnergyPct / veBurnPctPerLap) * 10) / 10)
      : undefined;
  const effectiveStintLapsLeft =
    lapsOfVeLeft !== undefined ? Math.min(lapsOfFuelLeft, lapsOfVeLeft) : lapsOfFuelLeft;

  const remainingRaceLaps = Math.max(
    1,
    effectiveRaceLengthLaps - frame.lapNumber + (1 - frame.lapDistPct)
  );

  // Pit at least 1 lap before running dry on fuel OR Virtual Energy (0% VE = 100s Stop-and-Go), or THIS lap if crash/damage
  const maxPitLap = frame.lapNumber + Math.max(1, Math.floor(effectiveStintLapsLeft - 0.8));
  const plannedPitLap = Math.min(effectiveRaceLengthLaps - 1, maxPitLap);
  const recommendedPitLap = crashAlertActive ? frame.lapNumber : plannedPitLap;

  const lapsAfterPit = Math.max(1, effectiveRaceLengthLaps - recommendedPitLap);
  const fuelNeeded =
    resolvedRaceMode === 'practice_quali'
      ? Math.round(fuelBurnPerLapLiters * (detectedSessionType === 'qualifying' ? 3 : 4) * 10) / 10
      : Math.max(
          0,
          Math.round(
            (lapsAfterPit * fuelBurnPerLapLiters +
              2.5 -
              Math.max(0, frame.fuelLiters - (recommendedPitLap - frame.lapNumber) * fuelBurnPerLapLiters)) *
              10
          ) / 10
        );
  const fuelToAddLiters = Math.min(90, fuelNeeded);

  const minTireWear = Math.min(
    frame.tireWearPct.fl,
    frame.tireWearPct.fr,
    frame.tireWearPct.rl,
    frame.tireWearPct.rr
  );
  const frontMinWear = Math.min(frame.tireWearPct.fl, frame.tireWearPct.fr);
  const rearMinWear = Math.min(frame.tireWearPct.rl, frame.tireWearPct.rr);
  const maxTireTemp = Math.max(
    frame.tireTempC.fl,
    frame.tireTempC.fr,
    frame.tireTempC.rl,
    frame.tireTempC.rr
  );

  const isDamp = options?.trackCondition === 'damp';
  const isHot =
    options?.trackCondition === 'hot' || maxTireTemp > car.optimalTireTempRange[1] + 5;
  const isCool = options?.trackCondition === 'cool';

  const currentCompound: PitStrategyPlan['currentCompound'] = isDamp
    ? 'Wet'
    : isHot && resolvedRaceMode === 'endurance'
      ? 'Hard'
      : detectedSessionType === 'qualifying' && !profile.isNewToGame
        ? 'Soft'
        : 'Medium';

  const getWearPerLapPct = (cmp: PitStrategyPlan['currentCompound']): number => {
    const longCircuit = track.lengthKm > 9;
    const base =
      cmp === 'Soft'
        ? longCircuit ? 5.6 : 3.6
        : cmp === 'Hard'
          ? longCircuit ? 2.2 : 1.5
          : cmp === 'Wet'
            ? longCircuit ? 4.2 : 2.8
            : longCircuit ? 3.5 : 2.3;
    const heatMult = isHot ? 1.15 : isCool ? 0.92 : 1.0;
    return Math.round(base * heatMult * 10) / 10;
  };

  const baseCurrentWearRate = getWearPerLapPct(currentCompound);
  const habitWearMult =
    profile.habits.lockupCount >= 3
      ? 1.24
      : profile.habits.lockupCount >= 2 || profile.habits.exitSnapCount >= 2
        ? 1.12
        : profile.habits.lapsAnalyzed >= 3 &&
            profile.habits.brakingConsistencyPct >= 90 &&
            profile.habits.lockupCount === 0 &&
            profile.habits.exitSnapCount === 0
          ? 0.9
          : 1.0;
  const adjustedBaseWearRate = baseCurrentWearRate * habitWearMult;
  const learnedWearRate = profile.habits.observedWearPerLapPct;
  const observedWearRate =
    frame.lapNumber > 1 && 100 - minTireWear > 1.2
      ? (100 - minTireWear) / Math.max(1, frame.lapNumber - 1 + frame.lapDistPct)
      : adjustedBaseWearRate;
  const effectiveWearPerLap =
    typeof learnedWearRate === 'number' && learnedWearRate > 0.2
      ? Math.round((adjustedBaseWearRate * 0.3 + learnedWearRate * 0.45 + observedWearRate * 0.25) * 10) / 10
      : Math.round((adjustedBaseWearRate * 0.55 + observedWearRate * 0.45) * 10) / 10;

  const projectWearAtLap = (startWear: number, startLapNum: number, targetLapNum: number, rate: number) =>
    Math.max(35, Math.min(100, Math.round(startWear - Math.max(0, targetLapNum - startLapNum) * rate)));

  const projectedNoStopFlagWear = projectWearAtLap(
    minTireWear,
    frame.lapNumber,
    effectiveRaceLengthLaps,
    effectiveWearPerLap
  );

  const autoSelectEnabled = options?.autoSelectPitTires ?? true;
  const manualOverride = !autoSelectEnabled ? options?.pitTireOverride ?? 'auto' : 'auto';

  let autoTireAction: PitStrategyPlan['tireAction'] = 'fuel_only';
  let autoTireCompound: PitStrategyPlan['tireCompound'] = 'Medium';
  let autoTireSelectionReason = '';

  if (isDamp) {
    autoTireAction = 'change_all';
    autoTireCompound = 'Wet';
    autoTireSelectionReason = crashAlertActive
      ? 'Crash on damp track — BOX NOW: enable Repairs ON and fit 4x Wet tires in LMU Pit MFD.'
      : 'Damp track detected — recommended 4x Wet tires to prevent cold-slick aquaplaning.';
  } else if (crashAlertActive) {
    autoTireAction = 'change_all';
    if (detectedSessionType === 'qualifying') {
      autoTireCompound = profile.isNewToGame || isHot ? 'Medium' : 'Soft';
      autoTireSelectionReason = `Crash in Qualifying — Box NOW for Repairs ON + fresh 4x ${autoTireCompound} (or Esc to Garage if time permits) before next push lap.`;
    } else if (detectedSessionType === 'practice') {
      autoTireCompound = 'Medium';
      autoTireSelectionReason = `Crash in Practice — Box this lap (or Esc to Garage) to repair damage and load fresh 4x Medium without losing race time.`;
    } else if (
      (resolvedRaceMode === 'endurance' && isHot) ||
      (remainingRaceLaps >= 18 && isHot && !profile.isNewToGame)
    ) {
      autoTireCompound = 'Hard';
      autoTireSelectionReason = `Impact detected in hot long stint — BOX THIS LAP: Repairs ON and best durability compound 4x Hard in LMU Pit MFD.`;
    } else if (
      !profile.isNewToGame &&
      remainingRaceLaps <= 5 &&
      !isHot &&
      profile.habits.lockupCount < 3
    ) {
      autoTireCompound = 'Soft';
      autoTireSelectionReason = `Crash in final ${Math.ceil(remainingRaceLaps)}-lap sprint — BOX THIS LAP: Repairs ON and fit fastest 4x Soft recovery tires.`;
    } else {
      autoTireCompound = 'Medium';
      autoTireSelectionReason = `Crash / puncture detected — BOX THIS LAP: enable Repairs ON and fit optimal 4x Medium so flat-spots or suspension damage don't wreck your stint.`;
    }
  } else if (resolvedRaceMode === 'practice_quali') {
    if (detectedSessionType === 'warmup') {
      autoTireAction = 'change_all';
      autoTireCompound = isHot ? 'Hard' : 'Medium';
      autoTireSelectionReason = `Warmup shakedown — recommended 4x ${autoTireCompound} with full-tank bias to test race-start grip.`;
    } else if (detectedSessionType === 'practice') {
      autoTireAction = 'change_all';
      autoTireCompound = isHot || profile.isNewToGame ? 'Medium' : 'Soft';
      autoTireSelectionReason = `Practice session detected — 4x ${autoTireCompound} gives repeatable setup & brake-mark runs (no position penalty to pit).`;
    } else {
      autoTireAction = 'change_all';
      autoTireCompound = profile.isNewToGame || isHot ? 'Medium' : 'Soft';
      autoTireSelectionReason =
        autoTireCompound === 'Soft'
          ? 'Qualifying session — 4x Soft + low fuel recommended for peak single-lap grip.'
          : isHot
            ? 'Hot Qualifying surface — 4x Medium avoids overheating in sector 3.'
            : 'Qualifying newcomer safety — 4x Medium for predictable cold out-lap warmup.';
    }
  } else if (resolvedRaceMode === 'short_online') {
    const heavyLearnedWear = typeof learnedWearRate === 'number' && learnedWearRate >= 5.2 && projectedNoStopFlagWear < 64;
    if (minTireWear >= 72 && profile.habits.lockupCount < 3 && !heavyLearnedWear) {
      autoTireAction = 'fuel_only';
      autoTireCompound = 'Medium';
      autoTireSelectionReason = `Short casual race (${effectiveRaceLengthLaps} laps, ${Math.round(minTireWear)}% rubber) — no tire change needed (0s); keep tires to the flag unless you get damage.`;
    } else if (frontMinWear < 78 && rearMinWear >= 82) {
      autoTireAction = 'change_fronts';
      autoTireCompound = 'Medium';
      autoTireSelectionReason = `Short online sprint — fronts worn to ${Math.round(frontMinWear)}% while rears are ${Math.round(rearMinWear)}%; 2x Front Medium (~7s) fixes turn-in fast.`;
    } else {
      autoTireAction = 'change_all';
      autoTireCompound =
        !profile.isNewToGame && remainingRaceLaps <= 4 && isCool ? 'Soft' : 'Medium';
      autoTireSelectionReason =
        profile.habits.lockupCount >= 3 || heavyLearnedWear
          ? `Short online race with ${profile.habits.lockupCount} lockups / ${effectiveWearPerLap.toFixed(1)}%/lap wear — switched to 4x ${autoTireCompound} to clear flat-spots safely.`
          : `Short online race (${Math.round(minTireWear)}% min wear) — recommended 4x ${autoTireCompound} for reliable grip to the flag.`;
    }
  } else if (resolvedRaceMode === 'endurance') {
    if (minTireWear < 85 || profile.habits.lockupCount >= 2 || remainingRaceLaps >= 16) {
      autoTireAction = 'change_all';
    } else if (frontMinWear < 89 && rearMinWear >= 89) {
      autoTireAction = 'change_fronts';
    } else {
      autoTireAction = 'fuel_only';
    }
    autoTireCompound = isHot || (remainingRaceLaps >= 20 && !profile.isNewToGame) ? 'Hard' : 'Medium';
    autoTireSelectionReason =
      autoTireAction === 'fuel_only'
        ? `Endurance double-stint (${Math.round(minTireWear)}% wear) — keeping tires saves ~12s at pit exit.`
        : autoTireCompound === 'Hard'
          ? `Endurance hot/long stint (${Math.round(remainingRaceLaps)} laps left) — recommended ${autoTireAction === 'change_fronts' ? '2x Front' : '4x'} Hard for thermal life.`
          : `Endurance stint — recommended ${autoTireAction === 'change_fronts' ? '2x Front' : '4x'} Medium for consistent pace over double stints.`;
  } else {
    // standard_online
    if (minTireWear < 82 || profile.habits.lockupCount >= 2 || (remainingRaceLaps > 10 && minTireWear < 86)) {
      autoTireAction = 'change_all';
    } else if (frontMinWear < 88 && rearMinWear >= 88) {
      autoTireAction = 'change_fronts';
    } else {
      autoTireAction = 'fuel_only';
    }

    if (isHot && remainingRaceLaps >= 11 && !profile.isNewToGame) {
      autoTireCompound = 'Hard';
    } else if (!profile.isNewToGame && profile.primaryGoal !== 'consistency' && remainingRaceLaps <= 6 && !isHot) {
      autoTireCompound = 'Soft';
    } else {
      autoTireCompound = 'Medium';
    }

    autoTireSelectionReason =
      autoTireAction === 'fuel_only'
        ? `Normal online race (${Math.round(minTireWear)}% wear) — keeping current tires saves ~12s in pits.`
        : autoTireAction === 'change_fronts'
          ? `Normal online race — fronts at ${Math.round(frontMinWear)}%; 2x Front ${autoTireCompound} (~7s) restores turn-in without full stop loss.`
          : autoTireCompound === 'Soft'
            ? `Final ${Math.ceil(remainingRaceLaps)}-lap sprint — recommended 4x Soft for maximum attacking grip.`
            : autoTireCompound === 'Hard'
              ? `Hot normal-distance stint — recommended 4x Hard to prevent late-stint blistering.`
              : `Normal online race — recommended 4x Medium for balanced warmup and grip (${Math.round(minTireWear)}% old wear).`;
  }

  let tireAction: PitStrategyPlan['tireAction'] = autoTireAction;
  let tireCompound: PitStrategyPlan['tireCompound'] = autoTireCompound;
  let tireSelectionReason = autoTireSelectionReason;
  const tireAutoSelected = autoSelectEnabled || manualOverride === 'auto';

  if (!tireAutoSelected) {
    switch (manualOverride) {
      case 'keep':
        tireAction = 'fuel_only';
        tireCompound = 'Medium';
        tireSelectionReason = 'Manual strategy: keeping current tires to save ~12s in pit lane.';
        break;
      case 'fronts_medium':
        tireAction = 'change_fronts';
        tireCompound = 'Medium';
        tireSelectionReason = 'Manual strategy: changing 2 front Medium tires (~7s stop).';
        break;
      case 'all_soft':
        tireAction = 'change_all';
        tireCompound = 'Soft';
        tireSelectionReason = 'Manual strategy: fitting 4x Soft tires for maximum short-stint grip.';
        break;
      case 'all_hard':
        tireAction = 'change_all';
        tireCompound = 'Hard';
        tireSelectionReason = 'Manual strategy: fitting 4x Hard tires for maximum thermal durability.';
        break;
      case 'all_wet':
        tireAction = 'change_all';
        tireCompound = 'Wet';
        tireSelectionReason = 'Manual strategy: fitting 4x Wet tires for damp/rain track.';
        break;
      case 'all_medium':
      default:
        tireAction = 'change_all';
        tireCompound = 'Medium';
        tireSelectionReason = 'Manual strategy: fitting 4x Medium tires.';
        break;
    }
  }

  const pitTireCallHeadline =
    tireAction === 'change_all'
      ? `4x ${tireCompound}`
      : tireAction === 'change_fronts'
        ? `2x Front ${tireCompound} (~7s)`
        : 'Keep Tires (0s)';

  const repairsRecommended = crashAlertActive;
  const veLimitingStint = lapsOfVeLeft !== undefined && lapsOfVeLeft < lapsOfFuelLeft;
  const stintLimitingFactor: PitStrategyPlan['stintLimitingFactor'] = crashAlertActive
    ? 'damage'
    : veLimitingStint && lapsOfVeLeft <= remainingRaceLaps + 1
      ? 'virtual_energy'
      : lapsOfFuelLeft <= remainingRaceLaps + 1
        ? 'fuel'
        : tireAction !== 'fuel_only'
          ? 'tires'
          : 'none';
  const pitCallUrgency: PitStrategyPlan['pitCallUrgency'] = crashAlertActive
    ? 'box_now_damage'
    : effectiveStintLapsLeft <= remainingRaceLaps + 1 || tireAction !== 'fuel_only'
      ? 'planned'
      : 'none';

  const setupAdjustmentsAtPit: string[] = [];
  if (profile.habits.lockupCount >= 1) {
    setupAdjustmentsAtPit.push(`Brake Bias ${(setup.brakeBiasPct - 1.0).toFixed(1)}%`);
  }
  if (profile.habits.exitSnapCount >= 1 || profile.isNewToGame) {
    setupAdjustmentsAtPit.push(`TC Map ${Math.min(8, setup.tcLevel + 1)}`);
  }
  if (Math.max(frame.tireTempC.fl, frame.tireTempC.fr) > car.optimalTireTempRange[1]) {
    setupAdjustmentsAtPit.push('Front PSI +0.4');
  }
  if (setupAdjustmentsAtPit.length === 0) {
    setupAdjustmentsAtPit.push('No mechanical changes — pace nominal');
  }

  // LMU pit timing: ~7s for 2 tires, ~12s for 4 tires + repairs if crashed
  const pitStopDurationEstSec =
    6 +
    (repairsRecommended ? 14 : 0) +
    Math.round(fuelToAddLiters * 0.25) +
    (tireAction === 'change_all' ? 12 : tireAction === 'change_fronts' ? 7 : 0);

  const veClause =
    isHypercar && typeof frame.virtualEnergyPct === 'number'
      ? ` & VE ${Math.round(frame.virtualEnergyPct)}%`
      : '';
  const tireLabel =
    tireAction === 'change_all'
      ? `4x ${tireCompound}`
      : tireAction === 'change_fronts'
        ? `2 fronts ${tireCompound} (~7s)`
        : 'keep tires (0s)';

  const mfdChecklist = [
    `Request Pit: Press your Pit Request button before pit entry`,
    `Fuel MFD: ${fuelToAddLiters > 0 ? `+${fuelToAddLiters.toFixed(0)} L` : '0 L (No refuel)'}${isHypercar ? ' + 100% VE' : ''}`,
    `Tires MFD (${tireAutoSelected ? 'Auto Plan' : 'Manual'}): ${pitTireCallHeadline}`,
    repairsRecommended
      ? 'Repairs MFD: ON — Fix Aero & Suspension Damage'
      : 'Repairs MFD: OFF unless steering or aero damaged',
    'Pit Entry: Engage Pit Limiter (60 km/h) before white line',
  ];

  const controlModeNote = options?.preselectPitTiresInLmu
    ? 'LMU Pit MFD Preselect ON (:6397 REST): Tires & repairs are pre-selected automatically. Press Pit Request and engage Pit Limiter on entry.'
    : 'Read-only Pit MFD advisor (100% RaceControl legal) — confirm these picks in LMU Pit MFD or enable Preselect in LMU; app never injects steering/pedal inputs.';

  const engineerSummary = crashAlertActive
    ? `BOX THIS LAP (${raceModeLabel}): Set Repairs ON, ${pitTireCallHeadline}${fuelToAddLiters > 0 ? `, +${fuelToAddLiters.toFixed(0)}L` : ''} in LMU Pit MFD.`
    : resolvedRaceMode === 'practice_quali'
      ? `${raceModeLabel} plan: ${pitTireCallHeadline}, ${fuelToAddLiters.toFixed(0)}L run fuel, repairs OFF unless damaged.`
      : effectiveStintLapsLeft >= remainingRaceLaps && tireAction === 'fuel_only'
        ? `Fuel${veClause} good to flag (${effectiveStintLapsLeft.toFixed(1)} laps left). No pit stop needed — keep current tires.`
        : veLimitingStint && lapsOfVeLeft !== undefined
          ? `MFD Box Lap ${recommendedPitLap} (${raceModeLabel}): VE ${Math.round(frame.virtualEnergyPct ?? 0)}% limits stint (~${lapsOfVeLeft.toFixed(1)} laps). Set 100% VE + ${fuelToAddLiters.toFixed(0)}L, ${tireLabel}, repairs OFF.`
          : `MFD Box Lap ${recommendedPitLap} (${raceModeLabel}): ${fuelToAddLiters.toFixed(0)}L${isHypercar ? ' + 100% VE' : ''}, ${tireLabel}, repairs OFF unless damaged.`;

  const lapsToCliff = Math.max(0, (minTireWear - 68) / Math.max(0.5, effectiveWearPerLap));
  const rawCliffLap = Math.round(frame.lapNumber + lapsToCliff);
  const estimatedCliffLap =
    rawCliffLap <= effectiveRaceLengthLaps + 2 && minTireWear < 99.5 ? rawCliffLap : rawCliffLap <= effectiveRaceLengthLaps ? rawCliffLap : null;

  const pitNeededThisRace = Boolean(
    crashAlertActive ||
      resolvedRaceMode === 'practice_quali' ||
      effectiveStintLapsLeft < remainingRaceLaps - 0.15 ||
      tireAction !== 'fuel_only'
  );

  const pitWindowStartLap = crashAlertActive
    ? frame.lapNumber
    : Math.max(frame.lapNumber, recommendedPitLap - 1);
  const pitWindowEndLap = crashAlertActive
    ? frame.lapNumber
    : Math.min(effectiveRaceLengthLaps - 1, recommendedPitLap + 1);

  const pitLaneTransitSec = track.lengthKm > 9 ? 16 : 13;
  const pitLaneLossTotalSec = pitLaneTransitSec + pitStopDurationEstSec;

  const estimatedWearAtPitPct = projectWearAtLap(
    minTireWear,
    frame.lapNumber,
    recommendedPitLap,
    effectiveWearPerLap
  );

  const buildStintsForPlan = (params: {
    pitRequired: boolean;
    pitLap: number | null;
    nextAction: 'change_all' | 'fuel_only' | 'change_fronts';
    nextCmp: PitStrategyPlan['currentCompound'];
    headline: string;
  }): { stints: PitStintSegment[]; finishWear: number } => {
    if (!params.pitRequired || params.pitLap === null) {
      const finishWear = projectWearAtLap(
        minTireWear,
        frame.lapNumber,
        effectiveRaceLengthLaps,
        effectiveWearPerLap
      );
      return {
        finishWear,
        stints: [
          {
            stintNumber: 1,
            startLap: 1,
            endLap: effectiveRaceLengthLaps,
            compound: currentCompound,
            actionLabel: 'To Flag · No Stop',
            isCurrent: true,
            isPitStopBefore: false,
            estimatedWearAtEndPct: finishWear,
          },
        ],
      };
    }

    const pLap = Math.max(frame.lapNumber, Math.min(effectiveRaceLengthLaps - 1, params.pitLap));
    const wearAtPit = projectWearAtLap(minTireWear, frame.lapNumber, pLap, effectiveWearPerLap);
    const stint2StartWear =
      params.nextAction === 'fuel_only'
        ? wearAtPit
        : params.nextAction === 'change_fronts'
          ? Math.min(100, Math.round((100 + Math.max(55, rearMinWear - Math.max(0, pLap - frame.lapNumber) * effectiveWearPerLap * 0.7)) / 2))
          : 100;
    const stint2Rate = getWearPerLapPct(params.nextAction === 'fuel_only' ? currentCompound : params.nextCmp);
    const finishWear = projectWearAtLap(stint2StartWear, pLap, effectiveRaceLengthLaps, stint2Rate);

    return {
      finishWear,
      stints: [
        {
          stintNumber: 1,
          startLap: 1,
          endLap: pLap,
          compound: currentCompound,
          actionLabel: `Current · ${currentCompound}`,
          isCurrent: true,
          isPitStopBefore: false,
          estimatedWearAtEndPct: wearAtPit,
        },
        {
          stintNumber: 2,
          startLap: pLap,
          endLap: effectiveRaceLengthLaps,
          compound: params.nextAction === 'fuel_only' ? currentCompound : params.nextCmp,
          actionLabel: params.headline,
          isCurrent: false,
          isPitStopBefore: true,
          pitLap: pLap,
          estimatedWearAtEndPct: finishWear,
        },
      ],
    };
  };

  const activeStintBuild = buildStintsForPlan({
    pitRequired: pitNeededThisRace,
    pitLap: pitNeededThisRace ? recommendedPitLap : null,
    nextAction: tireAction,
    nextCmp: tireCompound,
    headline: pitTireCallHeadline,
  });
  const activeStints = activeStintBuild.stints;
  const estimatedWearAtFlagPct = activeStintBuild.finishWear;

  const rejoinCars = (frame.opponents ?? [])
    .filter(
      (o) =>
        !o.inPits &&
        o.gapSeconds < 0 &&
        Math.abs(o.gapSeconds) <= pitLaneLossTotalSec + 3 &&
        Math.abs(o.gapSeconds) >= Math.max(3, pitLaneLossTotalSec - 14)
    )
    .sort((a, b) => Math.abs(a.gapSeconds) - Math.abs(b.gapSeconds))
    .slice(0, 2);

  const rejoinTrafficNote = !pitNeededThisRace
    ? `No pit needed — save ~${pitLaneTransitSec + 12}s pit lane loss.`
    : rejoinCars.length > 0
      ? `Rejoin window (~${pitLaneLossTotalSec}s loss): Traffic near #${rejoinCars
          .map((c) => `${c.carNumber} (${c.gapSeconds.toFixed(1)}s)`)
          .join(' & ')}`
      : `Rejoin window (~${pitLaneLossTotalSec}s total loss): Clean air predicted at pit exit.`;

  const estimateStopLoss = (action: 'change_all' | 'fuel_only' | 'change_fronts', includeFuel: boolean): number =>
    pitLaneTransitSec +
    (repairsRecommended ? 14 : 0) +
    (includeFuel ? 6 + Math.round(fuelToAddLiters * 0.25) : 0) +
    (action === 'change_all' ? 12 : action === 'change_fronts' ? 7 : 0);

  const strategyOptions: PitStrategyOption[] = [];

  // Plan Auto always reflects the engineer's live dynamic AI strategy across match length, crash/weather, and driver learning
  const hasLearnedFuelShift =
    typeof learnedFuelBurn === 'number' &&
    (learnedFuelBurn > baseFuelBurnPerLapLiters * 1.12 ||
      learnedFuelBurn < baseFuelBurnPerLapLiters * 0.9);
  const hasLearnedWearShift =
    profile.habits.lockupCount >= 2 ||
    (typeof learnedWearRate === 'number' && learnedWearRate > baseCurrentWearRate * 1.2) ||
    (profile.habits.lapsAnalyzed >= 3 &&
      profile.habits.brakingConsistencyPct >= 90 &&
      profile.habits.lockupCount === 0 &&
      profile.habits.exitSnapCount === 0);
  const isDriverAdapted = hasLearnedFuelShift || hasLearnedWearShift;

  const autoPitNeeded = Boolean(
    crashAlertActive ||
      resolvedRaceMode === 'practice_quali' ||
      effectiveStintLapsLeft < remainingRaceLaps - 0.15 ||
      autoTireAction !== 'fuel_only'
  );
  const autoPitTireHeadline =
    autoTireAction === 'change_all'
      ? `4x ${autoTireCompound}`
      : autoTireAction === 'change_fronts'
        ? `2x Front ${autoTireCompound} (~7s)`
        : 'Keep Tires (0s)';
  const autoPlanLoss = autoPitNeeded
    ? estimateStopLoss(autoTireAction, fuelToAddLiters > 0 || effectiveStintLapsLeft < remainingRaceLaps - 0.15)
    : 0;
  const planAutoStints = buildStintsForPlan({
    pitRequired: autoPitNeeded,
    pitLap: autoPitNeeded ? recommendedPitLap : null,
    nextAction: autoTireAction,
    nextCmp: autoTireCompound,
    headline: autoPitTireHeadline,
  });
  strategyOptions.push({
    id: 'plan_auto',
    code: 'Plan Auto',
    name: crashAlertActive
      ? 'Box Now · Repair'
      : isDamp
        ? 'Rain Auto · 4x Wet'
        : !autoPitNeeded
          ? `No-Stop · ${effectiveRaceLengthLaps}L Match`
          : isDriverAdapted
            ? 'Adaptive · Re-Timed'
            : resolvedRaceMode === 'practice_quali'
              ? 'Dynamic Run Plan'
              : 'Dynamic Balanced',
    tag: crashAlertActive ? 'Emergency' : 'Dynamic AI',
    pitRequired: autoPitNeeded,
    pitLap: autoPitNeeded ? recommendedPitLap : null,
    pitWindowStartLap: autoPitNeeded ? pitWindowStartLap : null,
    pitWindowEndLap: autoPitNeeded ? pitWindowEndLap : null,
    nextTireAction: autoTireAction,
    nextCompound: autoTireCompound,
    nextTireHeadline: autoPitTireHeadline,
    pitTireOverride: 'auto',
    autoSelectPitTires: true,
    stopLossSec: autoPlanLoss,
    deltaToOptimalSec: 0,
    projectedFinishWearPct: planAutoStints.finishWear,
    rationale: autoTireSelectionReason,
    stints: planAutoStints.stints,
  });

  // Plan A: Fixed Standard Baseline (4x Medium)
  const planALoss = estimateStopLoss('change_all', fuelToAddLiters > 0 || autoPitNeeded);
  const planAStints = buildStintsForPlan({
    pitRequired: true,
    pitLap: recommendedPitLap,
    nextAction: 'change_all',
    nextCmp: 'Medium',
    headline: '4x Medium',
  });
  strategyOptions.push({
    id: 'plan_a',
    code: 'Plan A',
    name: crashAlertActive
      ? 'Repair + 4x Medium'
      : resolvedRaceMode === 'practice_quali'
        ? 'Baseline 4x Medium'
        : 'Standard · 4x Medium',
    tag: 'Recommended',
    pitRequired: true,
    pitLap: recommendedPitLap,
    pitWindowStartLap: pitWindowStartLap,
    pitWindowEndLap: pitWindowEndLap,
    nextTireAction: 'change_all',
    nextCompound: 'Medium',
    nextTireHeadline: '4x Medium',
    pitTireOverride: 'all_medium',
    autoSelectPitTires: false,
    stopLossSec: planALoss,
    deltaToOptimalSec: autoPitNeeded ? Math.round((planALoss - autoPlanLoss) * 10) / 10 : planALoss,
    projectedFinishWearPct: planAStints.finishWear,
    rationale: `Box L${recommendedPitLap} onto 4x Medium for consistent warmup and balanced grip to flag.`,
    stints: planAStints.stints,
  });

  // Plan B: Undercut / Aggressive Sprint Option
  const earlyPitLap = Math.max(frame.lapNumber, Math.min(effectiveRaceLengthLaps - 1, recommendedPitLap - 1));
  const planBCmp: PitStrategyPlan['currentCompound'] = isDamp
    ? 'Wet'
    : 'Soft';
  const planBAction: 'change_all' | 'change_fronts' =
    resolvedRaceMode === 'short_online' && !crashAlertActive && !isDamp && minTireWear >= 70
      ? 'change_fronts'
      : 'change_all';
  const planBActualCmp = planBAction === 'change_fronts' ? 'Medium' : planBCmp;
  const planBOverride: PitTireOverride =
    planBAction === 'change_fronts'
      ? 'fronts_medium'
      : planBActualCmp === 'Wet'
        ? 'all_wet'
        : 'all_soft';
  const planBHeadline =
    planBAction === 'change_fronts'
      ? '2x Front Medium (~7s)'
      : `4x ${planBActualCmp}`;
  const planBLoss = estimateStopLoss(planBAction, fuelToAddLiters > 0 || autoPitNeeded);
  const planBStints = buildStintsForPlan({
    pitRequired: true,
    pitLap: earlyPitLap,
    nextAction: planBAction,
    nextCmp: planBActualCmp,
    headline: planBHeadline,
  });
  strategyOptions.push({
    id: 'plan_b',
    code: 'Plan B',
    name: crashAlertActive
      ? 'Repair + 4x Soft Attack'
      : isDamp
        ? 'Rain Box · 4x Wet'
        : resolvedRaceMode === 'practice_quali'
          ? 'Quali Flyer (4x Soft)'
          : planBAction === 'change_fronts'
            ? 'Quick 2-Tire Fronts'
            : 'Undercut · 4x Soft',
    tag: planBAction === 'change_fronts' ? 'Aggressive' : 'Undercut',
    pitRequired: true,
    pitLap: earlyPitLap,
    pitWindowStartLap: Math.max(frame.lapNumber, earlyPitLap - 1),
    pitWindowEndLap: earlyPitLap,
    nextTireAction: planBAction,
    nextCompound: planBActualCmp,
    nextTireHeadline: planBHeadline,
    pitTireOverride: planBOverride,
    autoSelectPitTires: false,
    stopLossSec: planBLoss,
    deltaToOptimalSec: autoPitNeeded ? Math.round((planBLoss - autoPlanLoss - 1.4) * 10) / 10 : Math.round((planBLoss - 1.5) * 10) / 10,
    projectedFinishWearPct: planBStints.finishWear,
    rationale:
      planBAction === 'change_fronts'
        ? `7s front-only swap restores turn-in bite in ${Math.round(remainingRaceLaps)} laps without full 4-tire loss.`
        : `Box L${earlyPitLap} onto 4x ${planBActualCmp} for ~0.5s/lap fresh-rubber undercut pace.`,
    stints: planBStints.stints,
  });

  // Plan C: Safe Long / Track Position Option (disjoint from Plan A's all_medium)
  const latePitLap = Math.max(frame.lapNumber, Math.min(effectiveRaceLengthLaps - 1, recommendedPitLap + 1));
  const planCUseKeep =
    autoPitNeeded &&
    !crashAlertActive &&
    !isDamp &&
    autoTireAction !== 'fuel_only' &&
    minTireWear >= 76 &&
    resolvedRaceMode !== 'practice_quali';
  const planCAction: 'change_all' | 'fuel_only' = planCUseKeep ? 'fuel_only' : 'change_all';
  const planCCmp: PitStrategyPlan['currentCompound'] = planCUseKeep
    ? currentCompound
    : 'Hard';
  const planCOverride: PitTireOverride = planCUseKeep ? 'keep' : 'all_hard';
  const planCHeadline = planCUseKeep ? 'Keep Tires (0s)' : '4x Hard';
  const planCLoss = estimateStopLoss(planCAction, true);
  const planCStints = buildStintsForPlan({
    pitRequired: true,
    pitLap: latePitLap,
    nextAction: planCAction,
    nextCmp: planCCmp,
    headline: planCHeadline,
  });
  strategyOptions.push({
    id: 'plan_c',
    code: 'Plan C',
    name: planCUseKeep
      ? 'Fuel-Only · Overcut'
      : resolvedRaceMode === 'practice_quali'
        ? 'Long Run (4x Hard)'
        : 'Endurance 4x Hard',
    tag: planCUseKeep ? 'Track Pos' : 'Safe Long',
    pitRequired: true,
    pitLap: latePitLap,
    pitWindowStartLap: latePitLap,
    pitWindowEndLap: Math.min(effectiveRaceLengthLaps - 1, latePitLap + 1),
    nextTireAction: planCAction,
    nextCompound: planCCmp,
    nextTireHeadline: planCHeadline,
    pitTireOverride: planCOverride,
    autoSelectPitTires: false,
    stopLossSec: planCLoss,
    deltaToOptimalSec: autoPitNeeded ? Math.round((planCLoss - autoPlanLoss) * 10) / 10 : planCLoss,
    projectedFinishWearPct: planCStints.finishWear,
    rationale: planCUseKeep
      ? `Stretch to L${latePitLap} and skip tire change (0s) to jump cars in pit lane.`
      : `Full 4x Hard swap guarantees zero thermal drop-off to the checkered flag.`,
    stints: planCStints.stints,
  });

  const matchedManualOption = !tireAutoSelected
    ? strategyOptions.find((opt) => !opt.autoSelectPitTires && opt.pitTireOverride === manualOverride)
    : undefined;

  const finalRecommendedPitLap = matchedManualOption?.pitLap ?? recommendedPitLap;
  const finalPitWindowStartLap = matchedManualOption?.pitWindowStartLap ?? pitWindowStartLap;
  const finalPitWindowEndLap = matchedManualOption?.pitWindowEndLap ?? pitWindowEndLap;
  const finalActiveStints = matchedManualOption?.stints ?? activeStints;
  const finalEstimatedWearAtFlagPct = matchedManualOption?.projectedFinishWearPct ?? estimatedWearAtFlagPct;

  const adaptationParts: string[] = [];
  if (
    typeof learnedFuelBurn === 'number' &&
    learnedFuelBurn > baseFuelBurnPerLapLiters * 1.12
  ) {
    adaptationParts.push(
      `learned higher fuel burn (${fuelBurnPerLapLiters.toFixed(1)}L/lap) — box target L${finalRecommendedPitLap}`
    );
  } else if (
    typeof learnedFuelBurn === 'number' &&
    learnedFuelBurn < baseFuelBurnPerLapLiters * 0.9
  ) {
    adaptationParts.push(
      `learned smooth fuel saving (${fuelBurnPerLapLiters.toFixed(1)}L/lap) — extending stint`
    );
  }
  if (
    profile.habits.lockupCount >= 2 ||
    (typeof learnedWearRate === 'number' && learnedWearRate > baseCurrentWearRate * 1.2)
  ) {
    adaptationParts.push(
      `learned higher tire wear (${effectiveWearPerLap.toFixed(1)}%/lap${
        profile.habits.lockupCount >= 2 ? `, ${profile.habits.lockupCount}x lockups` : ''
      }) — ${pitTireCallHeadline}`
    );
  } else if (
    profile.habits.lapsAnalyzed >= 3 &&
    profile.habits.brakingConsistencyPct >= 90 &&
    profile.habits.lockupCount === 0 &&
    profile.habits.exitSnapCount === 0 &&
    tireAction === 'fuel_only'
  ) {
    adaptationParts.push('learned clean braking & tire care — stretching stint on current rubber');
  }
  const learnedAdaptationNote =
    adaptationParts.length > 0 ? `Adapted from your driving: ${adaptationParts.join('; ')}.` : null;

  return {
    raceLengthLaps: effectiveRaceLengthLaps,
    currentLap: frame.lapNumber,
    fuelRemainingLiters: frame.fuelLiters,
    fuelBurnPerLapLiters,
    lapsOfFuelLeft,
    ...(lapsOfVeLeft !== undefined ? { lapsOfVeLeft } : {}),
    stintLimitingFactor,
    recommendedPitLap: finalRecommendedPitLap,
    fuelToAddLiters,
    tireAction,
    tireCompound,
    tireAutoSelected,
    resolvedRaceMode,
    raceModeLabel,
    detectedSessionType,
    sessionPhaseDetectedLabel,
    crashAlertActive,
    crashReason,
    repairsRecommended,
    pitCallUrgency,
    controlModeNote,
    pitTireCallHeadline,
    tireSelectionReason,
    mfdChecklist,
    pitStopDurationEstSec,
    setupAdjustmentsAtPit,
    engineerSummary,
    currentCompound,
    pitWindowStartLap: finalPitWindowStartLap,
    pitWindowEndLap: finalPitWindowEndLap,
    pitNeededThisRace,
    estimatedWearAtPitPct,
    estimatedWearAtFlagPct: finalEstimatedWearAtFlagPct,
    estimatedCliffLap,
    pitLaneLossTotalSec,
    rejoinTrafficNote,
    learnedAdaptationNote,
    activeStints: finalActiveStints,
    strategyOptions,
  };
}

export interface PitStrategyVoiceState {
  lastNotifiedPitWindowKey: string | null;
  lastNotifiedBoxLapKey: string | null;
  lastNotifiedPlanSignature: string | null;
  lastNotifiedNoStopKey: string | null;
  lastAlertAtMs: number;
}

export function createInitialPitStrategyVoiceState(): PitStrategyVoiceState {
  return {
    lastNotifiedPitWindowKey: null,
    lastNotifiedBoxLapKey: null,
    lastNotifiedPlanSignature: null,
    lastNotifiedNoStopKey: null,
    lastAlertAtMs: 0,
  };
}

export interface PitStrategyVoiceEvaluation {
  callout: CoachCallout | null;
  nextState: PitStrategyVoiceState;
  eventType: 'pit_window_open' | 'box_this_lap' | 'learned_strategy_shift' | 'no_stop_reassure' | null;
}

/**
 * Pure evaluator that turns live PitStrategyPlan transitions + match length + learned
 * driver habits into proactive pit radio & Live Voice announcements.
 */
export function evaluatePitStrategyVoiceCallout(params: {
  strategy: PitStrategyPlan;
  prevStrategy: PitStrategyPlan | null;
  frame: TelemetryFrame;
  settings: Pick<CoachSettings, 'voiceEnabled' | 'pitWindowCountdownEnabled'>;
  voiceState: PitStrategyVoiceState;
  nowMs?: number;
  carClass?: string;
}): PitStrategyVoiceEvaluation {
  const { strategy, prevStrategy, frame, settings, voiceState } = params;
  const nowMs = params.nowMs ?? frame.timestampMs ?? Date.now();
  const planSig = `${strategy.resolvedRaceMode}:${strategy.pitNeededThisRace}:${strategy.pitTireCallHeadline}:${
    strategy.pitNeededThisRace ? strategy.recommendedPitLap : 'flag'
  }`;

  if (
    !settings.voiceEnabled ||
    !(settings.pitWindowCountdownEnabled ?? true) ||
    frame.inPitOrGarage ||
    frame.isPaused ||
    frame.inFormationLap
  ) {
    return {
      callout: null,
      eventType: null,
      nextState: {
        ...voiceState,
        lastNotifiedPlanSignature: voiceState.lastNotifiedPlanSignature ?? planSig,
      },
    };
  }

  // Practice/Quali stops are manual unless crash/damage already handled
  if (
    strategy.detectedSessionType === 'qualifying' ||
    strategy.detectedSessionType === 'practice' ||
    strategy.crashAlertActive
  ) {
    return {
      callout: null,
      eventType: null,
      nextState: {
        ...voiceState,
        lastNotifiedPlanSignature: planSig,
      },
    };
  }

  const isHypercar = params.carClass === 'Hypercar' || frame.carClass === 'Hypercar';
  const veClause = isHypercar ? ' + 100% VE' : '';
  const fuelClause =
    strategy.fuelToAddLiters > 0 ? `+${strategy.fuelToAddLiters.toFixed(0)}L${veClause}` : `0L${veClause}`;

  // 1. Box This Lap callout on recommendedPitLap approaching pit entry
  if (
    strategy.pitNeededThisRace &&
    frame.lapNumber === strategy.recommendedPitLap &&
    frame.lapDistPct >= 0.38
  ) {
    const boxKey = `${strategy.raceLengthLaps}:${strategy.recommendedPitLap}:${strategy.pitTireCallHeadline}`;
    if (voiceState.lastNotifiedBoxLapKey !== boxKey) {
      return {
        eventType: 'box_this_lap',
        callout: {
          id: `pit-box-this-lap-${nowMs}`,
          timestampMs: nowMs,
          lapNumber: frame.lapNumber,
          cornerName: 'Box This Lap',
          severity: 'warning',
          category: 'strategy',
          message: `Box this lap, Lap ${frame.lapNumber} (${strategy.raceModeLabel}) — Pit MFD: ${fuelClause}, ${strategy.pitTireCallHeadline}, repairs OFF unless damaged. Watch pit speed limiter.`,
          spoken: false,
          source: 'realtime-engine',
        },
        nextState: {
          ...voiceState,
          lastNotifiedBoxLapKey: boxKey,
          lastNotifiedPlanSignature: planSig,
          lastAlertAtMs: nowMs,
        },
      };
    }
  }

  // 2. Pit Window Open callout when entering pitWindowStartLap
  if (
    strategy.pitNeededThisRace &&
    frame.lapNumber >= strategy.pitWindowStartLap &&
    frame.lapNumber < strategy.recommendedPitLap
  ) {
    const winKey = `${strategy.raceLengthLaps}:${strategy.pitWindowStartLap}-${strategy.pitWindowEndLap}`;
    if (
      voiceState.lastNotifiedPitWindowKey !== winKey &&
      (voiceState.lastAlertAtMs === 0 || nowMs - voiceState.lastAlertAtMs >= 12000)
    ) {
      return {
        eventType: 'pit_window_open',
        callout: {
          id: `pit-window-open-${nowMs}`,
          timestampMs: nowMs,
          lapNumber: frame.lapNumber,
          cornerName: 'Pit Window',
          severity: 'warning',
          category: 'strategy',
          message: `Pit window open L${strategy.pitWindowStartLap}–${strategy.pitWindowEndLap} (${strategy.raceModeLabel}) — target Box Lap ${strategy.recommendedPitLap}: ${strategy.pitTireCallHeadline}, ${fuelClause}.`,
          spoken: false,
          source: 'realtime-engine',
        },
        nextState: {
          ...voiceState,
          lastNotifiedPitWindowKey: winKey,
          lastNotifiedPlanSignature: planSig,
          lastAlertAtMs: nowMs,
        },
      };
    }
  }

  // 3. Learned dynamic strategy shift (driver habits, lockups, wear, or fuel burn altered the plan)
  const prevPlanSig = prevStrategy
    ? `${prevStrategy.resolvedRaceMode}:${prevStrategy.pitNeededThisRace}:${prevStrategy.pitTireCallHeadline}:${
        prevStrategy.pitNeededThisRace ? prevStrategy.recommendedPitLap : 'flag'
      }`
    : null;
  if (
    prevStrategy &&
    prevPlanSig !== null &&
    planSig !== prevPlanSig &&
    planSig !== voiceState.lastNotifiedPlanSignature &&
    (voiceState.lastAlertAtMs === 0 || nowMs - voiceState.lastAlertAtMs >= 16000)
  ) {
    const tireChanged = prevStrategy.pitTireCallHeadline !== strategy.pitTireCallHeadline;
    const stopNeededChanged = prevStrategy.pitNeededThisRace !== strategy.pitNeededThisRace;
    const pitLapMoved =
      strategy.pitNeededThisRace &&
      prevStrategy.pitNeededThisRace &&
      Math.abs(prevStrategy.recommendedPitLap - strategy.recommendedPitLap) >= 1;

    if (tireChanged || stopNeededChanged || pitLapMoved || Boolean(strategy.learnedAdaptationNote)) {
      const msg = !strategy.pitNeededThisRace
        ? `Strategy update: ${strategy.learnedAdaptationNote ?? 'fuel and tire wear look strong'} — no pit stop needed now, stay out to the Lap ${strategy.raceLengthLaps} flag.`
        : `Strategy update (${strategy.raceModeLabel}): ${strategy.learnedAdaptationNote ?? `switching to ${strategy.pitTireCallHeadline}`} Target Box Lap ${strategy.recommendedPitLap} (${fuelClause}).`;

      return {
        eventType: 'learned_strategy_shift',
        callout: {
          id: `pit-learned-shift-${nowMs}`,
          timestampMs: nowMs,
          lapNumber: frame.lapNumber,
          cornerName: 'Strategy Update',
          severity: 'warning',
          category: 'strategy',
          message: msg,
          spoken: false,
          source: 'realtime-engine',
        },
        nextState: {
          ...voiceState,
          lastNotifiedPlanSignature: planSig,
          lastAlertAtMs: nowMs,
        },
      };
    }
  }

  // 4. Short casual match reassurance once early in race (e.g. 11-lap casual race = No Stop needed)
  if (
    strategy.detectedSessionType === 'race' &&
    strategy.resolvedRaceMode === 'short_online' &&
    !strategy.pitNeededThisRace &&
    frame.lapNumber === 1 &&
    frame.lapDistPct >= 0.06
  ) {
    const noStopKey = `${strategy.raceLengthLaps}:${strategy.resolvedRaceMode}`;
    if (
      voiceState.lastNotifiedNoStopKey !== noStopKey &&
      (voiceState.lastAlertAtMs === 0 || nowMs - voiceState.lastAlertAtMs >= 10000)
    ) {
      return {
        eventType: 'no_stop_reassure',
        callout: {
          id: `pit-no-stop-${nowMs}`,
          timestampMs: nowMs,
          lapNumber: frame.lapNumber,
          cornerName: 'Match Strategy',
          severity: 'warning',
          category: 'strategy',
          message: `${strategy.raceLengthLaps}-lap short race detected — fuel and tires are good to the flag. No tire change needed unless you get crash damage.`,
          spoken: false,
          source: 'realtime-engine',
        },
        nextState: {
          ...voiceState,
          lastNotifiedNoStopKey: noStopKey,
          lastNotifiedPlanSignature: planSig,
          lastAlertAtMs: nowMs,
        },
      };
    }
  }

  return {
    callout: null,
    eventType: null,
    nextState: {
      ...voiceState,
      lastNotifiedPlanSignature: planSig,
    },
  };
}

export interface AutonomyEvaluationResult {
  nextSetup: CarSetup;
  appliedAction: AutonomyActionLog | null;
  calloutMessage: string | null;
}

function clampElectronicsParam(
  parameter: 'tcLevel' | 'absLevel' | 'brakeBiasPct',
  value: number
): number {
  if (parameter === 'brakeBiasPct') {
    return Math.round(Math.max(48.0, Math.min(65.0, value)) * 10) / 10;
  }
  return Math.round(Math.max(1, Math.min(10, value)));
}

/**
 * Evaluates whether the AI race engineer should automatically apply an immediate
 * electronics adjustment (TC, ABS, Brake Bias) when autonomyMode === 'hands_on'.
 */
export function evaluateAutonomyAction(
  mode: EngineerAutonomyMode,
  suggestions: ElectronicsSuggestion[],
  setup: CarSetup,
  lastAppliedAtMs: number,
  nowMs: number,
  _language: 'en' = 'en',
  cooldownMs = 10000
): AutonomyEvaluationResult {
  if (mode !== 'hands_on') {
    return { nextSetup: setup, appliedAction: null, calloutMessage: null };
  }

  if (lastAppliedAtMs > 0 && nowMs - lastAppliedAtMs < cooldownMs) {
    return { nextSetup: setup, appliedAction: null, calloutMessage: null };
  }

  const candidate = suggestions.find((sug) => {
    if (sug.urgency !== 'immediate') return false;
    const bounded = clampElectronicsParam(sug.parameter, sug.recommendedValue);
    return setup[sug.parameter] !== bounded;
  });

  if (!candidate) {
    return { nextSetup: setup, appliedAction: null, calloutMessage: null };
  }

  const previousValue = setup[candidate.parameter];
  const appliedValue = clampElectronicsParam(candidate.parameter, candidate.recommendedValue);
  if (previousValue === appliedValue) {
    return { nextSetup: setup, appliedAction: null, calloutMessage: null };
  }

  const nextSetup: CarSetup = {
    ...setup,
    [candidate.parameter]: appliedValue,
  };

  const unitSuffix = candidate.unit === '%' ? '%' : '';
  const calloutMessage = `Auto-Apply: ${candidate.title} adjusted ${previousValue}${unitSuffix} → ${appliedValue}${unitSuffix}.`;

  const appliedAction: AutonomyActionLog = {
    id: `auto-${candidate.parameter}-${nowMs}`,
    timestampMs: nowMs,
    parameter: candidate.parameter,
    title: candidate.title,
    previousValue,
    appliedValue,
    unit: candidate.unit,
    reason: candidate.reason,
  };

  return { nextSetup, appliedAction, calloutMessage };
}

export function makeCornerMemoryKey(trackId: string, cornerId: string): string {
  return `${trackId}:${cornerId}`;
}

function measureCornerWindowTimeSec(
  frames: TelemetryFrame[],
  corner: CornerDefinition,
  trackLenMeters: number
): number | null {
  let span = corner.exitPct - corner.startPct;
  if (span <= 0) span += 1;

  const pts: Array<{ rel: number; speed: number; t: number }> = [];
  for (const f of frames) {
    let rel = f.lapDistPct - corner.startPct;
    if (rel < -0.5) rel += 1;
    if (rel > 0.5) rel -= 1;
    if (rel >= -0.002 && rel <= span + 0.002 && f.speedKmh > 8) {
      pts.push({ rel, speed: f.speedKmh, t: f.timestampMs ?? 0 });
    }
  }
  pts.sort((a, b) => a.rel - b.rel);
  if (pts.length < 4 || pts[pts.length - 1].rel - pts[0].rel < span * 0.55) {
    return null;
  }
  const dt = (pts[pts.length - 1].t - pts[0].t) / 1000;
  if (dt > 0.4 && dt < 45) return Math.round(dt * 1000) / 1000;

  let integrated = 0;
  for (let i = 1; i < pts.length; i++) {
    const dist = (pts[i].rel - pts[i - 1].rel) * trackLenMeters;
    const avgSpeedMs = (pts[i].speed + pts[i - 1].speed) / 2 / 3.6;
    if (dist > 0 && avgSpeedMs > 1) {
      integrated += dist / avgSpeedMs;
    }
  }
  return integrated > 0.4 && integrated < 45 ? Math.round(integrated * 1000) / 1000 : null;
}

function compactCornerPassFrames(frames: TelemetryFrame[]): CompactTelemetryPoint[] {
  const stride = Math.max(1, Math.ceil(frames.length / 28));
  return frames
    .filter((_, idx) => idx % stride === 0)
    .map((f) => ({
      lapDistPct: Math.round(f.lapDistPct * 1000) / 1000,
      speedKmh: Math.round(f.speedKmh * 10) / 10,
      throttle: Math.round(f.throttle * 100) / 100,
      brake: Math.round(f.brake * 100) / 100,
      steeringRad: Math.round(f.steeringRad * 1000) / 1000,
      frontWheelSlip: Math.round(f.frontWheelSlip * 100) / 100,
      rearWheelSlip: Math.round(f.rearWheelSlip * 100) / 100,
      ...(Number.isFinite(f.posX) && Number.isFinite(f.posZ)
        ? {
            posX: Math.round((f.posX as number) * 100) / 100,
            posZ: Math.round((f.posZ as number) * 100) / 100,
          }
        : {}),
    }));
}

/**
 * Updates per-corner learned telemetry memory across laps and sessions:
 * remembers braking biases, lockups, exit snaps, trail scores, mastery (0..1),
 * and caches the driver's fastest clean pass per corner.
 */
export function recordCornerLearningFromLap(params: {
  profile: DriverProfile;
  track: TrackProfile;
  lap: LapRecord;
  referenceSamples: ReferenceSample[];
}): DriverProfile {
  const { profile, track, lap, referenceSamples } = params;
  if (!lap.frames || lap.frames.length < 10) return profile;

  const comparisons = analyzeLapByCorners(lap.frames, referenceSamples, track);
  const trackLenMeters = Math.max(500, track.lengthKm * 1000);
  const nextMemory: Record<string, LearnedCornerStats> = {
    ...(profile.cornerMemory ?? {}),
  };
  const nowIso = new Date().toISOString();

  for (const c of track.corners) {
    const comp = comparisons.find((item) => item.cornerId === c.id);
    if (!comp) continue;

    let span = c.exitPct - c.startPct;
    if (span <= 0) span += 1;
    const cornerFrames = lap.frames.filter((f) => {
      let rel = f.lapDistPct - c.startPct;
      if (rel < -0.5) rel += 1;
      if (rel > 0.5) rel -= 1;
      return rel >= -0.008 && rel <= span + 0.008;
    });
    if (cornerFrames.length < 3) continue;

    const hadLockup = cornerFrames.some((f) => f.frontWheelSlip > 0.16 && f.brake > 0.35);
    const hadExitSnap = cornerFrames.some((f) => f.rearWheelSlip > 0.16 && f.throttle > 0.65);
    const passTimeSec = measureCornerWindowTimeSec(lap.frames, c, trackLenMeters);

    const key = makeCornerMemoryKey(track.id, c.id);
    const prev = nextMemory[key];
    const attempts = (prev?.attempts ?? 0) + 1;
    const alpha = prev ? Math.max(0.25, 1 / Math.min(attempts, 4)) : 1;

    const blend = (oldVal: number | undefined, curVal: number) =>
      oldVal === undefined ? curVal : Math.round((oldVal * (1 - alpha) + curVal * alpha) * 10) / 10;

    const avgBrakeDeltaM = blend(prev?.avgBrakeDeltaM, comp.brakingDeltaMeters);
    const avgApexSpeedDeltaKmh = blend(prev?.avgApexSpeedDeltaKmh, comp.minApexSpeedDeltaKmh);
    const avgExitSpeedDeltaKmh = blend(prev?.avgExitSpeedDeltaKmh, comp.exitSpeedDeltaKmh);
    const avgTrailScore = Math.round(blend(prev?.avgTrailScore, comp.trailBrakingScore));
    const lockupEvents = (prev?.lockupEvents ?? 0) + (hadLockup ? 1 : 0);
    const exitSnapEvents = (prev?.exitSnapEvents ?? 0) + (hadExitSnap ? 1 : 0);

    const timePenalty = Math.min(0.45, Math.max(0, comp.timeLostSec) * 1.4);
    const slipPenalty = Math.min(0.32, (lockupEvents * 0.08 + exitSnapEvents * 0.08) / Math.max(1, attempts * 0.5));
    const trailComponent = Math.max(0, Math.min(1, avgTrailScore / 92));
    const rawMastery = Math.max(0.18, Math.min(0.99, 0.45 + trailComponent * 0.45 - timePenalty - slipPenalty));
    const mastery = Math.round(rawMastery * 100) / 100;

    const hasWorldCoords = cornerFrames.some((f) => Number.isFinite(f.posX) && Number.isFinite(f.posZ));
    const prevHasWorld = Boolean(
      prev?.bestPassFrames?.some((f) => Number.isFinite(f.posX) && Number.isFinite(f.posZ))
    );
    const isFasterCleanPass =
      lap.valid &&
      passTimeSec !== null &&
      (prev?.bestTimeSec === undefined || passTimeSec < prev.bestTimeSec - 0.01);
    const shouldReplacePass =
      cornerFrames.length >= 5 &&
      (isFasterCleanPass || (!prevHasWorld && hasWorldCoords && lap.valid) || !prev?.bestPassFrames);

    nextMemory[key] = {
      cornerId: c.id,
      trackId: track.id,
      attempts,
      avgBrakeDeltaM,
      avgApexSpeedDeltaKmh,
      avgExitSpeedDeltaKmh,
      avgTrailScore,
      lockupEvents,
      exitSnapEvents,
      mastery,
      bestTimeSec: isFasterCleanPass && passTimeSec !== null ? passTimeSec : prev?.bestTimeSec ?? (passTimeSec ?? undefined),
      bestPassFrames: shouldReplacePass ? compactCornerPassFrames(cornerFrames) : prev?.bestPassFrames,
      updatedAtIso: nowIso,
    };
  }

  // Cap corner memory size to keep localStorage fast and compact
  const entries = Object.entries(nextMemory);
  let cappedMemory = nextMemory;
  if (entries.length > 80) {
    entries.sort((a, b) => b[1].updatedAtIso.localeCompare(a[1].updatedAtIso));
    cappedMemory = Object.fromEntries(entries.slice(0, 80));
  }

  return {
    ...profile,
    cornerMemory: cappedMemory,
  };
}

export interface LearnedGreenLineCalibration {
  readiness: number; // 0.35 .. 1.0 (1.0 = full pro limit)
  brakeEarlierMeters: number; // 0 .. 11
  lateralMarginScale: number; // 0.74 .. 1.0 (fraction of max pro track width used)
  exitSquareBias: number; // 0 .. 0.14 (extra exit-straightening apex delay)
  apexSpeedTargetBlend: number; // 0.45 .. 1.0
  adaptationSummary: string;
}

/**
 * Translates learned driver profile + per-corner memory into an achievable,
 * confidence-building racing line calibration that progressively converges toward Pro.
 */
export function computeLearnedGreenLineCalibration(params: {
  profile?: DriverProfile;
  corner: CornerDefinition;
  trackId: string;
  comparison?: CornerComparison | null;
}): LearnedGreenLineCalibration {
  const { profile, corner, trackId, comparison } = params;
  if (!profile) {
    return {
      readiness: 1,
      brakeEarlierMeters: 0,
      lateralMarginScale: 1,
      exitSquareBias: 0,
      apexSpeedTargetBlend: 1,
      adaptationSummary: 'Full Pro optimal racing line.',
    };
  }

  const mem = profile.cornerMemory?.[makeCornerMemoryKey(trackId, corner.id)];
  const tierBase =
    profile.skillTier === 'pro'
      ? 0.96
      : profile.skillTier === 'competitive'
        ? 0.84
        : profile.skillTier === 'developing'
          ? 0.65
          : 0.45;

  const trailNorm = Math.max(
    0.35,
    Math.min(1, (mem?.avgTrailScore ?? profile.habits.avgTrailBrakeScore) / 92)
  );
  const consistencyNorm = Math.max(0.4, Math.min(1, profile.habits.brakingConsistencyPct / 95));
  const cornerMastery = mem?.mastery ?? tierBase;

  const readiness = Math.round(
    Math.max(0.38, Math.min(1, tierBase * 0.42 + cornerMastery * 0.32 + trailNorm * 0.16 + consistencyNorm * 0.1)) * 100
  ) / 100;

  const lockupSignals = (mem?.lockupEvents ?? 0) + (profile.habits.lockupCount >= 2 ? 1 : 0);
  const lateBrakeSignals =
    (mem && mem.avgBrakeDeltaM >= 4 ? 1 : 0) +
    (comparison && comparison.brakingDeltaMeters >= 5 ? 1 : 0) +
    (profile.isNewToGame ? 1 : 0);
  const exitSnapSignals =
    (mem?.exitSnapEvents ?? 0) +
    (profile.habits.exitSnapCount >= 2 ? 1 : 0) +
    (comparison && comparison.exitSpeedDeltaKmh <= -3 ? 1 : 0);

  const brakeEarlierMeters = Math.min(
    11,
    Math.round(
      (1 - readiness) * 5 +
        Math.min(4, lockupSignals * 2) +
        Math.min(3, lateBrakeSignals * 1.5)
    )
  );

  const lateralMarginScale = Math.round((0.74 + readiness * 0.26) * 100) / 100;
  const exitSquareBias = Math.round(
    Math.min(0.14, (1 - readiness) * 0.05 + Math.min(0.09, exitSnapSignals * 0.035)) * 1000
  ) / 1000;
  const apexSpeedTargetBlend = Math.round((0.48 + readiness * 0.52) * 100) / 100;

  const reasons: string[] = [];
  if (brakeEarlierMeters >= 3) {
    reasons.push(`brakes ${brakeEarlierMeters}m earlier for straight-line stability`);
  }
  if (exitSquareBias >= 0.04) {
    reasons.push('squares off the apex slightly to protect exit traction');
  }
  if (lateralMarginScale < 0.94) {
    reasons.push(`leaves ~${Math.round((1 - lateralMarginScale) * 120) / 10}m kerb safety margin`);
  }

  const adaptationSummary =
    reasons.length > 0
      ? `Tailored to your ${profile.skillTier} data (${Math.round(readiness * 100)}% readiness): ${reasons.join(', ')}.`
      : `Converged to ${Math.round(readiness * 100)}% of Pro limit based on your clean telemetry here.`;

  return {
    readiness,
    brakeEarlierMeters,
    lateralMarginScale,
    exitSquareBias,
    apexSpeedTargetBlend,
    adaptationSummary,
  };
}


