import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  CarProfile,
  CoachSettings,
  HardwareInputMapping,
  HardwareInputState,
  SimConnectionStatus,
  SimGameId,
  TrackProfile,
} from '../types/telemetry';
import type { AutoDetectedSession } from '../engine/autoDetect';
import type { SessionPhaseOverride } from '../engine/sessionPhase';
import type { SimScenarioFault } from '../engine/telemetrySimulator';
import { EngineerSettingsPanel, type EngineerSettingsSection } from './EngineerSettingsPanel';
import { SimBridgeView } from './SimBridgeView';

export type EngineerSettingsModalSection = Exclude<EngineerSettingsSection, 'all'> | 'sim_bridge';

interface SimBridgeModalProps {
  selectedSim: SimGameId;
  track: TrackProfile;
  car: CarProfile;
  wsConnected: boolean;
  externalStreamActive: boolean;
  simStatus: SimConnectionStatus;
  autoDetectEnabled: boolean;
  detectedSession: AutoDetectedSession | null;
  hardwareState: HardwareInputState;
  hardwareMapping: HardwareInputMapping;
  hardwareDriveEnabled: boolean;
  keyboardDriveEnabled: boolean;
  activeFault: SimScenarioFault;
  sessionPhaseOverride: SessionPhaseOverride;
  onToggleAutoDetect: () => void;
  onToggleHardwareDrive: () => void;
  onToggleKeyboardDrive: () => void;
  onUpdateHardwareMapping: (patch: Partial<HardwareInputMapping>) => void;
  onCalibrateHardwareRest: () => void;
  onResetSettings: () => void;
  onTriggerFault: (fault: SimScenarioFault) => void;
  onManualPedalOverride: (brake: number | null, throttle: number | null) => void;
  onChangeSessionPhaseOverride: (mode: SessionPhaseOverride) => void;
}

interface EngineerSettingsModalProps {
  isOpen: boolean;
  initialSection?: EngineerSettingsModalSection;
  onClose: () => void;
  settings: CoachSettings;
  onUpdateSettings: (patch: Partial<CoachSettings>) => void;
  onTestCallout: () => void;
  onResetDefaults: () => void;
  simBridgeProps?: SimBridgeModalProps;
}

const MODAL_SECTIONS: Array<{
  id: EngineerSettingsModalSection;
  label: string;
  hint: string;
}> = [
  { id: 'profiles', label: 'Profiles & Alerts', hint: 'Team setups & channels' },
  { id: 'voice', label: 'Voice', hint: 'Audio & phrasing' },
  { id: 'frequency', label: 'Frequency', hint: 'Timing & focus' },
  { id: 'sim_bridge', label: 'Sim Bridge & Lab', hint: 'LMU bridge, pedals & tests' },
];

export function EngineerSettingsModal({
  isOpen,
  initialSection = 'profiles',
  onClose,
  settings,
  onUpdateSettings,
  onTestCallout,
  onResetDefaults,
  simBridgeProps,
}: EngineerSettingsModalProps) {
  const [activeSection, setActiveSection] = useState<EngineerSettingsModalSection>(initialSection);

  useEffect(() => {
    if (isOpen) {
      setActiveSection(initialSection);
    }
  }, [isOpen, initialSection]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isSimBridge = activeSection === 'sim_bridge';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Race Engineer Settings & Sim Bridge"
      data-testid="engineer-settings-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`relative flex max-h-[88vh] w-full overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl ${
          isSimBridge ? 'max-w-6xl' : 'max-w-5xl'
        }`}
      >
        <aside className="flex w-40 shrink-0 flex-col border-r border-border bg-canvas-raised p-3 sm:w-52">
          <div className="px-2 pb-3 pt-1 text-sm font-semibold text-text">System &amp; Settings</div>
          <nav className="flex flex-col gap-0.5" aria-label="Settings sections">
            {MODAL_SECTIONS.map((sec) => {
              if (sec.id === 'sim_bridge' && !simBridgeProps) return null;
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
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400">
              {MODAL_SECTIONS.find((s) => s.id === activeSection)?.label ?? 'Settings'}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              data-testid="close-settings-modal-btn"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="overflow-y-auto p-5">
            {isSimBridge && simBridgeProps ? (
              <SimBridgeView
                selectedSim={simBridgeProps.selectedSim}
                track={simBridgeProps.track}
                car={simBridgeProps.car}
                settings={settings}
                wsConnected={simBridgeProps.wsConnected}
                externalStreamActive={simBridgeProps.externalStreamActive}
                simStatus={simBridgeProps.simStatus}
                autoDetectEnabled={simBridgeProps.autoDetectEnabled}
                detectedSession={simBridgeProps.detectedSession}
                hardwareState={simBridgeProps.hardwareState}
                hardwareMapping={simBridgeProps.hardwareMapping}
                hardwareDriveEnabled={simBridgeProps.hardwareDriveEnabled}
                keyboardDriveEnabled={simBridgeProps.keyboardDriveEnabled}
                activeFault={simBridgeProps.activeFault}
                sessionPhaseOverride={simBridgeProps.sessionPhaseOverride}
                onToggleAutoDetect={simBridgeProps.onToggleAutoDetect}
                onToggleHardwareDrive={simBridgeProps.onToggleHardwareDrive}
                onToggleKeyboardDrive={simBridgeProps.onToggleKeyboardDrive}
                onUpdateHardwareMapping={simBridgeProps.onUpdateHardwareMapping}
                onCalibrateHardwareRest={simBridgeProps.onCalibrateHardwareRest}
                onUpdateSettings={onUpdateSettings}
                onResetSettings={simBridgeProps.onResetSettings}
                onTestCallout={onTestCallout}
                onOpenSettings={() => setActiveSection('profiles')}
                onTriggerFault={simBridgeProps.onTriggerFault}
                onManualPedalOverride={simBridgeProps.onManualPedalOverride}
                onChangeSessionPhaseOverride={simBridgeProps.onChangeSessionPhaseOverride}
              />
            ) : (
              <EngineerSettingsPanel
                settings={settings}
                onUpdateSettings={onUpdateSettings}
                onTestCallout={onTestCallout}
                onResetDefaults={onResetDefaults}
                section={activeSection as Exclude<EngineerSettingsSection, 'all'>}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
