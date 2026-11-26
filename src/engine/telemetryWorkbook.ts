import type { CornerDefinition, ReferenceSample, TelemetryFrame } from '../types/telemetry';

export interface ZoomDomain {
  minPct: number;
  maxPct: number;
  spanPct: number;
  isZoomed: boolean;
}

export const FULL_LAP_DOMAIN: ZoomDomain = {
  minPct: 0,
  maxPct: 1,
  spanPct: 1,
  isZoomed: false,
};

export interface DeltaTracePoint {
  pct: number;
  deltaSec: number;
}

export interface DeltaTraceSeries {
  points: DeltaTracePoint[];
  maxAbsDeltaSec: number;
}

/**
 * Computes a padded normalized distance domain [minPct, maxPct] around a corner
 * for MoTeC/VRS-style Corner Zoom inspection.
 */
export function computeCornerZoomDomain(
  corner: CornerDefinition | null | undefined,
  paddingPct = 0.035,
  minSpanPct = 0.08
): ZoomDomain {
  if (!corner) return FULL_LAP_DOMAIN;

  let minPct: number;
  let maxPct: number;

  if (corner.exitPct < corner.startPct) {
    // Corner wraps across S/F line; focus on entry-to-S/F window cleanly.
    minPct = Math.max(0, corner.startPct - paddingPct);
    maxPct = 1;
  } else {
    minPct = Math.max(0, corner.startPct - paddingPct);
    maxPct = Math.min(1, corner.exitPct + paddingPct);
  }

  let span = maxPct - minPct;
  if (span < minSpanPct) {
    const extra = (minSpanPct - span) / 2;
    minPct = Math.max(0, minPct - extra);
    maxPct = Math.min(1, maxPct + extra);
    span = maxPct - minPct;
    if (span < minSpanPct) {
      if (minPct === 0) {
        maxPct = Math.min(1, minSpanPct);
      } else if (maxPct === 1) {
        minPct = Math.max(0, 1 - minSpanPct);
      }
      span = maxPct - minPct;
    }
  }

  return {
    minPct,
    maxPct,
    spanPct: Math.max(0.01, span),
    isZoomed: true,
  };
}

export function projectPctToSvgX(pct: number, domain: ZoomDomain, width: number): number {
  return ((pct - domain.minPct) / Math.max(0.0001, domain.spanPct)) * width;
}

export function svgRatioToPct(ratio01: number, domain: ZoomDomain): number {
  const clamped = Math.max(0, Math.min(1, ratio01));
  return Math.max(0, Math.min(1, domain.minPct + clamped * domain.spanPct));
}

export function sampleReferencePedalAtPct(
  refSamples: ReferenceSample[],
  lapDistPct: number
): { throttle: number; brake: number; speedKmh: number } {
  if (refSamples.length === 0) {
    return { throttle: 0, brake: 0, speedKmh: 0 };
  }
  const pct = Math.max(0, Math.min(1, lapDistPct));
  const scaledIdx = pct * (refSamples.length - 1);
  const lo = Math.floor(scaledIdx);
  const hi = Math.min(refSamples.length - 1, lo + 1);
  const t = scaledIdx - lo;
  const a = refSamples[lo];
  const b = refSamples[hi];
  return {
    throttle: a.throttle + (b.throttle - a.throttle) * t,
    brake: a.brake + (b.brake - a.brake) * t,
    speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * t,
  };
}

export function findNearestIndexByPct(
  items: ReadonlyArray<{ lapDistPct?: number; pct?: number }>,
  targetPct: number
): number {
  if (items.length === 0) return -1;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < items.length; i += 1) {
    const p = items[i].lapDistPct ?? items[i].pct ?? 0;
    const d = Math.abs(p - targetPct);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Produces an aligned MoTeC-style Delta-T (time gain/loss in seconds) trace.
 * Uses recorded frame.deltaSec when populated, or integrates speed delta vs reference.
 */
export function computeDeltaTraceSeries(
  frames: TelemetryFrame[],
  refSamples: ReferenceSample[],
  trackLengthKm: number
): DeltaTraceSeries {
  if (frames.length === 0) {
    return { points: [], maxAbsDeltaSec: 0.5 };
  }

  let minRaw = Infinity;
  let maxRaw = -Infinity;
  for (const f of frames) {
    if (f.deltaSec < minRaw) minRaw = f.deltaSec;
    if (f.deltaSec > maxRaw) maxRaw = f.deltaSec;
  }

  const hasLiveDelta = Number.isFinite(minRaw) && Number.isFinite(maxRaw) && maxRaw - minRaw > 0.02;

  const points: DeltaTracePoint[] = [];
  if (hasLiveDelta) {
    for (const f of frames) {
      points.push({
        pct: f.lapDistPct,
        deltaSec: Math.max(-4.5, Math.min(4.5, f.deltaSec)),
      });
    }
  } else {
    const trackLenM = Math.max(500, trackLengthKm * 1000);
    let cumulative = 0;
    for (let i = 0; i < frames.length; i += 1) {
      const f = frames[i];
      if (i > 0) {
        const prev = frames[i - 1];
        const dPct = Math.max(0, f.lapDistPct - prev.lapDistPct);
        const dsM = dPct * trackLenM;
        const refMid = sampleReferencePedalAtPct(refSamples, (f.lapDistPct + prev.lapDistPct) / 2);
        const userMs = Math.max(8, ((f.speedKmh + prev.speedKmh) / 2) / 3.6);
        const refMs = Math.max(8, refMid.speedKmh / 3.6);
        cumulative += dsM / userMs - dsM / refMs;
      }
      points.push({
        pct: f.lapDistPct,
        deltaSec: Math.max(-4.5, Math.min(4.5, cumulative)),
      });
    }
  }

  let maxAbs = 0.35;
  for (const pt of points) {
    const abs = Math.abs(pt.deltaSec);
    if (abs > maxAbs) maxAbs = abs;
  }

  return {
    points,
    maxAbsDeltaSec: Math.min(4.5, Math.ceil(maxAbs * 10) / 10),
  };
}
