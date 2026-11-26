import type {
  BrakingFeel,
  CarProfile,
  CarSetup,
  CornerComparison,
  CornerDefinition,
  DriverProfile,
  DriverSetupIntake,
  HandlingSymptom,
  SetupAdjustment,
  SetupDiagnosis,
  SmartSetupPlan,
  SmartSetupSignal,
  StintObjective,
  TelemetryFrame,
  TrackCondition,
  TrackProfile,
} from '../types/telemetry';

export const HANDLING_SYMPTOMS: Array<{
  id: HandlingSymptom;
  label: string;
  shortDesc: string;
}> = [
  {
    id: 'late_brake_lockup',
    label: 'Front Lockup Under Braking',
    shortDesc: 'Inside front locks or ABS engages early in heavy braking zones',
  },
  {
    id: 'entry_understeer',
    label: 'Corner Entry Understeer',
    shortDesc: 'Car pushes wide on initial turn-in while trail braking',
  },
  {
    id: 'mid_corner_understeer',
    label: 'Mid-Corner Washout',
    shortDesc: 'Front axle loses bite past apex before throttle pickup',
  },
  {
    id: 'exit_snap_oversteer',
    label: 'Exit Snap Oversteer',
    shortDesc: 'Rear steps out abruptly when feeding power out of slow/medium corners',
  },
  {
    id: 'high_speed_instability',
    label: 'High-Speed Aero Instability',
    shortDesc: 'Rear feels nervous through fast sweepers like Porsche Curves or Pouhon',
  },
  {
    id: 'kerb_bouncing',
    label: 'Kerb Bounce & Hop',
    shortDesc: 'Car skips across chicane kerbs and loses braking stability',
  },
  {
    id: 'tire_overheating',
    label: 'Tire Core Overheating',
    shortDesc: 'Surface and core temps exceed 100°C after 3–4 push laps',
  },
];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function diagnoseAndRecommendSetup(
  setup: CarSetup,
  symptom: HandlingSymptom,
  car: CarProfile,
  track: TrackProfile
): SetupDiagnosis {
  const adjustments: SetupAdjustment[] = [];
  let summary = '';
  let drivingTip = '';
  let estimatedGainSec = 0.35;

  switch (symptom) {
    case 'late_brake_lockup': {
      const targetBias = Math.round(clamp(setup.brakeBiasPct - 1.4, 49.0, 62.0) * 10) / 10;
      const targetMigration = Math.round(clamp(setup.brakeMigrationPct + 0.6, -3.0, 4.0) * 10) / 10;
      const targetAbs = Math.min(8, setup.absLevel + 1);
      adjustments.push({
        parameterKey: 'brakeBiasPct',
        parameterLabel: 'Brake Bias (Front %)',
        currentValue: `${setup.brakeBiasPct.toFixed(1)}%`,
        recommendedValue: `${targetBias.toFixed(1)}%`,
        deltaLabel: `${(targetBias - setup.brakeBiasPct).toFixed(1)}%`,
        reason: 'Shifts braking load rearward to relieve overloaded front tires at peak pressure.',
        numericTarget: targetBias,
      });
      if (car.carClass !== 'LMGT3') {
        adjustments.push({
          parameterKey: 'brakeMigrationPct',
          parameterLabel: 'Brake Migration',
          currentValue: `${setup.brakeMigrationPct.toFixed(1)}%`,
          recommendedValue: `${targetMigration.toFixed(1)}%`,
          deltaLabel: `+${(targetMigration - setup.brakeMigrationPct).toFixed(1)}%`,
          reason: 'Moves bias forward only at high aero downforce, then bleeds rearward into apex.',
          numericTarget: targetMigration,
        });
      } else {
        adjustments.push({
          parameterKey: 'absLevel',
          parameterLabel: 'ABS Map',
          currentValue: `${setup.absLevel}`,
          recommendedValue: `${targetAbs}`,
          deltaLabel: '+1 step',
          reason: 'Adds slight intervention margin on bumpy braking zones without hurting stopping distance.',
          numericTarget: targetAbs,
        });
      }
      summary = `Shifting brake bias rearward on ${car.name} for ${track.name}'s heavy braking zones prevents inside-front lockup and improves trail rotation.`;
      drivingTip = 'Hit 95% peak brake initially, then bleed off smoothly below 35% as steering angle increases.';
      estimatedGainSec = 0.42;
      break;
    }

    case 'entry_understeer': {
      const targetFrontArb = Math.max(1, setup.frontArbClicks - 1);
      const targetDiffCoast = Math.max(25, setup.diffCoastPct - 6);
      const targetFrontHeight = Math.max(38, setup.frontRideHeightMm - 2);
      adjustments.push(
        {
          parameterKey: 'frontArbClicks',
          parameterLabel: 'Front Anti-Roll Bar',
          currentValue: `${setup.frontArbClicks} clicks`,
          recommendedValue: `${targetFrontArb} clicks`,
          deltaLabel: '-1 click',
          reason: 'Softens front roll stiffness on turn-in so the outside front tire builds lateral grip sooner.',
          numericTarget: targetFrontArb,
        },
        {
          parameterKey: 'diffCoastPct',
          parameterLabel: 'Diff Coast Lock',
          currentValue: `${setup.diffCoastPct}%`,
          recommendedValue: `${targetDiffCoast}%`,
          deltaLabel: '-6%',
          reason: 'Allows rear wheels to rotate more freely off-throttle during trail braking.',
          numericTarget: targetDiffCoast,
        },
        {
          parameterKey: 'frontRideHeightMm',
          parameterLabel: 'Front Ride Height',
          currentValue: `${setup.frontRideHeightMm} mm`,
          recommendedValue: `${targetFrontHeight} mm`,
          deltaLabel: '-2 mm',
          reason: 'Increases front splitter rake and aero pitch sensitivity under braking.',
          numericTarget: targetFrontHeight,
        }
      );
      summary = `Freeing front roll compliance and lowering coast diff lock sharpens turn-in bite on ${track.name}.`;
      drivingTip = 'Hold 10–15% light trail brake all the way to the apex to keep nose weight planted.';
      estimatedGainSec = 0.38;
      break;
    }

    case 'mid_corner_understeer': {
      const targetRearArb = Math.min(10, setup.rearArbClicks + 1);
      const targetFrontWing = Math.round((setup.frontWingDeg + 0.5) * 10) / 10;
      const targetPreload = Math.max(20, setup.diffPreloadNm - 10);
      adjustments.push(
        {
          parameterKey: 'rearArbClicks',
          parameterLabel: 'Rear Anti-Roll Bar',
          currentValue: `${setup.rearArbClicks} clicks`,
          recommendedValue: `${targetRearArb} clicks`,
          deltaLabel: '+1 click',
          reason: 'Transfers lateral load toward the rear axle mid-corner, helping the nose stay tucked on the apex.',
          numericTarget: targetRearArb,
        },
        {
          parameterKey: 'frontWingDeg',
          parameterLabel: 'Front Wing / Diveplane',
          currentValue: `${setup.frontWingDeg.toFixed(1)}°`,
          recommendedValue: `${targetFrontWing.toFixed(1)}°`,
          deltaLabel: '+0.5°',
          reason: 'Shifts aerodynamic balance forward for medium-speed sustained corners.',
          numericTarget: targetFrontWing,
        },
        {
          parameterKey: 'diffPreloadNm',
          parameterLabel: 'Diff Preload',
          currentValue: `${setup.diffPreloadNm} Nm`,
          recommendedValue: `${targetPreload} Nm`,
          deltaLabel: '-10 Nm',
          reason: 'Reduces static locking torque at low-load transition between braking and throttle.',
          numericTarget: targetPreload,
        }
      );
      summary = `Adding rear roll stiffness and 10 Nm less preload eliminates mid-corner push without sacrificing straight-line speed.`;
      drivingTip = 'Wait an extra car length before picking up maintenance throttle so the front stays loaded.';
      estimatedGainSec = 0.31;
      break;
    }

    case 'exit_snap_oversteer': {
      const targetRearArb = Math.max(1, setup.rearArbClicks - 1);
      const targetDiffPower = Math.min(75, setup.diffPowerPct + 6);
      const targetTc = Math.min(10, setup.tcLevel + 1);
      adjustments.push(
        {
          parameterKey: 'rearArbClicks',
          parameterLabel: 'Rear Anti-Roll Bar',
          currentValue: `${setup.rearArbClicks} clicks`,
          recommendedValue: `${targetRearArb} clicks`,
          deltaLabel: '-1 click',
          reason: 'Softens rear lateral weight transfer on power, giving rear tires progressive slip.',
          numericTarget: targetRearArb,
        },
        {
          parameterKey: 'diffPowerPct',
          parameterLabel: 'Diff Power Lock',
          currentValue: `${setup.diffPowerPct}%`,
          recommendedValue: `${targetDiffPower}%`,
          deltaLabel: '+6%',
          reason: 'Equalizes torque across both rear wheels on corner exit to tame sudden inside wheelspin.',
          numericTarget: targetDiffPower,
        },
        {
          parameterKey: 'tcLevel',
          parameterLabel: 'Traction Control',
          currentValue: `${setup.tcLevel}`,
          recommendedValue: `${targetTc}`,
          deltaLabel: '+1 step',
          reason: 'Smooths initial torque spike over bumpy exit kerbs.',
          numericTarget: targetTc,
        }
      );
      summary = `Softening the rear ARB and raising power diff lock calms exit snap on ${car.name} so you can get on full throttle earlier.`;
      drivingTip = 'Unwind steering angle in sync with your throttle ramp—never exceed 70% throttle with heavy lock.';
      estimatedGainSec = 0.48;
      break;
    }

    case 'high_speed_instability': {
      const targetRearWing = Math.round(clamp(setup.rearWingDeg + 1.0, 0, 12) * 10) / 10;
      const targetRearHeight = Math.max(40, setup.rearRideHeightMm - 2);
      adjustments.push(
        {
          parameterKey: 'rearWingDeg',
          parameterLabel: 'Rear Wing Angle',
          currentValue: `${setup.rearWingDeg.toFixed(1)}°`,
          recommendedValue: `${targetRearWing.toFixed(1)}°`,
          deltaLabel: '+1.0°',
          reason: 'Stabilizes rear aero platform through 220+ km/h corners and under high-speed braking.',
          numericTarget: targetRearWing,
        },
        {
          parameterKey: 'rearRideHeightMm',
          parameterLabel: 'Rear Ride Height',
          currentValue: `${setup.rearRideHeightMm} mm`,
          recommendedValue: `${targetRearHeight} mm`,
          deltaLabel: '-2 mm',
          reason: 'Reduces static rake slightly so the rear diffuser remains consistent under pitch.',
          numericTarget: targetRearHeight,
        }
      );
      summary = `One degree of rear wing and 2mm lower rear ride height anchors the rear end in high-speed transitions on ${track.name}.`;
      drivingTip = 'Keep steering inputs linear and gradual in fast aero sweepers—avoid sudden mid-corner corrections.';
      estimatedGainSec = 0.36;
      break;
    }

    case 'kerb_bouncing': {
      const targetFrontSpring = Math.max(110, setup.frontSpringRateNmm - 15);
      const targetRearSpring = Math.max(110, setup.rearSpringRateNmm - 15);
      const targetFrontHeight = setup.frontRideHeightMm + 2;
      adjustments.push(
        {
          parameterKey: 'frontSpringRateNmm',
          parameterLabel: 'Front Spring Rate',
          currentValue: `${setup.frontSpringRateNmm} N/mm`,
          recommendedValue: `${targetFrontSpring} N/mm`,
          deltaLabel: '-15 N/mm',
          reason: 'Absorbs aggressive chicane kerb strikes without launching the front tires off the surface.',
          numericTarget: targetFrontSpring,
        },
        {
          parameterKey: 'rearSpringRateNmm',
          parameterLabel: 'Rear Spring Rate',
          currentValue: `${setup.rearSpringRateNmm} N/mm`,
          recommendedValue: `${targetRearSpring} N/mm`,
          deltaLabel: '-15 N/mm',
          reason: 'Keeps rear contact patch compliant over exit sausage kerbs.',
          numericTarget: targetRearSpring,
        },
        {
          parameterKey: 'frontRideHeightMm',
          parameterLabel: 'Front Ride Height',
          currentValue: `${setup.frontRideHeightMm} mm`,
          recommendedValue: `${targetFrontHeight} mm`,
          deltaLabel: '+2 mm',
          reason: 'Prevents plank bottoming when riding chicanes aggressively.',
          numericTarget: targetFrontHeight,
        }
      );
      summary = `Softening springs by 15 N/mm and adding 2mm front clearance lets you attack chicanes cleanly without losing traction.`;
      drivingTip = 'Straighten the wheel slightly over the apex kerb so suspension travels vertically rather than laterally.';
      estimatedGainSec = 0.29;
      break;
    }

    case 'tire_overheating': {
      const nextFl = Math.round((setup.coldPsi.fl + 0.5) * 10) / 10;
      const nextFr = Math.round((setup.coldPsi.fr + 0.5) * 10) / 10;
      adjustments.push(
        {
          parameterKey: 'coldPsi',
          parameterLabel: 'Cold Front Tire Pressure',
          currentValue: `${setup.coldPsi.fl.toFixed(1)} / ${setup.coldPsi.fr.toFixed(1)} PSI`,
          recommendedValue: `${nextFl.toFixed(1)} / ${nextFr.toFixed(1)} PSI`,
          deltaLabel: '+0.5 PSI',
          reason: 'Reduces sidewall flexing and carcass hysteresis heat buildup over long endurance stints.',
          numericTarget: nextFl,
        },
        {
          parameterKey: 'camberDeg',
          parameterLabel: 'Front Camber',
          currentValue: `${setup.camberDeg.fl.toFixed(1)}°`,
          recommendedValue: `${(setup.camberDeg.fl + 0.3).toFixed(1)}°`,
          deltaLabel: '+0.3° (less neg)',
          reason: 'Spreads thermal load more evenly across the inner and middle tire tread.',
          numericTarget: Math.round((setup.camberDeg.fl + 0.3) * 10) / 10,
        }
      );
      summary = `Raising cold pressures by 0.5 PSI and reducing negative camber lowers peak carcass temperature during long stints.`;
      drivingTip = 'Avoid scrubbing the front tires with excess steering angle at low speeds—turn in once smoothly.';
      estimatedGainSec = 0.25;
      break;
    }
  }

  return {
    symptom,
    summary,
    estimatedGainSec,
    adjustments,
    drivingTip,
  };
}

export function applyRecommendationsToSetup(
  setup: CarSetup,
  adjustments: SetupAdjustment[]
): CarSetup {
  const next: CarSetup = {
    ...setup,
    coldPsi: { ...setup.coldPsi },
    camberDeg: { ...setup.camberDeg },
  };

  for (const adj of adjustments) {
    if (adj.numericTarget === undefined) continue;
    if (adj.parameterKey === 'coldPsi') {
      next.coldPsi.fl = adj.numericTarget;
      next.coldPsi.fr = adj.numericTarget;
    } else if (adj.parameterKey === 'camberDeg') {
      next.camberDeg.fl = adj.numericTarget;
      next.camberDeg.fr = adj.numericTarget;
    } else {
      (next[adj.parameterKey] as number) = adj.numericTarget;
    }
  }

  return next;
}

export function exportSetupToLmuText(
  setup: CarSetup,
  car: CarProfile,
  track: TrackProfile
): string {
  return [
    `// ApexEngineer Setup Export for ${car.name} @ ${track.name}`,
    `VehicleClassSetting="${car.carClass}"`,
    `[GENERAL]`,
    `BrakeBiasSetting=${setup.brakeBiasPct.toFixed(1)}%`,
    `BrakeMigrationSetting=${setup.brakeMigrationPct.toFixed(1)}%`,
    `TractionControlSetting=${setup.tcLevel}`,
    car.carClass === 'LMGT3' ? `ABSSetting=${setup.absLevel}` : `ABSSetting=N/A (No ABS on ${car.carClass})`,
    ...(car.carClass === 'Hypercar' ? [`VirtualEnergyPitTarget=100%`] : []),
    `[AERO]`,
    `FrontWingSetting=${setup.frontWingDeg.toFixed(1)} deg`,
    `RearWingSetting=${setup.rearWingDeg.toFixed(1)} deg`,
    `[CHASSIS]`,
    `FrontAntiSwaySetting=${setup.frontArbClicks} clicks`,
    `RearAntiSwaySetting=${setup.rearArbClicks} clicks`,
    `FrontRideHeight=${setup.frontRideHeightMm} mm`,
    `RearRideHeight=${setup.rearRideHeightMm} mm`,
    `FrontSpringRate=${setup.frontSpringRateNmm} N/mm`,
    `RearSpringRate=${setup.rearSpringRateNmm} N/mm`,
    `[DRIVELINE]`,
    `DiffPreload=${setup.diffPreloadNm} Nm`,
    `DiffPower=${setup.diffPowerPct}%`,
    `DiffCoast=${setup.diffCoastPct}%`,
    `[TIRES]`,
    `FrontLeftPressure=${setup.coldPsi.fl.toFixed(1)} psi`,
    `FrontRightPressure=${setup.coldPsi.fr.toFixed(1)} psi`,
    `RearLeftPressure=${setup.coldPsi.rl.toFixed(1)} psi`,
    `RearRightPressure=${setup.coldPsi.rr.toFixed(1)} psi`,
    `FrontCamber=${setup.camberDeg.fl.toFixed(1)} deg`,
    `RearCamber=${setup.camberDeg.rl.toFixed(1)} deg`,
  ].join('\n');
}

export const DEFAULT_DRIVER_SETUP_INTAKE: DriverSetupIntake = {
  primarySymptom: 'auto',
  freeTextFeedback: '',
  cornerFocusId: 'auto',
  trackCondition: 'optimal',
  stintObjective: 'balanced_race',
  brakingFeel: 'balanced',
  useTelemetrySignals: true,
};

export interface ParsedDriverFeedback {
  detectedSymptoms: HandlingSymptom[];
  mentionedCorners: CornerDefinition[];
  severityMultiplier: number;
  mentionsColdTires: boolean;
  mentionsTopSpeedDrag: boolean;
}

export function parseDriverSetupFeedback(
  rawText: string,
  track: TrackProfile
): ParsedDriverFeedback {
  const text = (rawText || '').trim().toLowerCase();
  if (!text) {
    return {
      detectedSymptoms: [],
      mentionedCorners: [],
      severityMultiplier: 1,
      mentionsColdTires: false,
      mentionsTopSpeedDrag: false,
    };
  }

  const detectedSymptoms: HandlingSymptom[] = [];
  const pushSymptom = (s: HandlingSymptom) => {
    if (!detectedSymptoms.includes(s)) detectedSymptoms.push(s);
  };

  if (
    /lock\s?up|locking|flat\s?spot|abs\s+(kicking|early|too much|trigger)|front\s+lock|locks?.*braking|under\s+braking.*lock/i.test(
      text
    )
  ) {
    pushSymptom('late_brake_lockup');
  }

  if (
    /(exit|exiting|on\s+throttle|on\s+power|accelerating).*(snap|oversteer|loose|spin|step\s?out|tail|slide)|(snap|oversteer|loose|spin|step\s?out|slides?).*(exit|exiting|throttle|power)|wheel\s?spin|rear\s+(snaps?|steps?\s+out|slides?)/i.test(
      text
    )
  ) {
    pushSymptom('exit_snap_oversteer');
  }

  if (
    /(entry|turn[\s-]?in|trail[\s-]?brak).*(understeer|push|wide|won'?t turn|plow)|(understeer|push(?:es|ing)?|wide|plow).*(entry|turn[\s-]?in|trail[\s-]?brak)|won'?t turn in|nose\s+pushes/i.test(
      text
    )
  ) {
    pushSymptom('entry_understeer');
  }

  if (
    /(mid[\s-]?corner|apex).*(understeer|push|wash\s?out|wide)|(understeer|push(?:es|ing)?|wash(?:es|ing)?\s+out).*(mid[\s-]?corner|apex)|wash(?:es|ing)?\s+out|front\s+(washes|loses\s+bite)|general\s+understeer/i.test(
      text
    ) ||
    (/\bundersteer\b/i.test(text) && !detectedSymptoms.includes('entry_understeer'))
  ) {
    pushSymptom('mid_corner_understeer');
  }

  if (
    /(high[\s-]?speed|fast\s+(corner|sweeper)|aero|porsche\s+curves|eau\s+rouge|raidillon|blanchimont|mulsanne|parabolica|130r).*(nervous|unstable|loose|floaty|sketchy|snap)|aero\s+instab|rear\s+feels\s+nervous/i.test(
      text
    )
  ) {
    pushSymptom('high_speed_instability');
  }

  if (/kerb|curb|chicane|bounce|bouncing|hop|bottom(ing)?|plank|bumpy|bumps/i.test(text)) {
    pushSymptom('kerb_bouncing');
  }

  if (
    /(overheat|too\s+hot|hot\s+tires|tyres?\s+(too\s+)?hot|blister|cooking|temps?\s+(over|above|>|high)|10[0-9]\s*°?\s*c)/i.test(
      text
    )
  ) {
    pushSymptom('tire_overheating');
  }

  // Generic "oversteer" without exit/high-speed context defaults to exit_snap_oversteer
  if (
    /\b(oversteer|tail[\s-]?happy|loose\s+rear)\b/i.test(text) &&
    !detectedSymptoms.includes('exit_snap_oversteer') &&
    !detectedSymptoms.includes('high_speed_instability')
  ) {
    pushSymptom('exit_snap_oversteer');
  }

  const mentionedCorners: CornerDefinition[] = [];
  for (const corner of track.corners) {
    const turnRegex = new RegExp(`\\b(?:t|turn)\\s*0?${corner.number}\\b`, 'i');
    const cleanCornerName = corner.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const significantTokens = cleanCornerName.split(/\s+/).filter((w) => w.length >= 4);
    const matchesName =
      cleanCornerName.length >= 4 &&
      (text.includes(cleanCornerName) ||
        (significantTokens.length > 0 && significantTokens.some((tok) => text.includes(tok))));
    if (turnRegex.test(text) || matchesName) {
      mentionedCorners.push(corner);
    }
  }

  let severityMultiplier = 1;
  if (/\b(massive|severe|terrible|violent|huge|uncontrollable|every\s+lap|constantly|awful)\b/i.test(text)) {
    severityMultiplier = 1.35;
  } else if (/\b(slight|little|mild|minor|tiny|bit\s+of)\b/i.test(text)) {
    severityMultiplier = 0.8;
  }

  const mentionsColdTires = /cold\s+tires?|won'?t\s+warm|no\s+grip\s+early|out[\s-]?lap\s+ice/i.test(text);
  const mentionsTopSpeedDrag = /slow\s+on\s+straight|too\s+much\s+drag|draggy|top\s+speed\s+low/i.test(text);

  return {
    detectedSymptoms,
    mentionedCorners,
    severityMultiplier,
    mentionsColdTires,
    mentionsTopSpeedDrag,
  };
}

interface ParamDeltaBucket {
  delta: number;
  reasons: string[];
}

type NumericSetupKey =
  | 'brakeBiasPct'
  | 'brakeMigrationPct'
  | 'tcLevel'
  | 'absLevel'
  | 'frontWingDeg'
  | 'rearWingDeg'
  | 'frontRideHeightMm'
  | 'rearRideHeightMm'
  | 'frontArbClicks'
  | 'rearArbClicks'
  | 'frontSpringRateNmm'
  | 'rearSpringRateNmm'
  | 'diffPowerPct'
  | 'diffCoastPct'
  | 'diffPreloadNm'
  | 'coldPsi'
  | 'camberDeg';

const PARAM_LABELS: Record<NumericSetupKey, string> = {
  brakeBiasPct: 'Brake Bias (Front %)',
  brakeMigrationPct: 'Brake Migration',
  tcLevel: 'Traction Control',
  absLevel: 'ABS Map',
  frontWingDeg: 'Front Wing / Diveplane',
  rearWingDeg: 'Rear Wing Angle',
  frontRideHeightMm: 'Front Ride Height',
  rearRideHeightMm: 'Rear Ride Height',
  frontArbClicks: 'Front Anti-Roll Bar',
  rearArbClicks: 'Rear Anti-Roll Bar',
  frontSpringRateNmm: 'Front Spring Rate',
  rearSpringRateNmm: 'Rear Spring Rate',
  diffPowerPct: 'Diff Power Lock',
  diffCoastPct: 'Diff Coast Lock',
  diffPreloadNm: 'Diff Preload',
  coldPsi: 'Cold Front Tire Pressure',
  camberDeg: 'Front Camber',
};

function getCurrentNumericForKey(setup: CarSetup, key: NumericSetupKey): number {
  if (key === 'coldPsi') return setup.coldPsi.fl;
  if (key === 'camberDeg') return setup.camberDeg.fl;
  return setup[key];
}

function clampSetupParamValue(
  key: NumericSetupKey,
  value: number,
  car: CarProfile
): { target: number; precision: number; unit: string } {
  switch (key) {
    case 'brakeBiasPct':
      return { target: Math.round(clamp(value, 48.0, 64.0) * 10) / 10, precision: 1, unit: '%' };
    case 'brakeMigrationPct':
      return { target: Math.round(clamp(value, -5.0, 5.0) * 10) / 10, precision: 1, unit: '%' };
    case 'tcLevel':
      return { target: Math.round(clamp(value, 1, 10)), precision: 0, unit: ' step' };
    case 'absLevel':
      return {
        target: car.carClass === 'LMGT3' ? Math.round(clamp(value, 1, 10)) : 0,
        precision: 0,
        unit: ' step',
      };
    case 'frontWingDeg':
      return { target: Math.round(clamp(value, 0, 10) * 2) / 2, precision: 1, unit: '°' };
    case 'rearWingDeg':
      return { target: Math.round(clamp(value, 0, 14) * 2) / 2, precision: 1, unit: '°' };
    case 'frontRideHeightMm':
      return { target: Math.round(clamp(value, 35, 80)), precision: 0, unit: ' mm' };
    case 'rearRideHeightMm':
      return { target: Math.round(clamp(value, 40, 90)), precision: 0, unit: ' mm' };
    case 'frontArbClicks':
    case 'rearArbClicks':
      return { target: Math.round(clamp(value, 1, 10)), precision: 0, unit: ' clicks' };
    case 'frontSpringRateNmm':
    case 'rearSpringRateNmm':
      return { target: Math.round(clamp(value, 100, 260) / 5) * 5, precision: 0, unit: ' N/mm' };
    case 'diffPowerPct':
    case 'diffCoastPct':
      return { target: Math.round(clamp(value, 15, 85)), precision: 0, unit: '%' };
    case 'diffPreloadNm':
      return { target: Math.round(clamp(value, 10, 150) / 5) * 5, precision: 0, unit: ' Nm' };
    case 'coldPsi':
      return { target: Math.round(clamp(value, 20.0, 31.0) * 10) / 10, precision: 1, unit: ' PSI' };
    case 'camberDeg':
      return { target: Math.round(clamp(value, -4.5, -1.2) * 10) / 10, precision: 1, unit: '°' };
  }
}

function formatParamValue(key: NumericSetupKey, val: number): string {
  switch (key) {
    case 'brakeBiasPct':
    case 'brakeMigrationPct':
      return `${val.toFixed(1)}%`;
    case 'frontWingDeg':
    case 'rearWingDeg':
    case 'camberDeg':
      return `${val.toFixed(1)}°`;
    case 'frontRideHeightMm':
    case 'rearRideHeightMm':
      return `${Math.round(val)} mm`;
    case 'frontArbClicks':
    case 'rearArbClicks':
      return `${Math.round(val)} clicks`;
    case 'frontSpringRateNmm':
    case 'rearSpringRateNmm':
      return `${Math.round(val)} N/mm`;
    case 'diffPowerPct':
    case 'diffCoastPct':
      return `${Math.round(val)}%`;
    case 'diffPreloadNm':
      return `${Math.round(val)} Nm`;
    case 'coldPsi':
      return `${val.toFixed(1)} PSI`;
    case 'tcLevel':
    case 'absLevel':
      return `Map ${Math.round(val)}`;
  }
}

/**
 * Combines free-text driver notes, explicit symptom selection, track/stint/braking context,
 * persistent driver habits, and live telemetry/corner comparisons into a prioritized,
 * class-legal setup recommendation plan.
 */
export function buildSmartSetupPlan(params: {
  setup: CarSetup;
  intake: DriverSetupIntake;
  car: CarProfile;
  track: TrackProfile;
  driverProfile?: DriverProfile;
  cornerComparisons?: CornerComparison[];
  latestFrame?: TelemetryFrame;
}): SmartSetupPlan {
  const { setup, intake, car, track, driverProfile, cornerComparisons = [], latestFrame } = params;
  const parsed = parseDriverSetupFeedback(intake.freeTextFeedback, track);
  const signals: SmartSetupSignal[] = [];

  // 1. Collect symptoms from free-text feedback + explicit dropdown + live telemetry
  const symptomSet = new Set<HandlingSymptom>(parsed.detectedSymptoms);
  if (intake.primarySymptom !== 'auto') {
    symptomSet.add(intake.primarySymptom);
  }

  if (parsed.detectedSymptoms.length > 0) {
    signals.push({
      source: 'feedback',
      label: 'Driver Notes',
      detail: `Detected ${parsed.detectedSymptoms
        .map((s) => HANDLING_SYMPTOMS.find((h) => h.id === s)?.label ?? s)
        .join(' + ')}`,
    });
  }

  // Telemetry-driven inference (only when enabled)
  if (intake.useTelemetrySignals) {
    const worstCorner = [...cornerComparisons].sort((a, b) => b.timeLostSec - a.timeLostSec)[0];
    if (worstCorner && worstCorner.timeLostSec >= 0.08) {
      if (worstCorner.brakingDeltaMeters >= 7) {
        symptomSet.add('late_brake_lockup');
        signals.push({
          source: 'telemetry',
          label: `T${worstCorner.cornerNumber} Braking`,
          detail: `+${worstCorner.brakingDeltaMeters.toFixed(0)}m late brake (-${worstCorner.timeLostSec.toFixed(2)}s)`,
        });
      } else if (worstCorner.minApexSpeedDeltaKmh <= -5) {
        symptomSet.add('mid_corner_understeer');
        signals.push({
          source: 'telemetry',
          label: `T${worstCorner.cornerNumber} Apex`,
          detail: `${worstCorner.minApexSpeedDeltaKmh.toFixed(0)} km/h apex loss (-${worstCorner.timeLostSec.toFixed(2)}s)`,
        });
      } else if (worstCorner.exitSpeedDeltaKmh <= -4) {
        symptomSet.add('exit_snap_oversteer');
        signals.push({
          source: 'telemetry',
          label: `T${worstCorner.cornerNumber} Exit`,
          detail: `${worstCorner.exitSpeedDeltaKmh.toFixed(0)} km/h exit loss (-${worstCorner.timeLostSec.toFixed(2)}s)`,
        });
      }
    }

    if (latestFrame) {
      const peakFrontTemp = Math.max(latestFrame.tireTempC.fl, latestFrame.tireTempC.fr);
      const peakRearTemp = Math.max(latestFrame.tireTempC.rl, latestFrame.tireTempC.rr);
      const maxOptimal = car.optimalTireTempRange[1];
      const minOptimal = car.optimalTireTempRange[0];

      if (peakFrontTemp > maxOptimal + 4 || peakRearTemp > maxOptimal + 4) {
        symptomSet.add('tire_overheating');
        signals.push({
          source: 'telemetry',
          label: 'Hot Tires',
          detail: `Peak ${Math.round(Math.max(peakFrontTemp, peakRearTemp))}°C > ${maxOptimal}°C window`,
        });
      } else if (
        latestFrame.speedKmh > 40 &&
        Math.min(latestFrame.tireTempC.fl, latestFrame.tireTempC.fr) < minOptimal - 10
      ) {
        signals.push({
          source: 'telemetry',
          label: 'Cold Tires',
          detail: `Fronts at ${Math.round(Math.min(latestFrame.tireTempC.fl, latestFrame.tireTempC.fr))}°C (<${minOptimal}°C)`,
        });
      }

      if (latestFrame.frontWheelSlip > 0.18 && latestFrame.brake > 0.45) {
        symptomSet.add('late_brake_lockup');
        signals.push({
          source: 'telemetry',
          label: 'Live Front Slip',
          detail: `${Math.round(latestFrame.frontWheelSlip * 100)}% slip under braking`,
        });
      }
      if (latestFrame.rearWheelSlip > 0.18 && latestFrame.throttle > 0.65) {
        symptomSet.add('exit_snap_oversteer');
        signals.push({
          source: 'telemetry',
          label: 'Live Rear Slip',
          detail: `${Math.round(latestFrame.rearWheelSlip * 100)}% wheelspin on throttle`,
        });
      }
    }
  }

  // Driver profile habits
  if (driverProfile) {
    if (driverProfile.habits.lockupCount >= 2 && !symptomSet.has('late_brake_lockup')) {
      symptomSet.add('late_brake_lockup');
      signals.push({
        source: 'profile',
        label: 'Habit History',
        detail: `${driverProfile.habits.lockupCount} recorded lockups`,
      });
    }
    if (driverProfile.habits.exitSnapCount >= 2 && !symptomSet.has('exit_snap_oversteer')) {
      symptomSet.add('exit_snap_oversteer');
      signals.push({
        source: 'profile',
        label: 'Habit History',
        detail: `${driverProfile.habits.exitSnapCount} recorded exit snaps`,
      });
    }
    if (driverProfile.isNewToGame) {
      signals.push({
        source: 'profile',
        label: 'Driver Tier',
        detail: 'Newcomer stability margin active',
      });
    }
  }

  // Fallback if user gave no text/telemetry/habits yet
  if (symptomSet.size === 0) {
    symptomSet.add('late_brake_lockup');
  }

  const detectedSymptoms = Array.from(symptomSet);
  const primarySymptom =
    intake.primarySymptom !== 'auto' ? intake.primarySymptom : detectedSymptoms[0];

  // Resolve target corner
  const explicitCorner =
    intake.cornerFocusId !== 'auto'
      ? track.corners.find((c) => c.id === intake.cornerFocusId) ?? null
      : null;
  const telemetryWorstCorner =
    intake.useTelemetrySignals && cornerComparisons.length > 0
      ? [...cornerComparisons].sort((a, b) => b.timeLostSec - a.timeLostSec)[0]
      : null;
  const resolvedCornerLabel = explicitCorner
    ? `T${explicitCorner.number} ${explicitCorner.name}`
    : parsed.mentionedCorners[0]
      ? `T${parsed.mentionedCorners[0].number} ${parsed.mentionedCorners[0].name}`
      : telemetryWorstCorner && telemetryWorstCorner.timeLostSec > 0.05
        ? `T${telemetryWorstCorner.cornerNumber} ${telemetryWorstCorner.cornerName}`
        : null;

  // 2. Accumulate physics deltas across symptoms + user conditions
  const deltas = new Map<NumericSetupKey, ParamDeltaBucket>();
  const addDelta = (key: NumericSetupKey, amount: number, reason: string) => {
    if (key === 'absLevel' && car.carClass !== 'LMGT3') return;
    if (key === 'brakeMigrationPct' && car.carClass === 'LMGT3') return;
    const prev = deltas.get(key) ?? { delta: 0, reasons: [] };
    prev.delta += amount;
    if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
    deltas.set(key, prev);
  };

  const sev = parsed.severityMultiplier;

  for (const sym of detectedSymptoms) {
    switch (sym) {
      case 'late_brake_lockup':
        addDelta('brakeBiasPct', -1.2 * sev, 'Relieves overloaded front tires at peak braking pressure.');
        if (car.carClass !== 'LMGT3') {
          addDelta(
            'brakeMigrationPct',
            0.6 * sev,
            'Keeps bias forward at high aero speed and bleeds rearward into the apex.'
          );
        } else {
          addDelta('absLevel', 1, 'Adds braking safety margin on bumpy entry zones.');
        }
        break;
      case 'entry_understeer':
        addDelta('frontArbClicks', -1 * sev, 'Softens front roll resistance to build turn-in bite.');
        addDelta('diffCoastPct', -6 * sev, 'Allows rear axle to rotate freely during trail braking.');
        addDelta('frontRideHeightMm', -2, 'Adds front splitter aero pitch sensitivity on entry.');
        break;
      case 'mid_corner_understeer':
        addDelta('rearArbClicks', 1, 'Shifts mid-corner lateral load rearward so the nose holds the apex.');
        addDelta('frontWingDeg', 0.5 * sev, 'Increases front aero balance through sustained medium corners.');
        addDelta('diffPreloadNm', -10, 'Reduces static lock between braking release and throttle pickup.');
        break;
      case 'exit_snap_oversteer':
        addDelta('rearArbClicks', -1 * sev, 'Softens rear roll stiffness for progressive traction on throttle.');
        addDelta('diffPowerPct', 6 * sev, 'Stabilizes rear torque split to prevent inside wheelspin.');
        addDelta('tcLevel', 1, 'Smooths torque delivery over exit kerbs.');
        break;
      case 'high_speed_instability':
        if (!parsed.mentionsTopSpeedDrag) {
          addDelta('rearWingDeg', 1.0 * sev, 'Stabilizes high-speed rear aero platform above 210 km/h.');
        }
        addDelta('rearRideHeightMm', -2, 'Reduces aero rake sensitivity through fast sweepers.');
        break;
      case 'kerb_bouncing':
        addDelta('frontSpringRateNmm', -15, 'Softens vertical heave over aggressive chicane kerbs.');
        addDelta('rearSpringRateNmm', -15, 'Keeps rear contact patch planted over exit sausage kerbs.');
        addDelta('frontRideHeightMm', 2, 'Prevents splitter/plank bottoming across kerbs.');
        break;
      case 'tire_overheating':
        addDelta('coldPsi', 0.5, 'Reduces sidewall flex and carcass hysteresis heat buildup.');
        addDelta('camberDeg', 0.3, 'Spreads thermal load evenly across inner/center tread.');
        break;
    }
  }

  // Track conditions modifier
  const applyTrackCondition = (cond: TrackCondition) => {
    if (cond === 'hot') {
      signals.push({ source: 'conditions', label: 'Hot Track (>32°C)', detail: 'Lowered cold PSI & +1 TC thermal margin' });
      addDelta('coldPsi', -0.4, 'Compensates for higher hot-track pressure rise.');
      addDelta('tcLevel', 1, 'Protects overheated rear tires on corner exit.');
    } else if (cond === 'cool') {
      signals.push({ source: 'conditions', label: 'Cool Track (<22°C)', detail: 'Boosted PSI warmup & aero stability' });
      addDelta('coldPsi', 0.4, 'Helps tires reach target hot PSI on a cool surface.');
      if (car.carClass === 'LMGT3') addDelta('absLevel', 1, 'Extra ABS cushion on lower-grip cold asphalt.');
    } else if (cond === 'damp') {
      signals.push({ source: 'conditions', label: 'Damp Surface', detail: 'Softened ARBs, +2 TC & calmer brake bias' });
      addDelta('rearArbClicks', -1, 'Increases mechanical compliance on damp asphalt.');
      addDelta('tcLevel', 2, 'Prevents sudden wet-kerb wheelspin.');
      addDelta('brakeBiasPct', -0.8, 'Avoids sudden front lockups on low-grip entry.');
      if (car.carClass === 'LMGT3') addDelta('absLevel', 1, 'Higher ABS protection on damp braking zones.');
    }
  };
  applyTrackCondition(intake.trackCondition);

  // Stint objective modifier
  const applyStintObjective = (obj: StintObjective) => {
    if (obj === 'quali_sprint') {
      signals.push({ source: 'conditions', label: 'Quali Attack', detail: 'Sharper turn-in & reduced TC cut' });
      addDelta('frontWingDeg', 0.5, 'Sharpens front bite for single-lap qualifying commitment.');
      addDelta('tcLevel', -1, 'Reduces traction cut for maximum corner-exit drive.');
    } else if (obj === 'endurance_stability') {
      signals.push({ source: 'conditions', label: 'Endurance Stint', detail: 'Prioritizes stability, tire life & rear security' });
      addDelta('tcLevel', 1, 'Protects rear tire life over double stints.');
      addDelta('rearWingDeg', 0.5, 'Adds aero predictability in dirty air and traffic.');
    }
  };
  applyStintObjective(intake.stintObjective);

  // Braking style modifier
  const applyBrakingFeel = (feel: BrakingFeel) => {
    if (feel === 'aggressive_late') {
      signals.push({ source: 'conditions', label: 'Aggressive Braking', detail: 'Rearward bias & migration margin' });
      addDelta('brakeBiasPct', -0.6, 'Matches late, high-peak brake pressure without locking fronts.');
      if (car.carClass !== 'LMGT3') {
        addDelta('brakeMigrationPct', 0.4, 'Automatically shifts bias rearward as speed drops.');
      }
    } else if (feel === 'smooth_early') {
      signals.push({ source: 'conditions', label: 'Smooth Braking', detail: 'Allows subtle coast rotation' });
      addDelta('diffCoastPct', -4, 'Rewards smooth trail-braking with cleaner apex rotation.');
    }
  };
  applyBrakingFeel(intake.brakingFeel);

  if (parsed.mentionsColdTires) {
    signals.push({ source: 'feedback', label: 'Out-Lap Warmup', detail: 'Raised cold PSI target slightly' });
    addDelta('coldPsi', 0.3, 'Helps build core carcass heat faster on cold LMU out-laps.');
  }
  if (parsed.mentionsTopSpeedDrag) {
    signals.push({ source: 'feedback', label: 'Straight-Line Speed', detail: 'Trimmed wing drag for straights' });
    addDelta('rearWingDeg', -1.0, 'Reduces aero drag along long straights.');
  }

  // Conflict sanity: if both mid_corner_understeer (+1 rear ARB) and exit_snap_oversteer (-1 rear ARB) fired,
  // favor mechanical front wing / preload for mid-corner and keep rear ARB compliant for exit safety.
  if (detectedSymptoms.includes('mid_corner_understeer') && detectedSymptoms.includes('exit_snap_oversteer')) {
    const rearArb = deltas.get('rearArbClicks');
    if (rearArb && rearArb.delta >= 0) {
      addDelta('rearArbClicks', -1, 'Keeps rear axle compliant on power exit despite mid-corner push.');
    }
  }

  // 3. Build bounded, non-zero SetupAdjustment list prioritized by impact
  const priorityOrder: NumericSetupKey[] = [
    'brakeBiasPct',
    'brakeMigrationPct',
    'absLevel',
    'tcLevel',
    'rearWingDeg',
    'frontWingDeg',
    'rearArbClicks',
    'frontArbClicks',
    'diffPowerPct',
    'diffCoastPct',
    'diffPreloadNm',
    'frontSpringRateNmm',
    'rearSpringRateNmm',
    'frontRideHeightMm',
    'rearRideHeightMm',
    'coldPsi',
    'camberDeg',
  ];

  const adjustments: SetupAdjustment[] = [];
  for (const key of priorityOrder) {
    const bucket = deltas.get(key);
    if (!bucket || Math.abs(bucket.delta) < 0.05) continue;
    const current = getCurrentNumericForKey(setup, key);
    const rawNext = current + bucket.delta;
    const { target, precision } = clampSetupParamValue(key, rawNext, car);
    const actualDelta = Math.round((target - current) * Math.pow(10, precision)) / Math.pow(10, precision);
    if (Math.abs(actualDelta) < (precision === 0 ? 1 : 0.09)) continue;

    const sign = actualDelta > 0 ? '+' : '';
    const deltaLabel =
      key === 'tcLevel' || key === 'absLevel'
        ? `${sign}${actualDelta} step`
        : key === 'frontArbClicks' || key === 'rearArbClicks'
          ? `${sign}${actualDelta} click${Math.abs(actualDelta) === 1 ? '' : 's'}`
          : key === 'coldPsi'
            ? `${sign}${actualDelta.toFixed(1)} PSI`
            : key === 'brakeBiasPct' || key === 'brakeMigrationPct' || key === 'diffPowerPct' || key === 'diffCoastPct'
              ? `${sign}${precision === 1 ? actualDelta.toFixed(1) : actualDelta}%`
              : key === 'frontWingDeg' || key === 'rearWingDeg' || key === 'camberDeg'
                ? `${sign}${actualDelta.toFixed(1)}°`
                : key === 'frontRideHeightMm' || key === 'rearRideHeightMm'
                  ? `${sign}${actualDelta} mm`
                  : key === 'diffPreloadNm'
                    ? `${sign}${actualDelta} Nm`
                    : `${sign}${actualDelta} N/mm`;

    adjustments.push({
      parameterKey: key,
      parameterLabel: PARAM_LABELS[key],
      currentValue: formatParamValue(key, current),
      recommendedValue: formatParamValue(key, target),
      deltaLabel,
      reason: bucket.reasons.slice(0, 2).join(' '),
      numericTarget: target,
    });
  }

  const finalAdjustments = adjustments.slice(0, 6);
  const estimatedGainSec = Math.round(
    Math.min(0.95, 0.16 + detectedSymptoms.length * 0.14 + Math.min(4, finalAdjustments.length) * 0.05) * 100
  ) / 100;

  const symptomSummaryText = detectedSymptoms
    .map((s) => HANDLING_SYMPTOMS.find((h) => h.id === s)?.label ?? s)
    .join(' + ');

  const cornerClause = resolvedCornerLabel ? ` targeting ${resolvedCornerLabel}` : '';
  const summary =
    finalAdjustments.length > 0
      ? `Synthesized ${finalAdjustments.length} ${car.carClass}-legal clicks for ${car.name} at ${track.name}${cornerClause} addressing ${symptomSummaryText} (${intake.trackCondition} track · ${intake.stintObjective.replace(/_/g, ' ')}).`
      : `Current ${car.name} baseline already aligns well with your ${symptomSummaryText} feedback and ${intake.trackCondition} conditions.`;

  const drivingTip =
    detectedSymptoms.includes('late_brake_lockup')
      ? 'Hit peak brake in a straight line and bleed below 35% pressure before turning into the apex.'
      : detectedSymptoms.includes('exit_snap_oversteer')
        ? 'Wait until the steering wheel is unwinding before passing 70% throttle on exit.'
        : detectedSymptoms.includes('entry_understeer') || detectedSymptoms.includes('mid_corner_understeer')
          ? 'Keep 10–15% trail-brake weight on the nose up to the apex before picking up throttle.'
          : 'Smooth out steering and pedal transitions over kerbs to preserve aero platform stability.';

  const sourceCount = new Set(signals.map((s) => s.source)).size;
  const confidenceLabel =
    sourceCount >= 3
      ? 'High · Multi-Signal Match'
      : sourceCount === 2
        ? 'Good · Dual-Signal Match'
        : 'Baseline Physics Match';

  return {
    primarySymptom,
    detectedSymptoms,
    resolvedCornerLabel,
    confidenceLabel,
    signals: signals.slice(0, 5),
    summary,
    estimatedGainSec,
    adjustments: finalAdjustments,
    drivingTip,
  };
}

const VALID_SETUP_KEYS: ReadonlySet<string> = new Set<NumericSetupKey>([
  'brakeBiasPct',
  'brakeMigrationPct',
  'tcLevel',
  'absLevel',
  'frontWingDeg',
  'rearWingDeg',
  'frontRideHeightMm',
  'rearRideHeightMm',
  'frontArbClicks',
  'rearArbClicks',
  'frontSpringRateNmm',
  'rearSpringRateNmm',
  'diffPowerPct',
  'diffCoastPct',
  'diffPreloadNm',
  'coldPsi',
  'camberDeg',
]);

/**
 * Sanitizes AI-proposed setup adjustments so every adjustment uses a legal parameter
 * for the car's class and stays clamped inside safe physical bounds.
 */
export function sanitizeAiSetupAdjustments(
  rawAdjustments: unknown,
  setup: CarSetup,
  car: CarProfile
): SetupAdjustment[] {
  if (!Array.isArray(rawAdjustments)) return [];
  const seen = new Set<string>();
  const sanitized: SetupAdjustment[] = [];

  for (const item of rawAdjustments) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const rawKey = String(obj.parameterKey ?? '').trim();
    if (!VALID_SETUP_KEYS.has(rawKey)) continue;
    const key = rawKey as NumericSetupKey;
    if (key === 'absLevel' && car.carClass !== 'LMGT3') continue;
    if (key === 'brakeMigrationPct' && car.carClass === 'LMGT3') continue;
    if (seen.has(key)) continue;

    const rawTarget = Number(obj.numericTarget);
    if (!Number.isFinite(rawTarget)) continue;

    const current = getCurrentNumericForKey(setup, key);
    const { target, precision } = clampSetupParamValue(key, rawTarget, car);
    const actualDelta = Math.round((target - current) * Math.pow(10, precision)) / Math.pow(10, precision);
    if (Math.abs(actualDelta) < (precision === 0 ? 1 : 0.09)) continue;

    seen.add(key);
    const sign = actualDelta > 0 ? '+' : '';
    const fallbackDelta = `${sign}${precision === 1 ? actualDelta.toFixed(1) : actualDelta}`;

    sanitized.push({
      parameterKey: key,
      parameterLabel:
        typeof obj.parameterLabel === 'string' && obj.parameterLabel.trim()
          ? obj.parameterLabel.trim()
          : PARAM_LABELS[key],
      currentValue: formatParamValue(key, current),
      recommendedValue: formatParamValue(key, target),
      deltaLabel:
        typeof obj.deltaLabel === 'string' && obj.deltaLabel.trim()
          ? obj.deltaLabel.trim()
          : fallbackDelta,
      reason:
        typeof obj.reason === 'string' && obj.reason.trim()
          ? obj.reason.trim()
          : 'AI chassis optimization for your reported handling feedback.',
      numericTarget: target,
    });
  }

  return sanitized.slice(0, 6);
}

