import { useState, useMemo, useEffect } from 'react';
import {
  AlertTriangle,
  Award,
  CheckSquare,
  FilePlus2,
  Film,
  Sparkles,
  Square,
  Trash2,
  TrendingUp,
  Volume2,
  Wrench,
} from 'lucide-react';
import { extractAndPublishAiStatus } from '../utils/aiStatus';
import type { AiPostRaceBrief, CoachSettings, DriverProfile, RaceReport } from '../types/telemetry';
import { formatDelta, formatLapTime } from '../engine/coachRules';
import { recalculateReportProjection } from '../engine/raceReport';
import { formatSessionTypeLabel } from '../engine/sessionPhase';
import { TRACKS } from '../data/circuitsAndCars';
import { PostRaceLineMap } from './PostRaceLineMap';
import { AiDebriefPresentationModal } from './AiDebriefPresentationModal';
import { unlockAudioPlayback } from '../utils/radioAudio';

interface RaceReportsViewProps {
  reports: RaceReport[];
  activeTrackName: string;
  activeCarName: string;
  capturedLapsCount: number;
  language?: 'en';
  coachSettings?: CoachSettings;
  driverProfile?: DriverProfile;
  onGenerateReport: () => void;
  onUpdateReportAiBrief: (reportId: string, brief: AiPostRaceBrief) => void;
  onDeleteReport: (reportId: string) => void;
  onSpeakText: (text: string) => void;
  onOpenTelemetry?: () => void;
}

const GREEK_SCRIPT_RE = /[\u0370-\u03FF\u1F00-\u1FFF]/;

export function RaceReportsView({
  reports,
  activeTrackName,
  activeCarName,
  capturedLapsCount,
  coachSettings,
  driverProfile,
  onGenerateReport,
  onUpdateReportAiBrief,
  onDeleteReport,
  onSpeakText,
  onOpenTelemetry,
}: RaceReportsViewProps) {
  const [selectedReportId, setSelectedReportId] = useState<string>(reports[0]?.id ?? '');
  const [enabledFixIds, setEnabledFixIds] = useState<string[]>([]);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [selectedCornerId, setSelectedCornerId] = useState<string>('');
  const [isPresentationOpen, setIsPresentationOpen] = useState(false);

  useEffect(() => {
    if (reports.length === 0) {
      setSelectedReportId('');
      return;
    }
    if (!reports.some((r) => r.id === selectedReportId)) {
      setSelectedReportId(reports[0].id);
    }
  }, [reports, selectedReportId]);

  const selectedReport =
    reports.find((r) => r.id === selectedReportId) ?? reports[0] ?? null;
  const englishAiBrief =
    selectedReport?.aiBrief && !GREEK_SCRIPT_RE.test(JSON.stringify(selectedReport.aiBrief))
      ? selectedReport.aiBrief
      : null;

  useEffect(() => {
    if (!selectedReport) {
      setEnabledFixIds([]);
      setSelectedCornerId('');
      return;
    }
    setEnabledFixIds(selectedReport.mistakeFixes.map((f) => f.id));
    const reportTrack = TRACKS.find((t) => t.id === selectedReport.trackId) ?? TRACKS[0];
    const topCornerId =
      selectedReport.mistakeFixes.find((f) => f.cornerId)?.cornerId ??
      [...selectedReport.cornerComparisons].sort((a, b) => b.timeLostSec - a.timeLostSec)[0]
        ?.cornerId ??
      reportTrack.corners[0]?.id ??
      '';
    setSelectedCornerId(topCornerId);
    setAiError(null);
  }, [selectedReport?.id]);

  const projection = useMemo(() => {
    if (!selectedReport) return null;
    return recalculateReportProjection(selectedReport, enabledFixIds);
  }, [selectedReport, enabledFixIds]);

  const toggleFix = (fixId: string) => {
    setEnabledFixIds((prev) =>
      prev.includes(fixId) ? prev.filter((id) => id !== fixId) : [...prev, fixId]
    );
  };

  const handleGenerateAiDebrief = async () => {
    if (!selectedReport) return;
    unlockAudioPlayback();
    // Open the sequential speaking presentation immediately so the user sees slides & corner replay right away
    setIsPresentationOpen(true);
    setIsGeneratingAi(true);
    setAiError(null);
    try {
      const resp = await fetch('/api/coach/post-race-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report: selectedReport,
          language: 'en',
        }),
      });
      const data = await resp.json();
      extractAndPublishAiStatus(resp.status, data);
      if (!resp.ok || !data.brief) {
        setAiError(data.error || 'Could not generate AI post-race debrief.');
      } else {
        onUpdateReportAiBrief(selectedReport.id, data.brief as AiPostRaceBrief);
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Network error contacting AI engineer.');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const formatReportTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-GB', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Top Action Header */}
      <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-100">
              Post-Race Reports & Position Gain Lab
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              {`Auto-saved when a live race/stint ends · Current session: ${activeTrackName} (${activeCarName}) · Captured laps: ${capturedLapsCount}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onOpenTelemetry && (
              <button
                type="button"
                onClick={onOpenTelemetry}
                data-testid="open-telemetry-lab-btn"
                className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-300 hover:border-cyan-500/50 hover:text-slate-100 cursor-pointer whitespace-nowrap"
              >
                Telemetry Lab
              </button>
            )}
            <button
              type="button"
              onClick={onGenerateReport}
              data-testid="generate-race-report-btn"
              className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
            >
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Generate Report from Current Stint</span>
            </button>
          </div>
        </div>
      </section>

      {!selectedReport || !projection ? (
        <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-8 text-center">
          <Award className="mx-auto h-9 w-9 text-cyan-400" aria-hidden="true" />
          <h2 className="mt-3 font-display text-lg font-semibold text-slate-100">
            No Saved Post-Race Reports Yet
          </h2>
          <p className="mx-auto mt-1.5 max-w-xl text-xs leading-relaxed text-slate-400">
            Finish a stint in your simulator or generate a report right now to inspect corner mistakes, exact fixes, and how much lap time and grid ground you gain.
          </p>
          <button
            type="button"
            onClick={onGenerateReport}
            data-testid="empty-generate-race-report-btn"
            className="mt-5 inline-flex items-center gap-2 rounded-md bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
          >
            <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Generate Report from Current Stint</span>
          </button>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left Archive List */}
          <aside className="rounded-lg border border-[#1B2230] bg-[#10141D] p-4 lg:col-span-4">
            <div className="mb-3 flex items-center justify-between border-b border-[#1B2230] pb-2.5">
              <h2 className="font-display text-sm font-semibold text-slate-100">
                {`Session Archive (${reports.length})`}
              </h2>
              <span className="font-mono text-[11px] text-slate-500">Select report</span>
            </div>

            <div className="space-y-2">
              {reports.map((rep) => {
                const active = rep.id === selectedReport.id;
                return (
                  <div
                    key={rep.id}
                    className={`rounded-md border p-3 transition-colors ${
                      active
                        ? 'border-cyan-400 bg-cyan-500/10'
                        : 'border-[#1B2230] bg-[#090B10] hover:border-[#2C374C]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedReportId(rep.id)}
                        className="flex-1 text-left cursor-pointer"
                      >
                        <div className="font-display text-xs font-semibold text-slate-100 truncate">
                          {rep.trackName}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-400 truncate">
                          {rep.carName} · {formatReportTime(rep.createdAtIso)}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums">
                          {formatSessionTypeLabel(rep.sessionType) && (
                            <span
                              className={
                                rep.sessionType === 'race'
                                  ? 'text-emerald-400 font-semibold'
                                  : rep.sessionType === 'qualifying'
                                    ? 'text-amber-300 font-semibold'
                                    : 'text-cyan-300 font-semibold'
                              }
                            >
                              {formatSessionTypeLabel(rep.sessionType)}
                            </span>
                          )}
                          <span className="text-slate-300">
                            {rep.lapsCompleted}L · {formatLapTime(rep.bestLapSec)}
                          </span>
                          <span className="text-emerald-400 font-semibold">
                            {rep.fieldSize <= 1
                              ? `Solo · -${rep.fixableGainPerLapSec.toFixed(2)}s/L`
                              : !rep.positionKnown || rep.finishPosition < 1
                                ? `Pace · -${rep.fixableGainPerLapSec.toFixed(2)}s/L`
                                : `P${rep.finishPosition} → P${rep.projectedPosition} (+${rep.positionsGained})`}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteReport(rep.id)}
                        aria-label="Delete report"
                        className="rounded p-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-300 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>

          {/* Right Detailed Post-Race Report Stage */}
          <div className="flex flex-col gap-5 lg:col-span-8">
            {/* Hero Position & Time Gain Strip */}
            <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3.5">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wider text-cyan-400">
                    {selectedReport.simName} · {selectedReport.carClass} ·{' '}
                    {formatSessionTypeLabel(selectedReport.sessionType)
                      ? `${formatSessionTypeLabel(selectedReport.sessionType)} Session`
                      : selectedReport.sessionMode === 'live_race'
                        ? 'Live Session Telemetry'
                        : 'Practice Stint Telemetry'}
                  </div>
                  <h2 className="mt-0.5 font-display text-lg font-bold text-slate-100">
                    {selectedReport.trackName} — {selectedReport.carName}
                  </h2>
                </div>
                <div className="font-mono text-xs text-slate-400 tabular-nums">
                  Consistency:{' '}
                  <span className="font-semibold text-slate-100">
                    {selectedReport.consistencyPct}%
                  </span>{' '}
                  · Trail-Brake:{' '}
                  <span className="font-semibold text-cyan-400">
                    {selectedReport.trailBrakingScore}/100
                  </span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 divide-y divide-[#1B2230] rounded-md border border-[#1B2230] bg-[#090B10] font-mono tabular-nums sm:grid-cols-5 sm:divide-x sm:divide-y-0">
                <div className="px-3.5 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    Current Best
                  </div>
                  <div className="mt-0.5 text-base font-bold text-slate-100">
                    {formatLapTime(selectedReport.bestLapSec)}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Ref {formatLapTime(selectedReport.referenceLapSec)}
                  </div>
                  {selectedReport.provenBestLapSec != null && (
                    <div className="text-[10px] text-emerald-300" data-testid="proven-best-lap-subline">
                      Your corners {formatLapTime(selectedReport.provenBestLapSec)}
                      {selectedReport.provenGainSec ? ` (−${selectedReport.provenGainSec.toFixed(2)}s)` : ''}
                    </div>
                  )}
                </div>

                <div className="px-3.5 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    Projected Best
                  </div>
                  <div className="mt-0.5 text-base font-bold text-cyan-300">
                    {formatLapTime(projection.projectedBestLapSec)}
                  </div>
                  <div className="text-[10px] text-slate-500">With selected fixes</div>
                </div>

                <div className="px-3.5 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    Time Gain / Lap
                  </div>
                  <div className="mt-0.5 text-base font-bold text-emerald-400">
                    -{projection.selectedGainPerLapSec.toFixed(2)}s
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {enabledFixIds.length}/{selectedReport.mistakeFixes.length} fixes active
                  </div>
                </div>

                <div className="px-3.5 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    {`Race Gain (${selectedReport.raceDistanceLaps}L)`}
                  </div>
                  <div className="mt-0.5 text-base font-bold text-emerald-400">
                    -{projection.totalRaceTimeSavedSec.toFixed(1)}s
                  </div>
                  <div className="text-[10px] text-slate-500">Over full race stint</div>
                </div>

                <div className="px-3.5 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    {selectedReport.fieldSize <= 1
                      ? 'Session Format'
                      : !selectedReport.positionKnown || selectedReport.finishPosition < 1
                        ? 'Pace Analysis'
                        : 'Grid Positions Gain'}
                  </div>
                  <div
                    className="mt-0.5 text-base font-bold text-amber-300"
                    data-testid="projected-position-readout"
                  >
                    {selectedReport.fieldSize <= 1
                      ? 'Single Player'
                      : !selectedReport.positionKnown || selectedReport.finishPosition < 1
                        ? 'Pace Only'
                        : `P${selectedReport.finishPosition} → P${projection.projectedPosition}`}
                  </div>
                  <div className="text-[10px] font-semibold text-emerald-400">
                    {selectedReport.fieldSize <= 1
                      ? `Solo pace · -${projection.selectedGainPerLapSec.toFixed(2)}s/lap potential`
                      : !selectedReport.positionKnown || selectedReport.finishPosition < 1
                        ? `Grid pos live-race only · -${projection.selectedGainPerLapSec.toFixed(2)}s/L`
                        : `+${projection.positionsGained} ${
                            projection.positionsGained === 1 ? 'position gained' : 'positions gained'
                          }`}
                  </div>
                </div>
              </div>
            </section>

            {/* Detailed Corner Racing Line Map (Red vs Green + Braking & Throttle Points) */}
            <PostRaceLineMap
              report={selectedReport}
              selectedCornerId={selectedCornerId}
              onSelectCorner={setSelectedCornerId}
              driverProfile={driverProfile}
              language="en"
            />

            {/* AI Chief Engineer Post-Race Debrief */}
            <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3.5">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    AI Chief Engineer — Post-Race Verdict & Action Plan
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    What to watch out for and how to fix it. Position is shown only when the sim sent a place.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      unlockAudioPlayback();
                      setIsPresentationOpen(true);
                    }}
                    data-testid="open-presentation-btn"
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-500/40 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
                  >
                    <Film className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                    <span>Slide Presentation</span>
                  </button>
                  {englishAiBrief?.spokenSummary && (
                    <button
                      type="button"
                      onClick={() => onSpeakText(englishAiBrief.spokenSummary)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-500/40 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
                    >
                      <Volume2 className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                      <span>Read Aloud</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleGenerateAiDebrief}
                    disabled={isGeneratingAi}
                    data-testid="generate-ai-report-btn"
                    className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3.5 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500 hover:text-slate-950 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {isGeneratingAi
                        ? 'Analyzing...'
                        : englishAiBrief
                          ? 'Refresh AI Debrief'
                          : 'Generate AI Deep Debrief'}
                    </span>
                  </button>
                </div>
              </div>

              {aiError && (
                <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
                  {aiError}
                </div>
              )}

              {englishAiBrief ? (
                <div className="mt-4 space-y-4" data-testid="ai-post-race-brief">
                  <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
                    <div className="font-display text-sm font-semibold text-cyan-300">
                      {englishAiBrief.headline}
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-200">
                      {englishAiBrief.executiveSummary}
                    </p>
                    <div className="mt-2.5 flex items-center gap-2 text-xs font-medium text-emerald-400">
                      <TrendingUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{englishAiBrief.positionGainVerdict}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
                      <div className="mb-2 flex items-center gap-1.5 font-display text-xs font-semibold uppercase tracking-wider text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>What to Watch Out For</span>
                      </div>
                      <ul className="divide-y divide-[#1B2230] text-xs">
                        {englishAiBrief.watchOutFor?.map((w, i) => (
                          <li key={i} className="py-2 first:pt-0 last:pb-0">
                            <div className="font-semibold text-slate-100">{w.title}</div>
                            <p className="mt-0.5 text-slate-400">{w.detail}</p>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
                      <div className="mb-2 flex items-center gap-1.5 font-display text-xs font-semibold uppercase tracking-wider text-emerald-400">
                        <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Step-by-Step Fix Plan</span>
                      </div>
                      <ul className="divide-y divide-[#1B2230] text-xs">
                        {englishAiBrief.actionPlan?.map((a, i) => (
                          <li key={i} className="py-2 first:pt-0 last:pb-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-100">{a.step}</span>
                              {typeof a.expectedGainSec === 'number' && (
                                <span className="font-mono text-emerald-400 tabular-nums shrink-0">
                                  -{a.expectedGainSec.toFixed(2)}s
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-slate-400">{a.howToFix}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-400">
                  Quantitative telemetry & position gains are ready below. Click Generate AI Deep Debrief for personalized Chief Engineer commentary.
                </p>
              )}
            </section>

            {/* Interactive Mistake-Fix Simulator */}
            <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    Mistake Breakdown & What-If Position Simulator
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Toggle each mistake fix below to preview exact lap time and grid position gains.
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400 tabular-nums">
                  <span>Late Brake: {selectedReport.mistakeCounts.lateBrakes}</span>
                  <span>Lockups: {selectedReport.mistakeCounts.lockups}</span>
                  <span>Exit Snaps: {selectedReport.mistakeCounts.exitSnaps}</span>
                  <span>Off-Tracks: {selectedReport.mistakeCounts.offTracks}</span>
                </div>
              </div>

              <div className="divide-y divide-[#1B2230] rounded-md border border-[#1B2230] bg-[#090B10]">
                {selectedReport.mistakeFixes.map((fix) => {
                  const enabled = enabledFixIds.includes(fix.id);
                  return (
                    <div
                      key={fix.id}
                      className={`p-4 transition-colors hover:bg-[#141A26] ${
                        enabled ? '' : 'opacity-55'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => toggleFix(fix.id)}
                          aria-pressed={enabled}
                          className="flex flex-1 min-w-0 items-start gap-3 text-left cursor-pointer"
                        >
                          {enabled ? (
                            <CheckSquare
                              className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400"
                              aria-hidden="true"
                            />
                          ) : (
                            <Square
                              className="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
                              aria-hidden="true"
                            />
                          )}
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-display text-sm font-semibold text-slate-100">
                                {fix.mistakeTitle}
                              </span>
                              <span className="font-mono text-[11px] text-cyan-400">
                                {fix.cornerLabel}
                              </span>
                              {fix.severity === 'high' && (
                                <span className="font-mono text-[11px] font-medium text-rose-400">
                                  · High impact
                                </span>
                              )}
                            </div>

                            <p className="mt-1.5 text-xs text-amber-200/90">
                              <span className="font-semibold text-amber-300">
                                Watch out:{' '}
                              </span>
                              {fix.watchOutDetail}
                            </p>
                            <p className="mt-1 text-xs text-slate-300">
                              <span className="font-semibold text-emerald-400">
                                How to fix:{' '}
                              </span>
                              {fix.howToFix}
                            </p>
                            {fix.setupTweak && (
                              <p className="mt-1 font-mono text-[11px] text-cyan-300">
                                Setup: {fix.setupTweak}
                              </p>
                            )}
                          </div>
                        </button>

                        <div className="flex flex-col items-end gap-1.5 text-right font-mono tabular-nums shrink-0">
                          <div>
                            <div className="text-sm font-bold text-emerald-400">
                              -{fix.timeGainPerLapSec.toFixed(2)}s
                            </div>
                            <div className="text-[10px] text-slate-500">per lap</div>
                          </div>
                          {fix.cornerId && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedCornerId(fix.cornerId!);
                                document
                                  .querySelector('[data-testid="post-race-line-map"]')
                                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                              }}
                              className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/20 cursor-pointer"
                            >
                              Show on Map ↑
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Lap Consistency Table */}
            {selectedReport.lapSummaries.length > 0 && (
              <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Lap-by-Lap Consistency Breakdown
                </h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-[#1B2230] text-[11px] uppercase tracking-wider text-slate-400">
                        <th className="py-2 pr-4 font-medium">Lap</th>
                        <th className="px-3 py-2 text-right font-medium">Time</th>
                        <th className="px-3 py-2 text-right font-medium">Gap vs Pro</th>
                        <th className="px-3 py-2 text-right font-medium">Trail Score</th>
                        <th className="py-2 pl-4 text-right font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1B2230] font-mono tabular-nums">
                      {selectedReport.lapSummaries.map((lap) => (
                        <tr key={lap.lapNumber} className="hover:bg-[#161C28]">
                          <td className="py-2 pr-4 text-slate-200">Lap {lap.lapNumber}</td>
                          <td className="px-3 py-2 text-right text-slate-100">
                            {formatLapTime(lap.lapTimeSec)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right ${
                              lap.deltaToRefSec > 1.5 ? 'text-amber-400' : 'text-cyan-300'
                            }`}
                          >
                            {formatDelta(lap.deltaToRefSec)}
                          </td>
                          <td className="px-3 py-2 text-right text-cyan-400">
                            {lap.trailBrakeScore}/100
                          </td>
                          <td
                            className={`py-2 pl-4 text-right ${
                              lap.valid ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {lap.valid ? 'Valid' : 'Off-Track'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {selectedReport && (
        <AiDebriefPresentationModal
          isOpen={isPresentationOpen}
          onClose={() => setIsPresentationOpen(false)}
          report={selectedReport}
          driverProfile={driverProfile}
          language="en"
          isGeneratingAi={isGeneratingAi}
          aiError={aiError}
          coachSettings={coachSettings}
        />
      )}
    </div>
  );
}
