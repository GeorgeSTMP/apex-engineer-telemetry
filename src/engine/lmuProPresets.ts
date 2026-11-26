import type {
  CarProfile,
  CarSetup,
  CornerComparison,
  DriverProfile,
  LmuPresetRecommendation,
  LmuProPreset,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';

type TrackAeroArchetype = 'low_drag' | 'high_downforce' | 'bumpy_endurance' | 'balanced';

const LOW_DRAG_TRACKS = new Set(['lemans', 'monza', 'bahrain', 'paul_ricard', 'daytona']);
const BUMPY_TRACKS = new Set(['sebring', 'road_atlanta']);
const HIGH_DF_TRACKS = new Set(['imola', 'interlagos', 'barcelona', 'fuji', 'laguna_seca', 'long_beach', 'lusail']);

function getTrackAeroArchetype(trackId: string): TrackAeroArchetype {
  if (LOW_DRAG_TRACKS.has(trackId)) return 'low_drag';
  if (BUMPY_TRACKS.has(trackId)) return 'bumpy_endurance';
  if (HIGH_DF_TRACKS.has(trackId)) return 'high_downforce';
  return 'balanced';
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function cloneSetup(base: CarSetup, patch: Partial<CarSetup>): CarSetup {
  return {
    ...base,
    ...patch,
    coldPsi: { ...base.coldPsi, ...(patch.coldPsi ?? {}) },
    camberDeg: { ...base.camberDeg, ...(patch.camberDeg ?? {}) },
  };
}

/**
 * Builds 4 Le Mans Ultimate Pro Setup Presets calibrated for the exact LMU car & circuit.
 */
export function buildLmuProPresetsForTrackAndCar(
  car: CarProfile,
  track: TrackProfile
): LmuProPreset[] {
  const base = car.defaultSetup;
  const archetype = getTrackAeroArchetype(track.id);
  const isGt3 = car.carClass === 'LMGT3';

  const wingShift =
    archetype === 'low_drag'
      ? { f: -0.6, r: -1.2, label: 'Low-Drag Le Mans / Top-Speed Trim' }
      : archetype === 'high_downforce'
        ? { f: 0.8, r: 1.5, label: 'High-Downforce Technical Trim' }
        : archetype === 'bumpy_endurance'
          ? { f: 0.4, r: 1.0, label: 'Bumpy Endurance Compliance Trim' }
          : { f: 0.2, r: 0.5, label: 'Balanced WEC Medium-Downforce Trim' };

  const springShift = archetype === 'bumpy_endurance' ? -15 : archetype === 'low_drag' ? -5 : 0;

  // 1. Endurance Safe & Consistent
  const enduranceSetup = cloneSetup(base, {
    brakeBiasPct: round1(clamp(base.brakeBiasPct - 0.8, 50.0, 61.0)),
    brakeMigrationPct: isGt3 ? 0 : round1(clamp(base.brakeMigrationPct + 0.5, -2, 4)),
    frontWingDeg: isGt3 ? base.frontWingDeg : round1(clamp(base.frontWingDeg + wingShift.f, 0, 10)),
    rearWingDeg: round1(clamp(base.rearWingDeg + wingShift.r + 0.8, 0.5, 14)),
    frontArbClicks: clamp(base.frontArbClicks, 1, 10),
    rearArbClicks: clamp(base.rearArbClicks - 1, 1, 10),
    frontRideHeightMm: clamp(base.frontRideHeightMm + 2, 36, 75),
    rearRideHeightMm: clamp(base.rearRideHeightMm + 2, 42, 85),
    frontSpringRateNmm: clamp(base.frontSpringRateNmm + springShift - 10, 110, 240),
    rearSpringRateNmm: clamp(base.rearSpringRateNmm + springShift - 10, 110, 240),
    diffPreloadNm: clamp(base.diffPreloadNm + 10, 20, 130),
    diffPowerPct: clamp(base.diffPowerPct + 6, 20, 80),
    diffCoastPct: clamp(base.diffCoastPct + 4, 25, 80),
    tcLevel: clamp(base.tcLevel + 2, 1, 10),
    absLevel: !isGt3 ? 0 : clamp(base.absLevel + 2, 0, 10),
    coldPsi: {
      fl: round1(base.coldPsi.fl + 0.3),
      fr: round1(base.coldPsi.fr + 0.3),
      rl: round1(base.coldPsi.rl + 0.3),
      rr: round1(base.coldPsi.rr + 0.3),
    },
  });

  // 2. Pro Qualifying Attack
  const qualiSetup = cloneSetup(base, {
    brakeBiasPct: round1(clamp(base.brakeBiasPct + 0.4, 50.0, 62.0)),
    brakeMigrationPct: isGt3 ? 0 : round1(clamp(base.brakeMigrationPct - 0.3, -2, 4)),
    frontWingDeg: isGt3 ? base.frontWingDeg : round1(clamp(base.frontWingDeg + wingShift.f + 0.4, 0, 10)),
    rearWingDeg: round1(clamp(base.rearWingDeg + wingShift.r - 0.5, 0.5, 14)),
    frontArbClicks: clamp(base.frontArbClicks + 1, 1, 10),
    rearArbClicks: clamp(base.rearArbClicks + 1, 1, 10),
    frontRideHeightMm: clamp(base.frontRideHeightMm - 2, 36, 75),
    rearRideHeightMm: clamp(base.rearRideHeightMm - 1, 42, 85),
    frontSpringRateNmm: clamp(base.frontSpringRateNmm + springShift + 10, 110, 250),
    rearSpringRateNmm: clamp(base.rearSpringRateNmm + springShift + 10, 110, 250),
    diffPreloadNm: clamp(base.diffPreloadNm - 10, 20, 130),
    diffPowerPct: clamp(base.diffPowerPct - 4, 20, 80),
    diffCoastPct: clamp(base.diffCoastPct - 8, 25, 80),
    tcLevel: clamp(base.tcLevel - 1, 1, 10),
    absLevel: !isGt3 ? 0 : clamp(base.absLevel - 1, 0, 10),
    coldPsi: {
      fl: round1(base.coldPsi.fl - 0.4),
      fr: round1(base.coldPsi.fr - 0.4),
      rl: round1(base.coldPsi.rl - 0.4),
      rr: round1(base.coldPsi.rr - 0.4),
    },
    camberDeg: {
      fl: round1(base.camberDeg.fl - 0.2),
      fr: round1(base.camberDeg.fr - 0.2),
      rl: round1(base.camberDeg.rl - 0.1),
      rr: round1(base.camberDeg.rr - 0.1),
    },
  });

  // 3. Trail-Brake Rotation Spec
  const trailSetup = cloneSetup(base, {
    brakeBiasPct: round1(clamp(base.brakeBiasPct - 1.2, 49.5, 61.0)),
    brakeMigrationPct: isGt3 ? 0 : round1(clamp(base.brakeMigrationPct + 0.8, -2, 4.5)),
    frontWingDeg: isGt3 ? base.frontWingDeg : round1(clamp(base.frontWingDeg + wingShift.f + 0.5, 0, 10)),
    rearWingDeg: round1(clamp(base.rearWingDeg + wingShift.r, 0.5, 14)),
    frontArbClicks: clamp(base.frontArbClicks - 1, 1, 10),
    rearArbClicks: clamp(base.rearArbClicks + 1, 1, 10),
    frontRideHeightMm: clamp(base.frontRideHeightMm - 1, 36, 75),
    rearRideHeightMm: clamp(base.rearRideHeightMm + 1, 42, 85),
    frontSpringRateNmm: clamp(base.frontSpringRateNmm + springShift - 5, 110, 240),
    rearSpringRateNmm: clamp(base.rearSpringRateNmm + springShift + 5, 110, 240),
    diffPreloadNm: clamp(base.diffPreloadNm - 15, 20, 130),
    diffPowerPct: clamp(base.diffPowerPct, 20, 80),
    diffCoastPct: clamp(base.diffCoastPct - 10, 22, 80),
    tcLevel: clamp(base.tcLevel, 1, 10),
    absLevel: !isGt3 ? 0 : clamp(base.absLevel, 0, 10),
  });

  // 4. High-Speed & Kerb Stability
  const kerbStabilitySetup = cloneSetup(base, {
    brakeBiasPct: round1(clamp(base.brakeBiasPct - 0.4, 50.0, 61.5)),
    brakeMigrationPct: isGt3 ? 0 : round1(clamp(base.brakeMigrationPct + 0.3, -2, 4)),
    frontWingDeg: isGt3 ? base.frontWingDeg : round1(clamp(base.frontWingDeg + wingShift.f, 0, 10)),
    rearWingDeg: round1(clamp(base.rearWingDeg + wingShift.r + 1.0, 0.5, 14)),
    frontArbClicks: clamp(base.frontArbClicks - 1, 1, 10),
    rearArbClicks: clamp(base.rearArbClicks - 2, 1, 10),
    frontRideHeightMm: clamp(base.frontRideHeightMm + 3, 38, 78),
    rearRideHeightMm: clamp(base.rearRideHeightMm + 1, 42, 85),
    frontSpringRateNmm: clamp(base.frontSpringRateNmm + springShift - 15, 105, 240),
    rearSpringRateNmm: clamp(base.rearSpringRateNmm + springShift - 15, 105, 240),
    diffPreloadNm: clamp(base.diffPreloadNm + 5, 20, 130),
    diffPowerPct: clamp(base.diffPowerPct + 8, 20, 80),
    diffCoastPct: clamp(base.diffCoastPct + 2, 25, 80),
    tcLevel: clamp(base.tcLevel + 1, 1, 10),
    absLevel: !isGt3 ? 0 : clamp(base.absLevel + 1, 0, 10),
  });

  return [
    {
      id: 'endurance_safe',
      name: 'LMU Pro Endurance Safe',
      tag: 'Stint & Consistency',
      trackCategory: wingShift.label,
      summary: `Forgiving brake release, higher traction support, and stable tire wear for ${car.name} at ${track.name}.`,
      targetDriverStyle: 'Drivers building braking consistency, smoothing lockups, or running full WEC stints.',
      setup: enduranceSetup,
    },
    {
      id: 'quali_attack',
      name: 'LMU Pro Qualifying Attack',
      tag: 'Peak Pace',
      trackCategory: wingShift.label,
      summary: `Lower ride height, sharper front response, and freed coast diff for maximum single-lap rotation on ${track.name}.`,
      targetDriverStyle: 'Consistent, experienced drivers hitting brake markers cleanly who want extra apex speed.',
      setup: qualiSetup,
    },
    {
      id: 'trail_rotation',
      name: 'LMU Trail-Brake Rotation',
      tag: 'Corner Entry & Apex',
      trackCategory: wingShift.label,
      summary: `Rearward brake bias with low diff preload & coast lock so ${car.name} rotates smoothly into heavy chicanes.`,
      targetDriverStyle: 'Drivers losing time on corner entry/apex or fighting front push under trail braking.',
      setup: trailSetup,
    },
    {
      id: 'kerb_highspeed',
      name: 'LMU High-Speed & Kerb Spec',
      tag: 'Aero & Kerb Compliance',
      trackCategory: wingShift.label,
      summary: `Softer springs, extra ride clearance, and locked power diff to absorb chicanes and prevent exit snap.`,
      targetDriverStyle: 'Drivers attacking kerbs aggressively or getting rear snap oversteer on throttle exit.',
      setup: kerbStabilitySetup,
    },
  ];
}

/**
 * AI-style deterministic scoring engine that matches the 4 LMU Pro Presets against
 * BOTH how the driver drives overall (DriverProfile) AND how they drive this specific track
 * (CornerComparisons + live TelemetryFrame).
 */
export function recommendLmuPresets(
  car: CarProfile,
  track: TrackProfile,
  driverProfile: DriverProfile,
  cornerComparisons: CornerComparison[],
  latestFrame: TelemetryFrame
): LmuPresetRecommendation[] {
  const presets = buildLmuProPresetsForTrackAndCar(car, track);
  const archetype = getTrackAeroArchetype(track.id);

  // Track-specific driving diagnostics from cornerComparisons
  const lateBrakeCorners = cornerComparisons.filter((c) => c.brakingDeltaMeters > 6);
  const earlyBrakeCorners = cornerComparisons.filter((c) => c.brakingDeltaMeters < -7);
  const slowApexCorners = cornerComparisons.filter((c) => c.minApexSpeedDeltaKmh < -4);
  const slowExitCorners = cornerComparisons.filter((c) => c.exitSpeedDeltaKmh < -4);
  const avgTrailScore =
    cornerComparisons.length > 0
      ? cornerComparisons.reduce((sum, c) => sum + c.trailBrakingScore, 0) / cornerComparisons.length
      : driverProfile.habits.avgTrailBrakeScore;

  const avgTireTemp =
    (latestFrame.tireTempC.fl +
      latestFrame.tireTempC.fr +
      latestFrame.tireTempC.rl +
      latestFrame.tireTempC.rr) /
    4;

  const { habits, isNewToGame, skillTier, primaryGoal } = driverProfile;

  const scored: LmuPresetRecommendation[] = presets.map((preset) => {
    let score = 58;
    const reasons: string[] = [];
    let estGain = 0.25;

    if (preset.id === 'endurance_safe') {
      if (isNewToGame) {
        score += 20;
        reasons.push('Matched to your Newcomer consistency profile for predictable braking & exit grip.');
      }
      if (habits.lockupCount >= 2) {
        score += 14;
        estGain += 0.22;
        reasons.push(
          car.carClass === 'LMGT3'
            ? `Detected ${habits.lockupCount} front lockups — shifts bias rearward and raises ABS/TC buffer.`
            : `Detected ${habits.lockupCount} front lockups — shifts bias rearward and adds brake migration/TC buffer.`
        );
      }
      if (habits.lateBrakeCount >= 2 || lateBrakeCorners.length >= 2) {
        score += 12;
        estGain += 0.18;
        reasons.push(`Braked late in ${Math.max(habits.lateBrakeCount, lateBrakeCorners.length)} zones on ${track.name}; adds braking margin.`);
      }
      if (habits.brakingConsistencyPct < 72) {
        score += 10;
        reasons.push(`Braking consistency at ${habits.brakingConsistencyPct}% benefits from softer rear roll stiffness.`);
      }
      if (primaryGoal === 'endurance' || avgTireTemp > 96) {
        score += 8;
        reasons.push('Protects tire core temperatures across full LMU endurance stints.');
      }
      if (reasons.length === 0) {
        reasons.push(`Reliable baseline WEC endurance balance for ${car.name} around ${track.name}.`);
      }
    }

    if (preset.id === 'quali_attack') {
      if (!isNewToGame && (skillTier === 'competitive' || skillTier === 'pro')) {
        score += 22;
        estGain += 0.28;
        reasons.push(`Built for your ${skillTier} skill tier to extract maximum rotation and low-drag pace.`);
      }
      if (habits.brakingConsistencyPct >= 80 && habits.lockupCount <= 1) {
        score += 16;
        estGain += 0.2;
        reasons.push(`${habits.brakingConsistencyPct}% braking consistency lets you run -1 TC & lower ride height safely.`);
      }
      if (earlyBrakeCorners.length >= 2) {
        score += 8;
        reasons.push(`You brake early at ${earlyBrakeCorners.length} corners — sharper front aero supports later turn-in.`);
      }
      if (isNewToGame || habits.lockupCount >= 3 || habits.exitSnapCount >= 3) {
        score -= 22;
        reasons.push(
          car.carClass === 'LMGT3'
            ? 'Higher risk: demands clean trail-brake modulation without relying on high TC/ABS.'
            : 'Higher risk: demands clean trail-brake modulation without relying on high TC.'
        );
      }
      if (reasons.length === 0) {
        reasons.push(`Aggressive single-lap trim optimized for ${track.name}.`);
      }
    }

    if (preset.id === 'trail_rotation') {
      if (avgTrailScore < 76 || slowApexCorners.length >= 2) {
        score += 20;
        estGain += 0.26;
        reasons.push(
          `Track telemetry shows ${slowApexCorners.length} slow-apex corners & ${Math.round(avgTrailScore)}% trail score — lower diff coast aids rotation.`
        );
      }
      if (habits.lockupCount >= 1 && !isNewToGame) {
        score += 10;
        reasons.push('Moves brake bias rearward with higher brake migration to stop mid-entry lockups.');
      }
      if (archetype === 'high_downforce' || track.id === 'lemans' || track.id === 'monza') {
        score += 8;
        reasons.push(`Matches ${track.name}'s heavy-braking chicanes where entry rotation saves tenths.`);
      }
      if (reasons.length === 0) {
        reasons.push(`Neutralizes entry understeer on ${car.name} without hurting rear exit traction.`);
      }
    }

    if (preset.id === 'kerb_highspeed') {
      if (habits.exitSnapCount >= 2 || slowExitCorners.length >= 2) {
        score += 22;
        estGain += 0.3;
        reasons.push(
          `Addresses ${habits.exitSnapCount} exit snap events & ${slowExitCorners.length} slow corner exits with softer rear ARB + diff power lock.`
        );
      }
      if (habits.offTrackCount >= 2) {
        score += 10;
        reasons.push('Softer springs & +3mm front clearance absorb kerbs so you stay within LMU track limits.');
      }
      if (archetype === 'bumpy_endurance' || track.id === 'spa' || track.id === 'lemans') {
        score += 12;
        reasons.push(`Tailored for ${track.name}'s high-speed aero sweepers and heavy chicane kerbs.`);
      }
      if (reasons.length === 0) {
        reasons.push(`Maximum kerb & high-speed stability package for ${car.name}.`);
      }
    }

    return {
      preset,
      matchScore: Math.round(clamp(score, 32, 98)),
      isTopPick: false,
      reasons: reasons.slice(0, 3),
      estimatedGainSec: Math.round(estGain * 100) / 100,
    };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);
  if (scored.length > 0) {
    scored[0].isTopPick = true;
  }
  return scored;
}
