import type {
  CalloutCategory,
  CarProfile,
  CoachCallout,
  CoachSettings,
  CornerComparison,
  CornerDefinition,
  DriverProfile,
  DriverSkillMetrics,
  PitStrategyPlan,
  PriorityCornerDrill,
  ReferenceSample,
  SimSessionType,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';
import { evaluateRacecraft } from './racecraft';

export interface CooldownMap {
  hazard: number;
  braking: number;
  lockup: number;
  traction: number;
  tires: number;
  tires_optimal: number;
  tire_degradation: number;
  track_limits: number;
  pre_corner: number;
  racecraft: number;
  fuel: number;
  brakes: number;
  strategy: number;
  engineer: number;
  channels?: Record<string, number>;
}

export function createInitialCooldowns(): CooldownMap {
  return {
    hazard: 0,
    braking: 0,
    lockup: 0,
    traction: 0,
    tires: 0,
    tires_optimal: 0,
    tire_degradation: 0,
    track_limits: 0,
    pre_corner: 0,
    racecraft: 0,
    fuel: 0,
    brakes: 0,
    strategy: 0,
    engineer: 0,
    channels: {},
  };
}

export function formatLapTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '--:--.---';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds - mins * 60;
  return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
}

export function formatDelta(deltaSeconds: number): string {
  if (!Number.isFinite(deltaSeconds)) return '0.000s';
  const sign = deltaSeconds >= 0 ? '+' : '-';
  return `${sign}${Math.abs(deltaSeconds).toFixed(3)}s`;
}

export function formatCornerLabel(
  corner: CornerDefinition | null | undefined,
  _language: 'en' = 'en',
  fallback = 'On Track'
): string {
  if (!corner) return fallback;
  return `Turn ${corner.number} (${corner.name})`;
}

/**
 * Evaluates a live telemetry frame against the active corner, reference sample,
 * and hazard state to generate immediate Dave-style spoken race engineer callouts.
 */
export function evaluateLiveTelemetry(
  frame: TelemetryFrame,
  prevFrame: TelemetryFrame | null,
  track: TrackProfile,
  activeCorner: CornerDefinition | null,
  refSample: ReferenceSample | null,
  settings: CoachSettings,
  cooldowns: CooldownMap,
  driverProfile?: DriverProfile,
  car?: CarProfile,
  context?: {
    sessionType?: SimSessionType;
    pitStrategy?: Pick<
      PitStrategyPlan,
      | 'pitNeededThisRace'
      | 'recommendedPitLap'
      | 'pitTireCallHeadline'
      | 'fuelToAddLiters'
      | 'raceModeLabel'
      | 'crashAlertActive'
    >;
  }
): { callout: CoachCallout | null; nextCooldowns: CooldownMap } {
  const now = frame.timestampMs;
  const activeSessionType: SimSessionType = context?.sessionType ?? frame.sessionType ?? 'unknown';
  const prevChannels = cooldowns.channels ?? {};
  const nextCooldowns: CooldownMap = {
    ...cooldowns,
    channels: { ...prevChannels },
  };
  const focusMode = settings.focusMode ?? 'all';
  const preCornerEnabled = settings.preCornerCuesEnabled ?? true;
  const protocol = settings.radioProtocol ?? 'coaching_detail';

  const hasPedalSensors = frame.sensorCaps?.pedals ?? true;
  const hasTireSensors = frame.sensorCaps?.tires ?? true;
  const hasBrakeSensors = frame.sensorCaps?.brakes ?? true;

  const allowBraking = focusMode === 'all' || focusMode === 'braking';
  const allowApexLine = focusMode === 'all' || focusMode === 'apex_line';
  const allowThrottleExit = focusMode === 'all' || focusMode === 'throttle_exit';
  const allowTires = hasTireSensors && (settings.tireAlertsEnabled ?? true);

  const minSpeakMs = Math.max(0, (settings.minSpeakIntervalSec ?? 4) * 1000);
  const lastCalloutAt = Math.max(
    0,
    cooldowns.hazard,
    cooldowns.braking,
    cooldowns.lockup,
    cooldowns.traction,
    cooldowns.tires,
    cooldowns.tires_optimal,
    cooldowns.tire_degradation,
    cooldowns.track_limits,
    cooldowns.pre_corner,
    cooldowns.racecraft,
    cooldowns.fuel,
    cooldowns.brakes,
    cooldowns.strategy,
    cooldowns.engineer
  );
  const urgentInterrupts = settings.urgentInterruptsRadio ?? true;

  const canFire = (
    cat: CalloutCategory,
    minGapMs: number,
    isUrgent = false,
    channelKey: string = cat
  ): boolean => {
    const scaledCatGap =
      isUrgent || minSpeakMs <= 4000
        ? minGapMs
        : Math.max(minGapMs, minSpeakMs);
    const lastChannelAt =
      channelKey === cat
        ? cooldowns[cat] ?? 0
        : prevChannels[channelKey] ?? 0;
    if (now - lastChannelAt < scaledCatGap) {
      return false;
    }
    if (isUrgent && urgentInterrupts) {
      return true;
    }
    return now - lastCalloutAt >= minSpeakMs;
  };

  const makeCallout = (
    category: CalloutCategory,
    severity: CoachCallout['severity'],
    cornerName: string,
    message: string,
    quickReplies?: string[],
    channelKey: string = category
  ): CoachCallout => {
    nextCooldowns[category] = now;
    if (nextCooldowns.channels) {
      nextCooldowns.channels[channelKey] = now;
    }
    return {
      id: `${category}-${now}-${Math.round(frame.lapDistPct * 10000)}`,
      timestampMs: now,
      lapNumber: frame.lapNumber,
      cornerName,
      severity,
      category,
      message,
      spoken: false,
      source: 'realtime-engine',
      ...(quickReplies && quickReplies.length > 0 ? { quickReplies } : {}),
    };
  };

  const sectorFallback = `Sector ${frame.lapDistPct < 0.33 ? 1 : frame.lapDistPct < 0.66 ? 2 : 3}`;
  const cornerLabel = formatCornerLabel(activeCorner, 'en', sectorFallback);

  const shortTurn = (corner: CornerDefinition | null | undefined, fallback = 'Ahead') =>
    corner ? `Turn ${corner.number}` : fallback;

  // 1. Highest priority: Accident / Crash / Stopped car ahead on track
  if (
    settings.hazardAlertsEnabled &&
    frame.hazardAhead &&
    frame.hazardDistanceM <= 360 &&
    canFire('hazard', 5500, true)
  ) {
    const dist = Math.round(frame.hazardDistanceM);
    const desc = frame.hazardDescription ? ` ${frame.hazardDescription}` : '';
    const msg =
      protocol === 'pro_terse'
        ? `Yellow! Crash ${shortTurn(activeCorner, sectorFallback)}, ${dist}m.`
        : `Accident ahead at ${cornerLabel}, ${dist} meters! Yellow flag — watch for slow cars and lift early.${desc}`;
    return {
      callout: makeCallout('hazard', 'urgent', cornerLabel, msg),
      nextCooldowns,
    };
  }

  // 1b. Active Race Control Penalty (drive-through / stop-and-go)
  if (frame.penaltyActive && canFire('strategy', 18000, true, 'penalty_active')) {
    const msg =
      protocol === 'pro_terse'
        ? 'Penalty active — box for drive-through on limiter.'
        : 'Stewards penalty active — plan pit entry on the speed limiter to serve your drive-through or stop-go cleanly.';
    return {
      callout: makeCallout('strategy', 'urgent', 'Stewards Penalty', msg, undefined, 'penalty_active'),
      nextCooldowns,
    };
  }

  // 1b-2. Pit Lane Speeding Alert (LMU enforces strict 60 km/h pit speed limit -> automatic Drive-Through)
  if (frame.inPitOrGarage && frame.speedKmh > 62 && canFire('strategy', 4500, true, 'pit_speeding')) {
    const msg =
      protocol === 'pro_terse'
        ? `Pit limiter! Slow to 60 — ${Math.round(frame.speedKmh)} km/h.`
        : `Pit lane speeding at ${Math.round(frame.speedKmh)} km/h! Engage your pit limiter under 60 km/h immediately or stewards will issue a drive-through.`;
    return {
      callout: makeCallout('strategy', 'urgent', 'Pit Lane', msg, undefined, 'pit_speeding'),
      nextCooldowns,
    };
  }

  // 1b-3. Suppress on-track braking, apex, cold-tire, and pre-corner chatter while in pit lane or garage stall
  if (frame.inPitOrGarage) {
    return { callout: null, nextCooldowns };
  }

  // 1b-4. Rolling Start Green Flag transition
  if (
    prevFrame?.inFormationLap === true &&
    !frame.inFormationLap &&
    canFire('strategy', 10000, true, 'green_flag')
  ) {
    const msg =
      protocol === 'pro_terse'
        ? 'Green, green, green! Cold tires Turn 1.'
        : 'Green, green, green! Race is live — remember LMU has no tire warmers, so brake early into Turn 1 and protect the inside.';
    return {
      callout: makeCallout('strategy', 'urgent', 'Green Flag', msg, undefined, 'green_flag'),
      nextCooldowns,
    };
  }

  // 1c. Formation / Rolling Start Coaching (LMU class lane discipline + 60 km/h S/F zone + tire conditioning)
  if (frame.inFormationLap) {
    const avgFormTemp =
      (frame.tireTempC.fl +
        frame.tireTempC.fr +
        frame.tireTempC.rl +
        frame.tireTempC.rr) /
      4;
    if (canFire('strategy', 12000, false, 'formation_lap')) {
      const nearGreenZone = frame.lapDistPct >= 0.86;
      const msg = nearGreenZone
        ? protocol === 'pro_terse'
          ? 'Final sector — hold 60 km/h, ready for green.'
          : 'Final sector rolling start — respect the 60 km/h formation limit, hold your class lane, and prepare for cold Turn 1 braking.'
        : avgFormTemp < 50
          ? protocol === 'pro_terse'
            ? 'Formation: weave gently under 50°C, hold class lane.'
            : 'Formation lap: weave gently while tires are under 50°C and hold your class lane until the green Start/Finish line.'
          : protocol === 'pro_terse'
            ? 'Formation: drag brake & throttle, hold lane to green.'
            : 'Formation lap: tires above 50°C — use progressive brake and throttle load to build core heat, no passing before green.';
      return {
        callout: makeCallout('strategy', 'coaching', 'Formation Lap', msg, undefined, 'formation_lap'),
        nextCooldowns,
      };
    }
    return { callout: null, nextCooldowns };
  }

  // 2. Front wheel lockup / excessive brake pressure past turn-in
  if (
    hasPedalSensors &&
    allowBraking &&
    frame.brake > 0.88 &&
    frame.frontWheelSlip >= 0.16 &&
    frame.speedKmh > 65 &&
    canFire('lockup', 4200, true)
  ) {
    const brkZoneLabel = formatCornerLabel(
      activeCorner,
      'en',
      'Braking Zone'
    );
    const msg =
      protocol === 'pro_terse'
        ? `Front lockup ${shortTurn(activeCorner, 'entry')} — ease brake.`
        : `Front lockup into ${brkZoneLabel}! Ease the brake pedal off 15 percent and let the front tires grip.`;
    return {
      callout: makeCallout('lockup', 'urgent', brkZoneLabel, msg),
      nextCooldowns,
    };
  }

  // 2b. Live Racecraft & Traffic Spotter ("Car left!", "Car right!", "Three wide!", "All clear", attack/defense)
  if ((settings.racecraftAlertsEnabled ?? true) && frame.opponents && frame.opponents.length > 0) {
    const prevAlongside = (prevFrame?.opponents ?? []).filter(
      (o) => o.isAlongside || Math.abs(o.distanceMeters) <= 5.5
    );
    const nextCorner =
      activeCorner ??
      track.corners.find((c) => c.brakeMarkerPct > frame.lapDistPct) ??
      track.corners[0] ??
      null;
    const effectiveCar: CarProfile =
      car ??
      ({
        id: 'default',
        name: frame.carName ?? 'Race Car',
        carClass: (frame.carClass as CarProfile['carClass']) ?? 'Hypercar',
        simSupported: ['lmu'],
        maxRpm: frame.maxRpm,
        shiftRpm: Math.round(frame.maxRpm * 0.92),
        topSpeedKmh: 330,
        optimalTireTempRange: [75, 95],
        defaultSetup: {} as CarProfile['defaultSetup'],
      });
    const racecraft = evaluateRacecraft(frame, track, effectiveCar, nextCorner, 'en');
    const battleLabel = formatCornerLabel(nextCorner, 'en', 'Spotter');

    if (
      (racecraft.posture === 'three_wide' || racecraft.posture === 'hold_line_car_alongside') &&
      canFire('racecraft', 2600, true)
    ) {
      let spotterMsg = racecraft.detail;
      if (racecraft.posture === 'three_wide') {
        spotterMsg =
          protocol === 'pro_terse'
            ? 'Three wide — hold center.'
            : 'Three wide! Cars left and right — hold your center line.';
      } else if (racecraft.targetOpponent) {
        const sideWord = racecraft.targetOpponent.lateralSide === 'left' ? 'left' : 'right';
        spotterMsg =
          protocol === 'pro_terse'
            ? `Car ${sideWord} — hold line.`
            : `Car ${sideWord}! Hold your line — #${racecraft.targetOpponent.carNumber} alongside.`;
      }
      return {
        callout: makeCallout('racecraft', 'urgent', battleLabel, spotterMsg),
        nextCooldowns,
      };
    }

    const currentlyClearOfSide =
      racecraft.posture !== 'three_wide' &&
      racecraft.posture !== 'hold_line_car_alongside' &&
      frame.opponents.every((o) => !o.isAlongside && Math.abs(o.distanceMeters) > 5.5);

    if (prevAlongside.length > 0 && currentlyClearOfSide && canFire('racecraft', 1800, true)) {
      const hadLeft = prevAlongside.some((o) => o.lateralSide === 'left');
      const hadRight = prevAlongside.some((o) => o.lateralSide === 'right');
      const clearMsg =
        protocol === 'pro_terse'
          ? hadLeft && hadRight
            ? 'Clear both sides.'
            : hadLeft
              ? 'Clear left.'
              : 'Clear right.'
          : hadLeft && hadRight
            ? 'All clear! You are clear on both sides.'
            : hadLeft
              ? 'Clear left — all clear, take your line.'
              : 'Clear right — all clear, take your line.';
      return {
        callout: makeCallout('racecraft', 'info', 'Spotter · Clear', clearMsg),
        nextCooldowns,
      };
    }

    if (
      racecraft.posture !== 'clear' &&
      racecraft.posture !== 'three_wide' &&
      racecraft.posture !== 'hold_line_car_alongside' &&
      canFire('racecraft', 6200, true)
    ) {
      const severity: CoachCallout['severity'] =
        racecraft.posture === 'defend_inside' || racecraft.posture === 'blue_flag_yield'
          ? 'warning'
          : 'coaching';
      let directMsg = racecraft.detail;
      if (protocol === 'pro_terse' && racecraft.targetOpponent) {
        const opp = racecraft.targetOpponent;
        if (racecraft.posture === 'blue_flag_yield') {
          directMsg = `Blue flag #${opp.carNumber} — hold predictable line.`;
        } else if (racecraft.posture === 'defend_inside') {
          const distM = Math.abs(Math.round(opp.distanceMeters));
          directMsg = racecraft.safeToDefend
            ? `#${opp.carNumber} (${distM}m back) — cover inside.`
            : `#${opp.carNumber} (${distM}m dive) — hold outside.`;
        } else if (racecraft.posture === 'attack_opportunity') {
          directMsg = `Pass #${opp.carNumber} inside, ${shortTurn(nextCorner, 'next turn')}.`;
        }
      }
      return {
        callout: makeCallout('racecraft', severity, battleLabel, directMsg),
        nextCooldowns,
      };
    }
  }

  // 2c. Multiclass closing traffic (WEC / IMSA Hypercar -> LMP2 -> LMGT3 approach alert)
  if (
    settings.multiclassTrafficEnabled &&
    frame.opponents &&
    frame.opponents.length > 0 &&
    canFire('racecraft', 8500, false, 'multiclass_traffic')
  ) {
    const myClass = frame.carClass ?? car?.carClass ?? 'Hypercar';
    const classRank = (cls: string) =>
      cls === 'Hypercar' ? 3 : cls === 'LMP2' ? 2 : 1;
    const myRank = classRank(myClass);
    const fasterBehind = frame.opponents
      .filter(
        (o) =>
          !o.isAlongside &&
          o.distanceMeters <= -12 &&
          o.distanceMeters >= -110 &&
          o.closingSpeedKmh >= 16 &&
          classRank(o.carClass) > myRank
      )
      .sort((a, b) => b.distanceMeters - a.distanceMeters)[0];

    if (fasterBehind) {
      const distBehind = Math.round(Math.abs(fasterBehind.distanceMeters));
      const msg =
        protocol === 'pro_terse'
          ? `Traffic: ${fasterBehind.carClass} #${fasterBehind.carNumber} closing ${distBehind}m behind.`
          : `Multiclass traffic: faster ${fasterBehind.carClass} #${fasterBehind.carNumber} closing rapidly (${distBehind}m behind) — hold a predictable line.`;
      return {
        callout: makeCallout('racecraft', 'warning', 'Multiclass Traffic', msg, undefined, 'multiclass_traffic'),
        nextCooldowns,
      };
    }
  }

  // 3. Late braking detection compared to corner brake marker & reference speed
  if (allowBraking && activeCorner && refSample && canFire('braking', 4800)) {
    const trackLengthMeters = track.lengthKm * 1000;
    const distPastMarkerM = (frame.lapDistPct - activeCorner.brakeMarkerPct) * trackLengthMeters;
    const overspeedKmh = frame.speedKmh - refSample.speedKmh;

    const brakedLatePastMarker =
      hasPedalSensors &&
      distPastMarkerM >= settings.lateBrakeThresholdMeters &&
      distPastMarkerM <= 95 &&
      frame.brake < 0.35 &&
      frame.speedKmh > activeCorner.targetApexSpeedKmh + 45;

    const carryingTooMuchSpeedUnderBrake =
      frame.lapDistPct >= activeCorner.brakeMarkerPct + 0.004 &&
      frame.lapDistPct <= activeCorner.apexPct &&
      overspeedKmh >= 16 &&
      (hasPedalSensors ? frame.brake > 0.45 : frame.speedKmh > activeCorner.targetApexSpeedKmh + 35);

    if (brakedLatePastMarker || carryingTooMuchSpeedUnderBrake) {
      const metersLate = Math.max(8, Math.round(Math.abs(distPastMarkerM)));
      const msg =
        protocol === 'pro_terse'
          ? brakedLatePastMarker
            ? `${shortTurn(activeCorner)}: brake ${metersLate}m earlier.`
            : `${shortTurn(activeCorner)}: +${Math.round(overspeedKmh)} km/h — ease brake.`
          : brakedLatePastMarker
            ? `You braked ${metersLate} meters too late for ${cornerLabel}! Ease the brake smoothly and bleed pressure toward the apex.`
            : `Carrying ${Math.round(overspeedKmh)} km/h too much speed into ${cornerLabel} — ease the brake and open your steering slightly to avoid washing wide.`;
      return {
        callout: makeCallout('braking', 'warning', cornerLabel, msg),
        nextCooldowns,
      };
    }
  }

  // 4. Exit snap oversteer / wheelspin
  if (
    hasPedalSensors &&
    (settings.tractionAlertsEnabled ?? true) &&
    allowThrottleExit &&
    activeCorner &&
    frame.lapDistPct >= activeCorner.apexPct &&
    frame.lapDistPct <= activeCorner.exitPct &&
    frame.throttle > 0.72 &&
    frame.rearWheelSlip >= 0.18 &&
    canFire('traction', 5500)
  ) {
    const msg =
      protocol === 'pro_terse'
        ? `Rear slip ${shortTurn(activeCorner)} — unwind wheel.`
        : `Rear stepping out exiting ${cornerLabel} — unwind the wheel and feed throttle progressively.`;
    return {
      callout: makeCallout('traction', 'warning', cornerLabel, msg),
      nextCooldowns,
    };
  }

  // 4b. Apex & racing line speed loss cue (Line & Apex focus or All)
  if (
    allowApexLine &&
    activeCorner &&
    frame.lapDistPct >= activeCorner.apexPct - 0.006 &&
    frame.lapDistPct <= activeCorner.apexPct + 0.01 &&
    frame.speedKmh < activeCorner.targetApexSpeedKmh - 14 &&
    Math.abs(frame.steeringRad) > 0.25 &&
    canFire('engineer', 7000)
  ) {
    const apexDiff = Math.round(activeCorner.targetApexSpeedKmh - frame.speedKmh);
    const msg =
      protocol === 'pro_terse'
        ? `${shortTurn(activeCorner)}: carry +${apexDiff} km/h apex.`
        : `Over-slowed apex at ${cornerLabel} (-${apexDiff} km/h vs target). Release brake slightly earlier and roll speed through the apex.`;
    return {
      callout: makeCallout('engineer', 'coaching', cornerLabel, msg),
      nextCooldowns,
    };
  }

  // 5. Track limits warning & Qualifying/Practice lap deletion coaching
  if (
    (settings.trackLimitsAlertsEnabled ?? true) &&
    frame.lapInvalidated &&
    !prevFrame?.lapInvalidated &&
    canFire('track_limits', 8000, activeSessionType === 'qualifying', 'lap_invalidated')
  ) {
    const exitLabel = formatCornerLabel(activeCorner, 'en', 'Track Limits');
    const msg =
      activeSessionType === 'qualifying'
        ? protocol === 'pro_terse'
          ? 'Lap deleted — reset gap for next flyer.'
          : `Lap deleted at ${exitLabel} for track limits — cool the tires and build a clean-air gap for your next flying lap.`
        : protocol === 'pro_terse'
          ? `Lap invalidated ${shortTurn(activeCorner, 'exit')} — stay inside.`
          : `Lap invalidated for track limits at ${exitLabel} — keep two wheels inside the white line to avoid penalty points.`;
    return {
      callout: makeCallout('track_limits', 'warning', exitLabel, msg, undefined, 'lap_invalidated'),
      nextCooldowns,
    };
  }

  if (
    (settings.trackLimitsAlertsEnabled ?? true) &&
    frame.offTrackRisk >= 0.82 &&
    canFire('track_limits', 6500)
  ) {
    const exitLabel = formatCornerLabel(
      activeCorner,
      'en',
      'Track Exit'
    );
    const msg =
      protocol === 'pro_terse'
        ? `Track limits ${shortTurn(activeCorner, 'exit')} — stay inside.`
        : `Track limits tight at ${exitLabel} — keep two wheels inside the white line.`;
    return {
      callout: makeCallout('track_limits', 'warning', exitLabel, msg),
      nextCooldowns,
    };
  }

  // 5b. Low fuel & box window warning (independent channel so fuel-save coaching never blocks critical reserve)
  if (
    (settings.fuelAlertsEnabled ?? true) &&
    frame.fuelLiters > 0 &&
    frame.fuelLiters <= 6.5 &&
    canFire('fuel', 28000, true, 'fuel_critical')
  ) {
    const fuelLabel = 'Fuel Critical';
    const msg =
      protocol === 'pro_terse'
        ? `Box this lap. Fuel ${frame.fuelLiters.toFixed(1)}L.`
        : `Fuel critical (${frame.fuelLiters.toFixed(1)} liters remaining)! Box this lap or switch to fuel-save map.`;
    return {
      callout: makeCallout('fuel', 'urgent', fuelLabel, msg, undefined, 'fuel_critical'),
      nextCooldowns,
    };
  }

  // 5b-1. LMU Hypercar Virtual Energy critical alert (0% VE triggers 100s stop-and-go penalty)
  if (
    (settings.fuelAlertsEnabled ?? true) &&
    (car?.carClass === 'Hypercar' || frame.carClass === 'Hypercar') &&
    typeof frame.virtualEnergyPct === 'number' &&
    frame.virtualEnergyPct > 0 &&
    frame.virtualEnergyPct <= 14 &&
    canFire('fuel', 26000, true, 'virtual_energy_critical')
  ) {
    const vePct = Math.round(frame.virtualEnergyPct);
    const msg =
      protocol === 'pro_terse'
        ? `Box this lap. Virtual Energy ${vePct}%.`
        : `Virtual Energy critical (${vePct}% left)! Lift & coast or box now — 0% VE triggers a 100-second stop-and-go penalty.`;
    return {
      callout: makeCallout('fuel', 'urgent', 'Virtual Energy', msg, undefined, 'virtual_energy_critical'),
      nextCooldowns,
    };
  }

  // 5b-1b. Pit Exit Cold Slicks + Rejoin Traffic Check (LMU has no tire warmers)
  if (
    allowTires &&
    !frame.inPitOrGarage &&
    prevFrame?.inPitOrGarage === true &&
    frame.speedKmh >= 35 &&
    canFire('tires', 16000, false, 'pit_exit_cold')
  ) {
    const rejoinTraffic = (frame.opponents ?? [])
      .filter((o) => !o.inPits && o.distanceMeters < 0 && o.distanceMeters >= -160)
      .sort((a, b) => b.distanceMeters - a.distanceMeters)[0];
    const trafficClause = rejoinTraffic
      ? ` Watch #${rejoinTraffic.carNumber} (${Math.abs(Math.round(rejoinTraffic.distanceMeters))}m back) on merge.`
      : '';
    const msg =
      protocol === 'pro_terse'
        ? rejoinTraffic
          ? `Pit exit: cold slicks, watch #${rejoinTraffic.carNumber} merging.`
          : 'Pit exit: cold slicks, zero warmers — brake early T1.'
        : `Pit exit with cold slicks — LMU uses no tire warmers. Brake early into Turn 1 and build tire heat smoothly.${trafficClause}`;
    return {
      callout: makeCallout('tires', 'warning', 'Pit Exit', msg, undefined, 'pit_exit_cold'),
      nextCooldowns,
    };
  }

  // 5b-2. Pit window countdown (~2 laps remaining before dry on Fuel OR Hypercar Virtual Energy)
  const isHypercarClass = car?.carClass === 'Hypercar' || frame.carClass === 'Hypercar';
  const lowFuelWindow = frame.fuelLiters > 6.5 && frame.fuelLiters <= 11.5;
  const lowVeWindow =
    isHypercarClass &&
    typeof frame.virtualEnergyPct === 'number' &&
    frame.virtualEnergyPct > 14 &&
    frame.virtualEnergyPct <= 24;

  const strategyAllowsPitWindow = context?.pitStrategy
    ? context.pitStrategy.pitNeededThisRace
    : true;

  if (
    settings.pitWindowCountdownEnabled &&
    activeSessionType !== 'practice' &&
    activeSessionType !== 'qualifying' &&
    strategyAllowsPitWindow &&
    (lowFuelWindow || lowVeWindow) &&
    canFire('strategy', 28000, false, 'pit_window')
  ) {
    const estBurn =
      settings.fuelTargetLitersPerLap && settings.fuelTargetLitersPerLap > 0
        ? settings.fuelTargetLitersPerLap
        : track.lengthKm > 9
          ? 5.2
          : 2.9;
    const estFuelLapsLeft = Math.max(0.8, frame.fuelLiters / estBurn);
    const veBurn = track.lengthKm > 9 ? 11.2 : 7.8;
    const estVeLapsLeft =
      lowVeWindow && typeof frame.virtualEnergyPct === 'number'
        ? Math.max(0.8, frame.virtualEnergyPct / veBurn)
        : null;
    const estLapsLeft = estVeLapsLeft !== null ? Math.min(estFuelLapsLeft, estVeLapsLeft) : estFuelLapsLeft;
    const stratTireClause = context?.pitStrategy
      ? `, ${context.pitStrategy.pitTireCallHeadline}`
      : '';
    const stratBoxLapClause = context?.pitStrategy
      ? ` (Target Box L${context.pitStrategy.recommendedPitLap}${
          context.pitStrategy.fuelToAddLiters > 0
            ? `, +${context.pitStrategy.fuelToAddLiters.toFixed(0)}L`
            : ''
        }${stratTireClause})`
      : '';
    const msg =
      protocol === 'pro_terse'
        ? isHypercarClass
          ? lowVeWindow
            ? `Pit window open (VE ${Math.round(frame.virtualEnergyPct ?? 0)}%)${stratBoxLapClause} — MFD fuel + VE${stratTireClause}, repairs OFF.`
            : `Pit window open (${frame.fuelLiters.toFixed(1)}L)${stratBoxLapClause} — MFD fuel + VE${stratTireClause}, repairs OFF.`
          : `Pit window open (${frame.fuelLiters.toFixed(1)}L)${stratBoxLapClause} — MFD fuel${stratTireClause}, repairs OFF.`
        : isHypercarClass
          ? lowVeWindow
            ? `Pit window open: Virtual Energy at ${Math.round(frame.virtualEnergyPct ?? 0)}% (~${estLapsLeft.toFixed(1)} laps left)${stratBoxLapClause}. Pre-set MFD 100% VE + fuel${stratTireClause}, repairs OFF unless damaged, and prep pit limiter.`
            : `Pit window open: ${frame.fuelLiters.toFixed(1)} liters remaining (~${estLapsLeft.toFixed(1)} laps)${stratBoxLapClause}. Pre-set MFD fuel + 100% VE${stratTireClause}, repairs OFF unless damaged, and prep limiter.`
          : `Pit window open: ${frame.fuelLiters.toFixed(1)} liters remaining (~${estLapsLeft.toFixed(1)} laps)${stratBoxLapClause}. Pre-set MFD fuel${stratTireClause}, repairs OFF unless damaged, and prep limiter.`;
    return {
      callout: makeCallout('strategy', 'warning', 'Pit Window', msg, undefined, 'pit_window'),
      nextCooldowns,
    };
  }

  // 5c. Brake disc overheating alert (independent channel from dial coaching)
  if (hasBrakeSensors && (settings.brakeTempAlertsEnabled ?? true)) {
    const frontMaxBrake = Math.max(frame.brakeTempC.fl, frame.brakeTempC.fr);
    const rearMaxBrake = Math.max(frame.brakeTempC.rl, frame.brakeTempC.rr);
    const maxBrakeTemp = Math.max(frontMaxBrake, rearMaxBrake);
    if (maxBrakeTemp >= 740 && canFire('brakes', 16000, false, 'brake_overheat')) {
      const axle = frontMaxBrake >= rearMaxBrake ? 'Front' : 'Rear';
      const brakeLabel = formatCornerLabel(
        activeCorner,
        'en',
        'Brake Temps'
      );
      const msg =
        protocol === 'pro_terse'
          ? `${axle} brakes ${Math.round(maxBrakeTemp)}°C — lift early to cool.`
          : `${axle} brakes overheating at ${Math.round(maxBrakeTemp)}°C! Lift and coast slightly before heavy braking zones to avoid brake fade.`;
      return {
        callout: makeCallout('brakes', 'warning', brakeLabel, msg, undefined, 'brake_overheat'),
        nextCooldowns,
      };
    }
  }

  // 5d. Pro electronics & brake migration dial calls (bias / TC map)
  if (settings.electronicsCheckEnabled) {
    const frontMaxBrake = Math.max(frame.brakeTempC.fl, frame.brakeTempC.fr);
    const rearMaxBrake = Math.max(frame.brakeTempC.rl, frame.brakeTempC.rr);
    if (
      hasBrakeSensors &&
      frontMaxBrake >= 620 &&
      frontMaxBrake - rearMaxBrake >= 170 &&
      canFire('brakes', 22000, false, 'electronics_bias')
    ) {
      const diffC = Math.round(frontMaxBrake - rearMaxBrake);
      const msg =
        protocol === 'pro_terse'
          ? `Bias -1.0% rear (front rotors +${diffC}°C).`
          : `Front discs ${diffC}°C hotter than rears — move brake bias 1.0% rearward.`;
      return {
        callout: makeCallout('brakes', 'coaching', 'Brake Balance', msg, undefined, 'electronics_bias'),
        nextCooldowns,
      };
    }
    if (frame.tcActive && frame.rearWheelSlip >= 0.14 && canFire('traction', 18000, false, 'electronics_tc')) {
      const msg =
        protocol === 'pro_terse'
          ? 'TC +1 on dash — rear slip on exit.'
          : 'TC intervening heavily on exit — click TC map +1 for rear tire stability.';
      return {
        callout: makeCallout('traction', 'coaching', 'TC Map', msg, undefined, 'electronics_tc'),
        nextCooldowns,
      };
    }
  }

  // 6. Tire temperature window (cold, overheated, wear check-in always fire when tireAlertsEnabled is ON;
  //    optional informational optimal-window updates obey verbosity !== 'minimal')
  if (allowTires) {
    const [optMin, optMax] = car?.optimalTireTempRange ?? [75, 95];
    const temps = [
      frame.tireTempC.fl,
      frame.tireTempC.fr,
      frame.tireTempC.rl,
      frame.tireTempC.rr,
    ];
    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);
    const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;

    const frontMin = Math.min(frame.tireTempC.fl, frame.tireTempC.fr);
    const rearMin = Math.min(frame.tireTempC.rl, frame.tireTempC.rr);
    const frontMax = Math.max(frame.tireTempC.fl, frame.tireTempC.fr);
    const rearMax = Math.max(frame.tireTempC.rl, frame.tireTempC.rr);

    const coldThreshold = optMin - 5;
    const hotThreshold = optMax + 5;

    if (minTemp < coldThreshold && canFire('tires', 14000)) {
      nextCooldowns.tires_optimal = 0;
      const tireZoneLabel = formatCornerLabel(
        activeCorner,
        'en',
        'Tire Warmup'
      );
      const coldAxle =
        frontMin < coldThreshold && rearMin < coldThreshold
          ? 'all four tires'
          : frontMin <= rearMin
            ? 'the front tires'
            : 'the rear tires';

      const coldAxleShort =
        frontMin < coldThreshold && rearMin < coldThreshold
          ? 'Tires'
          : frontMin <= rearMin
            ? 'Fronts'
            : 'Rears';

      return {
        callout: makeCallout(
          'tires',
          'warning',
          tireZoneLabel,
          protocol === 'pro_terse'
            ? `${coldAxleShort} ${Math.round(minTemp)}°C cold — warm smoothly.`
            : `Watch out, your tires are cold (${Math.round(minTemp)}°C on ${coldAxle}). Brake slightly earlier and build heat smoothly up to ${optMin} degrees.`
        ),
        nextCooldowns,
      };
    }

    if (maxTemp > hotThreshold && canFire('tires', 14000)) {
      nextCooldowns.tires_optimal = 0;
      const heatLabel = formatCornerLabel(
        activeCorner,
        'en',
        'Tire Heat'
      );
      const hotAxle =
        frontMax > hotThreshold && rearMax > hotThreshold
          ? 'all four tires'
          : frontMax >= rearMax
            ? 'the front tires'
            : 'the rear tires';
      const hotAxleShort =
        frontMax > hotThreshold && rearMax > hotThreshold
          ? 'Tires'
          : frontMax >= rearMax
            ? 'Fronts'
            : 'Rears';

      return {
        callout: makeCallout(
          'tires',
          'warning',
          heatLabel,
          protocol === 'pro_terse'
            ? `${hotAxleShort} ${Math.round(maxTemp)}°C hot — smooth inputs.`
            : `Watch out, you've overheated ${hotAxle} (${Math.round(maxTemp)}°C)! Smooth out your steering and throttle inputs to cool them down.`
        ),
        nextCooldowns,
      };
    }

    // 6b. Interactive check-in when tires are heavily degraded (wear <= 74%)
    const wearValues = [
      frame.tireWearPct.fl,
      frame.tireWearPct.fr,
      frame.tireWearPct.rl,
      frame.tireWearPct.rr,
    ];
    const minWear = Math.min(...wearValues);
    if (minWear <= 74 && canFire('tire_degradation', 26000)) {
      const frontMinWear = Math.min(frame.tireWearPct.fl, frame.tireWearPct.fr);
      const rearMinWear = Math.min(frame.tireWearPct.rl, frame.tireWearPct.rr);
      const wornAxle = frontMinWear <= rearMinWear ? 'the fronts' : 'the rears';
      const wearLabel = formatCornerLabel(
        activeCorner,
        'en',
        'Tire Degradation'
      );
      const quickReplies = [
        'Fronts sliding (understeer)',
        'Rear sliding on exit',
        'Still feeling okay',
        'Should we box this lap?',
      ];

      return {
        callout: makeCallout(
          'tire_degradation',
          'warning',
          wearLabel,
          protocol === 'pro_terse'
            ? `Tires ${Math.round(minWear)}% worn — grip check?`
            : `Tires are heavily degraded (${Math.round(minWear)}% life left, ${wornAxle} worst). How do the tires feel — losing front turn-in or rear exit grip?`,
          quickReplies
        ),
        nextCooldowns,
      };
    }

    // 6c. Informational confirmation when tires reach / stay in the optimal temperature window
    const isNowOptimal = minTemp >= optMin - 2 && maxTemp <= optMax;
    if (isNowOptimal && settings.verbosity !== 'minimal' && canFire('tires_optimal', 50000)) {
      const prevMinTemp = prevFrame
        ? Math.min(
            prevFrame.tireTempC.fl,
            prevFrame.tireTempC.fr,
            prevFrame.tireTempC.rl,
            prevFrame.tireTempC.rr
          )
        : null;
      const prevMaxTemp = prevFrame
        ? Math.max(
            prevFrame.tireTempC.fl,
            prevFrame.tireTempC.fr,
            prevFrame.tireTempC.rl,
            prevFrame.tireTempC.rr
          )
        : null;

      const enteredOptimalFromOutside =
        prevMinTemp !== null &&
        prevMaxTemp !== null &&
        (prevMinTemp < coldThreshold || prevMaxTemp > hotThreshold);

      const stintMidLapConfirm =
        prevFrame !== null &&
        (cooldowns.tires_optimal ?? 0) === 0 &&
        frame.lapDistPct >= 0.45 &&
        frame.lapDistPct <= 0.65;

      const detailedConfirm =
        settings.verbosity === 'detailed' &&
        prevFrame !== null &&
        Math.abs(frame.lapDistPct - prevFrame.lapDistPct) < 0.05 &&
        frame.lapDistPct >= 0.25;

      if (enteredOptimalFromOutside || stintMidLapConfirm || detailedConfirm) {
        const optLabel = formatCornerLabel(
          activeCorner,
          'en',
          'Tire Window'
        );
        return {
          callout: makeCallout(
            'tires_optimal',
            'info',
            optLabel,
            protocol === 'pro_terse'
              ? `Tires ${Math.round(avgTemp)}°C optimal — push.`
              : `Your tires are at the right temperature (${Math.round(avgTemp)}°C, optimal ${optMin}-${optMax}°C window). Full grip available — push now!`
          ),
          nextCooldowns,
        };
      }
    }
  }

  // 6d. Tire Pressure PSI drift / puncture warning (independent channel & never blocked by verbosity/focusMode)
  if (
    hasTireSensors &&
    (settings.tirePressureAlertsEnabled ?? true) &&
    canFire('tires', 18000, false, 'tire_psi')
  ) {
    const psiValues = [
      frame.tirePressurePsi.fl,
      frame.tirePressurePsi.fr,
      frame.tirePressurePsi.rl,
      frame.tirePressurePsi.rr,
    ];
    const minPsi = Math.min(...psiValues);
    const maxPsi = Math.max(...psiValues);
    const psiLabel = formatCornerLabel(
      activeCorner,
      'en',
      'Tire Pressure'
    );
    if (minPsi > 0 && minPsi < 24.8) {
      return {
        callout: makeCallout(
          'tires',
          'warning',
          psiLabel,
          protocol === 'pro_terse'
            ? `Low PSI ${minPsi.toFixed(1)} — check next pit.`
            : `Low tire pressure detected (${minPsi.toFixed(1)} psi)! Watch for a slow puncture and raise cold PSI at your next stop.`,
          undefined,
          'tire_psi'
        ),
        nextCooldowns,
      };
    }
    if (maxPsi > 28.6) {
      return {
        callout: makeCallout(
          'tires',
          'warning',
          psiLabel,
          protocol === 'pro_terse'
            ? `High PSI ${maxPsi.toFixed(1)} — bleed next pit.`
            : `Tire pressure climbing too high (${maxPsi.toFixed(1)} psi) — losing apex grip. Bleed cold PSI slightly next pit.`,
          undefined,
          'tire_psi'
        ),
        nextCooldowns,
      };
    }
  }

  // 6e. New lap pace & delta debrief when crossing Start/Finish
  if (
    (settings.lapPaceAlertsEnabled ?? true) &&
    prevFrame &&
    frame.lapNumber > prevFrame.lapNumber &&
    canFire('strategy', 12000, false, 'lap_pace')
  ) {
    const completedLap = prevFrame.lapNumber;
    const prevDelta = prevFrame.deltaSec;
    const lapLabel = `Lap ${completedLap}`;
    const msg =
      protocol === 'pro_terse'
        ? `Lap ${completedLap}: ${formatDelta(prevDelta)}.`
        : prevDelta <= -0.15
          ? `Lap ${completedLap} complete at ${formatDelta(prevDelta)} faster than target! Great rhythm — keep it clean.`
          : prevDelta >= 0.6
            ? `Lap ${completedLap} finished +${prevDelta.toFixed(2)}s off pace. Trail-brake slightly lighter into apexes to unlock time.`
            : `Clean Lap ${completedLap} (${formatDelta(prevDelta)}). Solid consistency — stay on your marks.`;
    return {
      callout: makeCallout('strategy', 'info', lapLabel, msg, undefined, 'lap_pace'),
      nextCooldowns,
    };
  }

  // 6f. Sector splits (Sector 1 & Sector 2 timing loops)
  if (
    settings.sectorSplitsEnabled &&
    prevFrame &&
    frame.lapNumber === prevFrame.lapNumber &&
    canFire('strategy', 8000, false, 'sector_splits')
  ) {
    const crossedS1 = prevFrame.lapDistPct < 0.33 && frame.lapDistPct >= 0.33;
    const crossedS2 = prevFrame.lapDistPct < 0.66 && frame.lapDistPct >= 0.66;
    if (crossedS1 || crossedS2) {
      const secNum = crossedS1 ? 1 : 2;
      const statusWord =
        frame.deltaSec <= -0.08 ? 'green' : frame.deltaSec >= 0.15 ? 'off target' : 'on target';
      return {
        callout: makeCallout(
          'strategy',
          'info',
          `Sector ${secNum}`,
          protocol === 'pro_terse'
            ? `S${secNum}: ${formatDelta(frame.deltaSec)}.`
            : `Sector ${secNum} split: ${formatDelta(frame.deltaSec)} (${statusWord}).`,
          undefined,
          'sector_splits'
        ),
        nextCooldowns,
      };
    }
  }

  // 6g. Rival gap & winning battle coaching on straights
  if (
    settings.gapSplitsEnabled &&
    !activeCorner &&
    frame.opponents &&
    frame.opponents.length > 0 &&
    frame.speedKmh > 130 &&
    canFire('strategy', 22000, false, 'gap_splits')
  ) {
    const candidate = frame.opponents
      .filter((o) => !o.inPits && !o.isAlongside && Math.abs(o.distanceMeters) > 8 && Math.abs(o.distanceMeters) < 420)
      .sort((a, b) => Math.abs(a.gapSeconds) - Math.abs(b.gapSeconds))[0];
    if (candidate) {
      const ahead = candidate.distanceMeters > 0;
      const absGap = Math.abs(candidate.gapSeconds);
      const posLabel = candidate.position ? `P${candidate.position} ` : '';
      const closingFast = candidate.closingSpeedKmh >= 4;
      let msg: string;
      if (ahead && absGap <= 2.2 && closingFast) {
        msg =
          protocol === 'pro_terse'
            ? `Closing ${posLabel}#${candidate.carNumber} (+${absGap.toFixed(1)}s) — prep pass.`
            : `Closing fast on ${posLabel}#${candidate.carNumber} (+${absGap.toFixed(1)}s) — strong pace, carry exit speed and set up the pass next braking zone.`;
      } else if (!ahead && absGap <= 1.2 && closingFast) {
        msg =
          protocol === 'pro_terse'
            ? `#${candidate.carNumber} ${absGap.toFixed(1)}s back — nail exit.`
            : `#${candidate.carNumber} is ${absGap.toFixed(1)}s behind and closing — protect the inside on entry and maximize exit drive.`;
      } else {
        const trend =
          Math.abs(candidate.closingSpeedKmh) > 8
            ? candidate.closingSpeedKmh > 0
              ? ' (closing)'
              : ' (pulling clear)'
            : '';
        msg =
          protocol === 'pro_terse'
            ? `#${candidate.carNumber} ${ahead ? 'ahead' : 'back'}: ${absGap.toFixed(1)}s.`
            : `Gap to #${candidate.carNumber} ${ahead ? 'ahead' : 'behind'}: ${absGap.toFixed(1)}s${trend}.`;
      }
      return {
        callout: makeCallout('strategy', 'info', 'Gap Split', msg, undefined, 'gap_splits'),
        nextCooldowns,
      };
    }
  }

  // 6h. Lift-and-coast fuel target callout (Endurance)
  if (
    settings.fuelSaveCallsEnabled &&
    !activeCorner &&
    frame.speedKmh > 180 &&
    frame.throttle > 0.7 &&
    frame.fuelLiters > 6.5 &&
    frame.fuelLiters <= 24 &&
    canFire('fuel', 26000, false, 'fuel_save')
  ) {
    const targetBurn =
      settings.fuelTargetLitersPerLap && settings.fuelTargetLitersPerLap > 0
        ? settings.fuelTargetLitersPerLap
        : track.lengthKm > 9
          ? 5.0
          : 2.7;
    const msg =
      protocol === 'pro_terse'
        ? `Target ${targetBurn.toFixed(1)} L/lap — lift & coast.`
        : `Fuel target ${targetBurn.toFixed(1)} L/lap — lift and coast 50m into heavy braking to protect stint length.`;
    return {
      callout: makeCallout('fuel', 'coaching', 'Fuel Strategy', msg, undefined, 'fuel_save'),
      nextCooldowns,
    };
  }

  // 7. Pre-Corner Anticipation Cue before upcoming braking zone (always honors explicit preCornerCuesEnabled toggle)
  if (
    preCornerEnabled &&
    track.corners.length > 0 &&
    canFire('pre_corner', 6500)
  ) {
    const nextCorner =
      track.corners.find((c) => c.brakeMarkerPct > frame.lapDistPct) ?? track.corners[0];
    const trackLengthMeters = track.lengthKm * 1000;
    const distToBrakeM = ((nextCorner.brakeMarkerPct - frame.lapDistPct + 1) % 1) * trackLengthMeters;
    const needsEarlyBuffer =
      Boolean(driverProfile?.isNewToGame) || (driverProfile?.habits.lateBrakeCount ?? 0) >= 2;
    const minLookaheadM = 55;
    const maxLookaheadM = needsEarlyBuffer ? 185 : 145;

    if (
      (!activeCorner || activeCorner.id !== nextCorner.id) &&
      distToBrakeM >= minLookaheadM &&
      distToBrakeM <= maxLookaheadM &&
      frame.speedKmh > nextCorner.targetApexSpeedKmh + 28
    ) {
      const roundedDist = Math.max(50, Math.round(distToBrakeM / 10) * 10);
      const upcomingLabel = formatCornerLabel(nextCorner, 'en');
      let cueMsg: string;

      if (protocol === 'pro_terse') {
        cueMsg = `Turn ${nextCorner.number}, ${roundedDist}m — Gear ${nextCorner.targetGear}, ${nextCorner.targetApexSpeedKmh}.`;
      } else if (focusMode === 'braking') {
        cueMsg = `Approaching ${upcomingLabel} in ${roundedDist} meters — ${Math.round(nextCorner.targetBrakePressure * 100)}% brake target, down to gear ${nextCorner.targetGear}.`;
      } else if (focusMode === 'apex_line') {
        cueMsg = `Next up ${upcomingLabel} in ${roundedDist} meters — roll ${nextCorner.targetApexSpeedKmh} km/h apex in gear ${nextCorner.targetGear}.`;
      } else if (focusMode === 'throttle_exit') {
        cueMsg = `Approaching ${upcomingLabel} in ${roundedDist} meters — set the nose for clean throttle exit in gear ${nextCorner.targetGear}.`;
      } else {
        cueMsg = `Approaching ${upcomingLabel} in ${roundedDist} meters — brake for gear ${nextCorner.targetGear}, ${nextCorner.targetApexSpeedKmh} km/h apex.`;
      }

      return {
        callout: makeCallout('pre_corner', 'info', upcomingLabel, cueMsg),
        nextCooldowns,
      };
    }
  }

  // 8. Positive / detailed coaching cue when approaching corner cleanly
  if (
    settings.verbosity === 'detailed' &&
    activeCorner &&
    prevFrame &&
    prevFrame.lapDistPct < activeCorner.startPct &&
    frame.lapDistPct >= activeCorner.startPct &&
    canFire('engineer', 9000)
  ) {
    return {
      callout: makeCallout(
        'engineer',
        'coaching',
        cornerLabel,
        `${cornerLabel}: ${activeCorner.coachingCue}. Target gear ${activeCorner.targetGear}.`
      ),
      nextCooldowns,
    };
  }

  return { callout: null, nextCooldowns };
}

/**
 * Compares a user lap's telemetry frames against the pro reference samples
 * across every defined corner on the circuit.
 */
export function analyzeLapByCorners(
  userFrames: TelemetryFrame[],
  refSamples: ReferenceSample[],
  track: TrackProfile
): CornerComparison[] {
  const trackLengthMeters = track.lengthKm * 1000;

  return track.corners.map((corner) => {
    const cornerLabel = `Turn ${corner.number} (${corner.name})`;
    const zoneUser = userFrames.filter(
      (f) => f.lapDistPct >= corner.startPct - 0.01 && f.lapDistPct <= corner.exitPct + 0.01
    );
    const zoneRef = refSamples.filter(
      (r) => r.pct >= corner.startPct - 0.01 && r.pct <= corner.exitPct + 0.01
    );

    if (zoneUser.length === 0 || zoneRef.length === 0) {
      return {
        cornerId: corner.id,
        cornerNumber: corner.number,
        cornerName: corner.name,
        sector: corner.sector,
        brakingDeltaMeters: 0,
        entrySpeedDeltaKmh: 0,
        minApexSpeedDeltaKmh: 0,
        exitSpeedDeltaKmh: 0,
        trailBrakingScore: 82,
        timeLostSec: 0,
        primaryIssue: `${cornerLabel}: Clean corner pass`,
      };
    }

    const firstBrakeUser = zoneUser.find((f) => f.brake >= 0.25);
    const firstBrakeRef = zoneRef.find((r) => r.brake >= 0.25);

    const brakingDeltaMeters =
      firstBrakeUser && firstBrakeRef
        ? Math.round((firstBrakeUser.lapDistPct - firstBrakeRef.pct) * trackLengthMeters)
        : 0;

    const userEntrySpeed = zoneUser[0].speedKmh;
    const refEntrySpeed = zoneRef[0].speedKmh;
    const entrySpeedDeltaKmh = Math.round((userEntrySpeed - refEntrySpeed) * 10) / 10;

    const userMinApex = Math.min(...zoneUser.map((f) => f.speedKmh));
    const refMinApex = Math.min(...zoneRef.map((r) => r.speedKmh));
    const minApexSpeedDeltaKmh = Math.round((userMinApex - refMinApex) * 10) / 10;

    const userExitSpeed = zoneUser[zoneUser.length - 1].speedKmh;
    const refExitSpeed = zoneRef[zoneRef.length - 1].speedKmh;
    const exitSpeedDeltaKmh = Math.round((userExitSpeed - refExitSpeed) * 10) / 10;

    const trailSamples = zoneUser.filter(
      (f) => f.brake > 0.08 && f.brake < 0.72 && Math.abs(f.steeringRad) > 0.08
    );
    const lockupPenalty = zoneUser.some((f) => f.frontWheelSlip > 0.16) ? 18 : 0;
    const rawScore = 62 + Math.min(34, trailSamples.length * 8) - lockupPenalty - Math.min(18, Math.abs(brakingDeltaMeters));
    const trailBrakingScore = Math.max(25, Math.min(99, Math.round(rawScore)));

    const startDelta = zoneUser[0].deltaSec;
    const endDelta = zoneUser[zoneUser.length - 1].deltaSec;
    const timeLostSec = Math.round(Math.max(-0.5, endDelta - startDelta) * 1000) / 1000;

    let primaryIssue = `${cornerLabel}: Strong trail-braking and exit speed`;
    if (lockupPenalty > 0) {
      primaryIssue = `${cornerLabel}: Front wheel lockup mid-braking — ease off peak pressure earlier`;
    } else if (brakingDeltaMeters > 7) {
      primaryIssue = `${cornerLabel}: Braked ${brakingDeltaMeters}m too late — compromised apex speed`;
    } else if (brakingDeltaMeters < -8) {
      primaryIssue = `${cornerLabel}: Braked ${Math.abs(brakingDeltaMeters)}m early — carry more entry momentum`;
    } else if (exitSpeedDeltaKmh < -4) {
      primaryIssue = `${cornerLabel}: Delayed exit throttle pickup — open steering earlier past apex`;
    } else if (minApexSpeedDeltaKmh < -4) {
      primaryIssue = `${cornerLabel}: Over-slowed minimum apex speed — release brake earlier on turn-in`;
    }

    return {
      cornerId: corner.id,
      cornerNumber: corner.number,
      cornerName: corner.name,
      sector: corner.sector,
      brakingDeltaMeters,
      entrySpeedDeltaKmh,
      minApexSpeedDeltaKmh,
      exitSpeedDeltaKmh,
      trailBrakingScore,
      timeLostSec,
      primaryIssue,
    };
  });
}

/**
 * Computes Trophi.ai-style pedal & trail-braking skill metrics plus
 * Track Titan-style Top 3 Priority Corner Drills from lap frames.
 */
export function evaluateDriverSkillMetrics(
  frames: TelemetryFrame[],
  cornerComparisons: CornerComparison[],
  _language: 'en' = 'en'
): DriverSkillMetrics {
  const count = frames.length;

  let overlapCount = 0;
  let totalJerk = 0;
  for (let i = 0; i < count; i++) {
    const f = frames[i];
    if (f.throttle > 0.12 && f.brake > 0.12) {
      overlapCount += 1;
    }
    if (i > 0) {
      const prev = frames[i - 1];
      totalJerk +=
        Math.abs(f.brake - prev.brake) + Math.abs(f.throttle - prev.throttle);
    }
  }

  const pedalOverlapPct =
    count > 0 ? Math.round((overlapCount / count) * 1000) / 10 : 0;
  const avgJerk = count > 1 ? totalJerk / (count - 1) : 0.08;
  const inputSmoothnessScore = Math.max(
    35,
    Math.min(99, Math.round(98 - avgJerk * 115 - pedalOverlapPct * 1.4))
  );

  const avgTrail =
    cornerComparisons.length > 0
      ? Math.round(
          cornerComparisons.reduce((acc, c) => acc + c.trailBrakingScore, 0) /
            cornerComparisons.length
        )
      : 80;

  const ranked = [...cornerComparisons]
    .filter((c) => c.timeLostSec > 0.02)
    .sort((a, b) => b.timeLostSec - a.timeLostSec)
    .slice(0, 3);

  const topLossDrills: PriorityCornerDrill[] = ranked.map((c) => {
    let phase: PriorityCornerDrill['phase'] = 'apex';
    let actionDrill = '';

    if (Math.abs(c.brakingDeltaMeters) >= 6) {
      phase = 'braking';
      if (c.brakingDeltaMeters > 0) {
        actionDrill = `Brake ${c.brakingDeltaMeters}m earlier and bleed pressure smoothly toward apex.`;
      } else {
        actionDrill = `Push braking ${Math.abs(c.brakingDeltaMeters)}m deeper into the entry.`;
      }
    } else if (c.exitSpeedDeltaKmh <= -3) {
      phase = 'exit';
      actionDrill = `Unwind steering earlier and commit to throttle sooner (${c.exitSpeedDeltaKmh} km/h exit).`;
    } else {
      phase = 'apex';
      actionDrill = `Carry more minimum apex speed (${c.minApexSpeedDeltaKmh} km/h) with lighter trail-brake.`;
    }

    return {
      cornerId: c.cornerId,
      cornerNumber: c.cornerNumber,
      cornerName: c.cornerName,
      phase,
      timeLostSec: Math.round(c.timeLostSec * 1000) / 1000,
      actionDrill,
    };
  });

  const potentialGainSec =
    Math.round(
      cornerComparisons
        .filter((c) => c.timeLostSec > 0)
        .reduce((acc, c) => acc + c.timeLostSec, 0) * 100
    ) / 100;

  return {
    trailBrakingScore: avgTrail,
    pedalOverlapPct,
    inputSmoothnessScore,
    potentialGainSec,
    topLossDrills,
  };
}
