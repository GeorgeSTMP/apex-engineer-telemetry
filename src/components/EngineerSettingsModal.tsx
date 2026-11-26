import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { CoachSettings } from '../types/telemetry';
import { EngineerSettingsPanel, type EngineerSettingsSection } from './EngineerSettingsPanel';

interface EngineerSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: CoachSettings;
  onUpdateSettings: (patch: Partial<CoachSettings>) => void;
  onTestCallout: () => void;
  onResetDefaults: () => void;
  onOpenSimBridge?: () => void;
}

const MODAL_SECTIONS: Array<{
  id: Exclude<EngineerSettingsSection, 'all'>;
  label: string;
  hint: string;
}> = [
  { id: 'profiles', label: 'Profiles & Alerts', hint: 'Team setups & channels' },
  { id: 'voice', label: 'Voice', hint: 'Audio & phrasing' },
  { id: 'frequency', label: 'Frequency', hint: 'Timing & focus' },
];

export function EngineerSettingsModal({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onTestCallout,
  onResetDefaults,
  onOpenSimBridge,
}: EngineerSettingsModalProps) {
  const [activeSection, setActiveSection] = useState<Exclude<EngineerSettingsSection, 'all'>>('profiles');

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Race Engineer Settings"
      data-testid="engineer-settings-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl">
        <aside className="flex w-40 shrink-0 flex-col border-r border-border bg-canvas-raised p-3 sm:w-48">
          <div className="px-2 pb-3 pt-1 text-sm font-semibold text-text">Settings</div>
          <nav className="flex flex-col gap-0.5" aria-label="Settings sections">
            {MODAL_SECTIONS.map((sec) => {
              const active = activeSection === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => setActiveSection(sec.id)}
                  data-testid={`settings-tab-${sec.id}`}
                  className={`rounded-md px-2.5 py-2 text-left cursor-pointer ${
                    active
                      ? 'bg-accent-dim text-accent'
                      : 'text-text-muted hover:bg-surface-hover hover:text-text'
                  }`}
                >
                  <div className="text-xs font-medium">{sec.label}</div>
                  <div className="text-[10px] text-slate-500">{sec.hint}</div>
                </button>
              );
            })}
          </nav>

          {onOpenSimBridge && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSimBridge();
              }}
              data-testid="settings-sim-connection-btn"
              className="mt-auto px-2.5 py-2 text-left text-[11px] text-slate-500 hover:text-cyan-300 cursor-pointer"
            >
              Sim connection →
            </button>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-end border-b border-border px-4 py-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="overflow-y-auto p-5">
            <EngineerSettingsPanel
              settings={settings}
              onUpdateSettings={onUpdateSettings}
              onTestCallout={onTestCallout}
              onResetDefaults={onResetDefaults}
              section={activeSection}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
