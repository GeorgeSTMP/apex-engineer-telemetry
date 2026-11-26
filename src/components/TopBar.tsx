import type { AppView, SimConnectionStatus } from '../types/telemetry';
import { Play, Square, Radio, Settings } from 'lucide-react';

interface TopBarProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  isLiveRunning: boolean;
  externalStreamActive?: boolean;
  simStatus?: SimConnectionStatus;
  onToggleLive: () => void;
  onOpenSettings?: () => void;
}

const NAV_ITEMS: Array<{ id: AppView; label: string }> = [
  { id: 'pitwall', label: 'Pit Wall' },
  { id: 'cockpit', label: 'Cockpit HUD' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'bridge', label: 'Garage & Bridge' },
];

export function TopBar({
  activeView,
  onSelectView,
  isLiveRunning,
  externalStreamActive = false,
  simStatus,
  onToggleLive,
  onOpenSettings,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[#1B2230] bg-[#0B0F17]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-4 sm:gap-8 px-3 sm:px-6">
        {/* Zone 1: Brand icon + single-line wordmark */}
        <a
          href="#pitwall"
          onClick={(e) => {
            e.preventDefault();
            onSelectView('pitwall');
          }}
          className="inline-flex items-center gap-2.5 font-display text-base sm:text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          <img
            src="/icon.svg"
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 rounded-md shrink-0"
          />
          <span>ApexEngineer</span>
        </a>

        {/* Zone 2: 4 Pro Workbooks (single-line, bottom indicator bar) */}
        <nav aria-label="Primary workbooks" className="hidden md:flex h-full items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                data-testid={`nav-tab-${item.id}`}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-full items-center px-3.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                  active ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                <span>{item.label}</span>
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-3 right-3 h-0.5 bg-cyan-400"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Settings + Primary Session CTA */}
        <div className="flex items-center gap-2 shrink-0">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              data-testid="topbar-settings-btn"
              title="Race Engineer Settings"
              aria-label="Race Engineer Settings"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#273145] bg-[#0F1420] px-2.5 sm:px-3 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-300 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Settings className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              <span className="hidden sm:inline">Settings</span>
            </button>
          )}

          {externalStreamActive && simStatus?.connectionState !== 'in_pit' ? (
            <span
              data-testid="live-telemetry-badge"
              className="inline-flex h-8 items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-300 whitespace-nowrap shrink-0"
            >
              <Radio className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {simStatus?.source === 'lmu-rest'
                  ? 'Live · LMU'
                  : simStatus?.source === 'shared-memory'
                    ? 'Live · Shared Mem'
                    : 'Live Sim'}
              </span>
            </span>
          ) : (
            <button
              type="button"
              onClick={onToggleLive}
              data-testid="toggle-practice-demo-btn"
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                isLiveRunning
                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                  : 'border border-cyan-500/50 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500 hover:text-slate-950'
              }`}
            >
              {isLiveRunning ? (
                <>
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Stop Demo</span>
                  <span className="sm:hidden">Stop</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Practice Demo</span>
                  <span className="sm:hidden">Demo</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Mobile secondary navigation bar */}
      <nav
        aria-label="Mobile workbooks"
        className="flex md:hidden items-center gap-1 overflow-x-auto border-t border-[#1B2230] px-3 py-1"
      >
        {NAV_ITEMS.map((item) => {
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectView(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                active
                  ? 'bg-[#161B26] text-cyan-300'
                  : 'text-slate-400 hover:text-slate-100'
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
