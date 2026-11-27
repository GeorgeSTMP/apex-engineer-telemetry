import { getActiveCorner } from '../data/circuitsAndCars';
import type {
  CarProfile,
  ReferenceSample,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';
import { stepOpponentsSimulation } from './racecraft';

export type SimScenarioFault =
  | 'none'
  | 'late_brake'
  | 'lockup'
  | 'crash_ahead'
  | 'snap_oversteer'
  | 'cold_tires'
  | 'overheat_tires'
  | 'degraded_tires'
  | 'brake_overheat'
  | 'low_fuel'
  | 'off_track'
  | 'rival_attack'
  | 'attack_chance'
  | 'side_by_side'
  | 'side_by_side_right'
  | 'self_crash'
  | 'formation_lap'
  | 'pit_speeding';

export interface SimDriverOverrides {
  activeFault: SimScenarioFault;
  faultTicksRemaining: number;
  manualBrakeBiasShift: number;
  manualBrakeOverride: number | null; // 0..1 when user presses pedal/test brake
  manualThrottleOverride: number | null; // 0..1 when user presses pedal/test throttle
  manualSteeringOverride: number | null; // -0.6..+0.6 rad when user steers wheel/pad
  manualClutchOverride: number | null; // 0..1 when user presses clutch
  soloMode?: boolean; // Single Player Solo mode (0 traffic cars)
}

export function createInitialOverrides(): SimDriverOverrides {
  return {
    activeFault: 'none',
    faultTicksRemaining: 0,
    manualBrakeBiasShift: 0,
    manualBrakeOverride: null,
    manualThrottleOverride: null,
    manualSteeringOverride: null,
    manualClutchOverride: null,
    soloMode: false,
  };
}

/**
 * Advances the live telemetry simulation by dtMs along the selected track and car,
 * optionally applying active scenario faults (late braking, front lockup, crash ahead)
 * or manual/hardware pedal & wheel overrides so users hear real-time race engineer coaching immediately.
 */
export function stepTelemetrySimulation(
  prev: TelemetryFrame,
  track: TrackProfile,
  car: CarProfile,
  refSamples: ReferenceSample[],
  overrides: SimDriverOverrides,
  dtMs: number
): { frame: TelemetryFrame; nextOverrides: SimDriverOverrides } {
  const nextOverrides: SimDriverOverrides = { ...overrides };
  if (nextOverrides.faultTicksRemaining > 0) {
    nextOverrides.faultTicksRemaining -= 1;
    if (nextOverrides.faultTicksRemaining === 0) {
      nextOverrides.activeFault = 'none';
    }
  }

  // Advance distance along track proportionally to current speed
  const trackLengthMeters = track.lengthKm * 1000;
  const metersPerSec = Math.max(22, (prev.speedKmh * 1000) / 3600);
  // Slight simulation time multiplier on long circuits like Le Mans so users experience corners rapidly
  const simSpeedMultiplier = track.lengthKm > 9 ? 2.4 : 1.75;
  const distDeltaPct = ((metersPerSec * (dtMs / 1000)) * simSpeedMultiplier) / trackLengthMeters;

  let nextPct = prev.lapDistPct + distDeltaPct;
  let lapNumber = prev.lapNumber;
  let deltaSec = prev.deltaSec;
  if (nextPct >= 1.0) {
    nextPct -= 1.0;
    lapNumber += 1;
    deltaSec = 0;
  }

  // Find closest reference sample
  const refIdx = Math.min(
    refSamples.length - 1,
    Math.max(0, Math.floor(nextPct * refSamples.length))
  );
  const ref = refSamples[refIdx];
  const corner = getActiveCorner(track, nextPct);

  let speedKmh = ref.speedKmh;
  let throttle = ref.throttle;
  let brake = ref.brake;
  let clutch = 0;
  let steeringRad = ref.steeringRad;
  let frontWheelSlip = 0.03;
  let rearWheelSlip = 0.03;
  let offTrackRisk = 0.08;
  let hazardAhead = false;
  let hazardDistanceM = 999;
  let hazardDescription = '';
  let flagState: TelemetryFrame['flagState'] = 'green';
  let tireTempOffset = 0;

  // Apply triggered real-time faults so user can immediately test coach reactions
  switch (overrides.activeFault) {
    case 'late_brake': {
      speedKmh = Math.min(car.topSpeedKmh, ref.speedKmh + 26);
      brake = 0.72;
      throttle = 0.0;
      deltaSec += 0.015;
      break;
    }
    case 'lockup': {
      brake = 0.97;
      throttle = 0.0;
      frontWheelSlip = 0.24;
      speedKmh = Math.max(70, prev.speedKmh - 4);
      deltaSec += 0.02;
      break;
    }
    case 'crash_ahead': {
      hazardAhead = true;
      hazardDistanceM = Math.max(85, Math.min(240, 220 - (24 - overrides.faultTicksRemaining) * 6));
      hazardDescription = 'Two GT3 cars spun across apex.';
      flagState = 'yellow';
      break;
    }
    case 'snap_oversteer': {
      throttle = 0.92;
      brake = 0.0;
      rearWheelSlip = 0.26;
      steeringRad = -0.31;
      deltaSec += 0.018;
      break;
    }
    case 'cold_tires': {
      tireTempOffset = -22;
      break;
    }
    case 'overheat_tires': {
      tireTempOffset = 25;
      break;
    }
    case 'degraded_tires': {
      tireTempOffset = 4;
      break;
    }
    case 'brake_overheat': {
      brake = Math.max(brake, 0.55);
      break;
    }
    case 'low_fuel': {
      break;
    }
    case 'off_track': {
      offTrackRisk = 0.91;
      break;
    }
    case 'self_crash': {
      speedKmh = Math.max(18, prev.speedKmh - 75);
      throttle = 0;
      brake = 0.95;
      offTrackRisk = 0.94;
      flagState = 'yellow';
      break;
    }
    case 'formation_lap': {
      speedKmh = 95;
      throttle = 0.32;
      brake = 0.08;
      tireTempOffset = -32;
      break;
    }
    case 'pit_speeding': {
      speedKmh = 78;
      throttle = 0.25;
      brake = 0;
      break;
    }
    default: {
      const wobble = Math.sin(nextPct * Math.PI * 16) * 2.2;
      speedKmh = Math.max(50, Math.min(car.topSpeedKmh, ref.speedKmh + wobble));
      if (corner && nextPct > corner.brakeMarkerPct && nextPct < corner.apexPct) {
        deltaSec += Math.sin(nextPct * 35) * 0.004;
      }
      break;
    }
  }

  // Apply live hardware/manual driver input overrides
  const hasLivePedalControl =
    overrides.manualBrakeOverride !== null || overrides.manualThrottleOverride !== null;

  if (overrides.manualSteeringOverride !== null) {
    steeringRad = overrides.manualSteeringOverride;
  }
  if (overrides.manualClutchOverride !== null) {
    clutch = overrides.manualClutchOverride;
  }
  if (overrides.manualBrakeOverride !== null) {
    brake = overrides.manualBrakeOverride;
    if (brake > 0.89 && prev.speedKmh > 75) {
      frontWheelSlip = Math.max(frontWheelSlip, 0.21);
    }
    if (brake > 0.1) {
      throttle = 0;
    }
  }
  if (overrides.manualThrottleOverride !== null) {
    throttle = overrides.manualThrottleOverride;
    if (brake > 0.15) {
      // Braking takes precedence if both pressed slightly
      throttle = Math.min(throttle, 0.15);
    }
    if (throttle > 0.82 && Math.abs(steeringRad) > 0.22) {
      rearWheelSlip = Math.max(rearWheelSlip, 0.21);
    }
  }

  if (hasLivePedalControl) {
    const dtSec = dtMs / 1000;
    const netAccelKmhPerSec = throttle * (1 - clutch * 0.85) * 48 - brake * 110 - 6;
    const targetPhysicsSpeed = Math.max(40, Math.min(car.topSpeedKmh, prev.speedKmh + netAccelKmhPerSec * dtSec));
    speedKmh = Math.round((targetPhysicsSpeed * 0.72 + speedKmh * 0.28) * 10) / 10;
  }

  const isTrafficFault =
    overrides.activeFault === 'rival_attack' ||
    overrides.activeFault === 'attack_chance' ||
    overrides.activeFault === 'side_by_side' ||
    overrides.activeFault === 'side_by_side_right';

  const nextOpponents =
    overrides.soloMode && !isTrafficFault
      ? []
      : stepOpponentsSimulation(
          prev.opponents,
          nextPct,
          speedKmh,
          track,
          car,
          refSamples,
          overrides.activeFault,
          overrides.faultTicksRemaining,
          dtMs
        );

  const baseTire = 84 + tireTempOffset + (brake > 0.7 ? 2.5 : 0);
  const nextWear =
    overrides.activeFault === 'degraded_tires'
      ? {
          fl: Math.min(prev.tireWearPct.fl, 63.4),
          fr: Math.min(prev.tireWearPct.fr, 64.1),
          rl: Math.min(prev.tireWearPct.rl, 68.2),
          rr: Math.min(prev.tireWearPct.rr, 68.8),
        }
      : {
          fl: Math.max(45, Math.round((prev.tireWearPct.fl - 0.002) * 100) / 100),
          fr: Math.max(45, Math.round((prev.tireWearPct.fr - 0.002) * 100) / 100),
          rl: Math.max(45, Math.round((prev.tireWearPct.rl - 0.0015) * 100) / 100),
          rr: Math.max(45, Math.round((prev.tireWearPct.rr - 0.0015) * 100) / 100),
        };
  const prevVe = typeof prev.virtualEnergyPct === 'number' ? prev.virtualEnergyPct : 92;
  const virtualEnergyPct =
    car.carClass === 'Hypercar'
      ? overrides.activeFault === 'low_fuel'
        ? Math.min(prevVe, 11)
        : Math.max(4, Math.round((prevVe - 0.012) * 100) / 100)
      : undefined;

  const frame: TelemetryFrame = {
    timestampMs: prev.timestampMs + dtMs,
    lapNumber,
    lapDistPct: nextPct,
    speedKmh: Math.round(speedKmh * 10) / 10,
    rpm: ref.rpm,
    maxRpm: car.maxRpm,
    gear: ref.gear,
    throttle: Math.round(throttle * 100) / 100,
    brake: Math.round(brake * 100) / 100,
    clutch: Math.round(clutch * 100) / 100,
    steeringRad: Math.round(steeringRad * 1000) / 1000,
    latG: Math.round(steeringRad * (speedKmh / 108) * 100) / 100,
    longG:
      overrides.activeFault === 'self_crash'
        ? -3.85
        : Math.round((throttle * 1.18 - brake * 2.95) * 100) / 100,
    deltaSec: Math.round(deltaSec * 1000) / 1000,
    fuelLiters:
      overrides.activeFault === 'low_fuel'
        ? Math.min(prev.fuelLiters, 4.8)
        : Math.max(2.5, Math.round((prev.fuelLiters - 0.006) * 100) / 100),
    ...(virtualEnergyPct !== undefined ? { virtualEnergyPct } : {}),
    tireTempC: {
      fl: Math.round((baseTire + 2.4) * 10) / 10,
      fr: Math.round((baseTire + 1.1) * 10) / 10,
      rl: Math.round((baseTire - 1.2) * 10) / 10,
      rr: Math.round((baseTire - 1.8) * 10) / 10,
    },
    tirePressurePsi: {
      fl: Math.round((26.6 + tireTempOffset * 0.04) * 10) / 10,
      fr: Math.round((26.5 + tireTempOffset * 0.04) * 10) / 10,
      rl: Math.round((26.1 + tireTempOffset * 0.04) * 10) / 10,
      rr: Math.round((26.0 + tireTempOffset * 0.04) * 10) / 10,
    },
    tireWearPct: nextWear,
    brakeTempC:
      overrides.activeFault === 'brake_overheat'
        ? { fl: 790, fr: 775, rl: 590, rr: 580 }
        : {
            fl: Math.round(440 + brake * 310),
            fr: Math.round(435 + brake * 305),
            rl: Math.round(370 + brake * 210),
            rr: Math.round(365 + brake * 205),
          },
    frontWheelSlip,
    rearWheelSlip,
    absActive: frontWheelSlip > 0.15 && brake > 0.75,
    tcActive: rearWheelSlip > 0.16 && throttle > 0.65,
    offTrackRisk,
    hazardAhead,
    hazardDistanceM,
    hazardDescription,
    flagState,
    ...(overrides.activeFault === 'formation_lap' ? { inFormationLap: true } : {}),
    ...(overrides.activeFault === 'pit_speeding' ? { inPitOrGarage: true } : {}),
    opponents: nextOpponents,
  };

  return { frame, nextOverrides };
}
