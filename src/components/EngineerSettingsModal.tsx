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

export type EngineerSettingsModalSection =
  | Exclude<EngineerSettingsSection, 'all'>
  | 'connection'
  | 'profiles'
  | 'voice'
  | 'frequency'
  | 'sim_bridge';

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

type ModalTab = 'presets' | 'radio' | 'alerts' | 'strategy' | 'connection';

const MODAL_SECTIONS: Array<{ id: ModalTab; label: string; hint: string }> = [
  { id: 'presets', label: 'Presets', hint: 'One-click profiles' },
  { id: 'radio', label: 'Radio', hint: 'Voice & timing' },
  { id: 'alerts', label: 'Alerts', hint: 'What gets called' },
  { id: 'strategy', label: 'Strategy', hint: 'Pit & autonomy' },
  { id: 'connection', label: 'Connection', hint: 'Sim bridge & lab' },
];

function normalizeSection(section: EngineerSettingsModalSection | undefined): ModalTab {
  switch (section) {
    case 'profiles':
    case 'presets':
      return 'presets';
    case 'voice':
    case 'radio':
      return 'radio';
    case 'alerts':
      return 'alerts';
    case 'frequency':
    case 'strategy':
      return 'strategy';
    case 'sim_bridge':
    case 'connection':
      return 'connection';
    default:
      return 'presets';
  }
}

export function EngineerSettingsModal({
  isOpen,
  initialSection = 'presets',
  onClose,
  settings,
  onUpdateSettings,
  onTestCallout,
  onResetDefaults,
  simBridgeProps,
}: EngineerSettingsModalProps) {
  const [activeSection, setActiveSection] = useState<ModalTab>(normalizeSection(initialSection));

  useEffect(() => {
    if (isOpen) setActiveSection(normalizeSection(initialSection));
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

  const isConnection = activeSection === 'connection';
  const panelSection: EngineerSettingsSection =
    activeSection === 'connection' ? 'presets' : (activeSection as EngineerSettingsSection);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="engineer-settings-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`relative flex max-h-[88vh] w-full overflow-hidden rounded-2xl border border-cyan-500/25 bg-[#0B0F17] shadow-2xl ${
          isConnection ? 'max-w-6xl' : 'max-w-5xl'
        }`}
      >
        <aside className="flex w-44 shrink-0 flex-col border-r border-[#1B2230] bg-[#070A10] p-3 sm:w-56">
          <div className="px-2 pb-1 pt-1 text-sm font-bold text-slate-100">Settings</div>
          <p className="px-2 pb-3 text-[10px] uppercase tracking-wider text-amber-300/90">
            Redesigned 5-tab IA
          </p>
          <nav className="flex flex-col gap-1" aria-label="Settings sections">
            {MODAL_SECTIONS.map((sec) => {
              if (sec.id === 'connection' && !simBridgeProps) return null;
              const active = activeSection === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => setActiveSection(sec.id)}
                  data-testid={`settings-tab-${sec.id}`}
                  className={`rounded-xl px-3 py-2.5 text-left cursor-pointer ${
                    active
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:bg-[#121826] hover:text-slate-100'
                  }`}
                >
                  <div className="text-xs font-bold">{sec.label}</div>
                  <div className={`text-[10px] ${active ? 'text-slate-800' : 'text-slate-600'}`}>
                    {sec.hint}
                  </div>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-[#1B2230] px-5 py-3">
            <span className="font-mono text-[11px] uppercase tracking-wider text-cyan-300">
              {MODAL_SECTIONS.find((s) => s.id === activeSection)?.label ?? 'Settings'}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              data-testid="close-settings-modal-btn"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-[#121826] hover:text-slate-100 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="overflow-y-auto p-5">
            {isConnection && simBridgeProps ? (
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
                onOpenSettings={() => setActiveSection('presets')}
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
                section={panelSection}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
