import type {
  CarProfile,
  CornerDefinition,
  OpponentCar,
  RacecraftAdvice,
  ReferenceSample,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';
import { formatCornerLabel } from './coachRules';

const WEC_OPPONENT_ROSTER: Array<{
  id: string;
  carNumber: string;
  driverName: string;
  carClass: OpponentCar['carClass'];
  carName: string;
  safetyRating: OpponentCar['safetyRating'];
  paceFactor: number;
  position: number;
  inPits?: boolean;
}> = [
  {
    id: 'opp-7',
    carNumber: '7',
    driverName: 'K. Kobayashi',
    carClass: 'Hypercar',
    carName: 'Toyota GR010 Hybrid',
    safetyRating: 'clean',
    paceFactor: 0.96,
    position: 3,
  },
  {
    id: 'opp-51',
    carNumber: '51',
    driverName: 'A. Pier Guidi',
    carClass: 'Hypercar',
    carName: 'Ferrari 499P',
    safetyRating: 'aggressive',
    paceFactor: 1.04,
    position: 5,
  },
  {
    id: 'opp-83',
    carNumber: '83',
    driverName: 'R. Kubica',
    carClass: 'Hypercar',
    carName: 'AF Corse 499P',
    safetyRating: 'clean',
    paceFactor: 1.02,
    position: 2,
  },
  {
    id: 'opp-92',
    carNumber: '92',
    driverName: 'K. Estre',
    carClass: 'LMGT3',
    carName: 'Porsche 911 GT3 R',
    safetyRating: 'clean',
    paceFactor: 0.9,
    position: 14,
  },
  {
    id: 'opp-8',
    carNumber: '8',
    driverName: 'S. Buemi',
    carClass: 'Hypercar',
    carName: 'Toyota GR010 Hybrid',
    safetyRating: 'clean',
    paceFactor: 1.03,
    position: 1,
  },
  {
    id: 'opp-2',
    carNumber: '2',
    driverName: 'E. Bamber',
    carClass: 'Hypercar',
    carName: 'Cadillac V-Series.R',
    safetyRating: 'clean',
    paceFactor: 0.99,
    position: 6,
  },
  {
    id: 'opp-22',
    carNumber: '22',
    driverName: 'F. Albuquerque',
    carClass: 'LMP2',
    carName: 'Oreca 07 Gibson',
    safetyRating: 'clean',
    paceFactor: 0.94,
    position: 9,
  },
  {
    id: 'opp-34',
    carNumber: '34',
    driverName: 'J. Smiechowski',
    carClass: 'LMP2',
    carName: 'Inter Europol Oreca 07',
    safetyRating: 'clean',
    paceFactor: 0.93,
    position: 10,
  },
  {
    id: 'opp-46',
    carNumber: '46',
    driverName: 'V. Rossi',
    carClass: 'LMGT3',
    carName: 'BMW M4 LMGT3',
    safetyRating: 'clean',
    paceFactor: 0.89,
    position: 15,
  },
  {
    id: 'opp-54',
    carNumber: '54',
    driverName: 'D. Rigon',
    carClass: 'LMGT3',
    carName: 'Ferrari 296 LMGT3',
    safetyRating: 'clean',
    paceFactor: 0.88,
    position: 16,
    inPits: true,
  },
];

function wrapPct(pct: number): number {
  const modded = pct % 1;
  return modded < 0 ? modded + 1 : modded;
}

/**
 * Signed shortest distance along track in [-trackLength/2, +trackLength/2].
 * Positive = opponent is ahead of player; Negative = opponent is behind player.
 */
export function computeSignedDistanceMeters(
  playerPct: number,
  opponentPct: number,
  trackLengthKm: number
): number {
  let diff = opponentPct - playerPct;
  if (diff > 0.5) diff -= 1;
  if (diff < -0.5) diff += 1;
  return Math.round(diff * trackLengthKm * 1000 * 10) / 10;
}

/**
 * Computes whether an opponent car is to the left or right of the player car
 * in LMU / rFactor 2 left-handed world coordinates (+X=Left, +Y=Up, +Z=Back).
 */
export function computeLmuLateralSide(
  playerPos: { x: number; z: number },
  playerVel: { x: number; z: number },
  oppPos: { x: number; z: number }
): OpponentCar['lateralSide'] {
  const speedSq = playerVel.x * playerVel.x + playerVel.z * playerVel.z;
  if (speedSq < 4) return 'center';
  const len = Math.sqrt(speedSq);
  const fx = playerVel.x / len;
  const fz = playerVel.z / len;
  const dx = oppPos.x - playerPos.x;
  const dz = oppPos.z - playerPos.z;
  // In (Left, Up, Back) coordinates, Forward x Up = (-fz, 0, fx) points LEFT
  const lateralLeftMeters = -fz * dx + fx * dz;
  if (Math.abs(lateralLeftMeters) < 1.1) return 'center';
  return lateralLeftMeters > 0 ? 'left' : 'right';
}

export function createInitialOpponents(
  track: TrackProfile,
  car: CarProfile,
  playerPct: number,
  playerSpeedKmh: number
): OpponentCar[] {
  const trackMeters = track.lengthKm * 1000;
  // Place cars at realistic starting gaps (+28m ahead, -32m behind, +115m ahead, -95m behind)
  const initialOffsetsMeters = [28, -32, 115, -95, 520, -480, 1280, -1120, 2150];

  return WEC_OPPONENT_ROSTER.map((entry, idx) => {
    const isPitCar = Boolean(entry.inPits);
    const oppPct = isPitCar
      ? 0.014
      : wrapPct(playerPct + (initialOffsetsMeters[idx] ?? (idx + 1) * 190) / trackMeters);
    const offsetM = isPitCar
      ? computeSignedDistanceMeters(playerPct, oppPct, track.lengthKm)
      : (initialOffsetsMeters[idx] ?? (idx + 1) * 190);
    const baseClassSpeed = isPitCar
      ? 60
      : entry.carClass === car.carClass
        ? playerSpeedKmh * entry.paceFactor
        : entry.carClass === 'Hypercar'
          ? Math.min(330, playerSpeedKmh * 1.08)
          : entry.carClass === 'LMP2'
            ? Math.max(135, playerSpeedKmh * 0.95)
            : Math.max(120, playerSpeedKmh * 0.9);
    const speedKmh = Math.round(baseClassSpeed * 10) / 10;
    const closingSpeedKmh =
      offsetM > 0
        ? Math.round((playerSpeedKmh - speedKmh) * 10) / 10
        : Math.round((speedKmh - playerSpeedKmh) * 10) / 10;
    const sector: 1 | 2 | 3 = oppPct < 1 / 3 ? 1 : oppPct < 2 / 3 ? 2 : 3;

    return {
      id: entry.id,
      carNumber: entry.carNumber,
      driverName: entry.driverName,
      carClass: entry.carClass,
      carName: entry.carName,
      lapDistPct: oppPct,
      speedKmh,
      gapSeconds:
        Math.round((offsetM / Math.max(20, playerSpeedKmh / 3.6)) * 100) / 100,
      distanceMeters: offsetM,
      closingSpeedKmh,
      lateralSide: offsetM > 0 ? 'center' : 'left',
      isAlongside: !isPitCar && Math.abs(offsetM) <= 5.5,
      safetyRating: entry.safetyRating,
      position: entry.position,
      lapsCompleted: isPitCar ? 2 : 3,
      inPits: isPitCar,
      sector,
    };
  });
}

export function stepOpponentsSimulation(
  prevOpponents: OpponentCar[] | undefined,
  playerPct: number,
  playerSpeedKmh: number,
  track: TrackProfile,
  car: CarProfile,
  refSamples: ReferenceSample[],
  activeFault: string,
  faultTicksRemaining: number,
  dtMs: number
): OpponentCar[] {
  const base =
    prevOpponents && prevOpponents.length > 0
      ? prevOpponents
      : createInitialOpponents(track, car, playerPct, playerSpeedKmh);

  const trackMeters = track.lengthKm * 1000;
  const simSpeedMultiplier = track.lengthKm > 9 ? 2.4 : 1.75;

  return base.map((opp, idx) => {
    const roster = WEC_OPPONENT_ROSTER[idx];
    let oppPct = opp.lapDistPct;
    const refIdx = Math.min(
      refSamples.length - 1,
      Math.max(0, Math.floor(oppPct * refSamples.length))
    );
    const refSpeed = refSamples[refIdx]?.speedKmh ?? playerSpeedKmh;

    let paceFactor = roster?.paceFactor ?? 1.0;
    let lateralSide: OpponentCar['lateralSide'] = opp.lateralSide;

    // Force deterministic scenarios when triggered from Pit Wall simulator
    const isPitCar = Boolean(roster?.inPits ?? opp.inPits);
    if (activeFault === 'rival_attack' && idx === 1) {
      // #51 charging rapidly from behind (~18m -> 11m)
      const targetBehindM = -Math.max(11, 13 + faultTicksRemaining * 0.45);
      oppPct = wrapPct(playerPct + targetBehindM / trackMeters);
      paceFactor = 1.09;
      lateralSide = 'right';
    } else if (activeFault === 'attack_chance' && idx === 0) {
      // #7 ahead losing exit momentum (~26m ahead, player closing +13 km/h)
      const targetAheadM = Math.max(14, 16 + faultTicksRemaining * 0.6);
      oppPct = wrapPct(playerPct + targetAheadM / trackMeters);
      paceFactor = 0.89;
      lateralSide = 'center';
    } else if (activeFault === 'side_by_side' && idx === 2) {
      // #83 right beside player on LEFT
      const targetOverlapM = faultTicksRemaining % 2 === 0 ? 1.8 : -1.6;
      oppPct = wrapPct(playerPct + targetOverlapM / trackMeters);
      paceFactor = 1.0;
      lateralSide = 'left';
    } else if (activeFault === 'side_by_side_right' && idx === 1) {
      // #51 right beside player on RIGHT
      const targetOverlapM = faultTicksRemaining % 2 === 0 ? 1.5 : -1.4;
      oppPct = wrapPct(playerPct + targetOverlapM / trackMeters);
      paceFactor = 1.0;
      lateralSide = 'right';
    } else if (isPitCar) {
      // Cruise smoothly near pit lane speed along pit entry/exit zone (0.985 .. 0.03)
      const pitStep = ((60 * 1000) / 3600 * (dtMs / 1000)) / trackMeters;
      oppPct = oppPct >= 0.03 && oppPct < 0.98 ? 0.985 : wrapPct(oppPct + pitStep);
    } else {
      const oppMetersPerSec = Math.max(20, ((refSpeed * paceFactor) * 1000) / 3600);
      const distDeltaPct =
        (oppMetersPerSec * (dtMs / 1000) * simSpeedMultiplier) / trackMeters;
      oppPct = wrapPct(oppPct + distDeltaPct);
    }

    const oppSpeedKmh = isPitCar
      ? 60
      : Math.round(Math.max(55, Math.min(340, refSpeed * paceFactor)) * 10) / 10;

    let distanceMeters = computeSignedDistanceMeters(playerPct, oppPct, track.lengthKm);
    // Keep the close-pack cars (idx < 4) within +/- 260m while letting the rest of the field circulate across the full circuit
    if (
      idx < 4 &&
      activeFault !== 'rival_attack' &&
      activeFault !== 'attack_chance' &&
      activeFault !== 'side_by_side' &&
      activeFault !== 'side_by_side_right' &&
      Math.abs(distanceMeters) > 260
    ) {
      const resetOffset = idx % 2 === 0 ? 45 + idx * 15 : -(45 + idx * 15);
      oppPct = wrapPct(playerPct + resetOffset / trackMeters);
      distanceMeters = resetOffset;
    }

    const isAlongside = !isPitCar && Math.abs(distanceMeters) <= 5.5;
    if (isAlongside && lateralSide === 'center') {
      lateralSide = idx % 2 === 0 ? 'right' : 'left';
    } else if (!isAlongside && Math.abs(distanceMeters) > 25) {
      lateralSide = 'center';
    }

    const avgMetersPerSec = Math.max(20, ((playerSpeedKmh + oppSpeedKmh) / 2) / 3.6);
    const gapSeconds = Math.round((distanceMeters / avgMetersPerSec) * 100) / 100;
    const closingSpeedKmh =
      distanceMeters >= 0
        ? Math.round((playerSpeedKmh - oppSpeedKmh) * 10) / 10
        : Math.round((oppSpeedKmh - playerSpeedKmh) * 10) / 10;
    const sector: 1 | 2 | 3 = oppPct < 1 / 3 ? 1 : oppPct < 2 / 3 ? 2 : 3;

    return {
      ...opp,
      lapDistPct: oppPct,
      speedKmh: oppSpeedKmh,
      gapSeconds,
      distanceMeters,
      closingSpeedKmh,
      lateralSide,
      isAlongside,
      inPits: isPitCar,
      sector,
      position: roster?.position ?? opp.position,
    };
  });
}

/**
 * Evaluates all nearby opponents relative to the player to determine:
 * - Whether a rival is about to pass and if defending is safe
 * - Whether there is a clean, safe attack opportunity ahead
 * - Whether a car is already alongside in a blindspot
 */
export function evaluateRacecraft(
  frame: TelemetryFrame,
  _track: TrackProfile,
  car: CarProfile,
  upcomingCorner: CornerDefinition | null,
  _language: 'en' = 'en'
): RacecraftAdvice {
  const opponents = (frame.opponents ?? []).filter((o) => !o.inPits);

  if (opponents.length === 0) {
    return {
      posture: 'clear',
      safeToAttack: !frame.hazardAhead,
      safeToDefend: true,
      headline: 'Single Player · Clean Track',
      detail: 'Solo session — no other cars on track. Focus on braking markers, apex carry, and exit traction.',
      targetOpponent: null,
    };
  }

  const sortedByProximity = [...opponents].sort(
    (a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters)
  );
  const cornerLabel = formatCornerLabel(
    upcomingCorner,
    'en',
    'the next corner'
  );

  // 1. Highest priority: Car(s) physically alongside / overlapping (Car Left / Car Right / Three Wide)
  const alongsideCars = sortedByProximity.filter(
    (o) => o.isAlongside || Math.abs(o.distanceMeters) <= 5.5
  );
  if (alongsideCars.length > 0) {
    const leftCar = alongsideCars.find((o) => o.lateralSide === 'left');
    const rightCar = alongsideCars.find((o) => o.lateralSide === 'right');
    if (leftCar && rightCar) {
      return {
        posture: 'three_wide',
        safeToAttack: false,
        safeToDefend: false,
        headline: `Three Wide! — #${leftCar.carNumber} (L) & #${rightCar.carNumber} (R)`,
        detail: `Three wide! Hold your center line — #${leftCar.carNumber} on your LEFT and #${rightCar.carNumber} on your RIGHT.`,
        targetOpponent: alongsideCars[0],
      };
    }

    const alongsideCar = alongsideCars[0];
    const side = alongsideCar.lateralSide === 'left' ? 'left' : 'right';
    const sideTitle = side === 'left' ? 'Car Left!' : 'Car Right!';
    const sideUpper = side === 'left' ? 'LEFT' : 'RIGHT';
    return {
      posture: 'hold_line_car_alongside',
      safeToAttack: false,
      safeToDefend: false,
      headline: `${sideTitle} — #${alongsideCar.carNumber}`,
      detail: `${sideTitle} Hold your line — #${alongsideCar.carNumber} (${alongsideCar.driverName}) is alongside on your ${sideUpper}. Leave racing room.`,
      targetOpponent: alongsideCar,
    };
  }

  // 2. Blue flag faster class closing behind
  const fasterClassBehind = sortedByProximity.find(
    (o) =>
      o.distanceMeters < -5.5 &&
      o.distanceMeters >= -70 &&
      o.carClass === 'Hypercar' &&
      car.carClass !== 'Hypercar' &&
      o.closingSpeedKmh >= 10
  );
  if (fasterClassBehind) {
    return {
      posture: 'blue_flag_yield',
      safeToAttack: false,
      safeToDefend: false,
      headline: `Faster Hypercar #${fasterClassBehind.carNumber} Closing`,
      detail: `Blue flag: Hypercar #${fasterClassBehind.carNumber} closing at ${Math.abs(Math.round(fasterClassBehind.distanceMeters))}m (+${Math.round(fasterClassBehind.closingSpeedKmh)} km/h). Stay predictable and let it pass cleanly.`,
      targetOpponent: fasterClassBehind,
    };
  }

  // 3. Rival behind attempting to pass (Defense evaluation)
  const threateningBehind = sortedByProximity.find(
    (o) =>
      o.distanceMeters < -5.5 &&
      o.distanceMeters >= -48 &&
      (o.closingSpeedKmh >= 5 || Math.abs(o.gapSeconds) <= 0.65)
  );
  if (threateningBehind) {
    const absDist = Math.abs(Math.round(threateningBehind.distanceMeters));
    const closing = Math.max(1, Math.round(threateningBehind.closingSpeedKmh));
    const safeToDefend = absDist >= 10 && threateningBehind.safetyRating !== 'erratic';

    if (safeToDefend) {
      return {
        posture: 'defend_inside',
        safeToAttack: false,
        safeToDefend: true,
        headline: `Watch Out! #${threateningBehind.carNumber} Attacking Behind`,
        detail: `Watch out — #${threateningBehind.carNumber} (${absDist}m behind, +${closing} km/h) is going for a pass! Safe to cover the inside line cleanly before ${cornerLabel}.`,
        targetOpponent: threateningBehind,
      };
    }

    return {
      posture: 'defend_inside',
      safeToAttack: false,
      safeToDefend: false,
      headline: `Late Dive Risk from #${threateningBehind.carNumber}`,
      detail: `Heads up! #${threateningBehind.carNumber} is only ${absDist}m back on a late dive — do not chop across, hold outside and cut back on exit.`,
      targetOpponent: threateningBehind,
    };
  }

  // 4. Car ahead within attack window
  const carAheadInRange = sortedByProximity.find(
    (o) =>
      o.distanceMeters > 5.5 &&
      o.distanceMeters <= 46 &&
      (o.closingSpeedKmh >= 4 || frame.speedKmh > o.speedKmh + 4)
  );
  if (carAheadInRange) {
    const dist = Math.round(carAheadInRange.distanceMeters);
    const closing = Math.max(2, Math.round(carAheadInRange.closingSpeedKmh));
    const hasBehindPressure = sortedByProximity.some(
      (o) => o.id !== carAheadInRange.id && o.distanceMeters < 0 && o.distanceMeters >= -16
    );
    const safeToAttack =
      !frame.hazardAhead && frame.flagState === 'green' && !hasBehindPressure;

    if (!safeToAttack) {
      return {
        posture: 'defend_inside',
        safeToAttack: false,
        safeToDefend: true,
        headline: `Hold Attack — Traffic or Yellow Zone`,
        detail: `Close to #${carAheadInRange.carNumber} (${dist}m ahead), but traffic behind or yellow zone makes a lunge unsafe. Set up the exit.`,
        targetOpponent: carAheadInRange,
      };
    }

    const cautionNoteEn =
      carAheadInRange.safetyRating === 'aggressive'
        ? ' Rival defends hard — keep margin on apex.'
        : '';

    return {
      posture: 'attack_opportunity',
      safeToAttack: true,
      safeToDefend: true,
      headline: `Attack Opportunity on #${carAheadInRange.carNumber} (SAFE)`,
      detail: `Attack now — you have the opportunity! #${carAheadInRange.carNumber} is ${dist}m ahead (+${closing} km/h). Safe to commit inside into ${cornerLabel}.${cautionNoteEn}`,
      targetOpponent: carAheadInRange,
    };
  }

  return {
    posture: 'clear',
    safeToAttack: !frame.hazardAhead,
    safeToDefend: true,
    headline: 'Track Clear — Push Pace',
    detail: 'Safe gap to surrounding cars. Focus on clean braking markers and exit traction.',
    targetOpponent: sortedByProximity[0] ?? null,
  };
}
