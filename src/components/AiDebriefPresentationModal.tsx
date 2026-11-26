import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Film,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-react';
import type { CoachSettings, DriverProfile, RaceReport } from '../types/telemetry';
import { CARS, TRACKS, buildReferenceLap, interpolateTrackPoint } from '../data/circuitsAndCars';
import { buildDebriefPresentationDeck } from '../engine/debriefSlides';
import { formatLapTime } from '../engine/coachRules';
import {
  speakPresentationSegment,
  stopAllRadioSpeech,
  unlockAudioPlayback,
} from '../utils/radioAudio';

interface AiDebriefPresentationModalProps {
  isOpen: boolean;
  onClose: () => void;
  report: RaceReport;
  driverProfile?: DriverProfile;
  language?: 'en';
  isGeneratingAi?: boolean;
  aiError?: string | null;
  coachSettings?: Pick<
    CoachSettings,
    'voiceEnabled' | 'useGeminiTts' | 'geminiVoiceName' | 'speechRate' | 'voiceVolume'
  >;
}

export function AiDebriefPresentationModal({
  isOpen,
  onClose,
  report,
  driverProfile,
  isGeneratingAi = false,
  aiError = null,
  coachSettings,
}: AiDebriefPresentationModalProps) {
  const track = useMemo(
    () => TRACKS.find((t) => t.id === report.trackId) ?? TRACKS[0],
    [report.trackId]
  );
  const car = useMemo(
    () => CARS.find((c) => c.id === report.carId) ?? CARS[0],
    [report.carId]
  );
  const referenceSamples = useMemo(() => buildReferenceLap(track, car), [track, car]);

  const slides = useMemo(
    () =>
      buildDebriefPresentationDeck({
        report,
        track,
        car,
        referenceSamples,
        driverProfile,
        aiBrief: report.aiBrief ?? null,
        language: 'en',
      }),
    [report, track, car, referenceSamples, driverProfile]
  );

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<1 | 1.2>(1);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<{
    mode: 'idle' | 'loading' | 'gemini-tts' | 'browser-speech' | 'muted' | 'unavailable';
    reason?: string;
  }>({ mode: 'idle' });
  const [replayNonce, setReplayNonce] = useState(0);
  const [replayProgress, setReplayProgress] = useState(0); // 0..1 animation progress within current slide
  const [showRedLine, setShowRedLine] = useState(true);
  const [showGreenLine, setShowGreenLine] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const forceSpeakOnceRef = useRef(false);

  // Reset slide index to 0 and start playing whenever modal opens or report changes
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      stopAllRadioSpeech();
      setIsSpeaking(false);
      setSpeechStatus({ mode: 'idle' });
      return;
    }
    setCurrentIndex(0);
    setReplayProgress(0);
    setIsPlaying(true);
    setShowRedLine(true);
    setShowGreenLine(true);
  }, [isOpen, report.id]);

  // Clamp index if slides length changes
  const safeIndex = Math.min(currentIndex, Math.max(0, slides.length - 1));
  const activeSlide = slides[safeIndex] ?? slides[0];

  // Close on Escape key & always clean up speech on unmount
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight') {
        unlockAudioPlayback();
        setCurrentIndex((i) => Math.min(slides.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        unlockAudioPlayback();
        setCurrentIndex((i) => Math.max(0, i - 1));
      } else if (e.key === ' ') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== 'BUTTON' && tag !== 'INPUT') {
          e.preventDefault();
          unlockAudioPlayback();
          setIsPlaying((p) => !p);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose, slides.length]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopAllRadioSpeech();
    };
  }, []);

  // Visual progress animation loop + synchronized voice narration & auto-advance
  useEffect(() => {
    if (!isOpen || !activeSlide) return;

    const forcedManualReplay = forceSpeakOnceRef.current;
    forceSpeakOnceRef.current = false;

    abortRef.current?.abort();
    stopAllRadioSpeech();

    if (!isPlaying && !forcedManualReplay) {
      setIsSpeaking(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    const slideDurationMs = Math.max(4500, (activeSlide.durationSec * 1000) / playbackRate);
    const startTime = performance.now();
    let timerDone = !isPlaying;
    const shouldSpeak = forcedManualReplay
      ? !isMuted
      : !isMuted && (coachSettings?.voiceEnabled ?? true);
    let speechDone = !shouldSpeak;

    const tryAdvance = () => {
      if (cancelled || controller.signal.aborted || !isPlaying) return;
      if (timerDone && speechDone) {
        if (safeIndex < slides.length - 1) {
          setCurrentIndex((i) => Math.min(slides.length - 1, i + 1));
        } else {
          setIsPlaying(false);
          setReplayProgress(1);
        }
      }
    };

    let visualInterval: number | null = null;
    if (isPlaying) {
      setReplayProgress(0);
      visualInterval = window.setInterval(() => {
        if (cancelled) return;
        const elapsed = performance.now() - startTime;
        const norm = Math.min(1, elapsed / slideDurationMs);
        setReplayProgress(norm);
        if (norm >= 1 && !timerDone) {
          timerDone = true;
          tryAdvance();
        }
      }, 50);
    }

    // Trigger voice narration for this slide
    if (shouldSpeak) {
      setIsSpeaking(true);
      setSpeechStatus({ mode: 'loading' });
      speakPresentationSegment(activeSlide.narrationText, {
        language: 'en',
        voiceEnabled: true,
        useGeminiTts: coachSettings?.useGeminiTts ?? true,
        geminiVoiceName: coachSettings?.geminiVoiceName ?? 'Fenrir',
        speechRate: Math.min(1.3, (coachSettings?.speechRate ?? 1.02) * playbackRate),
        voiceVolume: coachSettings?.voiceVolume ?? 0.95,
        signal: controller.signal,
      }).then((result) => {
        if (cancelled) return;
        setIsSpeaking(false);
        setSpeechStatus(result);
        speechDone = true;
        tryAdvance();
      });
    } else {
      setIsSpeaking(false);
      setSpeechStatus({ mode: 'muted' });
    }

    return () => {
      cancelled = true;
      if (visualInterval !== null) window.clearInterval(visualInterval);
      controller.abort();
      stopAllRadioSpeech();
    };
  }, [
    isOpen,
    safeIndex,
    isPlaying,
    isMuted,
    playbackRate,
    replayNonce,
    activeSlide?.id,
    activeSlide?.narrationText,
    slides.length,
  ]);

  const handleReplayCurrentVoice = () => {
    if (!activeSlide) return;
    unlockAudioPlayback();
    forceSpeakOnceRef.current = true;
    if (isMuted) {
      setIsMuted(false);
    } else {
      setReplayNonce((n) => n + 1);
    }
  };

  if (!isOpen || !activeSlide) return null;

  const overviewDims = (() => {
    const parts = track.svgViewBox.split(' ').map(Number);
    const minY = Number.isFinite(parts[1]) ? parts[1] : 0;
    const w = parts[2] || 1000;
    const h = parts[3] || 550;
    return { minY, h, scale: Math.max(w, h) / 1000 };
  })();

  const cornerSlides = slides.filter((s) => s.kind === 'corner');
  const highlightedCornerIds = new Set(cornerSlides.map((s) => s.cornerId).filter(Boolean));

  // Compute animated Pro & Driver car positions along the corner slide trajectory
  const analysis = activeSlide.cornerAnalysis;
  const hw = analysis?.trackHalfWidth ?? 4;
  const markerR = Math.max(1.2, hw * 0.28);
  const labelFontSize = Math.max(3.2, hw * 0.62);

  const carCursorPos = (pts: Array<{ x: number; y: number }> | undefined, t: number) => {
    if (!pts || pts.length === 0) return null;
    const clamped = Math.max(0, Math.min(1, t));
    const exactIdx = clamped * (pts.length - 1);
    const i0 = Math.floor(exactIdx);
    const i1 = Math.min(pts.length - 1, i0 + 1);
    const frac = exactIdx - i0;
    return {
      x: pts[i0].x + (pts[i1].x - pts[i0].x) * frac,
      y: pts[i0].y + (pts[i1].y - pts[i0].y) * frac,
    };
  };

  // Loop corner car animation slightly faster so user sees Entry -> Apex -> Exit cleanly
  const loopT = (replayProgress * 1.4) % 1;
  const proCarPt = analysis ? carCursorPos(analysis.proPoints, loopT) : null;
  const userCarPt = analysis ? carCursorPos(analysis.userPoints, loopT) : null;

  const cornerSegmentPath = analysis
    ? (() => {
        const c = analysis.corner;
        let span = c.exitPct - c.startPct;
        if (span <= 0) span += 1;
        const pts: string[] = [];
        const steps = 20;
        for (let i = 0; i <= steps; i++) {
          const pct = (c.startPct + (span * i) / steps) % 1;
          const pt = interpolateTrackPoint(track, pct);
          pts.push(`${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`);
        }
        return pts.join(' ');
      })()
    : '';

  const locatorCarPt = analysis
    ? (() => {
        const c = analysis.corner;
        let span = c.exitPct - c.startPct;
        if (span <= 0) span += 1;
        const pct = (c.startPct + span * loopT) % 1;
        return interpolateTrackPoint(track, pct);
      })()
    : null;

  const pedalPaths = analysis
    ? (() => {
        const pts = analysis.pedalComparison;
        const w = 420;
        const h = 76;
        const toPath = (getVal: (p: (typeof pts)[number]) => number) =>
          pts
            .map((p, idx) => {
              const x = (idx / Math.max(1, pts.length - 1)) * w;
              const norm = Math.max(0, Math.min(1, getVal(p)));
              const y = h - 6 - norm * (h - 12);
              return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
            })
            .join(' ');
        return {
          w,
          h,
          proBrake: toPath((p) => p.proBrake),
          userBrake: toPath((p) => p.userBrake),
          proThrottle: toPath((p) => p.proThrottle),
          userThrottle: toPath((p) => p.userThrottle),
          cursorX: loopT * w,
        };
      })()
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="AI Debrief Video Presentation"
      data-testid="ai-debrief-presentation"
    >
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-[#243047] bg-[#0B0E15] text-slate-100 shadow-2xl">
        {/* Top Presentation Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] bg-[#10141D] px-5 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <Film className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-cyan-400">
                <span>{activeSlide.chapterLabel}</span>
                <span className="text-slate-600" aria-hidden="true">·</span>
                <span className="text-slate-400 truncate">
                  {track.name} ({car.name})
                </span>
                {isGeneratingAi && (
                  <>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="text-amber-300">Enriching with Gemini AI...</span>
                  </>
                )}
              </div>
              <h2 className="font-display text-base font-bold text-slate-100 truncate">
                {activeSlide.title}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setPlaybackRate((r) => (r === 1 ? 1.2 : 1))}
              className="rounded border border-[#243047] bg-[#090B10] px-2.5 py-1.5 font-mono text-[11px] font-semibold text-slate-300 hover:border-cyan-400 cursor-pointer"
              aria-label="Toggle playback speed"
            >
              {playbackRate}x
            </button>
            <button
              type="button"
              onClick={() => {
                unlockAudioPlayback();
                setIsMuted((m) => !m);
              }}
              data-testid="presentation-mute-btn"
              aria-pressed={!isMuted}
              className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[11px] font-semibold cursor-pointer ${
                !isMuted
                  ? 'border-cyan-500/45 bg-cyan-500/15 text-cyan-200'
                  : 'border-[#243047] bg-[#090B10] text-slate-400'
              }`}
            >
              {isMuted ? (
                <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{isMuted ? 'Muted' : 'Voice ON'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                stopAllRadioSpeech();
                onClose();
              }}
              data-testid="close-presentation-btn"
              aria-label="Close presentation"
              className="inline-flex items-center gap-1 rounded border border-[#243047] bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-rose-400 hover:text-rose-200 cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Close</span>
            </button>
          </div>
        </div>

        {/* Main Presentation Stage */}
        <div className="flex-1 overflow-y-auto p-5">
          {aiError && (
            <div className="mb-3 rounded border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {`Running full telemetry presentation (${aiError})`}
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            {/* LEFT 7 COLS: Visual Stage (Map Replay / Overview Circuit / Summary Gain Board) */}
            <div className="flex flex-col rounded-lg border border-[#1B2230] bg-[#090B10] p-4 lg:col-span-7">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-xs text-slate-400">{activeSlide.subtitle}</div>
                {activeSlide.timeGainLabel && (
                  <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-xs font-bold text-emerald-300 tabular-nums">
                    {activeSlide.timeGainLabel}
                  </div>
                )}
              </div>

              {activeSlide.kind === 'corner' && analysis ? (
                <>
                  {/* Red & Green ON/OFF inside presentation corner slide */}
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-pressed={showRedLine}
                        data-testid="slide-toggle-red-line"
                        onClick={() => setShowRedLine((v) => !v)}
                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 cursor-pointer ${
                          showRedLine
                            ? 'border-rose-500/50 bg-rose-500/15 text-rose-200'
                            : 'border-[#1B2230] bg-[#10141D] text-slate-500'
                        }`}
                      >
                        {showRedLine ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        <span>Red (You)</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={showGreenLine}
                        data-testid="slide-toggle-green-line"
                        onClick={() => setShowGreenLine((v) => !v)}
                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 cursor-pointer ${
                          showGreenLine
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                            : 'border-[#1B2230] bg-[#10141D] text-slate-500'
                        }`}
                      >
                        {showGreenLine ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        <span>
                          {analysis.greenLineSource === 'proven_best'
                            ? 'Green (Your Best)'
                            : analysis.greenLineSource === 'learned'
                              ? 'Green (Learned)'
                              : 'Green (Pro)'}
                        </span>
                      </button>
                    </div>
                    <span className="text-[10px] text-slate-400">
                      {analysis.greenLineTitle} · {analysis.cornerArchetype}
                    </span>
                  </div>

                  {/* Full-Circuit Locator + Animated Corner Zoom SVG */}
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
                    {/* Track Locator: shows exact location of this corner on the circuit */}
                    <div
                      className="flex h-[220px] sm:h-[290px] flex-col justify-between rounded border border-[#1B2230] bg-[#07090D] p-2.5 sm:col-span-5"
                      data-testid="slide-track-locator"
                    >
                      <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                        <span className="uppercase tracking-wider text-slate-400">Map Location</span>
                        <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 font-bold text-cyan-300">
                          T{analysis.corner.number} · S{analysis.corner.sector}
                        </span>
                      </div>

                      <div className="flex min-h-0 flex-1 items-center justify-center py-1">
                        <svg
                          viewBox={track.svgViewBox}
                          className="h-full w-full"
                          role="img"
                          aria-label={`${track.name} map highlighting Turn ${analysis.corner.number}`}
                        >
                          <path
                            d={track.svgPath}
                            fill="none"
                            stroke="#1E2636"
                            strokeWidth={16 * overviewDims.scale}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d={track.svgPath}
                            fill="none"
                            stroke="#334155"
                            strokeWidth={2.5 * overviewDims.scale}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          {cornerSegmentPath && (
                            <path
                              d={cornerSegmentPath}
                              fill="none"
                              stroke="#22D3EE"
                              strokeWidth={14 * overviewDims.scale}
                              strokeOpacity={0.78}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                          {track.corners.map((c) => {
                            const isActiveCorner = c.id === analysis.corner.id;
                            const pinR = (isActiveCorner ? 13 : 5.5) * overviewDims.scale;
                            return (
                              <g key={`loc-${c.id}`}>
                                {isActiveCorner && (
                                  <circle
                                    cx={c.mapPoint.x}
                                    cy={c.mapPoint.y}
                                    r={pinR * 2.15}
                                    fill="#22D3EE"
                                    fillOpacity={0.22}
                                    stroke="#22D3EE"
                                    strokeWidth={2 * overviewDims.scale}
                                  />
                                )}
                                <circle
                                  cx={c.mapPoint.x}
                                  cy={c.mapPoint.y}
                                  r={pinR}
                                  fill={isActiveCorner ? '#22D3EE' : '#475569'}
                                  stroke="#07090D"
                                  strokeWidth={2 * overviewDims.scale}
                                />
                                {isActiveCorner && (
                                  <text
                                    x={c.mapPoint.x}
                                    y={
                                      c.mapPoint.y - overviewDims.minY < overviewDims.h * 0.14
                                        ? c.mapPoint.y + pinR * 2.4
                                        : c.mapPoint.y - pinR * 1.7
                                    }
                                    textAnchor="middle"
                                    fill="#67E8F9"
                                    fontSize={22 * overviewDims.scale}
                                    fontFamily="monospace"
                                    fontWeight="800"
                                    paintOrder="stroke"
                                    stroke="#07090D"
                                    strokeWidth={4.5 * overviewDims.scale}
                                  >
                                    T{c.number}
                                  </text>
                                )}
                              </g>
                            );
                          })}
                          {locatorCarPt && (
                            <circle
                              cx={locatorCarPt.x}
                              cy={locatorCarPt.y}
                              r={8.5 * overviewDims.scale}
                              fill="#F8FAFC"
                              stroke="#07090D"
                              strokeWidth={2 * overviewDims.scale}
                            />
                          )}
                        </svg>
                      </div>

                      <div className="truncate border-t border-[#1B2230] pt-1.5 font-mono text-[10px] text-slate-400">
                        {track.name} · <span className="text-slate-200">{analysis.corner.name}</span>
                      </div>
                    </div>

                    {/* Zoomed Corner Trajectory Replay */}
                    <div className="rounded border border-[#1B2230] bg-[#07090D] p-1.5 sm:col-span-7">
                      <svg
                        viewBox={analysis.zoomViewBox}
                        className="h-[250px] sm:h-[276px] w-full"
                        data-testid="slide-corner-svg"
                        role="img"
                        aria-label={activeSlide.title}
                      >
                      <path d={analysis.roadPolygonPath} fill="#141923" />
                      <path
                        d={analysis.leftEdgePath}
                        fill="none"
                        stroke="#475569"
                        strokeWidth={Math.max(0.45, hw * 0.14)}
                        strokeLinecap="round"
                      />
                      <path
                        d={analysis.rightEdgePath}
                        fill="none"
                        stroke="#475569"
                        strokeWidth={Math.max(0.45, hw * 0.14)}
                        strokeLinecap="round"
                      />
                      {analysis.kerbPaths.map((kp, idx) => (
                        <g key={`slide-kerb-${idx}`}>
                          <path
                            d={kp}
                            fill="none"
                            stroke="#E11D48"
                            strokeWidth={Math.max(0.7, hw * 0.22)}
                            strokeLinecap="butt"
                          />
                          <path
                            d={kp}
                            fill="none"
                            stroke="#F8FAFC"
                            strokeWidth={Math.max(0.7, hw * 0.22)}
                            strokeDasharray={`${hw * 0.55} ${hw * 0.55}`}
                            strokeLinecap="butt"
                          />
                        </g>
                      ))}

                      {analysis.gateLines
                        .filter((g) => (g.line === 'green' ? showGreenLine : showRedLine))
                        .map((g) => (
                          <line
                            key={g.id}
                            x1={g.x1}
                            y1={g.y1}
                            x2={g.x2}
                            y2={g.y2}
                            stroke={g.line === 'green' ? '#10B981' : '#F43F5E'}
                            strokeOpacity={0.78}
                            strokeWidth={Math.max(0.45, hw * 0.12)}
                            strokeDasharray={`${hw * 0.32} ${hw * 0.22}`}
                          />
                        ))}

                      {showRedLine && (
                        <path
                          d={analysis.userLinePath}
                          fill="none"
                          stroke="#F43F5E"
                          strokeWidth={Math.max(0.75, hw * 0.22)}
                          strokeOpacity={0.95}
                          strokeLinecap="round"
                          strokeDasharray={`${hw * 0.6} ${hw * 0.3}`}
                        />
                      )}

                      {showGreenLine && (
                        <path
                          d={analysis.proLinePath}
                          fill="none"
                          stroke="#10B981"
                          strokeWidth={Math.max(0.85, hw * 0.25)}
                          strokeLinecap="round"
                        />
                      )}

                      {analysis.markers
                        .filter((m) => (m.line === 'green' ? showGreenLine : showRedLine))
                        .map((m) => {
                          const isGreen = m.line === 'green';
                          const fill = isGreen ? '#10B981' : '#F43F5E';
                          const textFill = isGreen ? '#6EE7B7' : '#FDA4AF';
                          return (
                            <g key={m.id}>
                              {m.shortLabel && (
                                <line
                                  x1={m.x}
                                  y1={m.y}
                                  x2={m.labelX}
                                  y2={m.labelY}
                                  stroke={fill}
                                  strokeOpacity={0.68}
                                  strokeWidth={Math.max(0.35, hw * 0.07)}
                                />
                              )}
                              <circle
                                cx={m.x}
                                cy={m.y}
                                r={markerR * 0.78}
                                fill={fill}
                                stroke="#07090D"
                                strokeWidth={markerR * 0.25}
                              />
                              {m.shortLabel && (
                                <text
                                  x={m.labelX}
                                  y={m.labelY}
                                  dominantBaseline="middle"
                                  textAnchor="middle"
                                  fill={textFill}
                                  fontSize={labelFontSize}
                                  fontFamily="monospace"
                                  fontWeight="700"
                                  paintOrder="stroke"
                                  stroke="#07090D"
                                  strokeWidth={labelFontSize * 0.42}
                                >
                                  {m.shortLabel}
                                </text>
                              )}
                            </g>
                          );
                        })}

                      {/* Animated Replay Car Cursors moving along Green & Red lines */}
                      {showRedLine && userCarPt && (
                        <g data-testid="slide-replay-car-red">
                          <circle
                            cx={userCarPt.x}
                            cy={userCarPt.y}
                            r={markerR * 1.9}
                            fill="#F43F5E"
                            fillOpacity={0.28}
                          />
                          <circle
                            cx={userCarPt.x}
                            cy={userCarPt.y}
                            r={markerR * 1.1}
                            fill="#FB7185"
                            stroke="#FFFFFF"
                            strokeWidth={markerR * 0.35}
                          />
                        </g>
                      )}
                      {showGreenLine && proCarPt && (
                        <g data-testid="slide-replay-car-green">
                          <circle
                            cx={proCarPt.x}
                            cy={proCarPt.y}
                            r={markerR * 1.9}
                            fill="#10B981"
                            fillOpacity={0.28}
                          />
                          <circle
                            cx={proCarPt.x}
                            cy={proCarPt.y}
                            r={markerR * 1.1}
                            fill="#34D399"
                            stroke="#FFFFFF"
                            strokeWidth={markerR * 0.35}
                          />
                        </g>
                      )}
                    </svg>
                    </div>
                  </div>

                  {/* Synchronized Pedal Trace */}
                  {pedalPaths && (
                    <div className="mt-2.5 rounded border border-[#1B2230] bg-[#07090D] px-3 py-2">
                      <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-slate-400">
                        <span>Corner Pedal Trace</span>
                        <div className="flex items-center gap-3">
                          {showGreenLine && <span className="text-emerald-400">━ {analysis.greenLineTitle}</span>}
                          {showRedLine && <span className="text-rose-400">┄ Yours</span>}
                        </div>
                      </div>
                      <svg viewBox={`0 0 ${pedalPaths.w} ${pedalPaths.h}`} className="h-[54px] w-full">
                        {showGreenLine && (
                          <>
                            <path d={pedalPaths.proBrake} fill="none" stroke="#10B981" strokeWidth="2" strokeOpacity="0.85" />
                            <path d={pedalPaths.proThrottle} fill="none" stroke="#34D399" strokeWidth="2" />
                          </>
                        )}
                        {showRedLine && (
                          <>
                            <path d={pedalPaths.userBrake} fill="none" stroke="#F43F5E" strokeWidth="2" strokeDasharray="4 3" />
                            <path d={pedalPaths.userThrottle} fill="none" stroke="#FB7185" strokeWidth="2" strokeDasharray="3 3" />
                          </>
                        )}
                        <line
                          x1={pedalPaths.cursorX}
                          y1={0}
                          x2={pedalPaths.cursorX}
                          y2={pedalPaths.h}
                          stroke="#22D3EE"
                          strokeWidth="1.5"
                          strokeOpacity="0.8"
                        />
                      </svg>
                    </div>
                  )}
                </>
              ) : (
                /* Overview / Summary Visual Circuit & Key Telemetry Board */
                <div className="flex flex-1 flex-col justify-between gap-3">
                  <div className="grid grid-cols-2 gap-2.5 rounded border border-[#1B2230] bg-[#07090D] p-3 font-mono tabular-nums sm:grid-cols-4">
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">Best Lap</div>
                      <div className="mt-0.5 text-sm font-bold text-slate-100">
                        {formatLapTime(report.bestLapSec)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">Pro Reference</div>
                      <div className="mt-0.5 text-sm font-bold text-cyan-300">
                        {formatLapTime(report.referenceLapSec)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">Consistency</div>
                      <div className="mt-0.5 text-sm font-bold text-slate-100">
                        {report.consistencyPct}%
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">
                        {report.positionKnown && report.finishPosition >= 1 ? 'Grid Climb' : 'Pace Gain'}
                      </div>
                      <div className="mt-0.5 text-sm font-bold text-emerald-400">
                        {report.positionKnown && report.finishPosition >= 1
                          ? `P${report.finishPosition} → P${report.projectedPosition}`
                          : `-${report.fixableGainPerLapSec.toFixed(2)}s / lap`}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-center rounded border border-[#1B2230] bg-[#07090D] p-3">
                    <svg
                      viewBox={track.svgViewBox}
                      className="h-[245px] w-full"
                      role="img"
                      aria-label={track.name}
                    >
                      <path
                        d={track.svgPath}
                        fill="none"
                        stroke="#1E2636"
                        strokeWidth={14 * overviewDims.scale}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d={track.svgPath}
                        fill="none"
                        stroke="#334155"
                        strokeWidth={2 * overviewDims.scale}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {track.corners.map((c) => {
                        const isFocus = highlightedCornerIds.has(c.id);
                        const isSummary = activeSlide.kind === 'summary';
                        const fill = isFocus ? (isSummary ? '#10B981' : '#F43F5E') : '#475569';
                        const r = (isFocus ? 10 : 6) * overviewDims.scale;
                        return (
                          <g key={c.id}>
                            {isFocus && (
                              <circle
                                cx={c.mapPoint.x}
                                cy={c.mapPoint.y}
                                r={r * 1.8}
                                fill={fill}
                                fillOpacity={0.22}
                              />
                            )}
                            <circle
                              cx={c.mapPoint.x}
                              cy={c.mapPoint.y}
                              r={r}
                              fill={fill}
                              stroke="#07090D"
                              strokeWidth={1.6 * overviewDims.scale}
                            />
                            <text
                              x={c.mapPoint.x}
                              y={c.mapPoint.y - r * 1.45}
                              textAnchor="middle"
                              fill={isFocus ? '#F8FAFC' : '#94A3B8'}
                              fontSize={16 * overviewDims.scale}
                              fontFamily="monospace"
                              fontWeight={isFocus ? '700' : '500'}
                              paintOrder="stroke"
                              stroke="#07090D"
                              strokeWidth={3.2 * overviewDims.scale}
                            >
                              T{c.number}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT 5 COLS: Synchronized Chief Engineer Narration + Right / Wrong / Fix */}
            <div className="flex flex-col gap-3 lg:col-span-5">
              {/* Spoken Engineer Commentary Card */}
              <div className="rounded-lg border border-[#243047] bg-[#10141D] p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                    <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {isSpeaking
                        ? speechStatus.mode === 'loading'
                          ? 'Preparing Voice...'
                          : 'Chief Engineer Speaking...'
                        : 'AI Engineer Commentary'}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid="replay-audio-btn"
                    onClick={handleReplayCurrentVoice}
                    className="rounded border border-[#243047] bg-[#090B10] px-2.5 py-0.5 font-mono text-[10px] text-slate-200 hover:border-cyan-400 hover:text-cyan-200 cursor-pointer"
                  >
                    {isSpeaking ? 'Restart Audio' : 'Replay Audio'}
                  </button>
                </div>
                <p
                  className="mt-2 text-xs leading-relaxed text-slate-200"
                  data-testid="slide-narration-text"
                >
                  {activeSlide.narrationText}
                </p>
                {speechStatus.mode === 'unavailable' && (
                  <div
                    data-testid="speech-status-label"
                    className="mt-2 rounded border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200"
                  >
                    {speechStatus.reason === 'browser-audio-blocked' ||
                    speechStatus.reason === 'not-allowed-or-silent'
                      ? 'Browser blocked automatic audio playback — click Replay Audio to play.'
                      : speechStatus.reason === 'no-english-voice' ||
                          speechStatus.reason === 'no-matching-voice'
                        ? 'No English system voice is available in this browser and Gemini TTS is unavailable — enable Chrome/Edge online English voices or add the Windows English speech pack.'
                        : 'No active Gemini TTS quota or English browser speech voice is available right now.'}
                  </div>
                )}
              </div>

              {/* What Went Right */}
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5">
                <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>What You Did Right</span>
                </div>
                <ul className="mt-1.5 space-y-1 text-xs text-slate-200" data-testid="slide-went-right">
                  {activeSlide.wentRight.map((item, i) => (
                    <li key={i} className="leading-relaxed">
                      • {item}
                    </li>
                  ))}
                </ul>
              </div>

              {/* What Went Wrong */}
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3.5">
                <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-rose-300">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>What Went Wrong</span>
                </div>
                <ul className="mt-1.5 space-y-1 text-xs text-slate-200" data-testid="slide-went-wrong">
                  {activeSlide.wentWrong.map((item, i) => (
                    <li key={i} className="leading-relaxed">
                      • {item}
                    </li>
                  ))}
                </ul>
              </div>

              {/* What to Fix */}
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3.5">
                <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                  <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>How to Fix It</span>
                </div>
                <ul className="mt-1.5 space-y-1 text-xs text-slate-200" data-testid="slide-how-to-fix">
                  {activeSlide.howToFix.map((item, i) => (
                    <li key={i} className="leading-relaxed">
                      • {item}
                    </li>
                  ))}
                </ul>
                {activeSlide.setupHint && (
                  <div className="mt-2 border-t border-cyan-500/20 pt-1.5 font-mono text-[11px] text-cyan-300">
                    Setup: {activeSlide.setupHint}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Video-Style Timeline & Slide Transport Controls */}
        <div className="border-t border-[#1B2230] bg-[#10141D] px-5 py-3">
          {/* Slide progress scrubber */}
          <div className="mb-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1B2230]">
            <div
              className="h-full bg-cyan-400"
              style={{
                width: `${((safeIndex + replayProgress) / Math.max(1, slides.length)) * 100}%`,
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Transport Buttons */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  unlockAudioPlayback();
                  setCurrentIndex(0);
                  setReplayProgress(0);
                  setIsPlaying(true);
                }}
                aria-label="Restart presentation"
                className="rounded border border-[#243047] bg-[#090B10] p-1.5 text-slate-300 hover:border-cyan-400 cursor-pointer"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={safeIndex === 0}
                onClick={() => {
                  unlockAudioPlayback();
                  setCurrentIndex((i) => Math.max(0, i - 1));
                }}
                data-testid="slide-prev-btn"
                aria-label="Previous slide"
                className="inline-flex items-center gap-1 rounded border border-[#243047] bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400 disabled:opacity-40 cursor-pointer"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                <span>Prev</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  unlockAudioPlayback();
                  setIsPlaying((p) => !p);
                }}
                data-testid="slide-play-pause-btn"
                className="inline-flex items-center gap-1.5 rounded bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
              >
                {isPlaying ? (
                  <>
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Play</span>
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={safeIndex >= slides.length - 1}
                onClick={() => {
                  unlockAudioPlayback();
                  setCurrentIndex((i) => Math.min(slides.length - 1, i + 1));
                }}
                data-testid="slide-next-btn"
                aria-label="Next slide"
                className="inline-flex items-center gap-1 rounded border border-[#243047] bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400 disabled:opacity-40 cursor-pointer"
              >
                <span>Next</span>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* Chronological Chapter Pills */}
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="tablist"
              aria-label="Presentation chapters"
            >
              {slides.map((slide, idx) => {
                const active = idx === safeIndex;
                return (
                  <button
                    key={slide.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`slide-tab-${idx}`}
                    onClick={() => {
                      unlockAudioPlayback();
                      setCurrentIndex(idx);
                      setReplayProgress(0);
                    }}
                    className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors cursor-pointer ${
                      active
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 font-semibold'
                        : idx < safeIndex
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-[#1B2230] bg-[#090B10] text-slate-400 hover:border-[#2C374C]'
                    }`}
                  >
                    {slide.chapterLabel}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
