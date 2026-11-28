import type { AppView, SimConnectionStatus } from '../types/telemetry';
import type { LiveVoiceStatus, LiveVoiceTurnPhase } from '../utils/liveVoiceClient';
import { Play, Square, Radio, Settings, PhoneCall, PhoneOff } from 'lucide-react';

interface TopBarProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  isLiveRunning: boolean;
  externalStreamActive?: boolean;
  simStatus?: SimConnectionStatus;
  liveVoiceStatus?: LiveVoiceStatus;
  liveVoicePhase?: LiveVoiceTurnPhase;
  statusLabel?: string;
  onToggleLiveVoice?: () => void;
  onToggleLive: () => void;
  onOpenSettings?: () => void;
  onOpenSimBridge?: () => void;
}

const NAV_ITEMS: Array<{ id: AppView; label: string; hint: string }> = [
  { id: 'cockpit', label: 'Drive', hint: 'Overlay' },
  { id: 'pitwall', label: 'Engineer', hint: 'Pit wall' },
  { id: 'telemetry', label: 'Debrief', hint: 'Traces' },
  { id: 'bridge', label: 'Garage', hint: 'Setup' },
];

export function TopBar({
  activeView,
  onSelectView,
  isLiveRunning,
  externalStreamActive = false,
  simStatus,
  liveVoiceStatus = 'disconnected',
  liveVoicePhase = 'idle',
  statusLabel,
  onToggleLiveVoice,
  onToggleLive,
  onOpenSettings,
}: TopBarProps) {
  const isVoiceActive = liveVoiceStatus === 'listening' || liveVoiceStatus === 'speaking';
  const isVoiceConnecting = liveVoiceStatus === 'connecting';
  const voiceLabel =
    liveVoiceStatus === 'speaking'
      ? 'End Voice'
      : liveVoiceStatus === 'listening'
        ? liveVoicePhase === 'user_speaking'
          ? 'Hearing'
          : 'Live Mic'
        : isVoiceConnecting
          ? 'Connecting'
          : 'Voice';

  return (
    <header className="sticky top-0 z-30 border-b border-cyan-500/30 bg-[#070A10]/95 backdrop-blur-md">
      <div
        data-testid="redesign-banner"
        className="border-b border-amber-500/40 bg-gradient-to-r from-amber-500/20 via-cyan-500/10 to-transparent px-3 sm:px-6 py-1.5"
      >
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="font-semibold uppercase tracking-[0.18em] text-amber-300">
            Redesigned IA · Drive / Engineer / Debrief / Garage
          </span>
          <span className="font-mono text-cyan-300/90">
            One job per mode · Settings: Presets · Radio · Alerts · Strategy · Connection
          </span>
        </div>
      </div>

      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-3 px-3 sm:px-6">
        <a
          href="#drive"
          onClick={(e) => {
            e.preventDefault();
            onSelectView('cockpit');
          }}
          className="inline-flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          <img src="/icon.svg" alt="" width={28} height={28} className="h-7 w-7 rounded-md shrink-0" />
          <span>ApexEngineer</span>
        </a>

        <nav
          aria-label="Primary modes"
          className="hidden md:flex h-10 items-center gap-1 rounded-xl border border-[#1B2230] bg-[#0B0F17] p-1"
        >
          {NAV_ITEMS.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                data-testid={`nav-tab-${item.id}`}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-full min-w-[88px] flex-col items-center justify-center rounded-lg px-3 transition-colors cursor-pointer ${
                  active
                    ? 'bg-cyan-500 text-slate-950 shadow-[0_0_24px_rgba(34,211,238,0.35)]'
                    : 'text-slate-400 hover:bg-[#121826] hover:text-slate-100'
                }`}
              >
                <span className="text-xs font-bold leading-none">{item.label}</span>
                <span
                  className={`mt-0.5 text-[9px] uppercase tracking-wider ${
                    active ? 'text-slate-800' : 'text-slate-600'
                  }`}
                >
                  {item.hint}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {statusLabel && (
            <span
              className="hidden xl:inline max-w-[240px] truncate font-mono text-[11px] text-slate-500"
              title={statusLabel}
            >
              {statusLabel}
            </span>
          )}

          {onToggleLiveVoice && (
            <button
              type="button"
              onClick={onToggleLiveVoice}
              data-testid="topbar-live-voice-btn"
              aria-pressed={isVoiceActive}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold cursor-pointer whitespace-nowrap ${
                isVoiceActive
                  ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                  : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
              }`}
            >
              {isVoiceActive ? <PhoneOff className="h-3.5 w-3.5" /> : <PhoneCall className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{voiceLabel}</span>
            </button>
          )}

          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              data-testid="topbar-settings-btn"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#273145] bg-[#0F1420] px-2.5 text-xs font-medium text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer"
            >
              <Settings className="h-3.5 w-3.5 text-cyan-400" />
              <span className="hidden lg:inline">Settings</span>
            </button>
          )}

          {externalStreamActive && simStatus?.connectionState !== 'in_pit' ? (
            <span
              data-testid="live-telemetry-badge"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-300"
            >
              <Radio className="h-3.5 w-3.5" />
              Live
            </span>
          ) : (
            <button
              type="button"
              onClick={onToggleLive}
              data-testid="toggle-practice-demo-btn"
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold cursor-pointer ${
                isLiveRunning ? 'bg-amber-500 text-slate-950' : 'bg-cyan-500 text-slate-950'
              }`}
            >
              {isLiveRunning ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{isLiveRunning ? 'Stop' : 'Demo'}</span>
            </button>
          )}
        </div>
      </div>

      <nav aria-label="Mobile modes" className="flex md:hidden gap-1 overflow-x-auto border-t border-[#1B2230] px-3 py-1.5">
        {NAV_ITEMS.map((item) => {
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectView(item.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer ${
                active ? 'bg-cyan-500 text-slate-950' : 'bg-[#0F1420] text-slate-400'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
