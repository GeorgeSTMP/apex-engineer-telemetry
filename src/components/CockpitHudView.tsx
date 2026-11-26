import { useMemo, useState } from 'react';
import { PhoneCall, PhoneOff, Send, Volume2, VolumeX, ArrowLeft } from 'lucide-react';
import type {
  CarProfile,
  CoachCallout,
  CoachSettings,
  CornerDefinition,
  PitStrategyPlan,
  SimConnectionStatus,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';
import { interpolateTrackPoint } from '../data/circuitsAndCars';
import { formatCornerLabel, formatDelta } from '../engine/coachRules';
import type { LiveVoiceStatus, LiveVoiceTurnPhase } from '../utils/liveVoiceClient';

export interface LivePedalTraceSample {
  throttle: number;
  brake: number;
  refThrottle?: number;
  refBrake?: number;
}

interface CockpitHudViewProps {
  track: TrackProfile;
  car: CarProfile;
  frame: TelemetryFrame;
  activeCorner: CornerDefinition | null;
  upcomingCorner: CornerDefinition;
  pitStrategy: PitStrategyPlan;
  callouts: CoachCallout[];
  recentPedalTrace: LivePedalTraceSample[];
  isLiveRunning: boolean;
  externalStreamActive: boolean;
  simStatus?: SimConnectionStatus;
  settings: CoachSettings;
  liveVoiceStatus: LiveVoiceStatus;
  liveVoicePhase?: LiveVoiceTurnPhase;
  isAskingEngineer: boolean;
  onToggleLiveVoice: () => void;
  onUpdateSettings: (patch: Partial<CoachSettings>) => void;
  onAskEngineer: (question: string) => Promise<void>;
  onOpenPitWall: () => void;
}

export function CockpitHudView({
  track,
  car,
  frame,
  activeCorner,
  upcomingCorner,
  pitStrategy,
  callouts,
  recentPedalTrace,
  isLiveRunning,
  externalStreamActive,
  simStatus,
  settings,
  liveVoiceStatus,
  liveVoicePhase = 'idle',
  isAskingEngineer,
  onToggleLiveVoice,
  onUpdateSettings,
  onAskEngineer,
  onOpenPitWall,
}: CockpitHudViewProps) {
  const [questionInput, setQuestionInput] = useState('');

  const isInGarageNow = Boolean(
    (simStatus?.gameRunning || externalStreamActive) &&
      (simStatus?.connectionState === 'in_pit' || (externalStreamActive && frame.inPitOrGarage))
  );

  const carPoint = interpolateTrackPoint(track, frame.lapDistPct);
  const rpmPct = Math.min(100, Math.round((frame.rpm / Math.max(1, frame.maxRpm)) * 100));
  const latestCallout = callouts[0];

  const pedalPaths = useMemo(() => {
    const samples: LivePedalTraceSample[] =
      recentPedalTrace.length >= 2
        ? recentPedalTrace
        : Array.from({ length: 20 }, () => ({
            throttle: frame.throttle,
            brake: frame.brake,
            refThrottle: frame.throttle,
            refBrake: frame.brake,
          }));
    const w = 520;
    const h = 88;
    const stepX = w / Math.max(1, samples.length - 1);
    const buildPath = (getter: (s: LivePedalTraceSample) => number) =>
      samples
        .map((s, i) => {
          const x = i * stepX;
          const y = h - 6 - Math.min(1, Math.max(0, getter(s))) * (h - 12);
          return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');

    const hasRef = samples.some((s) => typeof s.refThrottle === 'number' || typeof s.refBrake === 'number');
    return {
      w,
      h,
      thrPath: buildPath((s) => s.throttle),
      brkPath: buildPath((s) => s.brake),
      refThrPath: hasRef ? buildPath((s) => s.refThrottle ?? 0) : '',
      refBrkPath: hasRef ? buildPath((s) => s.refBrake ?? 0) : '',
      hasOverlapNow: frame.throttle > 0.12 && frame.brake > 0.12,
    };
  }, [recentPedalTrace, frame.throttle, frame.brake]);

  const focusHeading = isInGarageNow
    ? 'In Garage / Pit Lane'
    : !externalStreamActive && !isLiveRunning
      ? 'Standby — Ready on Grid'
      : formatCornerLabel(activeCorner || upcomingCorner, 'en');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = questionInput.trim();
    if (!trimmed || isAskingEngineer) return;
    setQuestionInput('');
    await onAskEngineer(trimmed);
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4" data-testid="cockpit-hud-view">
      {/* Top Distraction-Free Cockpit Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#1B2230] bg-[#10141D] px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onOpenPitWall}
            data-testid="cockpit-back-pitwall-btn"
            className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Pit Wall</span>
          </button>
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold text-slate-100 truncate">
              {focusHeading}
            </div>
            <div className="text-xs text-slate-400 truncate">
              {activeCorner ? activeCorner.coachingCue : upcomingCorner.coachingCue}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-5 font-mono text-xs tabular-nums shrink-0">
          <div>
            <span className="text-slate-500">LAP </span>
            <span className="font-semibold text-slate-100" data-testid="live-lap-number">
              {frame.lapNumber}
            </span>
          </div>
          <div>
            <span className="text-slate-500">FUEL </span>
            <span className="font-semibold text-slate-100">
              {frame.fuelLiters.toFixed(1)}L ({pitStrategy.lapsOfFuelLeft.toFixed(1)}Laps)
            </span>
          </div>
          {car.carClass === 'Hypercar' && typeof frame.virtualEnergyPct === 'number' && (
            <div data-testid="live-ve-pct">
              <span className="text-slate-500">VE </span>
              <span
                className={`font-semibold ${
                  frame.virtualEnergyPct <= 15 ? 'text-rose-400' : 'text-cyan-300'
                }`}
              >
                {Math.round(frame.virtualEnergyPct)}%
              </span>
            </div>
          )}
          <div>
            <span className="text-slate-500">BOX </span>
            <span
              data-testid="cockpit-box-call"
              className={
                pitStrategy.crashAlertActive
                  ? 'font-bold text-rose-400'
                  : 'font-semibold text-cyan-300'
              }
            >
              {pitStrategy.crashAlertActive ? 'BOX NOW' : `L${pitStrategy.recommendedPitLap}`}
            </span>
          </div>
          <div data-testid="cockpit-pit-tire-call">
            <span className="text-slate-500">MFD TIRE </span>
            <span className="font-semibold text-cyan-300">{pitStrategy.pitTireCallHeadline}</span>
          </div>
          <span
            className={`font-semibold ${
              frame.flagState === 'yellow'
                ? 'text-amber-400'
                : frame.flagState === 'blue'
                  ? 'text-cyan-300'
                  : 'text-emerald-400'
            }`}
          >
            {frame.flagState === 'yellow'
              ? 'YELLOW'
              : frame.flagState === 'blue'
                ? 'BLUE FLAG'
                : 'GREEN'}
          </span>
        </div>
      </div>

      {/* Primary Driver Focal Plane: Delta, Speed, Gear & RPM */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <section className="flex flex-col justify-between rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-8">
          <div className="grid grid-cols-3 items-baseline gap-4 border-b border-[#1B2230] pb-4 font-mono tabular-nums">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Delta to Ref</div>
              <div
                className={`mt-1 text-4xl sm:text-5xl font-bold tracking-tight ${
                  frame.deltaSec <= 0 ? 'text-emerald-400' : 'text-amber-400'
                }`}
                data-testid="live-delta"
              >
                {formatDelta(frame.deltaSec)}
              </div>
            </div>

            <div className="text-center">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Speed</div>
              <div
                className="mt-1 text-4xl sm:text-5xl font-bold tracking-tight text-slate-100"
                data-testid="live-speed"
              >
                {Math.round(frame.speedKmh)}
                <span className="ml-1 text-sm font-normal text-slate-500">km/h</span>
              </div>
            </div>

            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Gear</div>
              <div
                className="mt-1 text-4xl sm:text-5xl font-bold tracking-tight text-cyan-400"
                data-testid="live-gear"
              >
                {frame.gear === 0 ? 'N' : frame.gear}
              </div>
            </div>
          </div>

          {/* RPM Shift Bar */}
          <div className="mt-4">
            <div className="mb-1 flex justify-between font-mono text-[11px] tabular-nums text-slate-400">
              <span>Engine RPM</span>
              <span>
                {frame.rpm} / {frame.maxRpm}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-sm bg-[#090B10]">
              <div
                className={`h-full transition-all duration-75 ${
                  rpmPct > 92 ? 'bg-rose-500' : rpmPct > 82 ? 'bg-amber-400' : 'bg-cyan-400'
                }`}
                style={{ width: `${rpmPct}%` }}
              />
            </div>
          </div>

          {/* Trophi.ai Live Reference vs You Pedal Ghost Ribbon */}
          <div className="mt-5" data-testid="live-pedal-ribbon">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
              <div className="flex items-center gap-3">
                <span className="uppercase tracking-wider text-slate-300 font-semibold">
                  Pedal Trace (You vs Pro Ref)
                </span>
                <span className="text-emerald-400">― Thr {Math.round(frame.throttle * 100)}%</span>
                <span className="text-rose-400">― Brk {Math.round(frame.brake * 100)}%</span>
                <span className="text-slate-400">-- Ref Ghost</span>
              </div>
              <span className={pedalPaths.hasOverlapNow ? 'text-amber-400 font-semibold' : 'text-slate-500'}>
                {pedalPaths.hasOverlapNow
                  ? 'Pedal Overlap'
                  : frame.absActive
                    ? 'ABS Active'
                    : frame.tcActive
                      ? 'TC Active'
                      : 'Clean Trace'}
              </span>
            </div>
            <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-2">
              <svg
                viewBox={`0 0 ${pedalPaths.w} ${pedalPaths.h}`}
                preserveAspectRatio="none"
                className="h-24 w-full"
                aria-label="Live throttle and brake comparison against pro reference"
              >
                <line
                  x1="0"
                  y1={pedalPaths.h / 2}
                  x2={pedalPaths.w}
                  y2={pedalPaths.h / 2}
                  stroke="#1B2230"
                  strokeDasharray="4 4"
                />
                {pedalPaths.refThrPath && (
                  <path
                    d={pedalPaths.refThrPath}
                    fill="none"
                    stroke="#34D399"
                    strokeOpacity="0.35"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                  />
                )}
                {pedalPaths.refBrkPath && (
                  <path
                    d={pedalPaths.refBrkPath}
                    fill="none"
                    stroke="#F59E0B"
                    strokeOpacity="0.45"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                  />
                )}
                <path d={pedalPaths.thrPath} fill="none" stroke="#10B981" strokeWidth="2.25" />
                <path d={pedalPaths.brkPath} fill="none" stroke="#F43F5E" strokeWidth="2.25" />
              </svg>
            </div>
          </div>

          {/* 4-Corner Compact Tire Temp Strip */}
          <div className="mt-4 grid grid-cols-4 divide-x divide-[#1B2230] border-t border-[#1B2230] pt-3 font-mono text-xs tabular-nums">
            {(['fl', 'fr', 'rl', 'rr'] as const).map((k, idx) => {
              const t = frame.tireTempC[k];
              const w = frame.tireWearPct[k];
              const tone =
                t < car.optimalTireTempRange[0] - 5
                  ? 'text-cyan-400'
                  : t > car.optimalTireTempRange[1] + 5
                    ? 'text-rose-400'
                    : 'text-emerald-400';
              return (
                <div key={k} className={idx > 0 ? 'pl-3' : ''}>
                  <div className="text-[10px] uppercase text-slate-500">{k.toUpperCase()}</div>
                  <div className={`text-sm font-semibold ${tone}`}>{t.toFixed(0)}°C</div>
                  <div className="text-[10px] text-slate-500">Wear {w.toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Right 4 Cols: Track Minimap + Live Engineer Voice Comms */}
        <aside className="flex flex-col justify-between gap-4 rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-4">
          <div>
            <div className="flex items-center justify-between border-b border-[#1B2230] pb-2.5">
              <span className="font-display text-sm font-semibold text-slate-100">{track.name}</span>
              <span className="font-mono text-[11px] text-slate-400">
                {Math.round(frame.lapDistPct * track.lengthKm * 1000)}m
              </span>
            </div>
            <svg
              viewBox={track.svgViewBox}
              preserveAspectRatio="xMidYMid meet"
              className="mx-auto mt-3 h-[170px] w-full"
              aria-label={`${track.name} live track map`}
              data-testid="track-map-svg"
            >
              <path
                d={track.svgPath}
                fill="none"
                stroke="#1E293B"
                strokeWidth="14"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={track.svgPath}
                fill="none"
                stroke="#475569"
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle cx={carPoint.x} cy={carPoint.y} r="7" fill="#22D3EE" stroke="#ECFEFF" strokeWidth="2" />
            </svg>
          </div>

          <div className="border-t border-[#1B2230] pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-slate-400" data-testid="live-voice-status-text">
                {liveVoiceStatus === 'listening'
                  ? liveVoicePhase === 'user_speaking'
                    ? 'Hearing you...'
                    : liveVoicePhase === 'thinking'
                      ? 'Engineer thinking...'
                      : 'Live Voice ON'
                  : liveVoiceStatus === 'speaking'
                    ? 'Engineer speaking'
                    : liveVoiceStatus === 'connecting'
                      ? 'Connecting...'
                      : 'Pit Radio'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onToggleLiveVoice}
                  data-testid="live-voice-toggle"
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold cursor-pointer whitespace-nowrap ${
                    liveVoiceStatus === 'listening' || liveVoiceStatus === 'speaking'
                      ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                      : 'border-cyan-500 bg-cyan-500 text-slate-950 hover:bg-cyan-400'
                  }`}
                >
                  {liveVoiceStatus === 'listening' || liveVoiceStatus === 'speaking' ? (
                    <>
                      <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>End</span>
                    </>
                  ) : (
                    <>
                      <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Live Voice</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ voiceEnabled: !settings.voiceEnabled })}
                  aria-label={settings.voiceEnabled ? 'Mute voice radio' : 'Enable voice radio'}
                  className="inline-flex items-center rounded-md border border-[#273145] bg-[#090B10] p-1.5 text-slate-300 hover:text-cyan-300 cursor-pointer"
                >
                  {settings.voiceEnabled ? (
                    <Volume2 className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                  ) : (
                    <VolumeX className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <p className="mt-2.5 min-h-[44px] text-sm leading-snug text-slate-100" data-testid="pit-radio-feed">
              {latestCallout ? latestCallout.message : 'Radio quiet — engineer standing by.'}
            </p>

            <form onSubmit={handleSubmit} className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                placeholder="Ask engineer..."
                aria-label="Ask race engineer on pit radio"
                className="h-8 flex-1 rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!questionInput.trim() || isAskingEngineer}
                aria-label="Send pit radio message"
                className="inline-flex h-8 items-center gap-1 rounded-md bg-cyan-500 px-2.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40 cursor-pointer whitespace-nowrap"
              >
                <Send className="h-3 w-3" aria-hidden="true" />
                <span>{isAskingEngineer ? '...' : 'Send'}</span>
              </button>
            </form>
          </div>
        </aside>
      </div>
    </div>
  );
}
