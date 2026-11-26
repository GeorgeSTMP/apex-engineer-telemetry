import type {
  AutonomyActionLog,
  CarProfile,
  CarSetup,
  CoachCallout,
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
  completedLap?: { deltaSec: number; trailScore: number }
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
    if (explicitRaceLengthLaps <= 10) return 'short_online';
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

  const fuelBurnPerLapLiters =
    car.carClass === 'Hypercar'
      ? track.lengthKm > 9 ? 5.8 : 3.2
      : car.carClass === 'LMP2'
        ? track.lengthKm > 9 ? 5.1 : 2.8
        : track.lengthKm > 9 ? 4.4 : 2.4;

  const lapsOfFuelLeft = Math.max(
    0.4,
    Math.round((frame.fuelLiters / fuelBurnPerLapLiters) * 10) / 10
  );
  const remainingRaceLaps = Math.max(
    1,
    effectiveRaceLengthLaps - frame.lapNumber + (1 - frame.lapDistPct)
  );

  // Pit at least 1 lap before running dry, or THIS lap immediately if crash/damage detected
  const maxPitLap = frame.lapNumber + Math.max(1, Math.floor(lapsOfFuelLeft - 0.8));
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

  const autoSelectEnabled = options?.autoSelectPitTires ?? true;
  const manualOverride = !autoSelectEnabled ? options?.pitTireOverride ?? 'auto' : 'auto';

  let tireAction: PitStrategyPlan['tireAction'] = 'fuel_only';
  let tireCompound: PitStrategyPlan['tireCompound'] = 'Medium';
  let tireSelectionReason = '';
  let tireAutoSelected = autoSelectEnabled || manualOverride === 'auto';

  if (manualOverride !== 'auto') {
    tireAutoSelected = false;
    switch (manualOverride) {
      case 'keep':
        tireAction = 'fuel_only';
        tireCompound = 'Medium';
        tireSelectionReason = 'Manual override: keeping current tires to save ~12s in pit lane.';
        break;
      case 'fronts_medium':
        tireAction = 'change_fronts';
        tireCompound = 'Medium';
        tireSelectionReason = 'Manual override: changing 2 front Medium tires (~7s stop).';
        break;
      case 'all_soft':
        tireAction = 'change_all';
        tireCompound = 'Soft';
        tireSelectionReason = 'Manual override: fitting 4x Soft tires for maximum short-stint grip.';
        break;
      case 'all_hard':
        tireAction = 'change_all';
        tireCompound = 'Hard';
        tireSelectionReason = 'Manual override: fitting 4x Hard tires for maximum thermal durability.';
        break;
      case 'all_wet':
        tireAction = 'change_all';
        tireCompound = 'Wet';
        tireSelectionReason = 'Manual override: fitting 4x Wet tires for damp/rain track.';
        break;
      case 'all_medium':
      default:
        tireAction = 'change_all';
        tireCompound = 'Medium';
        tireSelectionReason = 'Manual override: fitting 4x Medium tires.';
        break;
    }
  } else if (isDamp) {
    tireAction = 'change_all';
    tireCompound = 'Wet';
    tireSelectionReason = crashAlertActive
      ? 'Crash on damp track — BOX NOW: enable Repairs ON and fit 4x Wet tires in LMU Pit MFD.'
      : 'Damp track detected — recommended 4x Wet tires to prevent cold-slick aquaplaning.';
  } else if (crashAlertActive) {
    tireAction = 'change_all';
    if (detectedSessionType === 'qualifying') {
      tireCompound = profile.isNewToGame || isHot ? 'Medium' : 'Soft';
      tireSelectionReason = `Crash in Qualifying — Box NOW for Repairs ON + fresh 4x ${tireCompound} (or Esc to Garage if time permits) before next push lap.`;
    } else if (detectedSessionType === 'practice') {
      tireCompound = 'Medium';
      tireSelectionReason = `Crash in Practice — Box this lap (or Esc to Garage) to repair damage and load fresh 4x Medium without losing race time.`;
    } else if (resolvedRaceMode === 'endurance' && isHot) {
      tireCompound = 'Hard';
      tireSelectionReason = `Impact detected in hot Endurance stint — BOX THIS LAP: set Repairs ON and 4x Hard in LMU Pit MFD.`;
    } else {
      tireCompound = 'Medium';
      tireSelectionReason = `Crash / puncture detected — BOX THIS LAP: enable Repairs ON and fit fresh 4x Medium so flat-spots or suspension damage don't wreck your stint.`;
    }
  } else if (resolvedRaceMode === 'practice_quali') {
    if (detectedSessionType === 'warmup') {
      tireAction = 'change_all';
      tireCompound = isHot ? 'Hard' : 'Medium';
      tireSelectionReason = `Warmup shakedown — recommended 4x ${tireCompound} with full-tank bias to test race-start grip.`;
    } else if (detectedSessionType === 'practice') {
      tireAction = 'change_all';
      tireCompound = isHot || profile.isNewToGame ? 'Medium' : 'Soft';
      tireSelectionReason = `Practice session detected — 4x ${tireCompound} gives repeatable setup & brake-mark runs (no position penalty to pit).`;
    } else {
      tireAction = 'change_all';
      tireCompound = profile.isNewToGame || isHot ? 'Medium' : 'Soft';
      tireSelectionReason =
        tireCompound === 'Soft'
          ? 'Qualifying session — 4x Soft + low fuel recommended for peak single-lap grip.'
          : isHot
            ? 'Hot Qualifying surface — 4x Medium avoids overheating in sector 3.'
            : 'Qualifying newcomer safety — 4x Medium for predictable cold out-lap warmup.';
    }
  } else if (resolvedRaceMode === 'short_online') {
    if (minTireWear >= 72 && profile.habits.lockupCount < 3) {
      tireAction = 'fuel_only';
      tireCompound = 'Medium';
      tireSelectionReason = `Short online race (${Math.round(minTireWear)}% rubber left) — keep current tires (0s) so you do not lose ~12s in pits.`;
    } else if (frontMinWear < 78 && rearMinWear >= 82) {
      tireAction = 'change_fronts';
      tireCompound = 'Medium';
      tireSelectionReason = `Short online sprint — fronts worn to ${Math.round(frontMinWear)}% while rears are ${Math.round(rearMinWear)}%; 2x Front Medium (~7s) fixes turn-in fast.`;
    } else {
      tireAction = 'change_all';
      tireCompound =
        !profile.isNewToGame && remainingRaceLaps <= 4 && isCool ? 'Soft' : 'Medium';
      tireSelectionReason =
        profile.habits.lockupCount >= 3
          ? `Short online race with ${profile.habits.lockupCount} lockups — recommended 4x ${tireCompound} to clear flat-spots safely.`
          : `Short online race (${Math.round(minTireWear)}% min wear) — recommended 4x ${tireCompound} for reliable grip to the flag.`;
    }
  } else if (resolvedRaceMode === 'endurance') {
    if (minTireWear < 85 || profile.habits.lockupCount >= 2 || remainingRaceLaps >= 16) {
      tireAction = 'change_all';
    } else if (frontMinWear < 89 && rearMinWear >= 89) {
      tireAction = 'change_fronts';
    } else {
      tireAction = 'fuel_only';
    }
    tireCompound = isHot || (remainingRaceLaps >= 20 && !profile.isNewToGame) ? 'Hard' : 'Medium';
    tireSelectionReason =
      tireAction === 'fuel_only'
        ? `Endurance double-stint (${Math.round(minTireWear)}% wear) — keeping tires saves ~12s at pit exit.`
        : tireCompound === 'Hard'
          ? `Endurance hot/long stint (${Math.round(remainingRaceLaps)} laps left) — recommended ${tireAction === 'change_fronts' ? '2x Front' : '4x'} Hard for thermal life.`
          : `Endurance stint — recommended ${tireAction === 'change_fronts' ? '2x Front' : '4x'} Medium for consistent pace over double stints.`;
  } else {
    // standard_online
    if (minTireWear < 82 || profile.habits.lockupCount >= 2 || (remainingRaceLaps > 10 && minTireWear < 86)) {
      tireAction = 'change_all';
    } else if (frontMinWear < 88 && rearMinWear >= 88) {
      tireAction = 'change_fronts';
    } else {
      tireAction = 'fuel_only';
    }

    if (isHot && remainingRaceLaps >= 11 && !profile.isNewToGame) {
      tireCompound = 'Hard';
    } else if (!profile.isNewToGame && profile.primaryGoal !== 'consistency' && remainingRaceLaps <= 6 && !isHot) {
      tireCompound = 'Soft';
    } else {
      tireCompound = 'Medium';
    }

    tireSelectionReason =
      tireAction === 'fuel_only'
        ? `Normal online race (${Math.round(minTireWear)}% wear) — keeping current tires saves ~12s in pits.`
        : tireAction === 'change_fronts'
          ? `Normal online race — fronts at ${Math.round(frontMinWear)}%; 2x Front ${tireCompound} (~7s) restores turn-in without full stop loss.`
          : tireCompound === 'Soft'
            ? `Final ${Math.ceil(remainingRaceLaps)}-lap sprint — recommended 4x Soft for maximum attacking grip.`
            : tireCompound === 'Hard'
              ? `Hot normal-distance stint — recommended 4x Hard to prevent late-stint blistering.`
              : `Normal online race — recommended 4x Medium for balanced warmup and grip (${Math.round(minTireWear)}% old wear).`;
  }

  const pitTireCallHeadline =
    tireAction === 'change_all'
      ? `4x ${tireCompound}`
      : tireAction === 'change_fronts'
        ? `2x Front ${tireCompound} (~7s)`
        : 'Keep Tires (0s)';

  const repairsRecommended = crashAlertActive;
  const pitCallUrgency: PitStrategyPlan['pitCallUrgency'] = crashAlertActive
    ? 'box_now_damage'
    : lapsOfFuelLeft <= remainingRaceLaps + 1 || tireAction !== 'fuel_only'
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
    car.carClass === 'Hypercar' && typeof frame.virtualEnergyPct === 'number'
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
    `Fuel MFD: ${fuelToAddLiters > 0 ? `+${fuelToAddLiters.toFixed(0)} L` : '0 L (No refuel)'}${car.carClass === 'Hypercar' ? ' + 100% VE' : ''}`,
    `Tires MFD (${tireAutoSelected ? 'Auto Plan' : 'Manual'}): ${pitTireCallHeadline}`,
    repairsRecommended
      ? 'Repairs MFD: ON — Fix Aero & Suspension Damage'
      : 'Repairs MFD: OFF unless steering or aero damaged',
    'Pit Entry: Engage Pit Limiter before white line',
  ];

  const controlModeNote =
    'Read-only Pit MFD advisor (100% RaceControl legal) — confirm these picks in LMU Pit MFD or wheel macros; app never injects game inputs.';

  const engineerSummary = crashAlertActive
    ? `BOX THIS LAP (${raceModeLabel}): Set Repairs ON, ${pitTireCallHeadline}${fuelToAddLiters > 0 ? `, +${fuelToAddLiters.toFixed(0)}L` : ''} in LMU Pit MFD.`
    : resolvedRaceMode === 'practice_quali'
      ? `${raceModeLabel} plan: ${pitTireCallHeadline}, ${fuelToAddLiters.toFixed(0)}L run fuel, repairs OFF unless damaged.`
      : lapsOfFuelLeft >= remainingRaceLaps && tireAction === 'fuel_only'
        ? `Fuel${veClause} good to flag (${lapsOfFuelLeft.toFixed(1)} laps left). No pit stop needed — keep current tires.`
        : `MFD Box Lap ${recommendedPitLap} (${raceModeLabel}): ${fuelToAddLiters.toFixed(0)}L${car.carClass === 'Hypercar' ? ' + 100% VE' : ''}, ${tireLabel}, repairs OFF unless damaged.`;

  return {
    raceLengthLaps: effectiveRaceLengthLaps,
    currentLap: frame.lapNumber,
    fuelRemainingLiters: frame.fuelLiters,
    fuelBurnPerLapLiters,
    lapsOfFuelLeft,
    recommendedPitLap,
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


