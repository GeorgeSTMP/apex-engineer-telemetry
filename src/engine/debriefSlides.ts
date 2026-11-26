import type {
  AiPostRaceBrief,
  CarProfile,
  CornerComparison,
  DriverProfile,
  RaceMistakeFix,
  RaceReport,
  ReferenceSample,
  TrackProfile,
} from '../types/telemetry';
import { formatLapTime } from './coachRules';
import { buildCornerLineAnalysis, type CornerDetailAnalysis } from './racingLine';

export type DebriefSlideKind = 'overview' | 'corner' | 'summary';

export interface DebriefSlide {
  id: string;
  index: number;
  kind: DebriefSlideKind;
  chapterLabel: string;
  title: string;
  subtitle: string;
  cornerId?: string;
  cornerNumber?: number;
  cornerAnalysis?: CornerDetailAnalysis;
  wentRight: string[];
  wentWrong: string[];
  howToFix: string[];
  timeGainLabel?: string;
  setupHint?: string;
  narrationText: string;
  durationSec: number;
}

function estimateSpeechDurationSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // ~2.3 words/sec spoken naturally + 1.5s visual buffer, bounded 5..14s
  return Math.max(5, Math.min(14, Math.round(words / 2.3 + 1.8)));
}

function hasGreekScript(text: string): boolean {
  return /[\u0370-\u03FF\u1F00-\u1FFF]/.test(text);
}

function isCleanEnglishText(text: string | undefined | null): boolean {
  if (!text || !text.trim()) return false;
  return !hasGreekScript(text);
}

/**
 * Finds the best positive observations from the driver's stint telemetry so
 * the presentation always balances mistakes with what the driver did RIGHT.
 */
function extractStintPositives(
  report: RaceReport,
  track: TrackProfile
): string[] {
  const positives: string[] = [];

  if (report.consistencyPct >= 82) {
    positives.push(
      `Strong lap-to-lap pace consistency (${report.consistencyPct}%) across the stint.`
    );
  }
  if (report.trailBrakingScore >= 72) {
    positives.push(
      `Solid trail-braking control (${report.trailBrakingScore}/100) releasing pressure cleanly into entry.`
    );
  }
  if (report.pedalOverlapPct < 2.5) {
    positives.push(
      `Clean pedal separation (${report.pedalOverlapPct.toFixed(1)}% overlap) with crisp brake-to-throttle handoff.`
    );
  }
  if (report.mistakeCounts.offTracks === 0) {
    positives.push(
      'Zero track-limit warnings — disciplined line control inside white lines.'
    );
  }

  // Find cleanest corners on track
  const cleanCorners = [...report.cornerComparisons]
    .filter((c) => c.timeLostSec <= 0.06)
    .sort((a, b) => a.timeLostSec - b.timeLostSec)
    .slice(0, 2);

  for (const c of cleanCorners) {
    positives.push(
      `Strong execution through Turn ${c.cornerNumber} (${c.cornerName}) — matching Pro pace (${c.timeLostSec.toFixed(2)}s gap).`
    );
  }

  if (positives.length === 0) {
    const gap = Math.max(0, report.bestLapSec - report.referenceLapSec);
    positives.push(
      `Completed ${report.lapsCompleted} representative laps at ${track.name} with a ${formatLapTime(report.bestLapSec)} best (+${gap.toFixed(2)}s vs Pro).`
    );
  }

  return positives.slice(0, 3);
}

/**
 * Evaluates what went right and wrong at a single corner in chronological lap order.
 */
function buildCornerFeedback(
  comp: CornerComparison | null,
  fix: RaceMistakeFix | null,
  analysis: CornerDetailAnalysis
): {
  wentRight: string[];
  wentWrong: string[];
  howToFix: string[];
  narration: string;
} {
  const c = analysis.corner;
  const wentRight: string[] = [];
  const wentWrong: string[] = [];
  const howToFix: string[] = [];

  const brakeDelta = comp?.brakingDeltaMeters ?? 0;
  const apexDelta = comp?.minApexSpeedDeltaKmh ?? 0;
  const exitDelta = comp?.exitSpeedDeltaKmh ?? 0;
  const trailScore = comp?.trailBrakingScore ?? 75;
  const hasLockup = Boolean(comp && /lockup/i.test(comp.primaryIssue));

  // What went RIGHT in this corner
  if (Math.abs(brakeDelta) <= 4 && !hasLockup) {
    wentRight.push(
      `Initial braking point was right on target near the green reference board.`
    );
  }
  if (Math.abs(apexDelta) <= 3) {
    wentRight.push(
      `Carried strong apex speed right around the ${Math.round(c.targetApexSpeedKmh)} km/h target.`
    );
  }
  if (exitDelta >= -2) {
    wentRight.push(
      `Clean exit traction onto the straight with minimal speed loss.`
    );
  }
  if (trailScore >= 75) {
    wentRight.push(
      `Good brake release modulation into turn-in (trail score ${trailScore}/100).`
    );
  }
  if (wentRight.length === 0) {
    wentRight.push(
      `Clean corner commitment keeping the car pointed in Gear ${c.targetGear}.`
    );
  }

  // What went WRONG (guard against any legacy stored non-English detail)
  if (fix && isCleanEnglishText(fix.watchOutDetail)) {
    wentWrong.push(fix.watchOutDetail);
  } else if (comp) {
    if (hasLockup) {
      wentWrong.push(
        `Front wheel lockup during braking pushed the car wide of the apex kerb.`
      );
    } else if (brakeDelta >= 4) {
      wentWrong.push(
        `Braked ${brakeDelta}m past the green board, overshooting the ideal apex.`
      );
    } else if (brakeDelta <= -5) {
      wentWrong.push(
        `Braked ${Math.abs(brakeDelta)}m early, scrubbing entry momentum before turn-in.`
      );
    }
    if (exitDelta <= -3) {
      wentWrong.push(
        `Committed late to throttle, losing ${Math.abs(Math.round(exitDelta))} km/h down the exit straight.`
      );
    }
  }
  if (wentWrong.length === 0) {
    wentWrong.push(
      `Minor trajectory offset costing ${(comp?.timeLostSec ?? 0.08).toFixed(2)}s vs the ideal Pro line.`
    );
  }

  // How to FIX
  howToFix.push(analysis.changesSummary.brakingAction);
  howToFix.push(analysis.changesSummary.lineApexAction);
  howToFix.push(analysis.changesSummary.throttleAction);

  const timeLostText = comp && comp.timeLostSec > 0.03 ? comp.timeLostSec.toFixed(2) : '0.08';

  const narration = `Turn ${c.number}, ${c.name}. What worked well: ${wentRight[0]} What cost you ${timeLostText} seconds: ${wentWrong[0]} Here is the fix: ${analysis.changesSummary.brakingAction} ${analysis.changesSummary.throttleAction}`;

  return {
    wentRight,
    wentWrong,
    howToFix,
    narration,
  };
}

/**
 * Generates an ordered, voice-ready presentation deck (like slides / narrated video)
 * walking sequentially through the driver's lap: Overview -> Corners in lap order -> Action Plan & Gain.
 */
export function buildDebriefPresentationDeck(params: {
  report: RaceReport;
  track: TrackProfile;
  car: CarProfile;
  referenceSamples: ReferenceSample[];
  driverProfile?: DriverProfile;
  aiBrief?: AiPostRaceBrief | null;
  language?: 'en';
}): DebriefSlide[] {
  const { report, track, car, referenceSamples, driverProfile, aiBrief = report.aiBrief ?? null } = params;

  const slides: DebriefSlide[] = [];

  // ── SLIDE 1: Stint Overview ──
  const overviewPositives = extractStintPositives(report, track);
  const overviewWrong: string[] = [];
  if (report.mistakeCounts.lateBrakes > 0) {
    overviewWrong.push(
      `${report.mistakeCounts.lateBrakes} late-braking events compromising corner exits.`
    );
  }
  if (report.mistakeCounts.lockups > 0) {
    overviewWrong.push(
      `${report.mistakeCounts.lockups} front wheel lockup(s) under heavy braking.`
    );
  }
  if (report.mistakeCounts.exitSnaps > 0) {
    overviewWrong.push(
      `${report.mistakeCounts.exitSnaps} rear traction snap(s) accelerating out of corners.`
    );
  }
  if (overviewWrong.length === 0 && report.mistakeFixes[0] && isCleanEnglishText(report.mistakeFixes[0].watchOutDetail)) {
    overviewWrong.push(report.mistakeFixes[0].watchOutDetail);
  } else if (overviewWrong.length === 0 && report.cornerComparisons[0]) {
    const worst = [...report.cornerComparisons].sort((a, b) => b.timeLostSec - a.timeLostSec)[0];
    if (worst) {
      overviewWrong.push(
        `Time loss of ${worst.timeLostSec.toFixed(2)}s through Turn ${worst.cornerNumber} (${worst.cornerName}).`
      );
    }
  }

  const posKnown = Boolean(report.positionKnown && report.finishPosition >= 1);
  const posWordEn = report.positionsGained === 1 ? 'position' : 'positions';
  const gapToRef = Math.max(0, report.bestLapSec - report.referenceLapSec);
  const useAiOverview = Boolean(
    aiBrief?.executiveSummary && isCleanEnglishText(aiBrief.executiveSummary) && isCleanEnglishText(aiBrief.headline)
  );
  const overviewNarration = useAiOverview && aiBrief
    ? `${aiBrief.headline}. ${aiBrief.executiveSummary}`
    : `Welcome to your post-race debrief at ${track.name} in the ${car.name}. Your best lap was ${formatLapTime(report.bestLapSec)}, ${gapToRef.toFixed(2)} seconds off Pro pace with ${report.consistencyPct}% consistency. Let's walk through the lap in order to see what you nailed and where the time is. ${posKnown ? `That is about ${report.positionsGained} grid ${posWordEn}.` : 'No classified place came from the sim, so this stays pace only.'}`;

  slides.push({
    id: 'slide-overview',
    index: 0,
    kind: 'overview',
    chapterLabel: '01 · Stint Overview',
    title:
      (useAiOverview && aiBrief?.headline) ||
      `${track.name} — Stint Breakdown`,
    subtitle: `${car.name} · Best ${formatLapTime(report.bestLapSec)} · Consistency ${report.consistencyPct}%`,
    wentRight: overviewPositives,
    wentWrong: overviewWrong.slice(0, 3),
    howToFix: [
      `Applying the priority fixes saves -${report.fixableGainPerLapSec.toFixed(2)}s per lap (-${report.totalRaceTimeSavedSec.toFixed(1)}s over race distance).`,
      posKnown
        ? `Projected grid climb: P${report.finishPosition} up to P${report.projectedPosition} (+${report.positionsGained} ${posWordEn}).`
        : 'Position is not in the telemetry, so this is pace only.',
    ],
    timeGainLabel: `-${report.fixableGainPerLapSec.toFixed(2)}s / lap`,
    narrationText: overviewNarration,
    durationSec: estimateSpeechDurationSec(overviewNarration),
  });

  // ── SLIDES 2..N-1: Chronological Turn-by-Turn Lap Walkthrough ──
  const fixesByCorner = new Map<string, RaceMistakeFix>();
  for (const fix of report.mistakeFixes) {
    if (fix.cornerId) fixesByCorner.set(fix.cornerId, fix);
  }

  // Pick top 4 problem corners from cornerComparisons, then sort IN CHRONOLOGICAL LAP ORDER (cornerNumber ascending!)
  const prioritizedCorners = [...report.cornerComparisons]
    .sort((a, b) => b.timeLostSec - a.timeLostSec)
    .slice(0, 4)
    .sort((a, b) => a.cornerNumber - b.cornerNumber);

  // Fallback if cornerComparisons was empty: pick first 3 corners of track in order
  const cornerTargets: Array<{ cornerId: string; comp: CornerComparison | null }> =
    prioritizedCorners.length > 0
      ? prioritizedCorners.map((c) => ({ cornerId: c.cornerId, comp: c }))
      : track.corners.slice(0, 3).map((c) => ({ cornerId: c.id, comp: null }));

  cornerTargets.forEach((item, idx) => {
    const corner = track.corners.find((tc) => tc.id === item.cornerId) ?? track.corners[0];
    if (!corner) return;

    const fix = fixesByCorner.get(corner.id) ?? null;
    const bestPass = report.bestCornerPasses?.find((bp) => bp.cornerId === corner.id);
    const analysis = buildCornerLineAnalysis({
      track,
      car,
      corner,
      comparison: item.comp,
      referenceSamples,
      driverFrames: report.representativeFrames,
      driverProfile,
      bestCornerPassFrames: bestPass?.frames,
      bestCornerPassTimeSec: bestPass?.timeSec,
      greenLineMode: 'auto',
      language: 'en',
    });

    const feedback = buildCornerFeedback(item.comp, fix, analysis);
    const timeGainSec = item.comp ? Math.max(0.04, item.comp.timeLostSec * 0.88) : 0.12;
    const safeSetupHint =
      analysis.changesSummary.setupHint ??
      (isCleanEnglishText(fix?.setupTweak) ? fix?.setupTweak : undefined);

    slides.push({
      id: `slide-corner-${corner.id}`,
      index: idx + 1,
      kind: 'corner',
      chapterLabel: `0${idx + 2} · Turn ${corner.number}`,
      title: `Turn ${corner.number} — ${corner.name}`,
      subtitle: `Sector ${corner.sector} · Target Apex ${Math.round(corner.targetApexSpeedKmh)} km/h · Gear ${corner.targetGear}`,
      cornerId: corner.id,
      cornerNumber: corner.number,
      cornerAnalysis: analysis,
      wentRight: feedback.wentRight,
      wentWrong: feedback.wentWrong,
      howToFix: feedback.howToFix,
      timeGainLabel: `-${timeGainSec.toFixed(2)}s`,
      setupHint: safeSetupHint,
      narrationText: feedback.narration,
      durationSec: estimateSpeechDurationSec(feedback.narration),
    });
  });

  // ── FINAL SLIDE: Summary, Setup Changes & Position Gain Verdict ──
  const cornerSlideFixes = slides
    .filter((s) => s.kind === 'corner')
    .slice(0, 3)
    .map((s) => `${s.title}: ${s.howToFix[s.howToFix.length - 1] || s.howToFix[0]}`);

  const summaryFixes =
    aiBrief?.actionPlan &&
    aiBrief.actionPlan.length > 0 &&
    isCleanEnglishText(aiBrief.actionPlan[0].howToFix)
      ? aiBrief.actionPlan.slice(0, 3).map((a) => `${a.step}: ${a.howToFix}`)
      : report.mistakeFixes.some((f) => isCleanEnglishText(f.howToFix))
        ? report.mistakeFixes
            .filter((f) => isCleanEnglishText(f.howToFix))
            .slice(0, 3)
            .map((f) => `${f.cornerLabel}: ${f.howToFix}`)
        : cornerSlideFixes;

  const summaryWatchOuts =
    aiBrief?.watchOutFor &&
    aiBrief.watchOutFor.length > 0 &&
    isCleanEnglishText(aiBrief.watchOutFor[0].detail)
      ? aiBrief.watchOutFor.slice(0, 3).map((w) => `${w.title} — ${w.detail}`)
      : report.mistakeFixes.some((f) => isCleanEnglishText(f.watchOutDetail))
        ? report.mistakeFixes
            .filter((f) => isCleanEnglishText(f.watchOutDetail))
            .slice(0, 2)
            .map((f) => f.watchOutDetail)
        : slides
            .filter((s) => s.kind === 'corner')
            .slice(0, 2)
            .map((s) => `${s.title}: ${s.wentWrong[0]}`);

  const summarySetupTweaks = report.mistakeFixes
    .map((f) => f.setupTweak)
    .filter((s): s is string => isCleanEnglishText(s));

  const aiSummarySpeech = `${aiBrief?.positionGainVerdict || ''} ${aiBrief?.spokenSummary || ''}`.trim();
  const useAiSummarySpeech = Boolean(
    aiSummarySpeech && isCleanEnglishText(aiSummarySpeech)
  );
  const targetBestSec =
    report.provenBestLapSec ??
    Math.max(report.referenceLapSec * 0.996, report.bestLapSec - report.fixableGainPerLapSec);
  const summaryNarration = useAiSummarySpeech
    ? aiSummarySpeech
    : `To wrap up: locking in these fixes drops your lap toward ${formatLapTime(targetBestSec)}, saving ${report.totalRaceTimeSavedSec.toFixed(1)} seconds over the race distance${posKnown ? ` and climbing from P${report.finishPosition} to P${report.projectedPosition}.` : '. Position was not sent by the sim.'}`;

  slides.push({
    id: 'slide-summary',
    index: slides.length,
    kind: 'summary',
    chapterLabel: `0${slides.length + 1} · Action Plan & Gain`,
    title: posKnown
      ? `Final Action Plan: P${report.finishPosition} → P${report.projectedPosition} (+${report.positionsGained} ${report.positionsGained === 1 ? 'spot' : 'spots'})`
      : `Final Action Plan: -${report.fixableGainPerLapSec.toFixed(2)}s per lap`,
    subtitle: `Total pace gain -${report.fixableGainPerLapSec.toFixed(2)}s / lap (-${report.totalRaceTimeSavedSec.toFixed(1)}s total race time)`,
    wentRight: overviewPositives.slice(0, 2),
    wentWrong: summaryWatchOuts,
    howToFix: summaryFixes,
    timeGainLabel: posKnown
      ? `+${report.positionsGained} ${posWordEn}`
      : `-${report.fixableGainPerLapSec.toFixed(2)}s / lap`,
    setupHint: summarySetupTweaks[0],
    narrationText: summaryNarration,
    durationSec: estimateSpeechDurationSec(summaryNarration),
  });

  return slides;
}
