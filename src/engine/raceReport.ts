import type {
  CarProfile,
  CarSetup,
  CompactTelemetryPoint,
  CornerComparison,
  DriverProfile,
  LapRecord,
  OpponentCar,
  RaceLapSummary,
  RaceMistakeFix,
  RaceReport,
  ReferenceSample,
  SimGameId,
  SimSessionType,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';
import { analyzeLapByCorners, evaluateDriverSkillMetrics } from './coachRules';

export interface BuildRaceReportParams {
  simId: SimGameId;
  simName: string;
  track: TrackProfile;
  car: CarProfile;
  setup: CarSetup;
  driverProfile: DriverProfile;
  laps: LapRecord[];
  referenceSamples: ReferenceSample[];
  mistakeCounts: {
    lateBrakes: number;
    lockups: number;
    exitSnaps: number;
    offTracks: number;
  };
  sessionMode: 'live_race' | 'practice_stint';
  sessionType?: SimSessionType;
  raceDistanceLaps?: number;
  fieldSize?: number;
  officialFinishPosition?: number;
  opponents?: OpponentCar[];
  language?: 'en';
  createdAtIso?: string;
}

export interface ProjectionResult {
  selectedGainPerLapSec: number;
  totalRaceTimeSavedSec: number;
  projectedBestLapSec: number;
  positionsGained: number;
  projectedPosition: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Computes how many grid/race positions are gained from a given per-lap improvement
 * over `raceDistanceLaps`, using typical GT3/Hypercar pack gap density (~0.34s/lap per spot)
 * or opponent gaps when available.
 */
export function calculateProjectedGain(
  bestLapSec: number,
  referenceLapSec: number,
  fixableGainPerLapSec: number,
  raceDistanceLaps: number,
  finishPosition: number,
  opponents: OpponentCar[] = [],
  overrideMaxGain?: number
): ProjectionResult {
  const maxRealisticGain =
    overrideMaxGain == null
      ? Math.max(0, bestLapSec - referenceLapSec * 0.996)
      : Math.max(0, overrideMaxGain);
  const clampedPerLap = round3(Math.min(maxRealisticGain, Math.max(0, fixableGainPerLapSec)));
  const totalRaceTimeSavedSec = round2(clampedPerLap * Math.max(1, raceDistanceLaps));
  const projectedBestLapSec = round3(
    Math.max(overrideMaxGain == null ? referenceLapSec * 0.996 : 0, bestLapSec - clampedPerLap)
  );

  let positionsGained = 0;

  // When live opponents ahead are known with positive gaps, count real cars overtaken over the stint
  const rivalsAhead = opponents
    .filter((o) => o.gapSeconds > 0.1)
    .sort((a, b) => a.gapSeconds - b.gapSeconds);

  if (rivalsAhead.length >= 2 && totalRaceTimeSavedSec > 0) {
    // Each car ahead sits at some race gap; additionally pack density scales up to finishPosition - 1
    const aheadGapsPassed = rivalsAhead.filter((r) => totalRaceTimeSavedSec >= r.gapSeconds).length;
    const avgPackGapPerSpot = Math.max(2.4, raceDistanceLaps * 0.34);
    const packEstimate = Math.floor(totalRaceTimeSavedSec / avgPackGapPerSpot);
    positionsGained = Math.max(aheadGapsPassed, packEstimate);
  } else {
    // Typical competitive LMU split: ~0.34s/lap separates consecutive grid positions over a stint
    const avgPackGapPerSpot = Math.max(2.4, raceDistanceLaps * 0.34);
    positionsGained = Math.floor(totalRaceTimeSavedSec / avgPackGapPerSpot);
  }

  if (finishPosition < 1) {
    return {
      selectedGainPerLapSec: clampedPerLap,
      totalRaceTimeSavedSec,
      projectedBestLapSec,
      positionsGained: 0,
      projectedPosition: 0,
    };
  }

  positionsGained = Math.min(Math.max(0, finishPosition - 1), Math.max(0, positionsGained));
  const projectedPosition = Math.max(1, finishPosition - positionsGained);

  return {
    selectedGainPerLapSec: clampedPerLap,
    totalRaceTimeSavedSec,
    projectedBestLapSec,
    positionsGained,
    projectedPosition,
  };
}

/**
 * Dynamically recalculates time & position gains when the user toggles specific fixes on/off.
 */
export function recalculateReportProjection(
  report: RaceReport,
  enabledFixIds: string[]
): ProjectionResult {
  const enabledSet = new Set(enabledFixIds);
  const sumGain = report.mistakeFixes
    .filter((f) => enabledSet.has(f.id))
    .reduce((acc, f) => acc + f.timeGainPerLapSec, 0);

  return calculateProjectedGain(
    report.bestLapSec,
    report.referenceLapSec,
    sumGain,
    report.raceDistanceLaps,
    report.finishPosition
  );
}

function computeCornerPassTime(
  frames: TelemetryFrame[],
  corner: TrackProfile['corners'][number],
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
  if (dt > 0.4 && dt < 45) return dt;

  let integrated = 0;
  for (let i = 1; i < pts.length; i++) {
    const dist = (pts[i].rel - pts[i - 1].rel) * trackLenMeters;
    const avgSpeedMs = (pts[i].speed + pts[i - 1].speed) / 2 / 3.6;
    if (dist > 0 && avgSpeedMs > 1) {
      integrated += dist / avgSpeedMs;
    }
  }
  return integrated > 0.4 && integrated < 45 ? integrated : null;
}

export function buildPostRaceReport(params: BuildRaceReportParams): RaceReport {
  const {
    simId,
    simName,
    track,
    car,
    setup,
    driverProfile,
    laps,
    referenceSamples,
    mistakeCounts,
    sessionMode,
    opponents = [],
  } = params;
  const fieldSize = params.fieldSize ?? 22;
  const raceDistanceLaps = params.raceDistanceLaps ?? (track.lengthKm > 9 ? 10 : 18);

  const validLaps = laps.filter((l) => l.frames.length >= 10);
  const representativeLap =
    validLaps.length > 0
      ? [...validLaps].sort((a, b) => a.lapTimeSec - b.lapTimeSec)[0]
      : null;

  const frames = representativeLap?.frames ?? [];
  const cornerComparisons: CornerComparison[] =
    frames.length > 0 ? analyzeLapByCorners(frames, referenceSamples, track) : [];

  const skillMetrics = evaluateDriverSkillMetrics(frames, cornerComparisons, 'en');

  const cornerOccurrences = new Map<string, number>();
  const lapSummaries: RaceLapSummary[] = validLaps.map((l) => {
    const comps = analyzeLapByCorners(l.frames, referenceSamples, track);
    for (const comp of comps) {
      if (comp.timeLostSec > 0.03) {
        cornerOccurrences.set(comp.cornerId, (cornerOccurrences.get(comp.cornerId) ?? 0) + 1);
      }
    }
    const metrics = evaluateDriverSkillMetrics(l.frames, comps, 'en');
    return {
      lapNumber: l.lapNumber,
      lapTimeSec: round3(l.lapTimeSec),
      deltaToRefSec: round3(l.lapTimeSec - track.referenceLapTimeSec),
      valid: l.valid,
      trailBrakeScore: metrics.trailBrakingScore,
    };
  });

  const bestLapSec =
    lapSummaries.length > 0
      ? Math.min(...lapSummaries.map((l) => l.lapTimeSec))
      : round3(track.referenceLapTimeSec + Math.max(0.4, driverProfile.habits.avgDeltaSec));

  const avgLapSec =
    lapSummaries.length > 0
      ? round3(lapSummaries.reduce((acc, l) => acc + l.lapTimeSec, 0) / lapSummaries.length)
      : round3(bestLapSec + 0.45);

  const spreadSec =
    lapSummaries.length >= 2
      ? Math.max(...lapSummaries.map((l) => l.lapTimeSec)) - bestLapSec
      : Math.max(0.35, (100 - driverProfile.habits.brakingConsistencyPct) * 0.06);

  const consistencyPct = Math.max(
    45,
    Math.min(99, Math.round(98 - spreadSec * 6.5 - mistakeCounts.offTracks * 2.5))
  );

  const paceGapToRef = Math.max(0, avgLapSec - track.referenceLapTimeSec);
  const rawPos = params.officialFinishPosition;
  const positionKnown = Number.isInteger(rawPos) && (rawPos as number) >= 1;
  const estimatedFinish = positionKnown ? Math.min(fieldSize, rawPos as number) : 0;

  const mistakeFixes: RaceMistakeFix[] = [];

  // 1. Top corner-level losses from telemetry
  const sortedCorners = [...cornerComparisons]
    .filter((c) => c.timeLostSec > 0.03)
    .sort((a, b) => b.timeLostSec - a.timeLostSec);

  for (const c of sortedCorners.slice(0, 4)) {
    const cornerLabel = `Turn ${c.cornerNumber} (${c.cornerName})`;
    const hasLockup = /lockup/i.test(c.primaryIssue);
    const lateBrake = c.brakingDeltaMeters >= 5;
    const earlyBrake = c.brakingDeltaMeters <= -6;
    const slowExit = c.exitSpeedDeltaKmh <= -3;

    let category: RaceMistakeFix['category'] = 'apex_speed';
    let mistakeTitle = '';
    let watchOutDetail = '';
    let howToFix = '';
    let setupTweak: string | undefined;

    if (hasLockup) {
      category = 'lockup';
      mistakeTitle = `Front wheel lockup under heavy braking`;
      watchOutDetail = `Excessive peak brake pressure kept too deep into turn-in at ${cornerLabel}, flat-spotting fronts and pushing wide.`;
      howToFix = `Bleed brake pressure down to 75–85% as steering angle builds, releasing smoothly to the apex.`;
      setupTweak = `Brake Bias ${(setup.brakeBiasPct - 1.0).toFixed(1)}% · ABS +1`;
    } else if (lateBrake) {
      category = 'braking';
      mistakeTitle = `Braking ${c.brakingDeltaMeters}m too late`;
      watchOutDetail = `Hitting the brakes ${c.brakingDeltaMeters}m past reference at ${cornerLabel}, overshooting the apex and hurting exit drive.`;
      howToFix = `Move braking point ${c.brakingDeltaMeters}m earlier to rotate cleanly and get on full throttle earlier.`;
    } else if (earlyBrake) {
      category = 'braking';
      mistakeTitle = `Braking ${Math.abs(c.brakingDeltaMeters)}m too early`;
      watchOutDetail = `Giving up entry speed ${Math.abs(c.brakingDeltaMeters)}m before the reference marker at ${cornerLabel}.`;
      howToFix = `Commit ${Math.max(4, Math.abs(c.brakingDeltaMeters) - 2)}m deeper into the braking zone before trail-braking.`;
    } else if (slowExit) {
      category = 'traction';
      mistakeTitle = `Delayed exit throttle (${c.exitSpeedDeltaKmh} km/h exit speed)`;
      watchOutDetail = `Holding steering lock too long past apex at ${cornerLabel}, delaying full throttle onto the straight.`;
      howToFix = `Square off the apex slightly, unwind wheel earlier, and roll throttle smoothly to 100%.`;
      setupTweak = `TC Map ${Math.min(10, setup.tcLevel + 1)} · Rear ARB -1 click`;
    } else {
      category = 'apex_speed';
      mistakeTitle = `Over-slowed minimum apex speed (${c.minApexSpeedDeltaKmh} km/h)`;
      watchOutDetail = `Carrying brake too long into mid-corner at ${cornerLabel}, scrubbing unnecessary minimum speed.`;
      howToFix = `Release brake 10% earlier on turn-in and let car rotation carry momentum across the apex.`;
    }

    mistakeFixes.push({
      id: `fix-corner-${c.cornerId}`,
      category,
      severity: c.timeLostSec >= 0.16 ? 'high' : 'medium',
      cornerId: c.cornerId,
      cornerLabel,
      mistakeTitle,
      watchOutDetail,
      howToFix,
      setupTweak,
      occurrences: Math.max(1, cornerOccurrences.get(c.cornerId) ?? 1),
      timeGainPerLapSec: round3(Math.max(0.05, c.timeLostSec * 0.88)),
    });
  }

  // 2. Pedal overlap habit (Trophi.ai signal)
  if (skillMetrics.pedalOverlapPct >= 2.5) {
    const overlapGain = round3(Math.min(0.32, skillMetrics.pedalOverlapPct * 0.032));
    mistakeFixes.push({
      id: 'fix-pedal-overlap',
      category: 'overlap',
      severity: skillMetrics.pedalOverlapPct >= 6 ? 'high' : 'medium',
      cornerLabel: 'Full Lap (Pedal Technique)',
      mistakeTitle: `Simultaneous throttle & brake overlap (${skillMetrics.pedalOverlapPct.toFixed(1)}%)`,
      watchOutDetail: `Overlapping throttle and brake on ${skillMetrics.pedalOverlapPct.toFixed(1)}% of trace samples fights front grip and wastes momentum.`,
      howToFix: `Separate pedal transitions cleanly: completely bleed off brake before committing back to throttle.`,
      occurrences: Math.max(1, Math.round(skillMetrics.pedalOverlapPct)),
      timeGainPerLapSec: overlapGain,
    });
  }

  // 3. Session incident habits (lockups / exit snaps / track limits)
  if (mistakeCounts.lockups >= 1 && !mistakeFixes.some((f) => f.category === 'lockup')) {
    mistakeFixes.push({
      id: 'fix-session-lockups',
      category: 'lockup',
      severity: mistakeCounts.lockups >= 3 ? 'high' : 'medium',
      cornerLabel: 'Heavy Braking Zones',
      mistakeTitle: `${mistakeCounts.lockups} front lockup event(s) recorded`,
      watchOutDetail: `Spiking brake pressure >90% as aero load bleeds off flat-spots front tires and stretches stopping distance.`,
      howToFix: `Hit initial peak pressure above 250 km/h, then progressively bleed off as downforce drops.`,
      setupTweak: `Brake Bias ${(setup.brakeBiasPct - 0.8).toFixed(1)}%`,
      occurrences: mistakeCounts.lockups,
      timeGainPerLapSec: round3(Math.min(0.28, 0.08 + mistakeCounts.lockups * 0.04)),
    });
  }

  if (mistakeCounts.exitSnaps >= 1 && !mistakeFixes.some((f) => f.category === 'traction')) {
    mistakeFixes.push({
      id: 'fix-session-traction',
      category: 'traction',
      severity: mistakeCounts.exitSnaps >= 3 ? 'high' : 'medium',
      cornerLabel: 'Slow Corner Exits',
      mistakeTitle: `${mistakeCounts.exitSnaps} rear traction snap(s) on exit`,
      watchOutDetail: `Snapping throttle before unwinding steering overheats rears and forces mid-exit corrections.`,
      howToFix: `Wait for steering angle to open before 100% throttle, especially in 1st and 2nd gear exits.`,
      setupTweak: `TC Map ${Math.min(10, setup.tcLevel + 1)}`,
      occurrences: mistakeCounts.exitSnaps,
      timeGainPerLapSec: round3(Math.min(0.26, 0.07 + mistakeCounts.exitSnaps * 0.04)),
    });
  }

  if (mistakeCounts.offTracks >= 1) {
    mistakeFixes.push({
      id: 'fix-track-limits',
      category: 'track_limits',
      severity: mistakeCounts.offTracks >= 3 ? 'high' : 'low',
      cornerLabel: 'Track Limits & Exit Kerbs',
      mistakeTitle: `${mistakeCounts.offTracks} track-limit warning(s) / kerb overshoots`,
      watchOutDetail: `Repeated exit kerb wide runs risk a 5s–Drive-Through penalty in LMU, costing far more than 0.05s gained.`,
      howToFix: `Leave a 20cm safety margin inside the white line on fast blind exits.`,
      occurrences: mistakeCounts.offTracks,
      timeGainPerLapSec: round3(Math.min(0.24, 0.06 + mistakeCounts.offTracks * 0.04)),
    });
  }

  // Ensure at least 1 constructive improvement item even on a clean stint
  if (mistakeFixes.length === 0) {
    mistakeFixes.push({
      id: 'fix-trail-precision',
      category: 'apex_speed',
      severity: 'low',
      cornerLabel: 'Corner Apex Precision',
      mistakeTitle: 'Apex carry speed optimization',
      watchOutDetail: 'Clean stint without major errors — remaining time hides in slightly lighter entry braking and earlier exit commitment.',
      howToFix: 'Push brake release 3–5m smoother on corners leading onto the longest straights.',
      occurrences: 1,
      timeGainPerLapSec: round3(Math.max(0.15, Math.min(0.45, paceGapToRef * 0.55))),
    });
  }

  mistakeFixes.sort((a, b) => b.timeGainPerLapSec - a.timeGainPerLapSec);
  const topFixes = mistakeFixes.slice(0, 6);
  const rawFixSum = topFixes.reduce((acc, f) => acc + f.timeGainPerLapSec, 0);

  const trackLenMeters = Math.max(500, track.lengthKm * 1000);
  let provenGainSec = 0;
  const bestCornerPassRaw: Array<{ cornerId: string; timeSec: number; frames: TelemetryFrame[] }> = [];

  if (representativeLap) {
    for (const c of track.corners) {
      let bestTime = Infinity;
      let bestFrames = representativeLap.frames;
      let repTime: number | null = null;

      for (const lap of validLaps) {
        const t = computeCornerPassTime(lap.frames, c, trackLenMeters);
        if (t == null) continue;
        if (lap === representativeLap) repTime = t;
        if (t < bestTime) {
          bestTime = t;
          bestFrames = lap.frames;
        }
      }

      if (repTime == null || !Number.isFinite(bestTime)) continue;
      const gain = Math.max(0, repTime - bestTime);
      provenGainSec += gain;
      if (gain >= 0.03 && bestFrames !== representativeLap.frames) {
        let span = c.exitPct - c.startPct;
        if (span <= 0) span += 1;
        const cornerFrames = bestFrames.filter((f) => {
          let rel = f.lapDistPct - c.startPct;
          if (rel < -0.5) rel += 1;
          if (rel > 0.5) rel -= 1;
          return rel >= -0.016 && rel <= span + 0.016;
        });
        bestCornerPassRaw.push({
          cornerId: c.id,
          timeSec: round3(bestTime),
          frames: cornerFrames,
        });
      }
    }
  }
  provenGainSec = round3(provenGainSec);
  const provenBestLapSec = round3(Math.max(0, bestLapSec - provenGainSec));

  const projection =
    validLaps.length >= 2
      ? calculateProjectedGain(
          bestLapSec,
          track.referenceLapTimeSec,
          provenGainSec,
          raceDistanceLaps,
          estimatedFinish,
          opponents,
          provenGainSec
        )
      : calculateProjectedGain(
          bestLapSec,
          track.referenceLapTimeSec,
          rawFixSum,
          raceDistanceLaps,
          estimatedFinish,
          opponents
        );

  const compactFrames = (sourceFrames: TelemetryFrame[]): CompactTelemetryPoint[] => {
    const stride = Math.max(1, Math.ceil(sourceFrames.length / 1600));
    return sourceFrames
      .filter((_, idx) => idx % stride === 0)
      .map((f) => ({
        lapDistPct: round3(f.lapDistPct),
        speedKmh: Math.round(f.speedKmh * 10) / 10,
        throttle: round2(f.throttle),
        brake: round2(f.brake),
        steeringRad: round3(f.steeringRad),
        frontWheelSlip: round2(f.frontWheelSlip),
        rearWheelSlip: round2(f.rearWheelSlip),
        ...(Number.isFinite(f.posX) && Number.isFinite(f.posZ)
          ? {
              posX: Math.round((f.posX as number) * 100) / 100,
              posZ: Math.round((f.posZ as number) * 100) / 100,
            }
          : {}),
      }))
      .sort((a, b) => a.lapDistPct - b.lapDistPct);
  };

  const representativeFrames = compactFrames(frames);
  const secondBestLap =
    validLaps.length > 1 ? [...validLaps].sort((a, b) => a.lapTimeSec - b.lapTimeSec)[1] : null;
  const compareFrames = secondBestLap ? compactFrames(secondBestLap.frames) : [];
  const bestCornerPasses = bestCornerPassRaw.map((p) => ({
    cornerId: p.cornerId,
    timeSec: p.timeSec,
    frames: compactFrames(p.frames),
  }));

  return {
    id: `report-${track.id}-${Date.now()}`,
    createdAtIso: params.createdAtIso ?? new Date().toISOString(),
    simId,
    simName,
    trackId: track.id,
    trackName: track.name,
    trackLengthKm: track.lengthKm,
    carId: car.id,
    carName: car.name,
    carClass: car.carClass,
    sessionMode,
    ...(params.sessionType ? { sessionType: params.sessionType } : {}),
    lapsCompleted: Math.max(1, lapSummaries.length),
    raceDistanceLaps,
    bestLapSec,
    avgLapSec,
    referenceLapSec: track.referenceLapTimeSec,
    consistencyPct,
    trailBrakingScore: skillMetrics.trailBrakingScore,
    pedalOverlapPct: skillMetrics.pedalOverlapPct,
    inputSmoothnessScore: skillMetrics.inputSmoothnessScore,
    finishPosition: estimatedFinish,
    positionKnown,
    projectedPosition: projection.projectedPosition,
    positionsGained: projection.positionsGained,
    fieldSize,
    fixableGainPerLapSec: projection.selectedGainPerLapSec,
    totalRaceTimeSavedSec: projection.totalRaceTimeSavedSec,
    mistakeCounts: { ...mistakeCounts },
    mistakeFixes: topFixes,
    lapSummaries,
    cornerComparisons,
    representativeFrames,
    ...(compareFrames.length > 0 ? { compareFrames } : {}),
    ...(bestCornerPasses.length > 0 ? { bestCornerPasses } : {}),
    provenBestLapSec,
    provenGainSec,
    aiBrief: null,
  };
}
