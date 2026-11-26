import {
  getActiveCorner,
  getUpcomingCorner,
  interpolateTrackPoint,
} from '../data/circuitsAndCars';
import type {
  CarProfile,
  OpponentCar,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';

export interface SvgBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrackCarPose {
  x: number;
  y: number;
  headingDeg: number;
}

export interface TrackCarLocationSummary {
  sector: 1 | 2 | 3;
  trackDistanceM: number;
  trackLengthM: number;
  lapPctLabel: string;
  zoneLabel: string;
  activeCornerNumber: number | null;
  nextCornerNumber: number;
  distanceToNextCornerM: number;
}

export type TrackCarStatusKind =
  | 'player'
  | 'pit'
  | 'alongside'
  | 'threat'
  | 'attack'
  | 'slow'
  | 'track';

export interface PitWallTrackedCar {
  id: string;
  isPlayer: boolean;
  carNumber: string;
  driverName: string;
  carName: string;
  carClass: 'Hypercar' | 'LMP2' | 'LMGT3';
  classShort: 'HY' | 'P2' | 'GT3';
  position?: number;
  lapsCompleted?: number;
  lapDistPct: number;
  speedKmh: number;
  gapSeconds: number;
  distanceMeters: number;
  closingSpeedKmh: number;
  lateralSide: OpponentCar['lateralSide'];
  isAlongside: boolean;
  inPits: boolean;
  posX?: number;
  posZ?: number;
  pose: TrackCarPose;
  location: TrackCarLocationSummary;
  status: TrackCarStatusKind;
  statusLabel: string;
}

export interface SectorBoundaryMarker {
  sector: 1 | 2 | 3;
  label: string;
  pct: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export function parseSvgViewBox(viewBox: string): SvgBounds {
  const parts = String(viewBox || '')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n) && (parts[2] > 0 && parts[3] > 0))) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  return { x: 0, y: 0, w: 1000, h: 600 };
}

function wrapPct(pct: number): number {
  const modded = pct % 1;
  return modded < 0 ? modded + 1 : modded;
}

export function getSectorForPct(lapDistPct: number, explicitSector?: 1 | 2 | 3): 1 | 2 | 3 {
  if (explicitSector === 1 || explicitSector === 2 || explicitSector === 3) {
    return explicitSector;
  }
  const pct = wrapPct(lapDistPct);
  if (pct < 1 / 3) return 1;
  if (pct < 2 / 3) return 2;
  return 3;
}

export function interpolateTrackPose(track: TrackProfile, lapDistPct: number): TrackCarPose {
  const pct = wrapPct(lapDistPct);
  const eps = 0.0025;
  const pPrev = interpolateTrackPoint(track, wrapPct(pct - eps));
  const pCurr = interpolateTrackPoint(track, pct);
  const pNext = interpolateTrackPoint(track, wrapPct(pct + eps));
  const dx = pNext.x - pPrev.x;
  const dy = pNext.y - pPrev.y;
  const headingDeg =
    Math.hypot(dx, dy) > 0.001
      ? Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 10) / 10
      : 0;
  return {
    x: pCurr.x,
    y: pCurr.y,
    headingDeg,
  };
}

export function getSectorBoundaries(track: TrackProfile): SectorBoundaryMarker[] {
  const defs: Array<{ sector: 1 | 2 | 3; label: string; pct: number }> = [
    { sector: 2, label: 'S1/S2', pct: 1 / 3 },
    { sector: 3, label: 'S2/S3', pct: 2 / 3 },
  ];
  return defs.map((d) => {
    const pPrev = interpolateTrackPoint(track, d.pct - 0.003);
    const pCurr = interpolateTrackPoint(track, d.pct);
    const pNext = interpolateTrackPoint(track, d.pct + 0.003);
    const dx = pNext.x - pPrev.x;
    const dy = pNext.y - pPrev.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      sector: d.sector,
      label: d.label,
      pct: d.pct,
      x: pCurr.x,
      y: pCurr.y,
      nx: (-dy / len) * 10,
      ny: (dx / len) * 10,
    };
  });
}

export function describeTrackLocation(
  track: TrackProfile,
  lapDistPct: number,
  options?: {
    inPits?: boolean;
    speedKmh?: number;
    explicitSector?: 1 | 2 | 3;
  }
): TrackCarLocationSummary {
  const pct = wrapPct(lapDistPct);
  const trackLengthM = Math.max(500, Math.round(track.lengthKm * 1000));
  const trackDistanceM = Math.round(pct * trackLengthM);
  const lapPctLabel = `${(pct * 100).toFixed(1)}%`;
  const sector = getSectorForPct(pct, options?.explicitSector);

  const active = getActiveCorner(track, pct);
  const upcoming = getUpcomingCorner(track, pct);
  let deltaToNext = upcoming.startPct - pct;
  if (deltaToNext < 0) deltaToNext += 1;
  const distanceToNextCornerM = Math.max(0, Math.round(deltaToNext * trackLengthM));

  let zoneLabel: string;
  if (options?.inPits) {
    zoneLabel =
      (options.speedKmh ?? 0) < 5
        ? 'Pit Box / Garage Stall'
        : `Pit Lane (${Math.round(options.speedKmh ?? 0)} km/h)`;
  } else if (active) {
    zoneLabel = `In T${active.number} · ${active.name}`;
  } else if (distanceToNextCornerM <= 260) {
    zoneLabel = `Approaching T${upcoming.number} ${upcoming.name} (${distanceToNextCornerM}m)`;
  } else {
    zoneLabel = `Straight · ${distanceToNextCornerM}m to T${upcoming.number}`;
  }

  return {
    sector,
    trackDistanceM,
    trackLengthM,
    lapPctLabel,
    zoneLabel,
    activeCornerNumber: active?.number ?? null,
    nextCornerNumber: upcoming.number,
    distanceToNextCornerM,
  };
}

export function computeFollowZoomViewBox(
  track: TrackProfile,
  targetPoint: { x: number; y: number },
  zoomFactor = 2.6
): string {
  const base = parseSvgViewBox(track.svgViewBox);
  const safeZoom = Math.max(1.25, Math.min(5, zoomFactor));
  const w = base.w / safeZoom;
  const h = base.h / safeZoom;

  const minX = base.x;
  const maxX = base.x + base.w - w;
  const minY = base.y;
  const maxY = base.y + base.h - h;

  const x = Math.max(minX, Math.min(maxX, targetPoint.x - w / 2));
  const y = Math.max(minY, Math.min(maxY, targetPoint.y - h / 2));

  return `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10} ${Math.round(w * 10) / 10} ${Math.round(h * 10) / 10}`;
}

export function getClassShortLabel(carClass: 'Hypercar' | 'LMP2' | 'LMGT3'): 'HY' | 'P2' | 'GT3' {
  if (carClass === 'LMP2') return 'P2';
  if (carClass === 'LMGT3') return 'GT3';
  return 'HY';
}

export function buildPitWallCarRoster(
  frame: TelemetryFrame,
  track: TrackProfile,
  playerCar: CarProfile
): PitWallTrackedCar[] {
  const playerPose = interpolateTrackPose(track, frame.lapDistPct);
  const playerInPits = Boolean(frame.inPitOrGarage);
  const playerLocation = describeTrackLocation(track, frame.lapDistPct, {
    inPits: playerInPits,
    speedKmh: frame.speedKmh,
  });

  const playerEntry: PitWallTrackedCar = {
    id: 'player',
    isPlayer: true,
    carNumber: 'YOU',
    driverName: 'You (Player)',
    carName: frame.carName || playerCar.name,
    carClass: playerCar.carClass,
    classShort: getClassShortLabel(playerCar.carClass),
    ...(frame.playerPosition !== undefined ? { position: frame.playerPosition } : {}),
    lapsCompleted: Math.max(0, frame.lapNumber - 1),
    lapDistPct: frame.lapDistPct,
    speedKmh: Math.round(frame.speedKmh),
    gapSeconds: 0,
    distanceMeters: 0,
    closingSpeedKmh: 0,
    lateralSide: 'center',
    isAlongside: false,
    inPits: playerInPits,
    ...(frame.posX !== undefined ? { posX: frame.posX } : {}),
    ...(frame.posZ !== undefined ? { posZ: frame.posZ } : {}),
    pose: playerPose,
    location: playerLocation,
    status: playerInPits ? 'pit' : 'player',
    statusLabel: playerInPits ? 'Pit / Garage' : 'You · On Track',
  };

  const oppEntries: PitWallTrackedCar[] = (frame.opponents ?? []).map((opp) => {
    const inPits = Boolean(opp.inPits);
    const isSlow = !inPits && opp.speedKmh < 45;
    const isThreat =
      !inPits &&
      opp.distanceMeters < 0 &&
      opp.distanceMeters >= -48 &&
      opp.closingSpeedKmh >= 5;
    const isAttack =
      !inPits &&
      opp.distanceMeters > 0 &&
      opp.distanceMeters <= 46 &&
      opp.closingSpeedKmh >= 4;

    let status: TrackCarStatusKind = 'track';
    let statusLabel = opp.distanceMeters >= 0 ? 'Ahead' : 'Behind';

    if (inPits) {
      status = 'pit';
      statusLabel = 'Pit Lane';
    } else if (opp.isAlongside) {
      status = 'alongside';
      statusLabel = `Alongside (${opp.lateralSide.toUpperCase()})`;
    } else if (isSlow) {
      status = 'slow';
      statusLabel = 'Slow / Hazard';
    } else if (isThreat) {
      status = 'threat';
      statusLabel = 'Attacking Behind';
    } else if (isAttack) {
      status = 'attack';
      statusLabel = 'Attack Window';
    }

    return {
      id: opp.id,
      isPlayer: false,
      carNumber: opp.carNumber,
      driverName: opp.driverName,
      carName: opp.carName,
      carClass: opp.carClass,
      classShort: getClassShortLabel(opp.carClass),
      ...(opp.position !== undefined ? { position: opp.position } : {}),
      ...(opp.lapsCompleted !== undefined ? { lapsCompleted: opp.lapsCompleted } : {}),
      lapDistPct: opp.lapDistPct,
      speedKmh: Math.round(opp.speedKmh),
      gapSeconds: opp.gapSeconds,
      distanceMeters: opp.distanceMeters,
      closingSpeedKmh: opp.closingSpeedKmh,
      lateralSide: opp.lateralSide,
      isAlongside: opp.isAlongside,
      inPits,
      ...(opp.posX !== undefined ? { posX: opp.posX } : {}),
      ...(opp.posZ !== undefined ? { posZ: opp.posZ } : {}),
      pose: interpolateTrackPose(track, opp.lapDistPct),
      location: describeTrackLocation(track, opp.lapDistPct, {
        inPits,
        speedKmh: opp.speedKmh,
        explicitSector: opp.sector,
      }),
      status,
      statusLabel,
    };
  });

  // Sort opponents by proximity to player (closest first) after player
  oppEntries.sort((a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters));

  return [playerEntry, ...oppEntries];
}

export interface CarLabelLayout {
  carId: string;
  labelText: string;
  x: number;
  y: number;
  textAnchor: 'middle' | 'start' | 'end';
  fontSize: number;
  showLeader: boolean;
  leaderX1: number;
  leaderY1: number;
  leaderX2: number;
  leaderY2: number;
}

interface LabelBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function boxesOverlap(a: LabelBox, b: LabelBox, pad = 2): boolean {
  return !(
    a.x2 + pad <= b.x1 ||
    a.x1 >= b.x2 + pad ||
    a.y2 + pad <= b.y1 ||
    a.y1 >= b.y2 + pad
  );
}

function boxOverlapArea(a: LabelBox, b: LabelBox): number {
  const ox = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const oy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return ox * oy;
}

function makeLabelBox(
  cx: number,
  cy: number,
  w: number,
  h: number,
  anchor: 'middle' | 'start' | 'end'
): LabelBox {
  const x1 = anchor === 'middle' ? cx - w / 2 : anchor === 'start' ? cx : cx - w;
  const x2 = x1 + w;
  return {
    x1,
    x2,
    y1: cy - h / 2,
    y2: cy + h / 2,
  };
}

export function computeCarLabelLayouts(
  roster: PitWallTrackedCar[],
  viewBox: string,
  markerScale = 1,
  selectedCarId?: string
): Map<string, CarLabelLayout> {
  const bounds = parseSvgViewBox(viewBox);
  const padX = 8 * markerScale;
  const padY = 8 * markerScale;

  // Higher priority cars keep closer, tighter anchor positions
  const prioritized = [...roster].sort((a, b) => {
    const score = (c: PitWallTrackedCar): number => {
      if (c.isPlayer) return 0;
      if (c.id === selectedCarId) return 1;
      if (c.status === 'alongside' || c.status === 'slow') return 2;
      if (c.status === 'threat' || c.status === 'attack') return 3;
      if (!c.inPits) return 4;
      return 5;
    };
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    return Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters);
  });

  // Reserve a small core around every car chevron so labels don't sit on top of other chevrons
  const chevronBoxes: Array<{ id: string; box: LabelBox }> = roster.map((car) => {
    const r = (car.isPlayer ? 10.5 : 8.5) * markerScale;
    return {
      id: car.id,
      box: {
        x1: car.pose.x - r,
        x2: car.pose.x + r,
        y1: car.pose.y - r,
        y2: car.pose.y + r,
      },
    };
  });

  const placedBoxes: LabelBox[] = [];
  const layouts = new Map<string, CarLabelLayout>();

  const radii = [16, 28, 42, 58, 76];
  const baseAnglesDeg = [-90, 90, 0, 180, -45, 45, -135, 135, -20, 20, -160, 160];
  const playerAnglesDeg = [90, -90, 0, 180, 45, -45, 135, -135, 20, -20, 160, -160];

  for (const car of prioritized) {
    const labelText = car.isPlayer
      ? car.position
        ? `P${car.position} YOU`
        : 'YOU'
      : car.inPits
        ? `#${car.carNumber} PIT`
        : `#${car.carNumber}`;

    const fontSize = (car.isPlayer ? 12 : 11.5) * markerScale;
    const boxW = (labelText.length * 6.8 + 6) * markerScale;
    const boxH = 14 * markerScale;
    const angles = car.isPlayer ? playerAnglesDeg : baseAnglesDeg;

    let bestCandidate: {
      x: number;
      y: number;
      anchor: 'middle' | 'start' | 'end';
      box: LabelBox;
      penalty: number;
    } | null = null;

    let foundClean = false;

    for (const radiusUnit of radii) {
      const r = radiusUnit * markerScale;
      for (const deg of angles) {
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        let anchor: 'middle' | 'start' | 'end' = 'middle';
        if (cos > 0.38) anchor = 'start';
        else if (cos < -0.38) anchor = 'end';

        let lx = car.pose.x + cos * r;
        let ly = car.pose.y + sin * r;

        // Clamp inside SVG viewBox bounds
        const minLx =
          anchor === 'middle'
            ? bounds.x + padX + boxW / 2
            : anchor === 'start'
              ? bounds.x + padX
              : bounds.x + padX + boxW;
        const maxLx =
          anchor === 'middle'
            ? bounds.x + bounds.w - padX - boxW / 2
            : anchor === 'start'
              ? bounds.x + bounds.w - padX - boxW
              : bounds.x + bounds.w - padX;

        if (minLx <= maxLx) {
          lx = Math.max(minLx, Math.min(maxLx, lx));
        }
        ly = Math.max(bounds.y + padY + boxH / 2, Math.min(bounds.y + bounds.h - padY - boxH / 2, ly));

        const box = makeLabelBox(lx, ly, boxW, boxH, anchor);

        let penalty = 0;
        for (const existing of placedBoxes) {
          if (boxesOverlap(box, existing, 2.5 * markerScale)) {
            penalty += boxOverlapArea(box, existing) + 25;
          }
        }
        for (const chev of chevronBoxes) {
          if (boxesOverlap(box, chev.box, 1 * markerScale)) {
            penalty += boxOverlapArea(box, chev.box) + (chev.id === car.id ? 60 : 15);
          }
        }

        if (penalty === 0) {
          bestCandidate = { x: lx, y: ly, anchor, box, penalty: 0 };
          foundClean = true;
          break;
        }

        // Tie-break slightly toward closer radii
        const scoreWithDist = penalty + radiusUnit * 0.15;
        if (!bestCandidate || scoreWithDist < bestCandidate.penalty) {
          bestCandidate = { x: lx, y: ly, anchor, box, penalty: scoreWithDist };
        }
      }
      if (foundClean) break;
    }

    const chosen = bestCandidate ?? {
      x: car.pose.x,
      y: car.pose.y - 16 * markerScale,
      anchor: 'middle' as const,
      box: makeLabelBox(car.pose.x, car.pose.y - 16 * markerScale, boxW, boxH, 'middle'),
      penalty: 0,
    };

    placedBoxes.push(chosen.box);

    // Closest point on label box to car center for clean leader line
    const nearestX = Math.max(chosen.box.x1, Math.min(chosen.box.x2, car.pose.x));
    const nearestY = Math.max(chosen.box.y1, Math.min(chosen.box.y2, car.pose.y));
    const distToBox = Math.hypot(nearestX - car.pose.x, nearestY - car.pose.y);

    layouts.set(car.id, {
      carId: car.id,
      labelText,
      x: Math.round(chosen.x * 10) / 10,
      y: Math.round(chosen.y * 10) / 10,
      textAnchor: chosen.anchor,
      fontSize,
      showLeader: distToBox > 14 * markerScale,
      leaderX1: Math.round(car.pose.x * 10) / 10,
      leaderY1: Math.round(car.pose.y * 10) / 10,
      leaderX2: Math.round(nearestX * 10) / 10,
      leaderY2: Math.round(nearestY * 10) / 10,
    });
  }

  return layouts;
}
