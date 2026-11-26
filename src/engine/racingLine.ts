import type {
  CarProfile,
  CompactTelemetryPoint,
  CornerArchetype,
  CornerComparison,
  CornerDefinition,
  DriverProfile,
  GreenLineMode,
  GreenLineSource,
  ReferenceSample,
  TrackProfile,
} from '../types/telemetry';
import {
  computeLearnedGreenLineCalibration,
  makeCornerMemoryKey,
} from './driverLearning';

export interface CornerActionMarker {
  id: string;
  kind:
    | 'pro_brake'
    | 'user_brake'
    | 'pro_apex'
    | 'user_apex'
    | 'pro_throttle'
    | 'user_throttle';
  line: 'green' | 'red';
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  pct: number;
  shortLabel: string;
  detailLabel: string;
}

export interface CornerGateLine {
  id: string;
  line: 'green' | 'red';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CornerPedalPoint {
  relPct: number; // 0..1 across corner window
  userBrake: number; // 0..1
  proBrake: number; // 0..1
  userThrottle: number; // 0..1
  proThrottle: number; // 0..1
  userSpeedKmh: number;
  proSpeedKmh: number;
}

export interface CornerDetailAnalysis {
  corner: CornerDefinition;
  comparison: CornerComparison | null;
  turnDirection: 'left' | 'right';
  cornerArchetype: CornerArchetype;
  greenLineSource: GreenLineSource;
  greenLineTitle: string;
  greenLineReason: string;
  zoomViewBox: string;
  trackHalfWidth: number;
  asphaltPath: string;
  roadPolygonPath: string;
  leftEdgePath: string;
  rightEdgePath: string;
  kerbPaths: string[];
  centerlinePath: string;
  proLinePath: string; // Green (Pro / Learned / Proven Best)
  userLinePath: string; // Red (Driver actual)
  proPoints: Array<{ x: number; y: number }>;
  userPoints: Array<{ x: number; y: number }>;
  gateLines: CornerGateLine[];
  markers: CornerActionMarker[];
  changesSummary: {
    brakingAction: string;
    lineApexAction: string;
    throttleAction: string;
    setupHint?: string;
    timeGainSec: number;
  };
  pedalComparison: CornerPedalPoint[];
  traceSource?: 'game' | 'schematic';
}

function wrapPct(pct: number): number {
  return ((pct % 1) + 1) % 1;
}

/**
 * Computes signed circular progress difference (b - a) in [-0.5, 0.5].
 */
function signedPctDiff(a: number, b: number): number {
  let d = wrapPct(b) - wrapPct(a);
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/**
 * Smooth Catmull-Rom spline interpolation along track.pathPoints at any [0, 1) lap distance.
 * Eliminates piecewise-linear polygon kinks when zoomed into individual corners.
 */
export function interpolateTrackPointPct(
  track: TrackProfile,
  lapDistPct: number
): { x: number; y: number } {
  const pts = track.pathPoints;
  const n = pts?.length ?? 0;
  if (n === 0) return { x: 500, y: 270 };
  if (n < 4) return { x: pts[0].x, y: pts[0].y };

  const pct = wrapPct(lapDistPct);

  let segIdx = 0;
  let localT = 0;
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const nextPct = i === n - 1 ? 1.0 : next.pct;
    if (pct >= cur.pct && pct <= nextPct) {
      segIdx = i;
      const span = Math.max(0.0001, nextPct - cur.pct);
      localT = Math.max(0, Math.min(1, (pct - cur.pct) / span));
      break;
    }
  }

  const p0 = pts[(segIdx - 1 + n) % n];
  const p1 = pts[segIdx];
  const p2 = pts[(segIdx + 1) % n];
  const p3 = pts[(segIdx + 2) % n];

  const t = localT;
  const t2 = t * t;
  const t3 = t2 * t;

  const x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return { x, y };
}

function sampleSeriesAtPct<T extends { pct?: number; lapDistPct?: number }>(
  items: T[],
  pct: number
): T | null {
  if (!items || items.length === 0) return null;
  let best = items[0];
  let bestDist = Infinity;
  const target = wrapPct(pct);
  for (const item of items) {
    const p = item.pct ?? item.lapDistPct ?? 0;
    const dist = Math.abs(signedPctDiff(target, p));
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}, ${xc.toFixed(2)} ${yc.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
}

function buildPolylinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Classifies corner geometry from curvature profile + apex speed into a
 * motorsport corner archetype: hairpin (late-apex V-line), chicane (exit-priority S-bend),
 * sweeper (high-minimum-speed geometric arc), or medium corner.
 */
export function classifyCornerArchetype(
  smoothKappa: number[],
  corner: CornerDefinition
): CornerArchetype {
  let posPeak = 0;
  let negPeak = 0;
  for (const k of smoothKappa) {
    if (k > posPeak) posPeak = k;
    if (-k > negPeak) negPeak = -k;
  }
  const maxAbsK = Math.max(0.08, posPeak, negPeak);
  const isChicane =
    (posPeak >= maxAbsK * 0.34 && negPeak >= maxAbsK * 0.34) ||
    /chicane|esses|s-curves|magotts|beckett|dunlop|bouchon/i.test(corner.name);

  if (isChicane) return 'chicane';
  if (corner.targetApexSpeedKmh <= 94 || maxAbsK >= 0.48) return 'hairpin';
  if (corner.targetApexSpeedKmh >= 152 && maxAbsK < 0.36) return 'sweeper';
  return 'medium';
}

/**
 * Biharmonic minimum-curvature + exit-priority racing-line solver.
 * Solves lateral offsets `alpha[i] in [-maxLat, +maxLat]` along centerline normals:
 * - Minimizes weighted squared path curvature (true widest effective corner radius)
 * - Weights exit curvature higher for hairpins/medium/chicanes to naturally shift into a late-apex V-line
 * - Enforces straight-line outside braking discipline prior to turn-in on heavy braking corners
 * - Scales kerb margin and exit-squaring smoothly when calibrated for player learning
 */
export function solveRealisticRacingLine(params: {
  smoothKappa: number[];
  rels: number[];
  brakeRel: number;
  apexRel: number;
  windowTotalPct: number;
  primaryInsideSign: number;
  archetype: CornerArchetype;
  maxLat?: number;
  exitSquareBias?: number;
}): number[] {
  const {
    smoothKappa,
    rels,
    brakeRel,
    apexRel,
    windowTotalPct,
    primaryInsideSign,
    archetype,
    maxLat = 0.85,
    exitSquareBias = 0,
  } = params;

  const n = smoothKappa.length;
  const maxAbsK = Math.max(0.08, ...smoothKappa.map((k) => Math.abs(k)));
  const hasRealCurvature = Math.max(...smoothKappa.map((k) => Math.abs(k))) >= 0.02;

  // Fallback synthetic curvature bell when geometry has minimal bend
  const kNorm = smoothKappa.map((k, idx) => {
    if (hasRealCurvature) return k / maxAbsK;
    const bell = Math.exp(
      -Math.pow((rels[idx] - apexRel) / Math.max(0.008, windowTotalPct * 0.22), 2)
    );
    return primaryInsideSign * bell;
  });

  // Curvature weights by corner archetype (higher exit weight -> authentic late apex & straighter exit drive)
  const apexRatio = clamp(apexRel / Math.max(0.001, windowTotalPct), 0.25, 0.75);
  const wStart =
    archetype === 'hairpin'
      ? 0.72
      : archetype === 'chicane'
        ? 0.78
        : archetype === 'sweeper'
          ? 0.96
          : 0.85;
  const wEnd =
    (archetype === 'hairpin'
      ? 1.46
      : archetype === 'chicane'
        ? 1.38
        : archetype === 'sweeper'
          ? 1.06
          : 1.24) + exitSquareBias * 1.4;

  const weights = rels.map((r) => {
    const u = clamp(r / Math.max(0.001, windowTotalPct), 0, 1);
    const shaped = u < apexRatio ? (u / apexRatio) * 0.42 : 0.42 + ((u - apexRatio) / (1 - apexRatio)) * 0.58;
    return wStart + (wEnd - wStart) * shaped;
  });

  // Biharmonic minimum-curvature gradient relaxation with 4-step curvature operator
  const stride = Math.max(3, Math.round(n / 18));
  const curvGain = 0.92;
  const smoothReg = 0.26;
  const lr = 0.036;
  const iterations = 60;

  let alpha = kNorm.map((k) => clamp(k * maxLat * 0.45, -maxLat, maxLat));
  const kappaNet = new Array<number>(n).fill(0);

  // Outside straight-line braking target before turn-in (holds outside edge cleanly during peak braking)
  const turnInEndRel =
    archetype === 'sweeper'
      ? brakeRel
      : Math.min(apexRel * 0.84, brakeRel + windowTotalPct * 0.08);
  const brakePriorWeight =
    archetype === 'hairpin' ? 0.14 : archetype === 'medium' ? 0.10 : archetype === 'chicane' ? 0.07 : 0.02;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      const iL = Math.max(0, i - stride);
      const iR = Math.min(n - 1, i + stride);
      const d2 = alpha[iR] - 2 * alpha[i] + alpha[iL];
      kappaNet[i] = kNorm[i] + curvGain * d2;
    }

    const next = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let gradCurv = -2 * weights[i] * kappaNet[i];
      if (i - stride >= 0) {
        gradCurv += weights[i - stride] * kappaNet[i - stride];
      }
      if (i + stride < n) {
        gradCurv += weights[i + stride] * kappaNet[i + stride];
      }
      gradCurv *= 2 * curvGain;

      const prevA = alpha[Math.max(0, i - 1)];
      const nextA = alpha[Math.min(n - 1, i + 1)];
      const gradSmooth = -2 * smoothReg * (prevA - 2 * alpha[i] + nextA);

      // Gently guide pre-turn-in braking zone to stay straight near the outside edge
      let gradBrakeAnchor = 0;
      if (rels[i] <= turnInEndRel) {
        const entryRamp = 1 - smoothstep(brakeRel * 0.7, turnInEndRel + 0.002, rels[i]);
        const targetOutside = -primaryInsideSign * maxLat * 0.88;
        gradBrakeAnchor = 2 * brakePriorWeight * entryRamp * (alpha[i] - targetOutside);
      }

      next[i] = clamp(alpha[i] - lr * (gradCurv + gradSmooth + gradBrakeAnchor), -maxLat, maxLat);
    }
    alpha = next;
  }

  // Final fluid smoothing pass preserving kerb peaks
  return alpha.map((_, idx) => {
    let sum = 0;
    let wSum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = clamp(idx + k, 0, n - 1);
      const w = 4 - Math.abs(k);
      sum += alpha[j] * w;
      wSum += w;
    }
    return clamp(sum / wSum, -maxLat, maxLat);
  });
}

function interpolateWorldPointAtPct(
  pts: Array<{ pct: number; x: number; y: number }>,
  targetPct: number
): { x: number; y: number } | null {
  if (pts.length < 2) return null;
  let best = pts[0];
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(signedPctDiff(targetPct, p.pct));
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return bestD <= 0.03 ? { x: best.x, y: best.y } : null;
}

/**
 * Generates accurate zoomed corner tarmac geometry (boundary edges + kerbs),
 * physics-solved Green racing line (Pro Optimal, Player's Proven Best Pass, or
 * Driver-Learned Adaptive Target) vs Red (Driver actual), perpendicular brake gates,
 * and actionable coaching directives for Race Reports.
 */
export function buildCornerLineAnalysis(params: {
  track: TrackProfile;
  car: CarProfile;
  corner: CornerDefinition;
  comparison?: CornerComparison | null;
  referenceSamples: ReferenceSample[];
  driverFrames?: CompactTelemetryPoint[];
  driverProfile?: DriverProfile;
  bestCornerPassFrames?: CompactTelemetryPoint[];
  bestCornerPassTimeSec?: number;
  greenLineMode?: GreenLineMode;
  language?: 'en';
}): CornerDetailAnalysis {
  const {
    track,
    car,
    corner,
    comparison = null,
    referenceSamples,
    driverFrames = [],
    driverProfile,
    bestCornerPassFrames,
    bestCornerPassTimeSec,
    greenLineMode = 'auto',
  } = params;

  const trackLenMeters = track.lengthKm * 1000;
  const rawSpan = Math.max(0.022, signedPctDiff(corner.startPct, corner.exitPct));
  const leadPad = Math.min(0.022, Math.max(0.013, rawSpan * 0.42));
  const tailPad = Math.min(0.022, Math.max(0.013, rawSpan * 0.42));
  const windowTotalPct = rawSpan + leadPad + tailPad;
  const windowStartPct = wrapPct(corner.startPct - leadPad);

  const relFromStart = (pct: number) => {
    const d = wrapPct(pct - windowStartPct);
    return clamp(d, 0, windowTotalPct);
  };

  const brakeRel = relFromStart(corner.brakeMarkerPct);
  const apexRel = relFromStart(corner.apexPct);

  // High-resolution resampling: prefer actual game world coordinates (posX, -posZ) when >= 5 frames fall in the corner window
  const rawGamePts = driverFrames
    .filter((f) => Number.isFinite(f.posX) && Number.isFinite(f.posZ) && Number.isFinite(f.lapDistPct))
    .map((f) => ({ rel: signedPctDiff(windowStartPct, f.lapDistPct), x: f.posX!, y: -f.posZ! }))
    .filter((p) => p.rel >= 0 && p.rel <= windowTotalPct)
    .sort((a, b) => a.rel - b.rel);

  const usingGameTrace = rawGamePts.length >= 5;
  const sampleCount = 78;
  const initialCenterPts: Array<{ rel: number; pct: number; x: number; y: number }> = [];

  if (usingGameTrace) {
    const cumLen = [0];
    for (let i = 1; i < rawGamePts.length; i++) {
      cumLen.push(
        cumLen[i - 1] +
          Math.hypot(rawGamePts[i].x - rawGamePts[i - 1].x, rawGamePts[i].y - rawGamePts[i - 1].y)
      );
    }
    const totalLen = cumLen[cumLen.length - 1] || 1;
    for (let i = 0; i < sampleCount; i++) {
      const targetLen = (i / (sampleCount - 1)) * totalLen;
      let seg = 1;
      while (seg < cumLen.length - 1 && cumLen[seg] < targetLen) seg++;
      const segLen = cumLen[seg] - cumLen[seg - 1] || 1;
      const frac = clamp((targetLen - cumLen[seg - 1]) / segLen, 0, 1);
      const p0 = rawGamePts[seg - 1];
      const p1 = rawGamePts[seg];
      const rel = p0.rel + (p1.rel - p0.rel) * frac;
      initialCenterPts.push({
        rel,
        pct: wrapPct(windowStartPct + rel),
        x: p0.x + (p1.x - p0.x) * frac,
        y: p0.y + (p1.y - p0.y) * frac,
      });
    }
  } else {
    for (let i = 0; i < sampleCount; i++) {
      const t = i / (sampleCount - 1);
      const rel = t * windowTotalPct;
      const pct = wrapPct(windowStartPct + rel);
      const pt = interpolateTrackPointPct(track, pct);
      initialCenterPts.push({ rel, pct, x: pt.x, y: pt.y });
    }
  }

  let rawMinX = Infinity;
  let rawMaxX = -Infinity;
  let rawMinY = Infinity;
  let rawMaxY = -Infinity;
  for (const p of initialCenterPts) {
    if (p.x < rawMinX) rawMinX = p.x;
    if (p.x > rawMaxX) rawMaxX = p.x;
    if (p.y < rawMinY) rawMinY = p.y;
    if (p.y > rawMaxY) rawMaxY = p.y;
  }

  const rawW = Math.max(42, rawMaxX - rawMinX);
  const rawH = Math.max(42, rawMaxY - rawMinY);
  const span = Math.max(rawW, rawH);
  // 6m fixed tarmac half-width when rendering real world meter coordinates, else proportional to SVG span
  const trackHalfWidth = usingGameTrace ? 6 : clamp(span * 0.048, 2.5, 8.2);

  // Compute unit tangents and normals along path
  const tangents = initialCenterPts.map((_, idx) => {
    const pPrev = initialCenterPts[Math.max(0, idx - 1)];
    const pNext = initialCenterPts[Math.min(initialCenterPts.length - 1, idx + 1)];
    const dx = pNext.x - pPrev.x;
    const dy = pNext.y - pPrev.y;
    const len = Math.hypot(dx, dy) || 1;
    return { tx: dx / len, ty: dy / len };
  });

  const leftNormals = tangents.map(({ tx, ty }) => ({
    nx: -ty,
    ny: tx,
  }));

  // Compute local signed curvature kappa[i] using a 4-sample chord
  const rawKappa = initialCenterPts.map((_, idx) => {
    const i0 = Math.max(0, idx - 3);
    const i1 = Math.min(initialCenterPts.length - 1, idx + 3);
    const t0 = tangents[i0];
    const t1 = tangents[i1];
    return t0.tx * t1.ty - t0.ty * t1.tx;
  });

  // Smooth curvature with a 5-point kernel
  const smoothKappa = rawKappa.map((_, idx) => {
    let sum = 0;
    let wSum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = clamp(idx + k, 0, rawKappa.length - 1);
      const w = 4 - Math.abs(k);
      sum += rawKappa[j] * w;
      wSum += w;
    }
    return sum / wSum;
  });

  // Primary turn direction & corner archetype
  const apexSampleIdx = Math.round((apexRel / Math.max(0.0001, windowTotalPct)) * (sampleCount - 1));
  const apexKappa = smoothKappa[clamp(apexSampleIdx, 0, sampleCount - 1)] || 0;
  const primaryInsideSign =
    Math.abs(apexKappa) > 0.01 ? (apexKappa >= 0 ? 1 : -1) : corner.number % 2 === 0 ? 1 : -1;
  const turnDirection: 'left' | 'right' = primaryInsideSign > 0 ? 'right' : 'left';
  const cornerArchetype = classifyCornerArchetype(smoothKappa, corner);
  const maxAbsK = Math.max(0.08, ...smoothKappa.map((k) => Math.abs(k)));

  // Extract telemetry mistake profile
  const brakeDeltaM = comparison?.brakingDeltaMeters ?? 0;
  const apexSpeedDelta = comparison?.minApexSpeedDeltaKmh ?? 0;
  const exitSpeedDelta = comparison?.exitSpeedDeltaKmh ?? 0;
  const timeLostSec = comparison?.timeLostSec ?? 0;
  const hasLockup = Boolean(comparison && /lockup/i.test(comparison.primaryIssue));
  const isLateBrake = brakeDeltaM >= 4 || hasLockup;
  const isEarlyBrake = brakeDeltaM <= -5;
  const isSlowExit = exitSpeedDelta <= -3;

  // Check if we have a proven faster corner pass (either from current report or learned profile memory)
  const memPass = driverProfile?.cornerMemory?.[makeCornerMemoryKey(track.id, corner.id)];
  const candidateBestFrames =
    bestCornerPassFrames && bestCornerPassFrames.length >= 5
      ? bestCornerPassFrames
      : memPass?.bestPassFrames && memPass.bestPassFrames.length >= 5
        ? memPass.bestPassFrames
        : undefined;

  const bestPassGamePts = (candidateBestFrames ?? [])
    .filter((f) => Number.isFinite(f.posX) && Number.isFinite(f.posZ) && Number.isFinite(f.lapDistPct))
    .map((f) => ({ pct: f.lapDistPct, x: f.posX!, y: -f.posZ! }));
  const hasWorldBestPass = usingGameTrace && bestPassGamePts.length >= 5;
  const hasAnyProvenPass = Boolean(candidateBestFrames && candidateBestFrames.length >= 5);

  const calibration = computeLearnedGreenLineCalibration({
    profile: driverProfile,
    corner,
    trackId: track.id,
    comparison,
  });

  // Resolve active Green line strategy based on mode + available player data
  let greenLineSource: GreenLineSource = 'pro';
  if (greenLineMode === 'pro') {
    greenLineSource = 'pro';
  } else if (greenLineMode === 'learned') {
    greenLineSource = hasWorldBestPass ? 'proven_best' : 'learned';
  } else {
    // 'auto' picks best available evidence: player's proven faster pass -> adaptive learned line -> full Pro
    if (hasWorldBestPass || (bestCornerPassFrames && bestCornerPassFrames.length >= 5)) {
      greenLineSource = 'proven_best';
    } else if (
      driverProfile &&
      (driverProfile.skillTier !== 'pro' ||
        (memPass && memPass.mastery < 0.85) ||
        calibration.brakeEarlierMeters >= 3)
    ) {
      greenLineSource = 'learned';
    } else {
      greenLineSource = 'pro';
    }
  }

  // Solve true Pro Optimal line with biharmonic minimum-curvature + exit-priority physics
  const rels = initialCenterPts.map((p) => p.rel);
  const pureProLatFactors = solveRealisticRacingLine({
    smoothKappa,
    rels,
    brakeRel,
    apexRel,
    windowTotalPct,
    primaryInsideSign,
    archetype: cornerArchetype,
    maxLat: 0.85,
    exitSquareBias: 0,
  });

  // Solve personalized Learned line when active (calibrates kerb margin & exit-squaring from driver data)
  const learnedLatFactors =
    greenLineSource === 'learned'
      ? solveRealisticRacingLine({
          smoothKappa,
          rels,
          brakeRel: Math.max(0, brakeRel - calibration.brakeEarlierMeters / Math.max(1000, trackLenMeters)),
          apexRel,
          windowTotalPct,
          primaryInsideSign,
          archetype: cornerArchetype,
          maxLat: clamp(0.85 * calibration.lateralMarginScale, 0.62, 0.85),
          exitSquareBias: calibration.exitSquareBias,
        })
      : pureProLatFactors;

  let proLatFactors = greenLineSource === 'learned' ? learnedLatFactors : pureProLatFactors;

  // Compute Red Driver Line relative to true road centerline in [-1, +1] ribbon coordinates
  let userLatFactors = pureProLatFactors.map((proF, idx) => {
    const rel = rels[idx];
    const localK = smoothKappa[idx];
    const localSign =
      Math.abs(localK) > 0.03 ? (localK >= 0 ? 1 : -1) : primaryInsideSign;

    if (isLateBrake) {
      const entryPhase = smoothstep(0, brakeRel + 0.003, rel);
      const apexPush =
        Math.exp(-Math.pow((rel - (apexRel + 0.002)) / Math.max(0.008, windowTotalPct * 0.22), 2)) *
        (hasLockup ? 0.86 : 0.68);
      const exitSettle = smoothstep(apexRel, windowTotalPct, rel);
      const shifted = proF * (0.58 + 0.24 * entryPhase) - localSign * apexPush + localSign * 0.14 * exitSettle;
      return clamp(shifted, -0.84, 0.84);
    }

    if (isEarlyBrake) {
      const earlyDive =
        Math.exp(-Math.pow((rel - apexRel * 0.72) / Math.max(0.008, windowTotalPct * 0.18), 2)) * 0.48;
      const lateWash = smoothstep(apexRel * 0.9, windowTotalPct, rel) * 0.35;
      return clamp(proF * 0.82 + localSign * earlyDive - localSign * lateWash, -0.84, 0.84);
    }

    if (isSlowExit) {
      const pinchBell =
        smoothstep(apexRel * 0.88, Math.min(windowTotalPct, apexRel + windowTotalPct * 0.35), rel) *
        (1 - 0.35 * smoothstep(apexRel + windowTotalPct * 0.35, windowTotalPct, rel));
      return clamp(proF + localSign * 0.50 * pinchBell, -0.82, 0.82);
    }

    return clamp(proF * 0.76, -0.78, 0.78);
  });

  // When rendering real-world posX/posZ telemetry coordinates:
  // Preserve Red directly on the driver's exact world points, reconstruct the 12m tarmac centerline
  // around the corridor, and solve Green along either the player's Proven Best world pass or true curvature Pro line!
  let centerPts = initialCenterPts;
  if (usingGameTrace) {
    if (greenLineSource === 'proven_best' && hasWorldBestPass) {
      // Plot Green directly on the driver's own proven faster world coordinates!
      proLatFactors = initialCenterPts.map((cp, idx) => {
        const bestPt = interpolateWorldPointAtPct(bestPassGamePts, cp.pct);
        if (!bestPt) return 0;
        const dx = bestPt.x - cp.x;
        const dy = bestPt.y - cp.y;
        const projMeters = dx * leftNormals[idx].nx + dy * leftNormals[idx].ny;
        return clamp(projMeters, -trackHalfWidth * 0.88, trackHalfWidth * 0.88) / trackHalfWidth;
      });
      userLatFactors = new Array<number>(sampleCount).fill(0);
    } else {
      // Reconstruct true road centerline so Red stays locked at exact GPS coords while Green follows real curvature Pro/Learned arc
      centerPts = initialCenterPts.map((cp, idx) => {
        const userOffMeters = userLatFactors[idx] * trackHalfWidth;
        return {
          ...cp,
          x: cp.x - leftNormals[idx].nx * userOffMeters,
          y: cp.y - leftNormals[idx].ny * userOffMeters,
        };
      });
    }
  }

  // Compute bounding box after final centerline alignment
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of centerPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // Build track boundary edges & closed tarmac polygon
  const leftEdgePts = centerPts.map((p, idx) => ({
    x: p.x + leftNormals[idx].nx * trackHalfWidth,
    y: p.y + leftNormals[idx].ny * trackHalfWidth,
  }));
  const rightEdgePts = centerPts.map((p, idx) => ({
    x: p.x - leftNormals[idx].nx * trackHalfWidth,
    y: p.y - leftNormals[idx].ny * trackHalfWidth,
  }));

  const roadPolygonPath =
    leftEdgePts.length > 1
      ? `${buildPolylinePath(leftEdgePts)} ${[...rightEdgePts]
          .reverse()
          .map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
          .join(' ')} Z`
      : '';

  const leftEdgePath = buildSmoothPath(leftEdgePts);
  const rightEdgePath = buildSmoothPath(rightEdgePts);

  // Extract inside apex kerb strips wherever curvature exceeds 42% of peak
  const kerbPaths: string[] = [];
  let currentKerb: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < centerPts.length; i++) {
    const k = smoothKappa[i];
    if (Math.abs(k) >= maxAbsK * 0.42) {
      const sign = k >= 0 ? 1 : -1;
      currentKerb.push({
        x: centerPts[i].x + leftNormals[i].nx * (sign * trackHalfWidth * 0.96),
        y: centerPts[i].y + leftNormals[i].ny * (sign * trackHalfWidth * 0.96),
      });
    } else if (currentKerb.length >= 2) {
      kerbPaths.push(buildSmoothPath(currentKerb));
      currentKerb = [];
    } else {
      currentKerb = [];
    }
  }
  if (currentKerb.length >= 2) {
    kerbPaths.push(buildSmoothPath(currentKerb));
  }

  const proPts = centerPts.map((p, idx) => {
    const off = proLatFactors[idx] * trackHalfWidth;
    return {
      rel: p.rel,
      pct: p.pct,
      x: p.x + leftNormals[idx].nx * off,
      y: p.y + leftNormals[idx].ny * off,
    };
  });

  const userPts = centerPts.map((p, idx) => {
    const off = userLatFactors[idx] * trackHalfWidth;
    return {
      rel: p.rel,
      pct: p.pct,
      x: p.x + leftNormals[idx].nx * off,
      y: p.y + leftNormals[idx].ny * off,
    };
  });

  const anchorAtRel = (
    pts: Array<{ rel: number; x: number; y: number }>,
    targetRel: number
  ) => {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].rel - targetRel);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    const n = leftNormals[bestIdx] ?? { nx: 0, ny: -1 };
    const cp = centerPts[bestIdx] ?? pts[bestIdx];
    const k = smoothKappa[bestIdx] || 0;
    const localSign = Math.abs(k) > 0.02 ? (k >= 0 ? 1 : -1) : primaryInsideSign;
    return { pt: pts[bestIdx], cp, nx: n.nx, ny: n.ny, localSign };
  };

  // Find actual inside kerb apex point along the solved Green line (respects late apex on hairpins!)
  const apexSearchStart = Math.max(4, Math.floor(sampleCount * 0.22));
  const apexSearchEnd = Math.min(sampleCount - 4, Math.ceil(sampleCount * 0.78));
  let solvedApexIdx = clamp(apexSampleIdx, 0, sampleCount - 1);
  let bestApexProjection = -Infinity;
  for (let i = apexSearchStart; i <= apexSearchEnd; i++) {
    const score = proLatFactors[i] * primaryInsideSign;
    if (score > bestApexProjection) {
      bestApexProjection = score;
      solvedApexIdx = i;
    }
  }
  const solvedApexRel =
    greenLineSource === 'proven_best'
      ? apexRel
      : centerPts[solvedApexIdx]?.rel ?? apexRel;

  // Interpolated threshold crossing for dense telemetry streams
  const detectBrakePct = (
    samples: Array<{ pct: number; brake: number }>,
    fallbackPct: number
  ): number => {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const rel = signedPctDiff(windowStartPct, s.pct);
      if (rel >= 0 && rel <= apexRel && s.brake >= 0.28) {
        return s.pct;
      }
    }
    return fallbackPct;
  };

  const detectThrottlePct = (
    samples: Array<{ pct: number; throttle: number }>,
    fallbackPct: number
  ): number => {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const rel = signedPctDiff(windowStartPct, s.pct);
      if (rel >= apexRel * 0.96 && rel <= windowTotalPct && s.throttle >= 0.7) {
        return s.pct;
      }
    }
    return fallbackPct;
  };

  const refNormalized = referenceSamples.map((r) => ({ pct: r.pct, brake: r.brake, throttle: r.throttle }));
  const usrNormalized = driverFrames.map((f) => ({
    pct: f.lapDistPct,
    brake: f.brake,
    throttle: f.throttle,
  }));
  const bestNormalized = (candidateBestFrames ?? []).map((f) => ({
    pct: f.lapDistPct,
    brake: f.brake,
    throttle: f.throttle,
  }));

  const hasHighResFrames = usrNormalized.length >= 12;

  const baseProBrakePct = detectBrakePct(refNormalized, corner.brakeMarkerPct);
  const proBrakePct =
    greenLineSource === 'proven_best' && bestNormalized.length >= 4
      ? detectBrakePct(bestNormalized, baseProBrakePct)
      : greenLineSource === 'learned' && calibration.brakeEarlierMeters > 0
        ? wrapPct(baseProBrakePct - calibration.brakeEarlierMeters / Math.max(1000, trackLenMeters))
        : baseProBrakePct;

  const fallbackUserBrakePct = wrapPct(
    baseProBrakePct + brakeDeltaM / Math.max(1000, trackLenMeters)
  );
  const userBrakePct = hasHighResFrames
    ? detectBrakePct(usrNormalized, fallbackUserBrakePct)
    : fallbackUserBrakePct;

  const defaultProThrottlePct = wrapPct(
    corner.apexPct + Math.max(0.004, signedPctDiff(corner.apexPct, corner.exitPct) * 0.34)
  );
  const baseProThrottlePct = detectThrottlePct(refNormalized, defaultProThrottlePct);
  const proThrottlePct =
    greenLineSource === 'proven_best' && bestNormalized.length >= 4
      ? detectThrottlePct(bestNormalized, baseProThrottlePct)
      : greenLineSource === 'learned' && calibration.exitSquareBias > 0.04
        ? wrapPct(baseProThrottlePct + (calibration.exitSquareBias * 18) / Math.max(1000, trackLenMeters))
        : baseProThrottlePct;

  const estThrottleDelayMeters = isSlowExit
    ? Math.max(6, Math.min(20, Math.round(Math.abs(exitSpeedDelta) * 2.2)))
    : isLateBrake
      ? 10
      : 2;
  const fallbackUserThrottlePct = wrapPct(
    baseProThrottlePct + estThrottleDelayMeters / Math.max(1000, trackLenMeters)
  );
  const userThrottlePct = hasHighResFrames
    ? detectThrottlePct(usrNormalized, fallbackUserThrottlePct)
    : fallbackUserThrottlePct;

  const proBrakeAnchor = anchorAtRel(proPts, relFromStart(proBrakePct));
  const userBrakeAnchor = anchorAtRel(userPts, relFromStart(userBrakePct));
  const proApexAnchor = anchorAtRel(proPts, solvedApexRel);
  const userApexAnchor = anchorAtRel(
    userPts,
    isEarlyBrake ? apexRel * 0.88 : apexRel + (isLateBrake ? 0.003 : 0)
  );
  const proThrottleAnchor = anchorAtRel(proPts, relFromStart(proThrottlePct));
  const userThrottleAnchor = anchorAtRel(userPts, relFromStart(userThrottlePct));

  const brakeDiffMeters = Math.round(
    signedPctDiff(proBrakePct, userBrakePct) * trackLenMeters
  );
  const throttleDiffMeters = Math.round(
    signedPctDiff(proThrottlePct, userThrottlePct) * trackLenMeters
  );

  // Perpendicular braking threshold gates across the tarmac width
  const gateLines: CornerGateLine[] = [
    {
      id: 'gate_pro_brake',
      line: 'green',
      x1: proBrakeAnchor.cp.x - proBrakeAnchor.nx * trackHalfWidth * 1.05,
      y1: proBrakeAnchor.cp.y - proBrakeAnchor.ny * trackHalfWidth * 1.05,
      x2: proBrakeAnchor.cp.x + proBrakeAnchor.nx * trackHalfWidth * 1.05,
      y2: proBrakeAnchor.cp.y + proBrakeAnchor.ny * trackHalfWidth * 1.05,
    },
    ...(Math.abs(brakeDiffMeters) >= 3
      ? [
          {
            id: 'gate_user_brake',
            line: 'red' as const,
            x1: userBrakeAnchor.cp.x - userBrakeAnchor.nx * trackHalfWidth * 1.05,
            y1: userBrakeAnchor.cp.y - userBrakeAnchor.ny * trackHalfWidth * 1.05,
            x2: userBrakeAnchor.cp.x + userBrakeAnchor.nx * trackHalfWidth * 1.05,
            y2: userBrakeAnchor.cp.y + userBrakeAnchor.ny * trackHalfWidth * 1.05,
          },
        ]
      : []),
  ];

  // Push labels cleanly outside the tarmac edge on opposite sides (green outward, red inward/opposite)
  const labelDistGreen = trackHalfWidth * 2.25;
  const labelDistRed = trackHalfWidth * 2.35;

  const greenBrakeLabel =
    greenLineSource === 'proven_best'
      ? 'BEST BRK'
      : greenLineSource === 'learned'
        ? 'TARGET BRK'
        : 'PRO BRK';
  const greenThrottleLabel =
    greenLineSource === 'proven_best'
      ? 'BEST THR'
      : greenLineSource === 'learned'
        ? 'TARGET THR'
        : 'PRO THR';

  const scaleSpeed = car.topSpeedKmh / 338;
  const rawProApexKmh = corner.targetApexSpeedKmh * scaleSpeed;
  const userApexEstKmh = Math.max(40, rawProApexKmh + apexSpeedDelta);
  const displayGreenApexKmh =
    greenLineSource === 'learned' && apexSpeedDelta < -2
      ? Math.round(userApexEstKmh + (rawProApexKmh - userApexEstKmh) * calibration.apexSpeedTargetBlend)
      : Math.round(corner.targetApexSpeedKmh);

  const markers: CornerActionMarker[] = [
    {
      id: 'pro_brake',
      kind: 'pro_brake',
      line: 'green',
      x: proBrakeAnchor.pt.x,
      y: proBrakeAnchor.pt.y,
      labelX: proBrakeAnchor.cp.x - proBrakeAnchor.nx * proBrakeAnchor.localSign * labelDistGreen,
      labelY: proBrakeAnchor.cp.y - proBrakeAnchor.ny * proBrakeAnchor.localSign * labelDistGreen,
      pct: proBrakePct,
      shortLabel: greenBrakeLabel,
      detailLabel:
        greenLineSource === 'proven_best'
          ? 'Braking marker from your fastest pass here'
          : greenLineSource === 'learned' && calibration.brakeEarlierMeters >= 2
            ? `Learned target brake (${calibration.brakeEarlierMeters}m safer straight-line buffer)`
            : `Reference brake (${Math.round(corner.targetBrakePressure * 100)}%)`,
    },
    {
      id: 'user_brake',
      kind: 'user_brake',
      line: 'red',
      x: userBrakeAnchor.pt.x,
      y: userBrakeAnchor.pt.y,
      labelX: userBrakeAnchor.cp.x + userBrakeAnchor.nx * userBrakeAnchor.localSign * labelDistRed,
      labelY: userBrakeAnchor.cp.y + userBrakeAnchor.ny * userBrakeAnchor.localSign * labelDistRed,
      pct: userBrakePct,
      shortLabel:
        brakeDiffMeters > 2
          ? `YOU +${brakeDiffMeters}m`
          : brakeDiffMeters < -2
            ? `YOU ${brakeDiffMeters}m`
            : 'YOU BRK',
      detailLabel:
        brakeDiffMeters > 2
          ? `Braked ${brakeDiffMeters}m past green marker`
          : brakeDiffMeters < -2
            ? `Braked ${Math.abs(brakeDiffMeters)}m early`
            : 'Driver braking point',
    },
    {
      id: 'pro_apex',
      kind: 'pro_apex',
      line: 'green',
      x: proApexAnchor.pt.x,
      y: proApexAnchor.pt.y,
      labelX: proApexAnchor.cp.x + proApexAnchor.nx * proApexAnchor.localSign * (trackHalfWidth * 2.3),
      labelY: proApexAnchor.cp.y + proApexAnchor.ny * proApexAnchor.localSign * (trackHalfWidth * 2.3),
      pct: wrapPct(windowStartPct + solvedApexRel),
      shortLabel: cornerArchetype === 'hairpin' ? 'LATE APEX' : 'APEX',
      detailLabel:
        greenLineSource === 'learned'
          ? `Achievable target apex: ${displayGreenApexKmh} km/h (Gear ${corner.targetGear})`
          : `Target apex: ${displayGreenApexKmh} km/h (Gear ${corner.targetGear})`,
    },
    {
      id: 'user_apex',
      kind: 'user_apex',
      line: 'red',
      x: userApexAnchor.pt.x,
      y: userApexAnchor.pt.y,
      labelX: proApexAnchor.cp.x - proApexAnchor.nx * proApexAnchor.localSign * (trackHalfWidth * 2.2),
      labelY: proApexAnchor.cp.y - proApexAnchor.ny * proApexAnchor.localSign * (trackHalfWidth * 2.2),
      pct: corner.apexPct,
      shortLabel: '',
      detailLabel: `Your apex speed delta (${apexSpeedDelta >= 0 ? '+' : ''}${Math.round(apexSpeedDelta)} km/h)`,
    },
    {
      id: 'pro_throttle',
      kind: 'pro_throttle',
      line: 'green',
      x: proThrottleAnchor.pt.x,
      y: proThrottleAnchor.pt.y,
      labelX: proThrottleAnchor.cp.x - proThrottleAnchor.nx * proThrottleAnchor.localSign * labelDistGreen,
      labelY: proThrottleAnchor.cp.y - proThrottleAnchor.ny * proThrottleAnchor.localSign * labelDistGreen,
      pct: proThrottlePct,
      shortLabel: greenThrottleLabel,
      detailLabel:
        greenLineSource === 'proven_best'
          ? 'Throttle pickup on your best pass'
          : greenLineSource === 'learned'
            ? 'Learned throttle commitment as wheel straightens'
            : 'Ideal Pro throttle point on exit',
    },
    {
      id: 'user_throttle',
      kind: 'user_throttle',
      line: 'red',
      x: userThrottleAnchor.pt.x,
      y: userThrottleAnchor.pt.y,
      labelX: userThrottleAnchor.cp.x + userThrottleAnchor.nx * userThrottleAnchor.localSign * labelDistRed,
      labelY: userThrottleAnchor.cp.y + userThrottleAnchor.ny * userThrottleAnchor.localSign * labelDistRed,
      pct: userThrottlePct,
      shortLabel:
        throttleDiffMeters > 2
          ? `THR +${throttleDiffMeters}m`
          : 'YOU THR',
      detailLabel:
        throttleDiffMeters > 2
          ? `Committed to full throttle ${throttleDiffMeters}m later`
          : 'Driver throttle point',
    },
  ];

  // Tight, proportional zoomed viewBox leaving space for outside labels while keeping road prominent
  const padX = Math.max(trackHalfWidth * 4.0, rawW * 0.12);
  const padY = Math.max(trackHalfWidth * 4.0, rawH * 0.14);
  const vbX = minX - padX;
  const vbY = minY - padY;
  const vbW = maxX - minX + padX * 2;
  const vbH = maxY - minY + padY * 2;
  const zoomViewBox = `${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`;

  const archetypeDesc =
    cornerArchetype === 'hairpin'
      ? 'Late-apex hairpin V-line: straight braking on the outside, patient rotation to clip the late apex kerb, then square off onto the exit.'
      : cornerArchetype === 'chicane'
        ? 'Chicane exit-priority arc: link the first apex smoothly without over-running mid-transition so the final exit opens straight onto the straight.'
        : cornerArchetype === 'sweeper'
          ? 'Fast aero sweeper geometric arc: carry wide entry, brush the inside kerb cleanly, and unwind gradually to preserve minimum speed.'
          : 'Medium-speed trail-brake arc: outside braking entry, progressive trail-release to the inside kerb, and full unwind to exit kerb.';

  const greenLineTitle =
    greenLineSource === 'proven_best'
      ? 'Your Best Pass'
      : greenLineSource === 'learned'
        ? 'Learned For You'
        : 'Pro Racing Line';

  const greenLineReason =
    greenLineSource === 'proven_best'
      ? `Proven faster line from your own best pass${bestCornerPassTimeSec ? ` (${bestCornerPassTimeSec.toFixed(2)}s through here)` : memPass?.bestTimeSec ? ` (${memPass.bestTimeSec.toFixed(2)}s best stored)` : ''}.`
      : greenLineSource === 'learned'
        ? `${calibration.adaptationSummary} ${archetypeDesc}`
        : archetypeDesc;

  // Actionable changes summary (Braking, Line/Apex, Throttle)
  const effectiveBrakeDelta = brakeDiffMeters !== 0 ? brakeDiffMeters : brakeDeltaM;
  let brakingAction = '';
  if (hasLockup) {
    brakingAction = `Peak at ${Math.round(corner.targetBrakePressure * 100)}% straight-line, then bleed brake pressure cleanly on turn-in to stop front lockup.`;
  } else if (effectiveBrakeDelta >= 3) {
    brakingAction = `Brake ${effectiveBrakeDelta}m earlier at the green marker (${Math.round(corner.targetBrakePressure * 100)}% initial pressure).`;
  } else if (effectiveBrakeDelta <= -4) {
    brakingAction = `Carry speed ${Math.abs(effectiveBrakeDelta) - 2}m deeper to the green brake marker.`;
  } else {
    brakingAction = `Keep brake marker steady (${Math.round(corner.targetBrakePressure * 100)}%), focus on smooth trail-off.`;
  }

  let lineApexAction = '';
  if (greenLineSource === 'proven_best' && hasWorldBestPass) {
    lineApexAction = isLateBrake
      ? 'You ran wide here compared to your own best pass — follow the green line back onto the inside apex kerb you proved works.'
      : 'Green traces the actual faster world line from your own best pass through this corner.';
  } else if (usingGameTrace && isLateBrake) {
    lineApexAction = 'You ran wide past the apex. The green line holds the outside brake zone longer and clips the inside kerb cleanly.';
  } else if (usingGameTrace && isEarlyBrake) {
    lineApexAction = 'You turned in early. The green line stays wider on entry and takes a later apex to straighten the exit.';
  } else if (usingGameTrace && isSlowExit) {
    lineApexAction = 'You pinched the exit. The green line squares the apex and tracks all the way out to the exit kerb.';
  } else if (isLateBrake) {
    lineApexAction = `Enter straight on the outside green line and clip the ${cornerArchetype === 'hairpin' ? 'late ' : ''}inside kerb (${displayGreenApexKmh} km/h, Gear ${corner.targetGear}) instead of washing wide on red.`;
  } else if (isEarlyBrake) {
    lineApexAction = `Hold outside longer before turn-in for a later apex so the car points straighter on exit.`;
  } else if (greenLineSource === 'learned') {
    lineApexAction = `${calibration.adaptationSummary} Target ~${displayGreenApexKmh} km/h across the inside kerb.`;
  } else if (hasAnyProvenPass) {
    lineApexAction = `Matches your strongest pass mechanics — carry ~${displayGreenApexKmh} km/h (Gear ${corner.targetGear}) cleanly across the inside apex kerb.`;
  } else {
    lineApexAction = `${archetypeDesc} Target ~${displayGreenApexKmh} km/h (Gear ${corner.targetGear}).`;
  }

  let throttleAction = '';
  if (isSlowExit || throttleDiffMeters >= 3) {
    const metersMsg = Math.max(4, Math.abs(throttleDiffMeters));
    throttleAction = `Unwind steering earlier past apex and commit to throttle ${metersMsg}m sooner at the green marker (+${Math.max(3, Math.abs(Math.round(exitSpeedDelta)))} km/h exit).`;
  } else {
    throttleAction = `Roll progressively to 100% throttle as steering unwinds toward the outside exit kerb.`;
  }

  const setupHint = hasLockup
    ? 'Brake Bias -0.8% rearward · ABS +1'
    : isSlowExit
      ? 'TC Map +1 · Rear ARB -1 click for exit bite'
      : undefined;

  const traceCount = 26;
  const pedalComparison: CornerPedalPoint[] = [];

  for (let i = 0; i < traceCount; i++) {
    const relRatio = i / (traceCount - 1);
    const pct = wrapPct(windowStartPct + relRatio * windowTotalPct);
    const refSample = sampleSeriesAtPct(referenceSamples, pct);
    const bestSample =
      greenLineSource === 'proven_best' && candidateBestFrames
        ? sampleSeriesAtPct(candidateBestFrames, pct)
        : null;
    const userFrame = driverFrames.length >= 20 ? sampleSeriesAtPct(driverFrames, pct) : null;

    const fallbackProSpeed =
      relRatio < 0.3
        ? corner.targetEntrySpeedKmh * scaleSpeed
        : relRatio < 0.6
          ? corner.targetApexSpeedKmh * scaleSpeed
          : Math.min(car.topSpeedKmh * 0.88, corner.targetApexSpeedKmh * scaleSpeed + 85);
    const rawProSpeed = bestSample?.speedKmh ?? refSample?.speedKmh ?? fallbackProSpeed;
    const rawProBrake =
      bestSample?.brake ??
      refSample?.brake ??
      (relRatio >= 0.25 && relRatio <= 0.52 ? corner.targetBrakePressure : 0);
    const rawProThrottle =
      bestSample?.throttle ??
      refSample?.throttle ??
      (relRatio < 0.22 ? 1 : relRatio > 0.56 ? Math.min(1, (relRatio - 0.52) * 2.1) : 0);

    let userSpeed = rawProSpeed;
    let userBrake = rawProBrake;
    let userThrottle = rawProThrottle;

    if (userFrame) {
      userSpeed = userFrame.speedKmh;
      userBrake = userFrame.brake;
      userThrottle = userFrame.throttle;
    } else {
      if (isLateBrake) {
        if (relRatio >= 0.24 && relRatio <= 0.34) {
          userBrake = Math.max(0, rawProBrake - 0.32);
          userSpeed = rawProSpeed + 14;
        } else if (relRatio > 0.34 && relRatio <= 0.58) {
          userBrake = Math.min(1, rawProBrake + 0.14);
          userSpeed = Math.max(45, rawProSpeed + apexSpeedDelta);
        }
      }
      if (isSlowExit && relRatio > 0.55) {
        userThrottle = Math.max(0, rawProThrottle - 0.18);
        userSpeed = Math.max(45, rawProSpeed + exitSpeedDelta);
      }
    }

    // In 'learned' mode, blend speed/pedal expectation to an achievable target between user's pace and Pro limit
    const proSpeed =
      greenLineSource === 'learned' && userSpeed < rawProSpeed
        ? userSpeed + (rawProSpeed - userSpeed) * calibration.apexSpeedTargetBlend
        : rawProSpeed;
    const proBrake =
      greenLineSource === 'learned' && calibration.brakeEarlierMeters >= 4
        ? clamp(rawProBrake * (1 - (1 - calibration.readiness) * 0.12), 0, 1)
        : rawProBrake;
    const proThrottle =
      greenLineSource === 'learned' && calibration.exitSquareBias >= 0.04 && relRatio > 0.48 && relRatio < 0.72
        ? clamp(rawProThrottle * 0.92, 0, 1)
        : rawProThrottle;

    pedalComparison.push({
      relPct: relRatio,
      userBrake: Math.round(userBrake * 100) / 100,
      proBrake: Math.round(proBrake * 100) / 100,
      userThrottle: Math.round(userThrottle * 100) / 100,
      proThrottle: Math.round(proThrottle * 100) / 100,
      userSpeedKmh: Math.round(userSpeed * 10) / 10,
      proSpeedKmh: Math.round(proSpeed * 10) / 10,
    });
  }

  return {
    corner,
    comparison,
    turnDirection,
    cornerArchetype,
    greenLineSource,
    greenLineTitle,
    greenLineReason,
    zoomViewBox,
    trackHalfWidth,
    asphaltPath: buildSmoothPath(centerPts),
    roadPolygonPath,
    leftEdgePath,
    rightEdgePath,
    kerbPaths,
    centerlinePath: buildSmoothPath(centerPts),
    proLinePath: buildSmoothPath(proPts),
    userLinePath: buildSmoothPath(userPts),
    proPoints: proPts.map((p) => ({ x: p.x, y: p.y })),
    userPoints: userPts.map((p) => ({ x: p.x, y: p.y })),
    gateLines,
    markers,
    changesSummary: {
      brakingAction,
      lineApexAction,
      throttleAction,
      setupHint,
      timeGainSec: Math.round(Math.max(0.03, timeLostSec * 0.88) * 100) / 100,
    },
    pedalComparison,
    traceSource: usingGameTrace ? 'game' : 'schematic',
  };
}

