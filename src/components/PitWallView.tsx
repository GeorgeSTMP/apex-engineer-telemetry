import { useState, useRef, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  Volume2,
  VolumeX,
  Play,
  ShieldAlert,
  Swords,
  Target,
  SlidersHorizontal,
  MessageSquarePlus,
  Maximize2,
} from 'lucide-react';
import type {
  AutonomyActionLog,
  CarProfile,
  CarSetup,
  CoachCallout,
  CoachFocusMode,
  CoachSettings,
  CornerDefinition,
  DriverProfile,
  DriverSkillMetrics,
  ElectronicsSuggestion,
  PitMfdSyncStatus,
  PitRaceMode,
  PitStrategyPlan,
  PitTireOverride,
  PitWallMapSize,
  RacecraftAdvice,
  RadioProtocol,
  SimConnectionStatus,
  SimSessionType,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';
import { formatCornerLabel, formatDelta } from '../engine/coachRules';
import { VOICE_PROFILE_DEFS } from '../engine/lmuKnowledge';
import type { SessionGridMode } from '../engine/lmuSinglePlayer';
import { formatSessionTypeLabel, type SessionPhaseOverride } from '../engine/sessionPhase';
import { describeTrackLocation } from '../engine/trackMapRadar';
import type { LiveVoiceStatus, LiveVoiceTurnPhase } from '../utils/liveVoiceClient';
import { stopAllRadioSpeech, unlockAudioPlayback } from '../utils/radioAudio';
import { PitWallTrackMap } from './PitWallTrackMap';
import type { LivePedalTraceSample } from './CockpitHudView';

interface PitWallViewProps {
  track: TrackProfile;
  car: CarProfile;
  setup: CarSetup;
  frame: TelemetryFrame;
  activeCorner: CornerDefinition | null;
  upcomingCorner: CornerDefinition;
  callouts: CoachCallout[];
  isLiveRunning: boolean;
  settings: CoachSettings;
  driverProfile: DriverProfile;
  electronicsSuggestions: ElectronicsSuggestion[];
  autonomyLog: AutonomyActionLog[];
  racecraftAdvice: RacecraftAdvice;
  pitStrategy: PitStrategyPlan;
  liveVoiceStatus: LiveVoiceStatus;
  liveVoicePhase?: LiveVoiceTurnPhase;
  liveVoiceError: string | null;
  externalStreamActive: boolean;
  simStatus?: SimConnectionStatus;
  onToggleLiveVoice: () => void;
  onToggleLive?: () => void;
  onToggleNewToGame: (isNew: boolean) => void;
  onApplyElectronicsSuggestion: (suggestion: ElectronicsSuggestion) => void;
  onUndoAutonomyAction: (action: AutonomyActionLog) => void;
  onUpdateSettings: (patch: Partial<CoachSettings>) => void;
  onAskEngineer: (question: string) => Promise<void>;
  onTranscribeAndAsk: (audioBase64: string, mimeType: string) => Promise<void>;
  onReplayCallout: (callout: CoachCallout) => void;
  isAskingEngineer: boolean;
  recentPedalTrace?: LivePedalTraceSample[];
  skillMetrics?: DriverSkillMetrics;
  onOpenSettings?: () => void;
  onOpenSimBridge?: () => void;
  onOpenCockpitHud?: () => void;
  onInspectDrillCorner?: () => void;
  onFinishStintReport?: () => void;
  sessionGridMode?: SessionGridMode;
  onChangeSessionGridMode?: (mode: SessionGridMode) => void;
  sessionType?: SimSessionType;
  sessionPhaseOverride?: SessionPhaseOverride;
  onChangeSessionPhaseOverride?: (mode: SessionPhaseOverride) => void;
  onDismissCrashAlert?: () => void;
  pitMfdSyncStatus?: PitMfdSyncStatus;
  onSyncPitMenuToLmu?: () => void;
}

function getTireTempTone(
  tempC: number,
  optimalRange: [number, number]
): {
  text: string;
  label: string;
} {
  if (tempC < optimalRange[0] - 5) {
    return { text: 'text-cyan-400', label: 'Cold' };
  }
  if (tempC > optimalRange[1] + 5) {
    return { text: 'text-rose-400', label: 'Hot' };
  }
  return { text: 'text-emerald-400', label: 'Optimal' };
}

export function PitWallView({
  track,
  car,
  setup,
  frame,
  activeCorner,
  upcomingCorner,
  callouts,
  isLiveRunning,
  settings,
  driverProfile,
  electronicsSuggestions,
  autonomyLog,
  racecraftAdvice,
  pitStrategy,
  liveVoiceStatus,
  liveVoicePhase = 'idle',
  liveVoiceError,
  externalStreamActive,
  simStatus,
  onToggleLiveVoice,
  onToggleLive,
  onToggleNewToGame,
  onApplyElectronicsSuggestion,
  onUndoAutonomyAction,
  onUpdateSettings,
  onAskEngineer,
  onTranscribeAndAsk,
  onReplayCallout,
  isAskingEngineer,
  recentPedalTrace = [],
  skillMetrics,
  onOpenSettings,
  onOpenSimBridge,
  onOpenCockpitHud,
  onInspectDrillCorner,
  onFinishStintReport,
  sessionGridMode = 'grid',
  onChangeSessionGridMode,
  sessionType = 'unknown',
  onDismissCrashAlert,
  pitMfdSyncStatus,
  onSyncPitMenuToLmu,
}: PitWallViewProps) {
  const [questionInput, setQuestionInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [opsTab, setOpsTab] = useState<'strategy' | 'drills'>('strategy');
  const [pitConfigOpen, setPitConfigOpen] = useState(false);
  const [mapSize, setMapSize] = useState<PitWallMapSize>(() => {
    if (typeof window === 'undefined') return 'standard';
    try {
      const saved = window.localStorage.getItem('apexEngineer.pitWallMapSize.v1');
      if (saved === 'compact' || saved === 'standard' || saved === 'large' || saved === 'full') {
        return saved;
      }
    } catch {
      // Ignore storage failures in sandboxed contexts
    }
    return 'standard';
  });
  const [selectedCarId, setSelectedCarId] = useState<string>('player');
  const [radarShowAll, setRadarShowAll] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const handleChangeMapSize = (nextSize: PitWallMapSize) => {
    setMapSize(nextSize);
    try {
      window.localStorage.setItem('apexEngineer.pitWallMapSize.v1', nextSize);
    } catch {
      // Ignore storage failures
    }
  };

  const isWideMap = mapSize === 'large' || mapSize === 'full';
  const rpmPct = Math.min(100, Math.round((frame.rpm / Math.max(1, frame.maxRpm)) * 100));
  const steerDeg = Math.round((frame.steeringRad * 180) / Math.PI);

  // Trophi.ai-style rolling pedal trace with Pro Reference ghost curves
  const pedalRibbon = useMemo(() => {
    const samples: LivePedalTraceSample[] =
      recentPedalTrace.length >= 2
        ? recentPedalTrace
        : Array.from({ length: 16 }, () => ({
            throttle: frame.throttle,
            brake: frame.brake,
            refThrottle: frame.throttle,
            refBrake: frame.brake,
          }));
    const w = 240;
    const h = 44;
    const stepX = w / Math.max(1, samples.length - 1);
    const buildPath = (getter: (s: LivePedalTraceSample) => number) =>
      samples
        .map((s, i) => {
          const x = i * stepX;
          const y = h - 4 - Math.min(1, Math.max(0, getter(s))) * (h - 8);
          return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
    const hasRef = samples.some(
      (s) => typeof s.refThrottle === 'number' || typeof s.refBrake === 'number'
    );
    const hasOverlapNow = frame.throttle > 0.12 && frame.brake > 0.12;
    const recentOverlapCount = samples.filter((s) => s.throttle > 0.12 && s.brake > 0.12).length;
    const recentOverlapPct = Math.round((recentOverlapCount / samples.length) * 100);
    return {
      thrPath: buildPath((s) => s.throttle),
      brkPath: buildPath((s) => s.brake),
      refThrPath: hasRef ? buildPath((s) => s.refThrottle ?? 0) : '',
      refBrkPath: hasRef ? buildPath((s) => s.refBrake ?? 0) : '',
      hasOverlapNow,
      recentOverlapPct,
      w,
      h,
    };
  }, [recentPedalTrace, frame.throttle, frame.brake]);

  const handleSubmitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = questionInput.trim();
    if (!trimmed || isAskingEngineer) return;
    setQuestionInput('');
    await onAskEngineer(trimmed);
  };

  const handleToggleMic = async () => {
    unlockAudioPlayback();
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      return;
    }
    stopAllRadioSpeech();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 128) return;
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
        }
        const base64 = btoa(binary);
        await onTranscribeAndAsk(base64, blob.type || 'audio/webm');
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setIsRecording(false);
    }
  };

  const tireCorners: Array<{ key: 'fl' | 'fr' | 'rl' | 'rr'; label: string }> = [
    { key: 'fl', label: 'Front Left' },
    { key: 'fr', label: 'Front Right' },
    { key: 'rl', label: 'Rear Left' },
    { key: 'rr', label: 'Rear Right' },
  ];

  const isInGarageNow = Boolean(
    (simStatus?.gameRunning || externalStreamActive) &&
      (simStatus?.connectionState === 'in_pit' || (externalStreamActive && frame.inPitOrGarage))
  );

  const currentVoiceMode: RadioProtocol = settings.radioProtocol ?? 'coaching_detail';
  const nextVoiceOrder: Record<RadioProtocol, RadioProtocol> = {
    pro_terse: 'endurance_calm',
    endurance_calm: 'coaching_detail',
    coaching_detail: 'pro_terse',
  };
  const nextVoiceMode = nextVoiceOrder[currentVoiceMode];

  const isStandby = !externalStreamActive && !isLiveRunning;

  return (
    <div className="flex flex-col gap-3">
      {/* Standby Quick-Start Guidance Banner */}
      {isStandby && (
        <div
          data-testid="pitwall-standby-quickstart"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-500/30 bg-[#0F1420] px-4 py-2"
        >
          <div className="flex items-center gap-2.5 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-400" aria-hidden="true" />
            <span className="font-medium text-slate-200">
              {simStatus?.gameRunning
                ? `${simStatus.gameName ?? 'Simulator'} detected in menus — drive out on track for live coaching`
                : 'Ready on Pit Wall — open Le Mans Ultimate for auto-sync or launch a practice stint'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onOpenSimBridge && (
              <button
                type="button"
                onClick={onOpenSimBridge}
                data-testid="standby-open-bridge-btn"
                className="inline-flex items-center gap-1.5 rounded border border-[#273145] bg-[#090B10] px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
              >
                <Cpu className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                <span>Sim Bridge &amp; Test Lab</span>
              </button>
            )}
            {onToggleLive && (
              <button
                type="button"
                onClick={onToggleLive}
                data-testid="standby-start-demo-btn"
                className="inline-flex items-center gap-1.5 rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
              >
                <Play className="h-3 w-3" aria-hidden="true" />
                <span>Start Practice Demo</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Enterprise RaceWatch Grid: 3-column 100vh on S/M, 2-row wide layout on L/XL */}
      <div
        data-testid="pitwall-main-grid"
        className={`grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-stretch ${
          isWideMap
            ? ''
            : isStandby
              ? 'lg:min-h-[max(660px,calc(100vh-188px))]'
              : 'lg:min-h-[max(660px,calc(100vh-134px))]'
        }`}
      >
        {/* COLUMN 1: Live Circuit Map + Timing & Spotter Tower */}
        <div
          className={`flex min-w-0 flex-col gap-3 ${
            isWideMap ? 'lg:col-span-6' : 'lg:col-span-4'
          }`}
        >
          {/* Track Map */}
          <section
            data-testid="pitwall-trackmap-card"
            className="shrink-0 overflow-hidden rounded-lg border border-[#1B2230] bg-[#0F1420] p-3.5"
          >
            <PitWallTrackMap
              track={track}
              car={car}
              frame={frame}
              activeCorner={activeCorner}
              mapSize={mapSize}
              onChangeMapSize={handleChangeMapSize}
              selectedCarId={selectedCarId}
              onSelectCarId={setSelectedCarId}
            />
          </section>

          {/* Timing & Spotter Tower */}
          <section
            className="flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-lg border border-[#1B2230] bg-[#0F1420] p-3.5"
            data-testid="racecraft-radar-panel"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1B2230] pb-2.5 shrink-0">
              <div className="min-w-0">
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Timing &amp; Spotter
                </h3>
                <p className="text-[11px] text-slate-400 truncate">
                  Proximity radar &amp; multiclass traffic windows
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {onChangeSessionGridMode && (
                  <div
                    className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5"
                    data-testid="session-grid-mode-toggle"
                  >
                    <button
                      type="button"
                      onClick={() => onChangeSessionGridMode('grid')}
                      data-testid="grid-mode-btn"
                      aria-pressed={(sessionGridMode ?? 'grid') === 'grid'}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        (sessionGridMode ?? 'grid') === 'grid'
                          ? 'bg-[#1D273B] text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Grid
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeSessionGridMode('solo')}
                      data-testid="solo-mode-btn"
                      aria-pressed={sessionGridMode === 'solo'}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        sessionGridMode === 'solo'
                          ? 'bg-cyan-500/20 text-cyan-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Solo
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({ racecraftAlertsEnabled: !(settings.racecraftAlertsEnabled ?? true) })
                  }
                  data-testid="racecraft-spotter-toggle"
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    settings.racecraftAlertsEnabled ?? true
                      ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {`Spotter: ${settings.racecraftAlertsEnabled ?? true ? 'ON' : 'OFF'}`}
                </button>
              </div>
            </div>

            {/* Compact Spotter Verdict */}
            <div
              data-testid="racecraft-verdict"
              className={`mt-2.5 flex shrink-0 flex-wrap items-start justify-between gap-2 rounded border px-3 py-2 ${
                racecraftAdvice.posture === 'hold_line_car_alongside' ||
                racecraftAdvice.posture === 'three_wide'
                  ? 'border-rose-500/50 bg-rose-500/10'
                  : racecraftAdvice.posture === 'defend_inside' || racecraftAdvice.posture === 'blue_flag_yield'
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : racecraftAdvice.posture === 'attack_opportunity'
                      ? 'border-emerald-500/50 bg-emerald-500/10'
                      : 'border-[#1B2230] bg-[#090B10]'
              }`}
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                {racecraftAdvice.posture === 'attack_opportunity' ? (
                  <Swords className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <ShieldAlert
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      racecraftAdvice.posture === 'hold_line_car_alongside' ||
                      racecraftAdvice.posture === 'three_wide'
                        ? 'text-rose-400'
                        : racecraftAdvice.posture === 'defend_inside' || racecraftAdvice.posture === 'blue_flag_yield'
                          ? 'text-amber-400'
                          : 'text-cyan-400'
                    }`}
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-100 truncate">
                    {racecraftAdvice.headline}
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-300 line-clamp-2">
                    {racecraftAdvice.detail}
                  </p>
                </div>
              </div>
              {(frame.opponents ?? []).length === 0 ? (
                <span className="font-mono text-[10px] whitespace-nowrap shrink-0 text-cyan-300">
                  SOLO
                </span>
              ) : (
                <div className="flex items-center gap-2 font-mono text-[10px] whitespace-nowrap shrink-0">
                  <span className={racecraftAdvice.safeToAttack ? 'text-emerald-400' : 'text-slate-500'}>
                    {`ATK: ${racecraftAdvice.safeToAttack ? 'SAFE' : 'HOLD'}`}
                  </span>
                  <span className="text-slate-600">·</span>
                  <span className={racecraftAdvice.safeToDefend ? 'text-cyan-300' : 'text-rose-400'}>
                    {`DEF: ${racecraftAdvice.safeToDefend ? 'SAFE' : 'HOLD'}`}
                  </span>
                </div>
              )}
            </div>

            {/* Scrollable Timing Tower List */}
            {(frame.opponents ?? []).length === 0 ? (
              <div
                data-testid="solo-radar-empty"
                className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded border border-[#1B2230] bg-[#090B10] px-3 py-2.5 font-mono text-[11px] text-slate-400"
              >
                <span>Solo session — 0 traffic on track. Coaching remains active.</span>
                {onChangeSessionGridMode && sessionGridMode === 'solo' && (
                  <button
                    type="button"
                    onClick={() => onChangeSessionGridMode('grid')}
                    className="rounded border border-[#273145] px-2 py-0.5 text-[10px] text-slate-300 hover:border-cyan-500/40 hover:text-cyan-300 cursor-pointer whitespace-nowrap"
                  >
                    Switch to Grid
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-2.5 flex min-h-0 flex-1 flex-col">
                {(frame.opponents ?? []).length > 4 && (
                  <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2 text-[10px]">
                    <span className="font-mono text-slate-500 truncate">Click row to lock map cursor</span>
                    <div className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => setRadarShowAll(false)}
                        aria-pressed={!radarShowAll}
                        data-testid="radar-scope-nearby"
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] cursor-pointer whitespace-nowrap ${
                          !radarShowAll ? 'bg-[#1D273B] text-slate-100' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Nearby (4)
                      </button>
                      <button
                        type="button"
                        onClick={() => setRadarShowAll(true)}
                        aria-pressed={radarShowAll}
                        data-testid="radar-scope-all"
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] cursor-pointer whitespace-nowrap ${
                          radarShowAll ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {`Field (${(frame.opponents ?? []).length})`}
                      </button>
                    </div>
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto pr-0.5">
                  <table className="w-full text-left font-mono text-[11px] tabular-nums">
                    <thead className="sticky top-0 bg-[#0F1420]">
                      <tr className="border-b border-[#1B2230] text-[10px] uppercase tracking-wider text-slate-500">
                        <th className="py-1.5 pr-2 font-medium">Car</th>
                        <th className="py-1.5 pr-2 font-medium">Loc</th>
                        <th className="py-1.5 pr-2 font-medium text-right">Gap</th>
                        <th className="py-1.5 pl-2 font-medium text-right">Spotter</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1B2230]">
                      {[...(frame.opponents ?? [])]
                        .sort((a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters))
                        .slice(0, radarShowAll ? 48 : 4)
                        .map((opp) => {
                          const loc = describeTrackLocation(track, opp.lapDistPct, {
                            inPits: opp.inPits,
                            speedKmh: opp.speedKmh,
                            explicitSector: opp.sector,
                          });
                          const isAhead = opp.distanceMeters >= 0;
                          const statusText = opp.inPits
                            ? 'Pit Lane'
                            : opp.isAlongside
                              ? `Alongside (${opp.lateralSide.toUpperCase()})`
                              : opp.distanceMeters < 0 && opp.distanceMeters >= -48 && opp.closingSpeedKmh >= 5
                                ? 'Closing'
                                : opp.distanceMeters > 0 && opp.distanceMeters <= 46 && opp.closingSpeedKmh >= 4
                                  ? 'Attack'
                                  : isAhead
                                    ? 'Ahead'
                                    : 'Behind';
                          const statusTone = opp.inPits
                            ? 'text-amber-300'
                            : opp.isAlongside
                              ? 'text-rose-400'
                              : statusText === 'Closing'
                                ? 'text-amber-400'
                                : statusText === 'Attack'
                                  ? 'text-emerald-400'
                                  : 'text-slate-400';
                          const isSelected = selectedCarId === opp.id;
                          return (
                            <tr
                              key={opp.id}
                              onClick={() => setSelectedCarId(opp.id)}
                              data-testid={`radar-row-${opp.id}`}
                              className={`cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-cyan-500/10 text-slate-100'
                                  : 'text-slate-300 hover:bg-[#141B29]'
                              }`}
                            >
                              <td className="py-1.5 pr-2 whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCarId(opp.id);
                                  }}
                                  aria-label={`Inspect #${opp.carNumber} ${opp.driverName} on track map`}
                                  className="inline-flex items-center gap-1 text-left cursor-pointer hover:text-cyan-300"
                                >
                                  {opp.position !== undefined && (
                                    <span className="text-[10px] text-slate-500">P{opp.position}</span>
                                  )}
                                  <span className="font-semibold text-slate-100">#{opp.carNumber}</span>
                                  <span className="max-w-[78px] truncate text-slate-400">
                                    {opp.driverName}
                                  </span>
                                </button>
                              </td>
                              <td className="py-1.5 pr-2 text-slate-300 whitespace-nowrap">
                                <span className="text-slate-500">S{loc.sector}·</span>
                                <span>
                                  {loc.activeCornerNumber !== null
                                    ? `T${loc.activeCornerNumber}`
                                    : opp.inPits
                                      ? 'Pit'
                                      : `→T${loc.nextCornerNumber}`}
                                </span>
                              </td>
                              <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                                {opp.distanceMeters >= 0 ? '+' : ''}
                                {Math.round(opp.distanceMeters)}m{' '}
                                <span className="text-slate-500">
                                  ({opp.gapSeconds >= 0 ? '+' : ''}
                                  {opp.gapSeconds.toFixed(1)}s)
                                </span>
                              </td>
                              <td className={`py-1.5 pl-2 text-right font-medium whitespace-nowrap ${statusTone}`}>
                                {statusText}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* COLUMN 2: Car Vitals, Pedals & Tires + Tabbed Pit Strategy / Drills */}
        <div
          className={`flex min-w-0 flex-col gap-3 ${
            isWideMap ? 'lg:col-span-6' : 'lg:col-span-4'
          }`}
        >
          {/* Car Vitals, Pedals & 2x2 Tires */}
          <section
            data-testid="pitwall-vitals-card"
            className="shrink-0 overflow-hidden rounded-lg border border-[#1B2230] bg-[#0F1420] p-3"
          >
            {/* Session Header + Cockpit HUD Shortcut */}
            <div className="flex items-start justify-between gap-2 border-b border-[#1B2230] pb-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h2
                    className="font-display text-sm font-semibold text-slate-100 truncate"
                    data-testid="pitwall-session-heading"
                  >
                    {isInGarageNow
                      ? 'In Garage / Pit Stall'
                      : !externalStreamActive && !isLiveRunning
                        ? simStatus?.gameRunning && simStatus.connectionState === 'menus'
                          ? `${simStatus.gameName ?? 'Simulator'} in Menus`
                          : 'Standby'
                        : activeCorner
                          ? formatCornerLabel(activeCorner, 'en')
                          : `Approaching ${formatCornerLabel(upcomingCorner, 'en')}`}
                  </h2>
                  <span className="text-xs text-slate-600" aria-hidden="true">·</span>
                  <span
                    data-testid="pitwall-track-status"
                    className={`font-mono text-[11px] font-medium whitespace-nowrap ${
                      isInGarageNow
                        ? 'text-amber-300'
                        : !externalStreamActive && !isLiveRunning
                          ? simStatus?.gameRunning
                            ? 'text-amber-300'
                            : 'text-slate-400'
                          : frame.flagState === 'yellow'
                            ? 'text-amber-400'
                            : frame.flagState === 'blue'
                              ? 'text-cyan-300'
                              : 'text-emerald-400'
                    }`}
                  >
                    {isInGarageNow
                      ? 'Pit Lane'
                      : !externalStreamActive && !isLiveRunning
                        ? simStatus?.gameRunning
                          ? 'Waiting'
                          : 'No Telemetry'
                        : frame.flagState === 'yellow'
                          ? 'Yellow'
                          : frame.flagState === 'blue'
                            ? 'Blue'
                            : 'Green Track'}
                  </span>
                  {formatSessionTypeLabel(sessionType) && (
                    <>
                      <span className="text-xs text-slate-600" aria-hidden="true">·</span>
                      <span
                        data-testid="pitwall-session-phase"
                        className={`font-mono text-[11px] font-semibold whitespace-nowrap ${
                          sessionType === 'race'
                            ? 'text-emerald-400'
                            : sessionType === 'qualifying'
                              ? 'text-amber-300'
                              : 'text-cyan-300'
                        }`}
                      >
                        {formatSessionTypeLabel(sessionType)}
                      </span>
                    </>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400 truncate">
                  {isInGarageNow
                    ? `In pit stall (${Math.round(frame.speedKmh)} km/h) — roll out for live coaching.`
                    : !externalStreamActive && !isLiveRunning
                      ? simStatus?.gameRunning
                        ? `${simStatus.gameName ?? 'Sim'} in menus — load session or Practice Demo.`
                        : `Preview: ${formatCornerLabel(upcomingCorner, 'en')}`
                      : activeCorner
                        ? activeCorner.coachingCue
                        : upcomingCorner.coachingCue}
                </p>
              </div>

              {onOpenCockpitHud && (
                <button
                  type="button"
                  onClick={onOpenCockpitHud}
                  data-testid="pitwall-less-btn"
                  title="Switch to distraction-free Cockpit HUD"
                  className="inline-flex items-center gap-1 rounded border border-[#273145] bg-[#090B10] px-2 py-1 font-sans text-[11px] font-medium text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Maximize2 className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                  <span>Cockpit</span>
                </button>
              )}
            </div>

            {/* 4-KPI Stint Vitals Strip */}
            <div className="mt-2.5 grid grid-cols-4 divide-x divide-[#1B2230] border-b border-[#1B2230] pb-2 font-mono tabular-nums">
              <div className="pr-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Lap</div>
                <div className="text-sm font-semibold text-slate-100" data-testid="live-lap-number">
                  {frame.lapNumber}
                </div>
              </div>
              <div className="px-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Delta</div>
                <div
                  className={`text-sm font-semibold ${
                    frame.deltaSec <= 0 ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                  data-testid="live-delta"
                >
                  {formatDelta(frame.deltaSec)}
                </div>
              </div>
              <div className="px-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  {car.carClass === 'Hypercar' && typeof frame.virtualEnergyPct === 'number'
                    ? 'Fuel · VE'
                    : 'Fuel'}
                </div>
                <div className="text-sm font-semibold text-slate-100 whitespace-nowrap">
                  {frame.fuelLiters.toFixed(1)}L
                  {car.carClass === 'Hypercar' && typeof frame.virtualEnergyPct === 'number' && (
                    <span
                      data-testid="live-ve-pct"
                      className={`ml-1 text-[11px] ${
                        frame.virtualEnergyPct <= 15 ? 'text-rose-400' : 'text-cyan-300'
                      }`}
                    >
                      · {Math.round(frame.virtualEnergyPct)}%
                    </span>
                  )}
                </div>
              </div>
              <div className="pl-2 text-right">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Box</div>
                <div className="text-sm font-semibold text-cyan-300">
                  L{pitStrategy.recommendedPitLap}
                </div>
              </div>
            </div>

            {/* Hazard Banner */}
            {frame.hazardAhead && (
              <div
                role="alert"
                data-testid="hazard-banner"
                className="mt-2.5 flex items-center justify-between gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200"
              >
                <div className="flex min-w-0 items-center gap-2 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                  <span className="truncate">
                    Incident ({Math.round(frame.hazardDistanceM)}m):{' '}
                    {frame.hazardDescription || 'Slow traffic ahead'}
                  </span>
                </div>
                <span className="font-mono text-[10px] font-semibold uppercase text-amber-300 whitespace-nowrap">
                  Yellow
                </span>
              </div>
            )}

            {/* Speed/Gear + Live Pedals & Waveform */}
            <div className="mt-2.5 grid grid-cols-12 gap-3 items-center">
              <div className="col-span-5 space-y-2 border-r border-[#1B2230] pr-3">
                <div className="flex items-baseline justify-between font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] uppercase text-slate-500">Speed</div>
                    <div className="text-2xl font-bold text-slate-100" data-testid="live-speed">
                      {Math.round(frame.speedKmh)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-slate-500">Gear</div>
                    <div className="text-2xl font-bold text-cyan-400" data-testid="live-gear">
                      {frame.gear === 0 ? 'N' : frame.gear}
                    </div>
                  </div>
                </div>
                <div>
                  <div className="mb-0.5 flex justify-between font-mono text-[10px] tabular-nums text-slate-400">
                    <span>RPM</span>
                    <span>{frame.rpm}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-sm bg-[#161B26]">
                    <div
                      className={`h-full transition-all duration-75 ${
                        rpmPct > 92 ? 'bg-rose-500' : rpmPct > 80 ? 'bg-amber-400' : 'bg-cyan-400'
                      }`}
                      style={{ width: `${rpmPct}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-slate-400">
                  <span>{steerDeg > 0 ? `+${steerDeg}°` : `${steerDeg}°`}</span>
                  <span>{frame.latG.toFixed(1)}G Lat</span>
                </div>
              </div>

              <div className="col-span-7 space-y-1.5" data-testid="live-pedal-ribbon">
                <div className="grid grid-cols-2 gap-2 font-mono text-[10px] tabular-nums">
                  <div>
                    <div className="mb-0.5 flex justify-between">
                      <span className="text-slate-400">Thr</span>
                      <span className="text-emerald-400">{Math.round(frame.throttle * 100)}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-sm bg-[#161B26]">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-75"
                        style={{ width: `${Math.round(frame.throttle * 100)}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="mb-0.5 flex justify-between">
                      <span className="text-slate-400">
                        Brk{frame.absActive ? '·ABS' : frame.frontWheelSlip > 0.16 ? '·LOCK' : ''}
                      </span>
                      <span className="text-rose-400">{Math.round(frame.brake * 100)}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-sm bg-[#161B26]">
                      <div
                        className="h-full bg-rose-500 transition-all duration-75"
                        style={{ width: `${Math.round(frame.brake * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between font-mono text-[10px] text-slate-500">
                  <span>Pedal Trace vs Ref</span>
                  <span
                    className={
                      pedalRibbon.hasOverlapNow || pedalRibbon.recentOverlapPct > 4
                        ? 'font-semibold text-amber-400'
                        : 'text-slate-500'
                    }
                  >
                    {pedalRibbon.hasOverlapNow ? 'Overlap!' : `Overlap ${pedalRibbon.recentOverlapPct}%`}
                  </span>
                </div>
                <div className="overflow-hidden rounded bg-[#090B10] px-1.5 py-0.5">
                  <svg
                    viewBox={`0 0 ${pedalRibbon.w} ${pedalRibbon.h}`}
                    preserveAspectRatio="none"
                    className="h-8 w-full"
                    aria-label="Live throttle and brake waveform with pro reference ghost"
                  >
                    <line
                      x1="0"
                      y1={pedalRibbon.h / 2}
                      x2={pedalRibbon.w}
                      y2={pedalRibbon.h / 2}
                      stroke="#1B2230"
                      strokeDasharray="3 3"
                    />
                    {pedalRibbon.refThrPath && (
                      <path
                        d={pedalRibbon.refThrPath}
                        fill="none"
                        stroke="#34D399"
                        strokeOpacity="0.35"
                        strokeWidth="1.25"
                        strokeDasharray="3 3"
                      />
                    )}
                    {pedalRibbon.refBrkPath && (
                      <path
                        d={pedalRibbon.refBrkPath}
                        fill="none"
                        stroke="#F59E0B"
                        strokeOpacity="0.45"
                        strokeWidth="1.25"
                        strokeDasharray="3 3"
                      />
                    )}
                    <path d={pedalRibbon.thrPath} fill="none" stroke="#10B981" strokeWidth="1.75" />
                    <path d={pedalRibbon.brkPath} fill="none" stroke="#F43F5E" strokeWidth="1.75" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Compact 2x2 Tire & Brake Strip */}
            <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-[#1B2230] pt-2.5">
              {tireCorners.map((tc, idx) => {
                const temp = frame.tireTempC[tc.key];
                const psi = frame.tirePressurePsi[tc.key];
                const wear = frame.tireWearPct[tc.key];
                const brakeTemp = frame.brakeTempC[tc.key];
                const tone = getTireTempTone(temp, car.optimalTireTempRange);
                const wearTone =
                  wear <= 65
                    ? 'text-rose-400 font-semibold'
                    : wear <= 74
                      ? 'text-amber-400 font-semibold'
                      : 'text-slate-400';
                return (
                  <div
                    key={tc.key}
                    className={`${idx % 2 === 1 ? 'border-l border-[#1B2230] pl-3' : ''} ${
                      idx >= 2 ? 'border-t border-[#1B2230] pt-1.5' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 text-[11px]">
                      <span className="font-medium text-slate-300">{tc.label}</span>
                      <span className={`font-mono text-[10px] ${tone.text}`}>{tone.label}</span>
                    </div>
                    <div className="flex items-baseline justify-between font-mono tabular-nums">
                      <span className={`text-sm font-semibold ${tone.text}`}>{temp.toFixed(0)}°C</span>
                      <span className="text-[11px] text-slate-400">{psi.toFixed(1)} psi</span>
                    </div>
                    <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-slate-500">
                      <span className={wearTone}>Wear {wear.toFixed(0)}%</span>
                      <span>Brk {brakeTemp}°</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Tabbed Operations Panel: Pit Strategy | Electronics & Drills */}
          <section
            className="flex min-h-[285px] flex-1 flex-col overflow-hidden rounded-lg border border-[#1B2230] bg-[#0F1420] p-3.5"
            data-testid="driver-learning-strategy"
          >
            {/* Operations Sub-Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1B2230] pb-2 shrink-0">
              <div
                role="tablist"
                aria-label="Pit wall operations"
                className="inline-flex rounded border border-[#1B2230] bg-[#090B10] p-0.5 text-[11px]"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={opsTab === 'strategy'}
                  onClick={() => setOpsTab('strategy')}
                  data-testid="pitwall-ops-tab-strategy"
                  className={`rounded px-2.5 py-1 font-medium cursor-pointer whitespace-nowrap transition-colors ${
                    opsTab === 'strategy'
                      ? 'bg-[#1D273B] text-cyan-200'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  Pit Strategy
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={opsTab === 'drills'}
                  onClick={() => setOpsTab('drills')}
                  data-testid="pitwall-ops-tab-drills"
                  className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium cursor-pointer whitespace-nowrap transition-colors ${
                    opsTab === 'drills'
                      ? 'bg-[#1D273B] text-cyan-200'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <Target className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                  <span>Electronics &amp; Drills</span>
                  {electronicsSuggestions.length > 0 && (
                    <span className="rounded bg-amber-500/20 px-1 font-mono text-[10px] text-amber-300">
                      {electronicsSuggestions.length}
                    </span>
                  )}
                </button>
              </div>

              <span className="font-mono text-[11px] text-slate-400 whitespace-nowrap">
                TC {setup.tcLevel} · Bias {setup.brakeBiasPct.toFixed(1)}%
              </span>
            </div>

            {/* Tab Content */}
            <div className="min-h-0 flex-1 overflow-y-auto pt-2.5 pr-0.5">
              {opsTab === 'strategy' ? (
                <div className="space-y-2.5">
                  {/* Decision Hero Row + Progressive Disclosure Toggle */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span
                        data-testid="pit-box-lap-badge"
                        className={`font-mono text-sm font-semibold tabular-nums whitespace-nowrap ${
                          pitStrategy.crashAlertActive ? 'text-rose-400' : 'text-cyan-400'
                        }`}
                      >
                        {pitStrategy.crashAlertActive
                          ? 'BOX NOW · Repairs'
                          : `Box Lap ${pitStrategy.recommendedPitLap}`}
                      </span>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span
                        data-testid="pit-detected-session"
                        className={`font-mono text-[11px] font-medium whitespace-nowrap ${
                          pitStrategy.detectedSessionType === 'qualifying'
                            ? 'text-amber-300'
                            : pitStrategy.detectedSessionType === 'race'
                              ? 'text-emerald-400'
                              : isLiveRunning && pitStrategy.detectedSessionType === 'unknown'
                                ? 'text-cyan-300'
                                : 'text-slate-300'
                        }`}
                      >
                        {pitStrategy.detectedSessionType === 'unknown' && isLiveRunning
                          ? 'Practice Demo Stint'
                          : pitStrategy.sessionPhaseDetectedLabel}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setPitConfigOpen((v) => !v)}
                      aria-expanded={pitConfigOpen}
                      data-testid="pit-configure-toggle"
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        pitConfigOpen
                          ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#273145] bg-[#090B10] text-slate-300 hover:border-cyan-500/40'
                      }`}
                    >
                      <span>Configure</span>
                      {pitConfigOpen ? (
                        <ChevronUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  {/* Crash / Damage Pit Alert */}
                  {pitStrategy.crashAlertActive && (
                    <div
                      role="alert"
                      data-testid="pit-crash-alert-box"
                      className="flex items-start justify-between gap-2 rounded border border-rose-500/50 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-200"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-semibold uppercase text-rose-300">
                          Crash / Damage Pit Call · Repairs ON
                        </div>
                        <p className="mt-0.5 text-[11px] text-rose-200/90">
                          {pitStrategy.crashReason}
                        </p>
                      </div>
                      {onDismissCrashAlert && (
                        <button
                          type="button"
                          data-testid="dismiss-crash-pit-alert"
                          onClick={onDismissCrashAlert}
                          className="rounded border border-rose-400/50 bg-[#090B10] px-2 py-0.5 font-mono text-[10px] font-medium text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap shrink-0"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  )}

                  {/* Core Strategy Telemetry Trio */}
                  <div className="grid grid-cols-3 divide-x divide-[#1B2230] rounded border border-[#1B2230] bg-[#090B10] px-2.5 py-2 font-mono text-xs tabular-nums">
                    <div className="pr-2">
                      <div className="text-[10px] uppercase text-slate-500">
                        {pitStrategy.stintLimitingFactor === 'virtual_energy' ? 'Fuel / VE' : 'Fuel Left'}
                      </div>
                      <div className="mt-0.5 text-slate-200">
                        {pitStrategy.lapsOfFuelLeft.toFixed(1)} laps
                        {pitStrategy.lapsOfVeLeft !== undefined && (
                          <span
                            className={`block text-[10px] ${
                              pitStrategy.stintLimitingFactor === 'virtual_energy'
                                ? 'text-cyan-300 font-semibold'
                                : 'text-slate-500'
                            }`}
                          >
                            VE: {pitStrategy.lapsOfVeLeft.toFixed(1)}L
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="px-2">
                      <div className="text-[10px] uppercase text-slate-500">Add Fuel</div>
                      <div className="mt-0.5 text-slate-200">
                        {pitStrategy.fuelToAddLiters.toFixed(0)} L
                        {car.carClass === 'Hypercar' && (
                          <span className="block text-[10px] text-slate-500">+ 100% VE</span>
                        )}
                      </div>
                    </div>
                    <div className="pl-2">
                      <div className="text-[10px] uppercase text-slate-500">Pit MFD Tires</div>
                      <div
                        className="mt-0.5 text-cyan-300 font-semibold truncate"
                        data-testid="pit-tire-call-headline"
                      >
                        {pitStrategy.pitTireCallHeadline}
                      </div>
                    </div>
                  </div>

                  {/* Actionable Strategy Call */}
                  <p className="text-xs leading-relaxed text-slate-200" data-testid="pit-tire-reason">
                    {pitStrategy.tireSelectionReason}
                  </p>
                  <p className="text-[11px] text-slate-400">{pitStrategy.engineerSummary}</p>

                  {/* LMU Pit MFD Quick Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#1B2230] bg-[#090B10] px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="lmu-preselect-tires-toggle"
                        title="Pre-select recommended tires & repairs inside Le Mans Ultimate's Pit MFD via local :6397 API."
                        onClick={() =>
                          onUpdateSettings({
                            preselectPitTiresInLmu: !(settings.preselectPitTiresInLmu ?? false),
                          })
                        }
                        className={`rounded border px-2 py-1 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          (settings.preselectPitTiresInLmu ?? false)
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                            : 'border-[#273145] bg-[#10141D] text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200'
                        }`}
                      >
                        Preselect in LMU: {(settings.preselectPitTiresInLmu ?? false) ? 'ON' : 'OFF'}
                      </button>
                      {onSyncPitMenuToLmu && (
                        <button
                          type="button"
                          data-testid="sync-lmu-mfd-btn"
                          onClick={onSyncPitMenuToLmu}
                          className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 font-mono text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap"
                        >
                          Sync MFD
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      data-testid="auto-pit-tires-toggle"
                      onClick={() =>
                        onUpdateSettings({
                          autoSelectPitTires: !(settings.autoSelectPitTires ?? true),
                        })
                      }
                      className={`rounded border px-2 py-1 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        (settings.autoSelectPitTires ?? true)
                          ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#273145] bg-[#10141D] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Auto Tire Plan: {(settings.autoSelectPitTires ?? true) ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  {((settings.preselectPitTiresInLmu ?? false) ||
                    (pitMfdSyncStatus && pitMfdSyncStatus.state !== 'idle')) &&
                    pitMfdSyncStatus && (
                      <p
                        data-testid="lmu-mfd-sync-status"
                        className={`font-mono text-[10px] leading-snug ${
                          pitMfdSyncStatus.state === 'applied'
                            ? 'text-emerald-400'
                            : pitMfdSyncStatus.state === 'error'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                        }`}
                      >
                        {pitMfdSyncStatus.message}
                      </p>
                    )}

                  {/* Progressive Disclosure: Pit Race Mode & Manual Tire Override */}
                  {pitConfigOpen && (
                    <div className="space-y-2 rounded border border-[#1B2230] bg-[#090B10] p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label="Pit race mode"
                          data-testid="pit-race-mode-select"
                          value={settings.pitRaceMode ?? 'auto'}
                          onChange={(e) =>
                            onUpdateSettings({ pitRaceMode: e.target.value as PitRaceMode })
                          }
                          className="h-7 flex-1 min-w-[155px] rounded border border-[#273145] bg-[#10141D] px-2 text-[11px] text-slate-200 focus:border-cyan-500 focus:outline-none"
                        >
                          <option value="auto">Mode: Auto ({pitStrategy.raceModeLabel})</option>
                          <option value="short_online">Short Online / Beginner Race</option>
                          <option value="standard_online">Normal Online Race</option>
                          <option value="endurance">Endurance Stint (2h+)</option>
                          <option value="practice_quali">Practice / Qualifying</option>
                        </select>

                        {!(settings.autoSelectPitTires ?? true) && (
                          <select
                            aria-label="Manual pit tire choice"
                            data-testid="manual-pit-tire-select"
                            value={settings.pitTireOverride ?? 'auto'}
                            onChange={(e) =>
                              onUpdateSettings({ pitTireOverride: e.target.value as PitTireOverride })
                            }
                            className="h-7 rounded border border-[#273145] bg-[#10141D] px-2 text-[11px] text-slate-200 focus:border-cyan-500 focus:outline-none"
                          >
                            <option value="auto">Use Recommended</option>
                            <option value="keep">Keep Tires (0s)</option>
                            <option value="fronts_medium">2x Fronts Medium (~7s)</option>
                            <option value="all_medium">4x Medium</option>
                            <option value="all_soft">4x Soft</option>
                            <option value="all_hard">4x Hard</option>
                            <option value="all_wet">4x Wet</option>
                          </select>
                        )}
                      </div>
                      <p className="text-[10px] text-slate-500" data-testid="pit-control-mode-note">
                        {pitStrategy.controlModeNote}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {/* Engineer Autonomy + Driver Experience */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div
                      className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5"
                      data-testid="autonomy-mode-toggle"
                    >
                      <button
                        type="button"
                        onClick={() => onUpdateSettings({ autonomyMode: 'advise' })}
                        data-testid="autonomy-advise-btn"
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          (settings.autonomyMode ?? 'advise') === 'advise'
                            ? 'bg-[#1D273B] text-slate-100'
                            : 'text-slate-400 hover:text-slate-100'
                        }`}
                      >
                        Advise-Only
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdateSettings({ autonomyMode: 'hands_on' })}
                        data-testid="autonomy-hands-on-btn"
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          settings.autonomyMode === 'hands_on'
                            ? 'bg-emerald-500 text-slate-950 font-semibold'
                            : 'text-slate-400 hover:text-slate-100'
                        }`}
                      >
                        Auto-Apply
                      </button>
                    </div>

                    <div className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5">
                      <button
                        type="button"
                        onClick={() => onToggleNewToGame(true)}
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          driverProfile.isNewToGame
                            ? 'bg-cyan-500 text-slate-950'
                            : 'text-slate-400 hover:text-slate-100'
                        }`}
                      >
                        New to Sim
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleNewToGame(false)}
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          !driverProfile.isNewToGame
                            ? 'bg-cyan-500 text-slate-950'
                            : 'text-slate-400 hover:text-slate-100'
                        }`}
                      >
                        Experienced
                      </button>
                    </div>
                  </div>

                  {settings.autonomyMode === 'hands_on' && (
                    <div
                      data-testid="autonomy-active-banner"
                      className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 font-mono text-[10px] text-emerald-300"
                    >
                      Auto-Apply ON · Tunes in-app TC / ABS / Brake Bias automatically.
                    </div>
                  )}

                  {/* Electronics Suggestions & Driver Habits */}
                  <div className="rounded border border-[#1B2230] bg-[#090B10] p-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-slate-200">Electronics &amp; Habits</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        Consistency {driverProfile.habits.brakingConsistencyPct}%
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">{driverProfile.learnedWeaknesses[0]}</p>

                    {electronicsSuggestions.length > 0 && (
                      <div className="mt-2 space-y-1.5 border-t border-[#1B2230] pt-2">
                        {electronicsSuggestions.map((sug) => (
                          <div key={sug.id} className="flex items-center justify-between gap-2 text-[11px]">
                            <div>
                              <div className="font-medium text-amber-300">
                                {sug.title}: {sug.currentValue}
                                {sug.unit === '%' ? '%' : ''} → {sug.recommendedValue}
                                {sug.unit === '%' ? '%' : ''}
                              </div>
                              <div className="text-[10px] text-slate-400">{sug.reason}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => onApplyElectronicsSuggestion(sug)}
                              className="rounded border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/25 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {settings.autonomyMode === 'hands_on' ? 'Apply Now' : 'Apply'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {autonomyLog.length > 0 && (
                      <div
                        data-testid="autonomy-audit-log"
                        className="mt-2 space-y-1 border-t border-[#1B2230] pt-2"
                      >
                        {autonomyLog.slice(0, 3).map((entry) => {
                          const unit = entry.unit === '%' ? '%' : '';
                          return (
                            <div key={entry.id} className="flex items-center justify-between gap-2 text-[10px]">
                              <span
                                className={`font-mono ${
                                  entry.reverted ? 'text-slate-500 line-through' : 'text-emerald-300'
                                }`}
                              >
                                {entry.title}: {entry.previousValue}
                                {unit} → {entry.appliedValue}
                                {unit}
                              </span>
                              {!entry.reverted && (
                                <button
                                  type="button"
                                  onClick={() => onUndoAutonomyAction(entry)}
                                  data-testid="undo-autonomy-btn"
                                  className="rounded border border-[#273145] bg-[#10141D] px-1.5 py-0.5 font-mono text-[10px] text-slate-200 hover:border-amber-400/60 cursor-pointer whitespace-nowrap"
                                >
                                  Undo
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Top 3 Priority Time-Loss Drills */}
                  {skillMetrics && skillMetrics.topLossDrills.length > 0 && (
                    <div className="border-t border-[#1B2230] pt-2.5" data-testid="priority-drills-list">
                      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-slate-200">
                          Top 3 Priority Corner Drills
                        </span>
                        <div className="flex items-center gap-2.5">
                          {onFinishStintReport && (
                            <button
                              type="button"
                              onClick={onFinishStintReport}
                              className="font-mono text-[10px] text-emerald-400 hover:underline cursor-pointer"
                            >
                              Finish Stint → Report
                            </button>
                          )}
                          {onInspectDrillCorner && (
                            <button
                              type="button"
                              onClick={onInspectDrillCorner}
                              className="font-mono text-[10px] text-cyan-400 hover:underline cursor-pointer"
                            >
                              Telemetry →
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="divide-y divide-[#1B2230]">
                        {skillMetrics.topLossDrills.map((drill) => (
                          <div
                            key={drill.cornerId}
                            className="flex items-start justify-between gap-2 py-1.5 text-[11px]"
                          >
                            <div className="min-w-0 flex-1">
                              <span className="font-mono font-semibold text-slate-100">
                                T{drill.cornerNumber} {drill.cornerName}
                              </span>
                              <span className="mx-1.5 font-mono text-[10px] uppercase text-cyan-400">
                                [{drill.phase}]
                              </span>
                              <span className="text-slate-300">{drill.actionDrill}</span>
                            </div>
                            <span className="font-mono font-semibold tabular-nums text-amber-400 whitespace-nowrap">
                              +{drill.timeLostSec.toFixed(2)}s
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* COLUMN 3: Full-Height Live Pit Radio Rail (or Full-Width Row 2 Dock on L/XL) */}
        <aside
          data-testid="pitwall-radio-panel"
          className={`flex h-[440px] min-w-0 flex-col overflow-hidden rounded-lg border border-[#1B2230] bg-[#0F1420] p-3.5 ${
            isWideMap
              ? 'lg:col-span-12 lg:h-[360px]'
              : 'lg:relative lg:col-span-4 lg:h-auto lg:min-h-full lg:p-0'
          }`}
        >
          <div
            className={`flex min-h-0 flex-1 flex-col ${
              isWideMap ? '' : 'lg:absolute lg:inset-0 lg:p-3.5'
            }`}
          >
          {/* Zone 1: Clean Radio Header */}
          <div className="relative border-b border-[#1B2230] pb-2.5 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-display text-base font-semibold text-slate-100">Live Pit Radio</h2>
                <p className="text-[11px] text-text-muted truncate" data-testid="live-voice-status-text">
                  {liveVoiceStatus === 'listening'
                    ? liveVoicePhase === 'user_speaking'
                      ? 'Hearing you — speak naturally'
                      : liveVoicePhase === 'thinking'
                        ? 'Engineer processing your radio...'
                        : 'Live voice active — speak anytime'
                    : liveVoiceStatus === 'speaking'
                      ? 'Engineer speaking live'
                      : liveVoiceStatus === 'connecting'
                        ? 'Connecting live audio...'
                        : 'Real-time voice & coaching feed'}
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={onToggleLiveVoice}
                  data-testid="live-voice-toggle"
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    liveVoiceStatus === 'listening' || liveVoiceStatus === 'speaking'
                      ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                      : liveVoiceStatus === 'connecting'
                        ? 'border-amber-400/50 bg-amber-500/15 text-amber-300'
                        : 'border-cyan-500 bg-cyan-500 text-slate-950 hover:bg-cyan-400'
                  }`}
                >
                  {liveVoiceStatus === 'listening' || liveVoiceStatus === 'speaking' ? (
                    <>
                      <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {liveVoiceStatus === 'speaking'
                          ? 'Speaking · End'
                          : liveVoicePhase === 'user_speaking'
                            ? 'Hearing · End'
                            : liveVoicePhase === 'thinking'
                              ? 'Thinking · End'
                              : 'Live Mic · End'}
                      </span>
                    </>
                  ) : (
                    <>
                      <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{liveVoiceStatus === 'connecting' ? 'Connecting...' : 'Live Voice'}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  data-testid="quick-voice-profile-btn"
                  title={`Voice Profile (${VOICE_PROFILE_DEFS[currentVoiceMode].label}). Click to switch to ${VOICE_PROFILE_DEFS[nextVoiceMode].label}`}
                  onClick={() =>
                    onUpdateSettings({
                      radioProtocol: nextVoiceMode,
                      ...(nextVoiceMode === 'pro_terse' && settings.verbosity === 'detailed'
                        ? { verbosity: 'minimal' }
                        : {}),
                    })
                  }
                  className={`rounded-md border px-2 py-1 font-mono text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    currentVoiceMode === 'pro_terse'
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#273145] bg-[#090B10] text-slate-300 hover:border-cyan-500/40'
                  }`}
                >
                  {VOICE_PROFILE_DEFS[currentVoiceMode].shortLabel}
                </button>

                <button
                  type="button"
                  onClick={() => onUpdateSettings({ voiceEnabled: !settings.voiceEnabled })}
                  aria-label={settings.voiceEnabled ? 'Mute voice radio' : 'Enable voice radio'}
                  className={`inline-flex items-center rounded-md border p-1.5 text-xs transition-colors cursor-pointer ${
                    settings.voiceEnabled
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#273145] bg-[#090B10] text-slate-400'
                  }`}
                >
                  {settings.voiceEnabled ? (
                    <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setFiltersOpen((v) => !v)}
                  aria-expanded={filtersOpen}
                  aria-label="Radio coaching filters"
                  data-testid="radio-filters-btn"
                  className={`inline-flex items-center rounded-md border p-1.5 text-xs transition-colors cursor-pointer ${
                    filtersOpen
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>

            {filtersOpen && (
              <div
                className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#1B2230] bg-[#090B10] p-2"
                data-testid="coach-focus-bar"
              >
                <div className="flex flex-wrap items-center gap-1">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      { id: 'braking', label: 'Braking' },
                      { id: 'apex_line', label: 'Apex' },
                      { id: 'throttle_exit', label: 'Exit' },
                    ] as Array<{ id: CoachFocusMode; label: string }>
                  ).map((opt) => {
                    const isSelected = (settings.focusMode ?? 'all') === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => onUpdateSettings({ focusMode: opt.id })}
                        className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          isSelected ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 hover:text-slate-100'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateSettings({ preCornerCuesEnabled: !(settings.preCornerCuesEnabled ?? true) })
                    }
                    data-testid="pre-corner-toggle"
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      settings.preCornerCuesEnabled ?? true
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : 'border-[#273145] bg-[#10141D] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {`Pre-Corner: ${settings.preCornerCuesEnabled ?? true ? 'ON' : 'OFF'}`}
                  </button>
                  {onOpenSettings && (
                    <button
                      type="button"
                      onClick={() => {
                        setFiltersOpen(false);
                        onOpenSettings();
                      }}
                      className="font-mono text-[10px] text-cyan-400 hover:underline cursor-pointer whitespace-nowrap"
                    >
                      More →
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {liveVoiceError && (
            <div
              className="mt-2.5 shrink-0 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300"
              role="alert"
            >
              {liveVoiceError}
            </div>
          )}

          {/* Zone 2: Full-Height Scrollable Radio Feed */}
          <div
            className="mt-2 min-h-0 flex-1 divide-y divide-[#1B2230] overflow-y-auto pr-1"
            data-testid="pit-radio-feed"
          >
            {callouts.length === 0 ? (
              <div className="py-6 text-xs text-slate-400">
                Radio channel open. Start Live Voice or trigger an event to hear pit wall coaching.
              </div>
            ) : (
              callouts.map((c) => {
                const severityLabel =
                  c.category === 'racecraft'
                    ? 'SPOTTER'
                    : c.category === 'fuel'
                      ? 'FUEL'
                      : c.category === 'brakes'
                        ? 'BRAKES'
                        : c.category === 'tire_degradation'
                          ? 'QUESTION'
                          : c.category === 'tires' || c.category === 'tires_optimal'
                            ? 'TIRES'
                            : c.severity === 'urgent'
                              ? 'URGENT'
                              : c.severity === 'warning'
                                ? 'WARN'
                                : c.category === 'pre_corner'
                                  ? 'NEXT'
                                  : c.source === 'driver-radio'
                                    ? 'DRIVER'
                                    : 'COACH';
                const labelTone =
                  c.severity === 'urgent' || c.category === 'fuel'
                    ? 'text-rose-400'
                    : c.category === 'brakes'
                      ? 'text-amber-400'
                      : c.category === 'tire_degradation'
                        ? 'text-amber-300'
                        : c.category === 'tires_optimal'
                          ? 'text-emerald-400'
                          : c.severity === 'warning'
                            ? 'text-amber-400'
                            : c.category === 'racecraft' || c.category === 'pre_corner'
                              ? 'text-emerald-400'
                              : c.source === 'driver-radio'
                                ? 'text-slate-400'
                                : 'text-cyan-400';

                return (
                  <div key={c.id} className="py-2.5 first:pt-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-center gap-1.5 font-mono">
                        <span className={`font-semibold ${labelTone}`}>{severityLabel}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-500">Lap {c.lapNumber}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-300 truncate max-w-[140px]">{c.cornerName}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onReplayCallout(c)}
                        aria-label={`Play radio callout: ${c.cornerName}`}
                        className="inline-flex items-center gap-1 text-slate-500 hover:text-cyan-300 cursor-pointer shrink-0"
                      >
                        <Play className="h-3 w-3" aria-hidden="true" />
                        <span>Play</span>
                      </button>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-100">{c.message}</p>
                    {c.quickReplies && c.quickReplies.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="callout-quick-replies">
                        {c.quickReplies.map((reply) => (
                          <button
                            key={reply}
                            type="button"
                            disabled={isAskingEngineer}
                            onClick={() => onAskEngineer(reply)}
                            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50 cursor-pointer"
                          >
                            {reply}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Zone 3: Single Comms Bar with On-Demand Quick Prompts */}
          <div className="mt-2 shrink-0 border-t border-[#1B2230] pt-2.5">
            {promptsOpen && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {[
                  'Safe to attack?',
                  'Where am I losing time?',
                  `Braking at Turn ${upcomingCorner.number}?`,
                ].map((promptText) => (
                  <button
                    key={promptText}
                    type="button"
                    disabled={isAskingEngineer}
                    onClick={() => {
                      setPromptsOpen(false);
                      onAskEngineer(promptText);
                    }}
                    className="rounded border border-[#273145] bg-[#090B10] px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    {promptText}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={handleSubmitQuestion} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleToggleMic}
                aria-label={isRecording ? 'Stop recording radio message' : 'Push to talk to race engineer'}
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer ${
                  isRecording
                    ? 'border-rose-500 bg-rose-500/20 text-rose-300'
                    : 'border-[#273145] bg-[#090B10] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-300'
                }`}
              >
                {isRecording ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              </button>

              <button
                type="button"
                onClick={() => setPromptsOpen((v) => !v)}
                aria-expanded={promptsOpen}
                aria-label="Quick radio prompts"
                data-testid="radio-prompts-btn"
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer ${
                  promptsOpen
                    ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                    : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-200'
                }`}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                placeholder="Ask race engineer on pit radio..."
                aria-label="Ask race engineer on pit radio"
                className="h-8 flex-1 rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
              />

              <button
                type="submit"
                disabled={!questionInput.trim() || isAskingEngineer}
                aria-label="Send pit radio message"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-cyan-500 px-2.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Send className="h-3 w-3" aria-hidden="true" />
                <span>{isAskingEngineer ? '...' : 'Radio'}</span>
              </button>
            </form>
          </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
