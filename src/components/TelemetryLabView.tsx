import { useState, useMemo, useEffect, useId } from 'react';
import { Sparkles, Target, Volume2, ZoomIn, Maximize2 } from 'lucide-react';
import { extractAndPublishAiStatus } from '../utils/aiStatus';
import type {
  CarProfile,
  CarSetup,
  CornerComparison,
  LapRecord,
  ReferenceSample,
  TrackProfile,
} from '../types/telemetry';
import {
  analyzeLapByCorners,
  evaluateDriverSkillMetrics,
  formatDelta,
  formatLapTime,
} from '../engine/coachRules';
import {
  FULL_LAP_DOMAIN,
  computeCornerZoomDomain,
  computeDeltaTraceSeries,
  findNearestIndexByPct,
  projectPctToSvgX,
  sampleReferencePedalAtPct,
  svgRatioToPct,
} from '../engine/telemetryWorkbook';
import { interpolateTrackPose } from '../engine/trackMapRadar';

interface TelemetryLabViewProps {
  simName: string;
  track: TrackProfile;
  car: CarProfile;
  setup: CarSetup;
  lap: LapRecord;
  recordedLap?: LapRecord | null;
  referenceSamples: ReferenceSample[];
  language?: 'en';
  onSpeakText: (text: string) => void;
}

interface AiLapAnalysis {
  headline?: string;
  spokenSummary?: string;
  topTimeLossCorners?: Array<{
    cornerName: string;
    diagnosis: string;
    fix: string;
  }>;
  setupTweaks?: string[];
}

export function TelemetryLabView({
  simName,
  track,
  car,
  setup,
  lap,
  recordedLap = null,
  referenceSamples,
  language = 'en',
  onSpeakText,
}: TelemetryLabViewProps) {
  const [lapSource, setLapSource] = useState<'recorded' | 'sample'>(
    recordedLap && recordedLap.frames.length >= 20 ? 'recorded' : 'sample'
  );
  const [selectedCornerId, setSelectedCornerId] = useState<string>(track.corners[0]?.id ?? '');
  const [traceScope, setTraceScope] = useState<'lap' | 'corner'>('lap');
  const [showSteeringTrace, setShowSteeringTrace] = useState(true);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiLapAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const clipPrefix = useId().replace(/:/g, '');

  const hasRecordedLap = Boolean(recordedLap && recordedLap.frames.length >= 20);

  useEffect(() => {
    setSelectedCornerId(track.corners[0]?.id ?? '');
    setAiAnalysis(null);
    setAnalyzeError(null);
  }, [track.id, track.corners]);

  useEffect(() => {
    if (!hasRecordedLap && lapSource === 'recorded') {
      setLapSource('sample');
    }
  }, [hasRecordedLap, lapSource]);

  const activeLap = lapSource === 'recorded' && hasRecordedLap && recordedLap ? recordedLap : lap;

  const cornerComparisons = useMemo<CornerComparison[]>(() => {
    return analyzeLapByCorners(activeLap.frames, referenceSamples, track);
  }, [activeLap.frames, referenceSamples, track]);

  const skillMetrics = useMemo(() => {
    return evaluateDriverSkillMetrics(activeLap.frames, cornerComparisons, language);
  }, [activeLap.frames, cornerComparisons, language]);

  const selectedCorner =
    track.corners.find((c) => c.id === selectedCornerId) ?? track.corners[0];
  const selectedComparison =
    cornerComparisons.find((c) => c.cornerId === selectedCorner?.id) ?? cornerComparisons[0];

  const domain = useMemo(
    () =>
      traceScope === 'corner' && selectedCorner
        ? computeCornerZoomDomain(selectedCorner, 0.035, 0.09)
        : FULL_LAP_DOMAIN,
    [traceScope, selectedCorner]
  );

  const deltaSeries = useMemo(
    () => computeDeltaTraceSeries(activeLap.frames, referenceSamples, track.lengthKm),
    [activeLap.frames, referenceSamples, track.lengthKm]
  );

  const width = 960;
  const speedHeight = 136;
  const deltaHeight = 82;
  const pedalHeight = 114;

  const userSpeedPath = useMemo(() => {
    if (activeLap.frames.length === 0) return '';
    return activeLap.frames
      .map((f, idx) => {
        const x = projectPctToSvgX(f.lapDistPct, domain, width);
        const y =
          speedHeight -
          (Math.min(car.topSpeedKmh + 10, f.speedKmh) / (car.topSpeedKmh + 15)) *
            (speedHeight - 16) -
          8;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [activeLap.frames, car.topSpeedKmh, domain]);

  const refSpeedPath = useMemo(() => {
    if (referenceSamples.length === 0) return '';
    return referenceSamples
      .map((r, idx) => {
        const x = projectPctToSvgX(r.pct, domain, width);
        const y =
          speedHeight -
          (Math.min(car.topSpeedKmh + 10, r.speedKmh) / (car.topSpeedKmh + 15)) *
            (speedHeight - 16) -
          8;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [referenceSamples, car.topSpeedKmh, domain]);

  const deltaTPath = useMemo(() => {
    if (deltaSeries.points.length === 0) return '';
    const midY = deltaHeight / 2;
    const halfAmp = (deltaHeight - 18) / 2;
    const scale = Math.max(0.25, deltaSeries.maxAbsDeltaSec);
    return deltaSeries.points
      .map((pt, idx) => {
        const x = projectPctToSvgX(pt.pct, domain, width);
        // Negative delta = faster than ref -> plot ABOVE zero baseline cleanly
        const y = midY + (pt.deltaSec / scale) * halfAmp;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [deltaSeries, domain]);

  const userThrottlePath = useMemo(() => {
    if (activeLap.frames.length === 0) return '';
    return activeLap.frames
      .map((f, idx) => {
        const x = projectPctToSvgX(f.lapDistPct, domain, width);
        const y = pedalHeight - f.throttle * (pedalHeight - 16) - 8;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [activeLap.frames, domain]);

  const refThrottlePath = useMemo(() => {
    if (referenceSamples.length === 0) return '';
    return referenceSamples
      .map((r, idx) => {
        const x = projectPctToSvgX(r.pct, domain, width);
        const y = pedalHeight - r.throttle * (pedalHeight - 16) - 8;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [referenceSamples, domain]);

  const userBrakePath = useMemo(() => {
    if (activeLap.frames.length === 0) return '';
    return activeLap.frames
      .map((f, idx) => {
        const x = projectPctToSvgX(f.lapDistPct, domain, width);
        const y = pedalHeight - f.brake * (pedalHeight - 16) - 8;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [activeLap.frames, domain]);

  const refBrakePath = useMemo(() => {
    if (referenceSamples.length === 0) return '';
    return referenceSamples
      .map((r, idx) => {
        const x = projectPctToSvgX(r.pct, domain, width);
        const y = pedalHeight - r.brake * (pedalHeight - 16) - 8;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [referenceSamples, domain]);

  const userSteerPath = useMemo(() => {
    if (activeLap.frames.length === 0) return '';
    return activeLap.frames
      .map((f, idx) => {
        const x = projectPctToSvgX(f.lapDistPct, domain, width);
        const normSteer = Math.max(-1, Math.min(1, f.steeringRad / 0.65));
        const y = pedalHeight / 2 - normSteer * ((pedalHeight - 20) / 2);
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [activeLap.frames, domain]);

  const hoverUserFrame = useMemo(() => {
    if (hoverPct === null || activeLap.frames.length === 0) return null;
    const idx = findNearestIndexByPct(activeLap.frames, hoverPct);
    return idx >= 0 ? activeLap.frames[idx] : null;
  }, [hoverPct, activeLap.frames]);

  const hoverRefSample = useMemo(() => {
    if (hoverPct === null || referenceSamples.length === 0) return null;
    return sampleReferencePedalAtPct(referenceSamples, hoverPct);
  }, [hoverPct, referenceSamples]);

  const hoverDeltaSec = useMemo(() => {
    if (hoverPct === null || deltaSeries.points.length === 0) return null;
    const idx = findNearestIndexByPct(deltaSeries.points, hoverPct);
    return idx >= 0 ? deltaSeries.points[idx].deltaSec : null;
  }, [hoverPct, deltaSeries.points]);

  const hoverSvgX = hoverPct !== null ? projectPctToSvgX(hoverPct, domain, width) : null;

  const activeCursorPct = hoverPct ?? selectedCorner?.apexPct ?? 0;
  const activeCursorPose = useMemo(
    () => interpolateTrackPose(track, activeCursorPct),
    [track, activeCursorPct]
  );
  const selectedCornerPose = useMemo(
    () => (selectedCorner ? interpolateTrackPose(track, selectedCorner.apexPct) : null),
    [track, selectedCorner]
  );

  const handleAnalyzeLap = async () => {
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const resp = await fetch('/api/coach/analyze-lap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          simName,
          trackName: track.name,
          carName: car.name,
          lapTimeFormatted: formatLapTime(activeLap.lapTimeSec),
          cornerComparisons,
          setup,
        }),
      });
      const data = await resp.json();
      extractAndPublishAiStatus(resp.status, data);
      if (!resp.ok) {
        setAnalyzeError(data.error || 'Could not analyze lap telemetry.');
      } else {
        setAiAnalysis(data);
      }
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Network error analyzing lap.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="telemetry-lab-view">
      {/* Top Lap Summary & Trophi.ai Skill Strip */}
      <section
        data-testid="debrief-mode-banner"
        className="rounded-2xl border border-cyan-500/25 bg-gradient-to-r from-[#0A1620] via-[#10141D] to-[#0B0F17] p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1B2230] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-cyan-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-950">
                Debrief
              </span>
              <h1 className="font-display text-xl font-bold text-slate-100">
                Telemetry Trace &amp; Corner Analysis
              </h1>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              {track.name} · {car.name} ·{' '}
              {lapSource === 'recorded' && hasRecordedLap
                ? `Recorded Driver Lap ${activeLap.lapNumber}`
                : `Practice Sample Lap ${activeLap.lapNumber}`}{' '}
              vs Pro Ref ({formatLapTime(track.referenceLapTimeSec)})
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Lap Source Switcher */}
            <div
              className="inline-flex rounded-md border border-[#273145] bg-[#090B10] p-0.5 text-xs"
              role="tablist"
              aria-label="Lap telemetry source"
            >
              <button
                type="button"
                role="tab"
                aria-selected={lapSource === 'recorded'}
                disabled={!hasRecordedLap}
                onClick={() => setLapSource('recorded')}
                title={
                  hasRecordedLap
                    ? 'Compare your last completed driven lap'
                    : 'Complete 1 full lap to unlock recorded trace'
                }
                className={`rounded px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
                  lapSource === 'recorded' && hasRecordedLap
                    ? 'bg-cyan-500/20 text-cyan-200'
                    : hasRecordedLap
                      ? 'text-slate-400 hover:text-slate-200 cursor-pointer'
                      : 'text-slate-600 cursor-not-allowed'
                }`}
              >
                Last Driven Lap
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={lapSource === 'sample'}
                onClick={() => setLapSource('sample')}
                className={`rounded px-2.5 py-1 font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  lapSource === 'sample'
                    ? 'bg-cyan-500/20 text-cyan-200'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Practice Sample
              </button>
            </div>

            <button
              type="button"
              onClick={handleAnalyzeLap}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-3.5 py-2 font-sans text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{isAnalyzing ? 'Analyzing Lap...' : 'AI Engineer Debrief'}</span>
            </button>
          </div>
        </div>

        {/* Clean Hairline-Divided Skill KPI Strip */}
        <div className="mt-4 grid grid-cols-2 divide-y divide-[#1B2230] rounded-md border border-[#1B2230] bg-[#090B10] font-mono tabular-nums sm:grid-cols-6 sm:divide-x sm:divide-y-0">
          <div className="px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Lap Time</div>
            <div className="mt-0.5 text-base font-bold text-slate-100">
              {formatLapTime(activeLap.lapTimeSec)}
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Gap to Pro</div>
            <div className="mt-0.5 text-base font-bold text-amber-400">
              {formatDelta(activeLap.lapTimeSec - track.referenceLapTimeSec)}
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Trail-Brake</div>
            <div className="mt-0.5 text-base font-bold text-cyan-400">
              {skillMetrics.trailBrakingScore}/100
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Pedal Overlap</div>
            <div
              className={`mt-0.5 text-base font-bold ${
                skillMetrics.pedalOverlapPct > 4 ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {skillMetrics.pedalOverlapPct.toFixed(1)}%
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Smoothness</div>
            <div className="mt-0.5 text-base font-bold text-slate-100">
              {skillMetrics.inputSmoothnessScore}/100
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Potential Gain</div>
            <div className="mt-0.5 text-base font-bold text-emerald-400">
              -{skillMetrics.potentialGainSec.toFixed(2)}s
            </div>
          </div>
        </div>

        {/* Clickable Top 3 Priority Corner Drills (click zooms trace straight into corner) */}
        {skillMetrics.topLossDrills.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 font-medium text-slate-300">
                <Target className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                <span>Top 3 Priority Corner Drills (Click to zoom corner trace)</span>
              </div>
              <span className="font-mono text-[11px] text-slate-500">Ranked by time lost</span>
            </div>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
              {skillMetrics.topLossDrills.map((drill, idx) => {
                const isSelected = drill.cornerId === selectedCorner?.id;
                return (
                  <button
                    key={drill.cornerId}
                    type="button"
                    onClick={() => {
                      setSelectedCornerId(drill.cornerId);
                      setTraceScope('corner');
                    }}
                    className={`rounded-md border p-3 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-cyan-400 bg-cyan-500/10'
                        : 'border-[#1B2230] bg-[#090B10] hover:border-[#2C374C]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-xs font-semibold text-slate-100 truncate">
                        #{idx + 1} · T{drill.cornerNumber} {drill.cornerName}
                      </span>
                      <span className="font-mono text-xs font-semibold text-amber-400 tabular-nums shrink-0">
                        +{drill.timeLostSec.toFixed(2)}s
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                      {drill.actionDrill}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Corner Selector (Full width without cutoff) */}
        <div className="mt-4 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 shrink-0">
            Corners
          </span>
          <div
            className="flex flex-1 items-center gap-1.5 overflow-x-auto pb-1"
            role="tablist"
            aria-label="Circuit corners"
          >
            {track.corners.map((corner) => {
              const active = corner.id === selectedCorner?.id;
              return (
                <button
                  key={corner.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedCornerId(corner.id)}
                  className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                      : 'border-[#273145] bg-[#090B10] text-slate-400 hover:border-slate-500 hover:text-slate-100'
                  }`}
                >
                  T{corner.number} · {corner.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Synchronized 3-Channel MoTeC/VRS SVG Telemetry Trace (Speed + Delta-T + Pedals & Steer) */}
        <div className="mt-3 rounded-md border border-[#1B2230] bg-[#090B10] p-4">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <div
                className="inline-flex rounded-md border border-[#273145] bg-[#10141D] p-0.5 text-[11px] shrink-0"
                data-testid="trace-zoom-toggle"
              >
                <button
                  type="button"
                  onClick={() => setTraceScope('lap')}
                  data-testid="trace-full-lap-btn"
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium cursor-pointer whitespace-nowrap ${
                    traceScope === 'lap'
                      ? 'bg-[#1D273B] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Maximize2 className="h-3 w-3" aria-hidden="true" />
                  <span>Full Lap</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTraceScope('corner')}
                  data-testid="trace-corner-zoom-btn"
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium cursor-pointer whitespace-nowrap ${
                    traceScope === 'corner'
                      ? 'bg-cyan-500/20 text-cyan-200'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <ZoomIn className="h-3 w-3" aria-hidden="true" />
                  <span>{selectedCorner ? `Corner Zoom · T${selectedCorner.number}` : 'Corner Zoom'}</span>
                </button>
              </div>
              <span className="font-mono text-cyan-400">― Speed</span>
              <span className="font-mono text-slate-400">-- Ref</span>
              <span className="font-mono text-sky-300">― Δt (s)</span>
              <span className="font-mono text-emerald-400">― Throttle</span>
              <span className="font-mono text-rose-400">― Brake</span>
              <span className="font-mono text-amber-400">-- Ref Brake</span>
              <button
                type="button"
                onClick={() => setShowSteeringTrace((v) => !v)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] cursor-pointer whitespace-nowrap ${
                  showSteeringTrace
                    ? 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                    : 'border-[#273145] text-slate-500 hover:text-slate-300'
                }`}
              >
                {showSteeringTrace ? '― Steer: ON' : 'Steer: OFF'}
              </button>
            </div>
            <div
              className="min-h-[20px] font-mono text-xs tabular-nums"
              data-testid="telemetry-cursor-readout"
            >
              {hoverUserFrame && hoverRefSample ? (
                <span className="text-slate-200">
                  {Math.round(hoverUserFrame.lapDistPct * track.lengthKm * 1000)}m ·{' '}
                  {hoverUserFrame.speedKmh.toFixed(0)} vs {hoverRefSample.speedKmh.toFixed(0)} km/h ·{' '}
                  {hoverDeltaSec !== null && (
                    <span className={hoverDeltaSec <= 0 ? 'text-emerald-400' : 'text-amber-300'}>
                      Δt {formatDelta(hoverDeltaSec)}{' '}
                    </span>
                  )}
                  · Brk {Math.round(hoverUserFrame.brake * 100)}% vs{' '}
                  {Math.round(hoverRefSample.brake * 100)}% · Thr{' '}
                  {Math.round(hoverUserFrame.throttle * 100)}% · Str{' '}
                  {(hoverUserFrame.steeringRad * 57.3).toFixed(0)}°
                </span>
              ) : (
                <span className="font-sans text-slate-400">
                  {traceScope === 'corner' && selectedCorner
                    ? `Zoomed on T${selectedCorner.number} ${selectedCorner.name} (${Math.round(domain.minPct * track.lengthKm * 1000)}m–${Math.round(domain.maxPct * track.lengthKm * 1000)}m) · move cursor to inspect`
                    : 'Move cursor across channels to inspect speed, Δt, braking & steering'}
                </span>
              )}
            </div>
          </div>

          <div
            className="relative cursor-crosshair select-none"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
              setHoverPct(svgRatioToPct(ratio, domain));
            }}
            onMouseLeave={() => setHoverPct(null)}
          >
            {/* Band 1: Speed */}
            <svg
              viewBox={`0 0 ${width} ${speedHeight}`}
              preserveAspectRatio="none"
              className="h-32 w-full"
              aria-label="Speed trace comparison"
            >
              <defs>
                <clipPath id={`${clipPrefix}-spd`}>
                  <rect x={0} y={0} width={width} height={speedHeight} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipPrefix}-spd)`}>
                {selectedCorner && (
                  <rect
                    x={projectPctToSvgX(selectedCorner.startPct, domain, width)}
                    y={0}
                    width={Math.max(
                      12,
                      projectPctToSvgX(selectedCorner.exitPct, domain, width) -
                        projectPctToSvgX(selectedCorner.startPct, domain, width)
                    )}
                    height={speedHeight}
                    fill="#06B6D4"
                    fillOpacity="0.09"
                  />
                )}
                <line x1="0" y1={speedHeight * 0.25} x2={width} y2={speedHeight * 0.25} stroke="#1B2230" strokeDasharray="3 3" />
                <line x1="0" y1={speedHeight * 0.5} x2={width} y2={speedHeight * 0.5} stroke="#1B2230" strokeDasharray="3 3" />
                <line x1="0" y1={speedHeight * 0.75} x2={width} y2={speedHeight * 0.75} stroke="#1B2230" strokeDasharray="3 3" />
                <path d={refSpeedPath} fill="none" stroke="#64748B" strokeWidth="1.75" strokeDasharray="5 4" />
                <path d={userSpeedPath} fill="none" stroke="#06B6D4" strokeWidth="2.25" />
                {hoverSvgX !== null && (
                  <line x1={hoverSvgX} y1={0} x2={hoverSvgX} y2={speedHeight} stroke="#F59E0B" strokeWidth="1" />
                )}
              </g>
            </svg>

            {/* Band 2: MoTeC Delta-T (Time Gain/Loss vs Reference) */}
            <svg
              viewBox={`0 0 ${width} ${deltaHeight}`}
              preserveAspectRatio="none"
              className="mt-1.5 h-20 w-full border-t border-[#1B2230]"
              aria-label="Delta time trace vs pro reference"
              data-testid="delta-t-chart"
            >
              <defs>
                <clipPath id={`${clipPrefix}-dlt`}>
                  <rect x={0} y={0} width={width} height={deltaHeight} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipPrefix}-dlt)`}>
                {selectedCorner && (
                  <rect
                    x={projectPctToSvgX(selectedCorner.startPct, domain, width)}
                    y={0}
                    width={Math.max(
                      12,
                      projectPctToSvgX(selectedCorner.exitPct, domain, width) -
                        projectPctToSvgX(selectedCorner.startPct, domain, width)
                    )}
                    height={deltaHeight}
                    fill="#06B6D4"
                    fillOpacity="0.09"
                  />
                )}
                <line
                  x1="0"
                  y1={deltaHeight / 2}
                  x2={width}
                  y2={deltaHeight / 2}
                  stroke="#334155"
                  strokeDasharray="4 4"
                />
                <text x="6" y="14" fill="#64748B" fontSize="10" fontFamily="monospace">
                  {`-${deltaSeries.maxAbsDeltaSec.toFixed(1)}s (Faster)`}
                </text>
                <text x="6" y={deltaHeight - 6} fill="#64748B" fontSize="10" fontFamily="monospace">
                  {`+${deltaSeries.maxAbsDeltaSec.toFixed(1)}s (Slower)`}
                </text>
                <path d={deltaTPath} fill="none" stroke="#38BDF8" strokeWidth="2" />
                {hoverSvgX !== null && (
                  <line x1={hoverSvgX} y1={0} x2={hoverSvgX} y2={deltaHeight} stroke="#F59E0B" strokeWidth="1" />
                )}
              </g>
            </svg>

            {/* Band 3: Throttle, Brake & Optional Steering Overlay */}
            <svg
              viewBox={`0 0 ${width} ${pedalHeight}`}
              preserveAspectRatio="none"
              className="mt-1.5 h-28 w-full border-t border-[#1B2230]"
              aria-label="Throttle, brake and steering trace"
            >
              <defs>
                <clipPath id={`${clipPrefix}-pdl`}>
                  <rect x={0} y={0} width={width} height={pedalHeight} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipPrefix}-pdl)`}>
                {selectedCorner && (
                  <rect
                    x={projectPctToSvgX(selectedCorner.startPct, domain, width)}
                    y={0}
                    width={Math.max(
                      12,
                      projectPctToSvgX(selectedCorner.exitPct, domain, width) -
                        projectPctToSvgX(selectedCorner.startPct, domain, width)
                    )}
                    height={pedalHeight}
                    fill="#06B6D4"
                    fillOpacity="0.09"
                  />
                )}
                {showSteeringTrace && (
                  <>
                    <line
                      x1="0"
                      y1={pedalHeight / 2}
                      x2={width}
                      y2={pedalHeight / 2}
                      stroke="#1E293B"
                      strokeDasharray="2 4"
                    />
                    <path
                      d={userSteerPath}
                      fill="none"
                      stroke="#A78BFA"
                      strokeWidth="1.4"
                      strokeOpacity="0.85"
                    />
                  </>
                )}
                <path
                  d={refThrottlePath}
                  fill="none"
                  stroke="#34D399"
                  strokeOpacity="0.32"
                  strokeWidth="1.35"
                  strokeDasharray="4 4"
                />
                <path d={refBrakePath} fill="none" stroke="#F59E0B" strokeWidth="1.5" strokeDasharray="4 4" />
                <path d={userThrottlePath} fill="none" stroke="#10B981" strokeWidth="2" />
                <path d={userBrakePath} fill="none" stroke="#EF4444" strokeWidth="2" />
                {hoverSvgX !== null && (
                  <line x1={hoverSvgX} y1={0} x2={hoverSvgX} y2={pedalHeight} stroke="#F59E0B" strokeWidth="1" />
                )}
              </g>
            </svg>
          </div>
        </div>

        {/* Selected Corner Deep Inspection + MoTeC Synced Circuit Map */}
        {selectedCorner && selectedComparison && (
          <div className="mt-4 grid grid-cols-1 gap-4 rounded-md border border-[#1B2230] bg-[#090B10] p-4 md:grid-cols-12 md:items-center">
            <div
              className="rounded border border-[#1B2230] bg-[#0D111A] p-2.5 md:col-span-3"
              data-testid="telemetry-circuit-minimap"
            >
              <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-slate-400">
                <span className="uppercase tracking-wider">Circuit Sync</span>
                <span className="tabular-nums text-cyan-300">
                  {Math.round(activeCursorPct * track.lengthKm * 1000)}m ·{' '}
                  {hoverPct !== null ? 'Trace' : `T${selectedCorner.number}`}
                </span>
              </div>
              <svg
                viewBox={track.svgViewBox}
                preserveAspectRatio="xMidYMid meet"
                className="h-24 w-full"
                aria-label={`${track.name} telemetry trace position map`}
              >
                <path
                  d={track.svgPath}
                  fill="none"
                  stroke="#1E293B"
                  strokeWidth={14}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={track.svgPath}
                  fill="none"
                  stroke="#475569"
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {selectedCornerPose && (
                  <circle
                    cx={selectedCornerPose.x}
                    cy={selectedCornerPose.y}
                    r={10}
                    fill="#F59E0B"
                    fillOpacity={0.28}
                    stroke="#F59E0B"
                    strokeWidth={2}
                  />
                )}
                <circle
                  cx={activeCursorPose.x}
                  cy={activeCursorPose.y}
                  r={12}
                  fill="#06B6D4"
                  fillOpacity={0.25}
                />
                <circle
                  cx={activeCursorPose.x}
                  cy={activeCursorPose.y}
                  r={6.5}
                  fill="#22D3EE"
                  stroke="#ECFEFF"
                  strokeWidth={2}
                />
              </svg>
            </div>

            <div className="md:col-span-4">
              <div className="font-mono text-[11px] font-medium text-cyan-400">
                {`Selected Corner · Sector ${selectedCorner.sector}`}
              </div>
              <h3 className="mt-0.5 font-display text-lg font-semibold text-slate-100">
                Turn {selectedCorner.number}: {selectedCorner.name}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-300">
                {selectedComparison.primaryIssue}
              </p>
              <p className="mt-1.5 text-xs text-slate-400">
                Pro Cue: {selectedCorner.coachingCue}
              </p>
            </div>
            <div className="grid grid-cols-2 divide-y divide-[#1B2230] border-t border-[#1B2230] pt-3 font-mono tabular-nums sm:grid-cols-2 sm:divide-x sm:divide-y md:col-span-5 md:border-t-0 md:border-l md:pl-4 md:pt-0">
              <div className="py-2 pr-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Brake Point</div>
                <div
                  className={`mt-1 text-base font-semibold ${
                    selectedComparison.brakingDeltaMeters > 5 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  {selectedComparison.brakingDeltaMeters >= 0
                    ? `+${selectedComparison.brakingDeltaMeters}m`
                    : `${selectedComparison.brakingDeltaMeters}m`}
                </div>
                <div className="text-[10px] text-slate-500">
                  {selectedComparison.brakingDeltaMeters > 0 ? 'Later than ref' : 'Earlier than ref'}
                </div>
              </div>
              <div className="py-2 pl-3 sm:border-t-0">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Apex Speed</div>
                <div
                  className={`mt-1 text-base font-semibold ${
                    selectedComparison.minApexSpeedDeltaKmh < -3 ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {selectedComparison.minApexSpeedDeltaKmh >= 0
                    ? `+${selectedComparison.minApexSpeedDeltaKmh}`
                    : selectedComparison.minApexSpeedDeltaKmh}{' '}
                  km/h
                </div>
                <div className="text-[10px] text-slate-500">Target {selectedCorner.targetApexSpeedKmh} km/h</div>
              </div>
              <div className="py-2 pr-3 sm:border-l-0">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Trail Score</div>
                <div className="mt-1 text-base font-semibold text-cyan-400">
                  {selectedComparison.trailBrakingScore}/100
                </div>
                <div className="text-[10px] text-slate-500">Brake-to-steer</div>
              </div>
              <div className="py-2 pl-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Time Lost</div>
                <div
                  className={`mt-1 text-base font-semibold ${
                    selectedComparison.timeLostSec > 0.08 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  {formatDelta(selectedComparison.timeLostSec)}
                </div>
                <div className="text-[10px] text-slate-500">Target gear {selectedCorner.targetGear}</div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* AI Engineer Debrief Output */}
      {(aiAnalysis || analyzeError) && (
        <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5" data-testid="ai-lap-debrief">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                {aiAnalysis?.headline || 'AI Engineer Telemetry Debrief'}
              </h2>
            </div>
            {aiAnalysis?.spokenSummary && (
              <button
                type="button"
                onClick={() => onSpeakText(aiAnalysis.spokenSummary || '')}
                className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 cursor-pointer"
              >
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Read Debrief Aloud</span>
              </button>
            )}
          </div>
          {analyzeError ? (
            <p className="mt-3 text-sm text-rose-400">{analyzeError}</p>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-8">
                <p className="text-sm leading-relaxed text-slate-200">{aiAnalysis?.spokenSummary}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {aiAnalysis?.topTimeLossCorners?.map((item, idx) => (
                    <div key={idx} className="rounded-md border border-[#1B2230] bg-[#090B10] p-3.5">
                      <div className="font-display text-sm font-semibold text-amber-300">
                        {item.cornerName}
                      </div>
                      <p className="mt-1 text-xs text-slate-300">{item.diagnosis}</p>
                      <p className="mt-1.5 text-xs font-medium text-cyan-300">Fix: {item.fix}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4 lg:col-span-4">
                <div className="font-display text-sm font-semibold text-slate-100">
                  Recommended Setup Tweaks
                </div>
                <ul className="mt-2.5 space-y-2 text-xs text-slate-300">
                  {aiAnalysis?.setupTweaks?.map((tweak, i) => (
                    <li key={i} className="border-b border-[#1B2230] pb-2 last:border-b-0 last:pb-0">
                      {tweak}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Corner-by-Corner Telemetry Breakdown Table */}
      <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Corner-by-Corner Breakdown
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[#1B2230] text-[11px] uppercase tracking-wider text-slate-400">
                <th className="py-2.5 pr-4 font-medium">Corner</th>
                <th className="px-3 py-2.5 text-right font-medium">Brake Delta</th>
                <th className="px-3 py-2.5 text-right font-medium">Entry Delta</th>
                <th className="px-3 py-2.5 text-right font-medium">Apex Delta</th>
                <th className="px-3 py-2.5 text-right font-medium">Exit Delta</th>
                <th className="px-3 py-2.5 text-right font-medium">Trail Score</th>
                <th className="px-3 py-2.5 text-right font-medium">Time Lost</th>
                <th className="py-2.5 pl-4 font-medium">Engineer Finding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1B2230]">
              {cornerComparisons.map((row) => {
                const selected = row.cornerId === selectedCorner?.id;
                return (
                  <tr
                    key={row.cornerId}
                    onClick={() => {
                      setSelectedCornerId(row.cornerId);
                      setTraceScope('corner');
                    }}
                    className={`cursor-pointer transition-colors hover:bg-[#161C28] ${
                      selected ? 'bg-cyan-500/10' : ''
                    }`}
                  >
                    <td className="py-2.5 pr-4 font-medium text-slate-100 whitespace-nowrap">
                      T{row.cornerNumber} · {row.cornerName}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                        row.brakingDeltaMeters > 6 ? 'text-rose-400' : 'text-slate-300'
                      }`}
                    >
                      {row.brakingDeltaMeters >= 0 ? `+${row.brakingDeltaMeters}m` : `${row.brakingDeltaMeters}m`}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {row.entrySpeedDeltaKmh >= 0 ? `+${row.entrySpeedDeltaKmh}` : row.entrySpeedDeltaKmh}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {row.minApexSpeedDeltaKmh >= 0 ? `+${row.minApexSpeedDeltaKmh}` : row.minApexSpeedDeltaKmh}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {row.exitSpeedDeltaKmh >= 0 ? `+${row.exitSpeedDeltaKmh}` : row.exitSpeedDeltaKmh}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-cyan-400">
                      {row.trailBrakingScore}%
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                        row.timeLostSec > 0.08 ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    >
                      {formatDelta(row.timeLostSec)}
                    </td>
                    <td className="py-2.5 pl-4 text-slate-300">{row.primaryIssue}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
