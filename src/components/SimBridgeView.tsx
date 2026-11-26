import { useState, useEffect, useRef } from 'react';
import { Download, Radio, Sliders, Cpu, Settings, Volume2, RotateCcw } from 'lucide-react';
import type {
  CarProfile,
  CoachSettings,
  HardwareInputMapping,
  HardwareInputState,
  SimConnectionStatus,
  SimGameId,
  TrackProfile,
} from '../types/telemetry';
import { SIM_GAMES } from '../data/circuitsAndCars';
import type { AutoDetectedSession } from '../engine/autoDetect';
import { RADIO_MODULE_CATALOG, getEnabledModulesForPatch } from '../engine/engineerPresets';
import type { SessionPhaseOverride } from '../engine/sessionPhase';
import type { SimScenarioFault } from '../engine/telemetrySimulator';

interface SimBridgeViewProps {
  selectedSim: SimGameId;
  track: TrackProfile;
  car: CarProfile;
  settings: CoachSettings;
  wsConnected: boolean;
  externalStreamActive?: boolean;
  simStatus?: SimConnectionStatus;
  autoDetectEnabled: boolean;
  detectedSession: AutoDetectedSession | null;
  hardwareState: HardwareInputState;
  hardwareMapping: HardwareInputMapping;
  hardwareDriveEnabled: boolean;
  keyboardDriveEnabled: boolean;
  activeFault?: SimScenarioFault;
  sessionPhaseOverride?: SessionPhaseOverride;
  onToggleAutoDetect: () => void;
  onToggleHardwareDrive: () => void;
  onToggleKeyboardDrive: () => void;
  onUpdateHardwareMapping: (patch: Partial<HardwareInputMapping>) => void;
  onCalibrateHardwareRest: () => void;
  onUpdateSettings: (patch: Partial<CoachSettings>) => void;
  onTestCallout: () => void;
  onResetSettings?: () => void;
  onOpenSettings?: () => void;
  onTriggerFault?: (fault: SimScenarioFault) => void;
  onManualPedalOverride?: (brake: number | null, throttle: number | null) => void;
  onChangeSessionPhaseOverride?: (mode: SessionPhaseOverride) => void;
}

type BindTarget = 'steering' | 'throttle' | 'brake' | 'clutch' | null;

const SAMPLE_SESSION_PAYLOADS = [
  {
    id: 'spa_499p',
    label: 'LMU · Spa + Ferrari 499P',
    simId: 'Le Mans Ultimate',
    trackName: 'Circuit de Spa-Francorchamps',
    trackLengthKm: 7.004,
    carName: 'AF Corse Ferrari 499P #51',
    carClass: 'Hypercar',
    maxRpm: 8600,
    speedKmh: 274,
    lapDistPct: 0.295,
    throttle: 0.0,
    brake: 0.91,
    clutch: 0.0,
    steeringRad: 0.04,
  },
  {
    id: 'monza_gt3',
    label: 'ACC · Monza + Porsche 911 GT3 R',
    simId: 'acc',
    trackName: 'Autodromo Nazionale Monza',
    trackLengthKm: 5.793,
    carName: 'Porsche 911 GT3 R (992)',
    carClass: 'LMGT3',
    maxRpm: 9250,
    speedKmh: 262,
    lapDistPct: 0.155,
    throttle: 0.0,
    brake: 0.88,
    clutch: 0.0,
    steeringRad: -0.02,
  },
  {
    id: 'sebring_lmp2',
    label: 'rF2 · Sebring + Oreca 07 LMP2',
    simId: 'rf2',
    trackName: 'Sebring International Raceway',
    trackLengthKm: 6.019,
    carName: 'Oreca 07 Gibson',
    carClass: 'LMP2',
    maxRpm: 8900,
    speedKmh: 248,
    lapDistPct: 0.352,
    throttle: 0.86,
    brake: 0.0,
    clutch: 0.0,
    steeringRad: -0.22,
  },
];

export function SimBridgeView({
  selectedSim,
  track,
  car,
  settings,
  wsConnected,
  externalStreamActive = false,
  simStatus,
  autoDetectEnabled,
  detectedSession,
  hardwareState,
  hardwareMapping,
  hardwareDriveEnabled,
  keyboardDriveEnabled,
  activeFault = 'none',
  sessionPhaseOverride = 'auto',
  onToggleAutoDetect,
  onToggleHardwareDrive,
  onToggleKeyboardDrive,
  onUpdateHardwareMapping,
  onCalibrateHardwareRest,
  onTestCallout,
  onOpenSettings,
  onTriggerFault,
  onManualPedalOverride,
  onChangeSessionPhaseOverride,
}: SimBridgeViewProps) {
  const [packetStatus, setPacketStatus] = useState<string | null>(null);
  const [bindTarget, setBindTarget] = useState<BindTarget>(null);
  const [manualBrake, setManualBrake] = useState<number>(0);
  const [manualOverrideActive, setManualOverrideActive] = useState(false);
  const baselineAxesRef = useRef<number[]>([]);
  const simInfo = SIM_GAMES.find((s) => s.id === selectedSim) ?? SIM_GAMES[0];
  const isRemotePreview =
    typeof window !== 'undefined' &&
    !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

  // Auto-bind axis when user clicks Bind and moves wheel or pedal
  useEffect(() => {
    if (!bindTarget || !hardwareState.connected || hardwareState.sourceKind !== 'gamepad') {
      return;
    }
    const base = baselineAxesRef.current;
    if (base.length === 0) {
      baselineAxesRef.current = [...hardwareState.axes];
      return;
    }

    let bestAxis = -1;
    let bestDelta = 0.25;
    hardwareState.axes.forEach((val, idx) => {
      const diff = Math.abs(val - (base[idx] ?? 0));
      if (diff > bestDelta) {
        bestDelta = diff;
        bestAxis = idx;
      }
    });

    if (bestAxis >= 0) {
      const restVal = base[bestAxis] ?? 0;
      if (bindTarget === 'steering') {
        onUpdateHardwareMapping({ steeringAxis: bestAxis });
      } else if (bindTarget === 'throttle') {
        onUpdateHardwareMapping({
          throttleAxis: bestAxis,
          throttleButton: null,
          throttleRestValue: restVal,
          invertThrottle: restVal > 0.5,
        });
      } else if (bindTarget === 'brake') {
        onUpdateHardwareMapping({
          brakeAxis: bestAxis,
          brakeButton: null,
          brakeRestValue: restVal,
          invertBrake: restVal > 0.5,
        });
      } else if (bindTarget === 'clutch') {
        onUpdateHardwareMapping({
          clutchAxis: bestAxis,
          clutchButton: null,
          clutchRestValue: restVal,
          invertClutch: restVal > 0.5,
        });
      }
      setBindTarget(null);
      baselineAxesRef.current = [];
      return;
    }

    // Check trigger button movement if standard controller
    if (
      bindTarget !== 'steering' &&
      hardwareState.isStandardMapping &&
      hardwareState.pressedButtons.length > 0
    ) {
      const btnIdx = hardwareState.pressedButtons[0];
      if (bindTarget === 'throttle') {
        onUpdateHardwareMapping({ throttleButton: btnIdx, throttleAxis: null });
      } else if (bindTarget === 'brake') {
        onUpdateHardwareMapping({ brakeButton: btnIdx, brakeAxis: null });
      } else if (bindTarget === 'clutch') {
        onUpdateHardwareMapping({ clutchButton: btnIdx, clutchAxis: null });
      }
      setBindTarget(null);
      baselineAxesRef.current = [];
    }
  }, [bindTarget, hardwareState, onUpdateHardwareMapping]);

  const startAxisBind = (target: BindTarget) => {
    if (bindTarget === target) {
      setBindTarget(null);
      baselineAxesRef.current = [];
      return;
    }
    baselineAxesRef.current = [...hardwareState.axes];
    setBindTarget(target);
  };

  const handleSendTestPacket = async (sample?: (typeof SAMPLE_SESSION_PAYLOADS)[number]) => {
    setPacketStatus('Sending...');
    try {
      const payload = sample
        ? {
            timestampMs: Date.now(),
            simId: sample.simId,
            trackName: sample.trackName,
            trackLengthKm: sample.trackLengthKm,
            carName: sample.carName,
            carClass: sample.carClass,
            lapNumber: 2,
            lapDistPct: sample.lapDistPct,
            speedKmh: sample.speedKmh,
            rpm: Math.round(sample.maxRpm * 0.82),
            maxRpm: sample.maxRpm,
            gear: 4,
            throttle: sample.throttle,
            brake: sample.brake,
            clutch: sample.clutch,
            steeringRad: sample.steeringRad,
            latG: 0.7,
            longG: sample.brake > 0 ? -2.4 : 0.8,
            deltaSec: 0.12,
            fuelLiters: 46.2,
            tireTempC: { fl: 87, fr: 86, rl: 84, rr: 83 },
            tirePressurePsi: { fl: 26.8, fr: 26.7, rl: 26.2, rr: 26.1 },
            tireWearPct: { fl: 96, fr: 96, rl: 97, rr: 97 },
            brakeTempC: { fl: 640, fr: 635, rl: 470, rr: 465 },
            frontWheelSlip: 0.06,
            rearWheelSlip: 0.04,
            absActive: false,
            tcActive: false,
            offTrackRisk: 0.08,
            hazardAhead: false,
            hazardDistanceM: 999,
            hazardDescription: '',
            flagState: 'green',
          }
        : {
            timestampMs: Date.now(),
            simId: selectedSim,
            trackName: track.name,
            trackLengthKm: track.lengthKm,
            carName: car.name,
            carClass: car.carClass,
            lapNumber: 3,
            lapDistPct: 0.531,
            speedKmh: 288,
            rpm: 7900,
            maxRpm: car.maxRpm,
            gear: 6,
            throttle: 0,
            brake: 0.94,
            clutch: 0,
            steeringRad: 0.05,
            latG: 0.4,
            longG: -2.6,
            deltaSec: 0.14,
            fuelLiters: 42.5,
            tireTempC: { fl: 89, fr: 87, rl: 84, rr: 83 },
            tirePressurePsi: { fl: 26.8, fr: 26.7, rl: 26.2, rr: 26.1 },
            tireWearPct: { fl: 94, fr: 94, rl: 95, rr: 96 },
            brakeTempC: { fl: 680, fr: 670, rl: 490, rr: 485 },
            frontWheelSlip: 0.19,
            rearWheelSlip: 0.04,
            absActive: true,
            tcActive: false,
            offTrackRisk: 0.12,
            hazardAhead: false,
            hazardDistanceM: 999,
            hazardDescription: '',
            flagState: 'green',
          };

      const resp = await fetch('/api/telemetry/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (resp.ok) {
        setPacketStatus(
          sample
            ? `Sent ${sample.carName} @ ${sample.trackName} to ${data.delivered} cockpit client(s).`
            : `Delivered test frame to ${data.delivered} connected cockpit client(s).`
        );
      } else {
        setPacketStatus(data.error || 'Failed to send telemetry packet.');
      }
    } catch (err) {
      setPacketStatus(err instanceof Error ? err.message : 'Network error.');
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Top Left 6 Columns: Live Telemetry Bridge & Auto Session Detection */}
      <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-6">
        <div className="flex items-center justify-between border-b border-[#1B2230] pb-4">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-100">
              Sim Telemetry Bridge & Auto-Detect
            </h1>
            <p className="mt-0.5 text-xs text-slate-400">
              Connect {simInfo.name} ({simInfo.protocol}) to auto-detect car, track, and inputs
            </p>
          </div>
          <span
            className={`font-mono text-xs font-medium whitespace-nowrap shrink-0 ${
              wsConnected ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {wsConnected ? 'WebSocket Ready' : 'Connecting...'}
          </span>
        </div>

        <div className="mt-4 space-y-4 text-xs text-slate-300">
          {/* Live Game Process & Telemetry Diagnostics */}
          <div
            data-testid="sim-diagnostics-card"
            className="rounded-md border border-[#1B2230] bg-[#090B10] p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-display text-sm font-semibold text-slate-100">
                Live Simulator &amp; Telemetry Status
              </div>
              <span
                className={`font-mono text-[11px] font-semibold ${
                  externalStreamActive && simStatus?.connectionState !== 'in_pit'
                    ? 'text-emerald-400'
                    : simStatus?.gameRunning || externalStreamActive
                      ? 'text-amber-300'
                      : 'text-slate-400'
                }`}
              >
                {externalStreamActive && simStatus?.connectionState !== 'in_pit'
                  ? 'Connected · On Track'
                  : simStatus?.gameRunning || externalStreamActive
                    ? simStatus?.connectionState === 'in_pit'
                      ? 'Game Open · In Garage'
                      : 'Game Open · Menus'
                    : 'Offline · Waiting for Sim'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 font-mono text-[11px]">
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Game Process</div>
                <div className={simStatus?.gameRunning ? 'text-emerald-300' : 'text-slate-300'}>
                  {simStatus?.gameRunning ? simStatus.gameName ?? 'Detected' : 'Not Running'}
                </div>
              </div>
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Session State</div>
                <div className="text-slate-100">
                  {simStatus?.connectionState === 'on_track'
                    ? 'On Track (Live)'
                    : simStatus?.connectionState === 'in_pit'
                      ? 'In Garage / Pits'
                      : simStatus?.connectionState === 'menus'
                        ? 'In Menus'
                        : 'Standby'}
                </div>
              </div>
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Source</div>
                <div className="text-cyan-300">
                  {simStatus?.source === 'lmu-rest'
                    ? 'LMU REST (:6397)'
                    : simStatus?.source === 'shared-memory'
                      ? 'Shared Memory'
                      : simStatus?.source === 'udp-5606'
                        ? 'UDP (:5606)'
                        : '—'}
                </div>
              </div>
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Telemetry</div>
                <div className="text-slate-100">
                  {simStatus?.telemetryQuality === 'full'
                    ? 'Full (Pedals/Tires)'
                    : simStatus?.telemetryQuality === 'partial_rest'
                      ? 'LMU Native REST'
                      : '—'}
                </div>
              </div>
            </div>

            {simStatus?.note && (
              <p className="mt-2.5 text-[11px] text-slate-400">{simStatus.note}</p>
            )}

            {isRemotePreview && (
              <div className="mt-3 rounded border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
                You are viewing the remote Cloud Preview URL, which cannot inspect localhost:6397 or Windows game processes on your PC. Download and run the Windows Desktop App (.zip) locally on your PC for zero-config Le Mans Ultimate detection.
              </div>
            )}

            <div
              data-testid="lmu-legality-card"
              className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-[11px] leading-relaxed text-slate-300"
            >
              <div className="font-mono text-[11px] font-semibold text-emerald-300">
                ✓ Le Mans Ultimate Anti-Cheat &amp; Fair-Play Safe (Read-Only)
              </div>
              <p className="mt-1 text-slate-400">
                Reads LMU&apos;s native <code className="font-mono text-slate-300">LMU_Data</code> / <code className="font-mono text-slate-300">$LMU_Data$</code> shared memory, optional <code className="font-mono text-slate-300">$rFactor2SMMP_Telemetry$</code>, ACC <code className="font-mono text-slate-300">acpmf_*</code>, and built-in REST (<code className="font-mono text-slate-300">127.0.0.1:6397</code>) — identical in approach to Crew Chief, SimHub, and Coach Dave Delta. Zero DLL injection, zero game-file edits, zero RaceControl token scraping, and zero steering/pedal automation.
              </p>
            </div>
          </div>

          {/* Auto-Detection Status */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                <span className="font-display text-sm font-semibold text-slate-100">
                  Automatic Car & Track Detection
                </span>
              </div>
              <button
                type="button"
                onClick={onToggleAutoDetect}
                className={`rounded border px-2.5 py-1 font-mono text-xs font-medium cursor-pointer whitespace-nowrap ${
                  autoDetectEnabled
                    ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                    : 'border-[#273145] bg-[#10141D] text-slate-400'
                }`}
              >
                {autoDetectEnabled ? 'Auto-Switch: ON' : 'Auto-Switch: OFF'}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 font-mono text-[11px]">
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Active Sim</div>
                <div className="text-slate-100">{simInfo.name}</div>
              </div>
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Active Track</div>
                <div className="text-slate-100">{track.name}</div>
              </div>
              <div className="border-t border-[#1B2230] pt-2">
                <div className="text-slate-500">Active Car</div>
                <div className="text-slate-100">{car.name}</div>
              </div>
            </div>

            {detectedSession && (detectedSession.rawTrackName || detectedSession.rawCarName) && (
              <p className="mt-2.5 font-mono text-[11px] text-emerald-400">
                Last Bridge Metadata: {detectedSession.rawCarName ?? '—'} @{' '}
                {detectedSession.rawTrackName ?? '—'} (Track match: {detectedSession.trackConfidence},
                Car match: {detectedSession.carConfidence})
              </p>
            )}

            <div className="mt-3 border-t border-[#1B2230] pt-3">
              <div className="mb-2 text-[11px] text-slate-400">
                Test automatic Car & Track switching with simulated external telemetry packets:
              </div>
              <div className="flex flex-wrap gap-2">
                {SAMPLE_SESSION_PAYLOADS.map((sample) => (
                  <button
                    key={sample.id}
                    type="button"
                    onClick={() => handleSendTestPacket(sample)}
                    data-testid={`test-autodetect-${sample.id}`}
                    className="rounded border border-[#273145] bg-[#10141D] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 hover:border-cyan-500/60 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 1-Click Native Windows Desktop App (.exe) */}
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-2.5">
              <img
                src="/icon.svg"
                alt=""
                width={24}
                height={24}
                className="h-6 w-6 rounded-md shrink-0"
              />
              <div className="font-display text-sm font-semibold text-emerald-200">
                Native Windows Desktop App (ApexEngineer.exe — No Chrome Window)
              </div>
            </div>
            <p className="mt-2 leading-relaxed text-slate-300">
              Extract the ZIP and double-click <code className="font-mono text-emerald-200">ApexEngineer.exe</code> — opens fast in a dedicated native desktop window with the ApexEngineer icon (no Chrome tabs or black console), built-in LMU :6397 + UDP :5606 bridge, and optional 1-click Desktop shortcut.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href="/api/download-desktop-bundle"
                download="ApexEngineer-Windows.zip"
                data-testid="download-desktop-zip-btn"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download ApexEngineer.exe (.zip)</span>
              </a>
              <span className="font-mono text-[11px] text-slate-400">
                Includes Create_Desktop_Shortcut.bat &amp; apex-engineer.ico
              </span>
            </div>
          </div>

          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <div className="font-display text-sm font-semibold text-slate-100">
              Local UDP Bridge Agent (LMU / rF2 / ACC / SimHub)
            </div>
            <p className="mt-1.5 leading-relaxed text-slate-400">
              Forwards <code className="font-mono text-cyan-300">trackName</code>,{' '}
              <code className="font-mono text-cyan-300">carName</code>,{' '}
              <code className="font-mono text-cyan-300">trackLengthKm</code>, and live{' '}
              <code className="font-mono text-cyan-300">throttle / brake / clutch / steeringRad</code>{' '}
              from UDP port <code className="font-mono text-cyan-300">5606</code>.
            </p>
            <pre className="mt-2 overflow-x-auto rounded border border-[#1B2230] bg-[#0D111A] p-3 font-mono text-[11px] text-cyan-300">
              node apex-engineer-bridge.mjs
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href="/api/bridge/script"
                download="apex-engineer-bridge.mjs"
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download Bridge Script (.mjs)</span>
              </a>
              <button
                type="button"
                onClick={() => handleSendTestPacket()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#10141D] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-cyan-500/50 cursor-pointer whitespace-nowrap"
              >
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Send Current Session Packet</span>
              </button>
            </div>
            {packetStatus && (
              <p className="mt-2 font-mono text-xs text-emerald-400" role="status">
                {packetStatus}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Top Right 6 Columns: Hardware Wheel, Pedals & Input Detector */}
      <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-4">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-100">
              Live Wheel, Pedals & Input Detection
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Detects USB steering wheels, load-cell pedals, gamepads, or keyboard simultaneously
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleHardwareDrive}
              className={`rounded border px-2.5 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                hardwareDriveEnabled
                  ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                  : 'border-[#273145] bg-[#090B10] text-slate-400'
              }`}
            >
              {hardwareDriveEnabled ? 'Inject Inputs: ON' : 'Inject Inputs: OFF'}
            </button>
            <button
              type="button"
              onClick={onToggleKeyboardDrive}
              className={`rounded border px-2.5 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                keyboardDriveEnabled
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                  : 'border-[#273145] bg-[#090B10] text-slate-400'
              }`}
            >
              {keyboardDriveEnabled ? 'WASD Drive: ON' : 'WASD Drive: OFF'}
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {/* Connected Device Status + Live Pedal/Wheel Readouts */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                <span className="font-medium text-slate-100" data-testid="hardware-device-name">
                  {hardwareState.connected
                    ? hardwareState.deviceName
                    : 'No USB Wheel / Controller Detected — press any pedal or button to wake'}
                </span>
              </div>
              {hardwareState.connected && hardwareState.sourceKind === 'gamepad' && (
                <button
                  type="button"
                  onClick={onCalibrateHardwareRest}
                  className="rounded border border-[#273145] bg-[#10141D] px-2.5 py-1 font-mono text-[11px] text-cyan-300 hover:border-cyan-500/50 cursor-pointer whitespace-nowrap"
                >
                  Zero Rest Pedals
                </button>
              )}
            </div>

            {/* Live Bars */}
            <div className="mt-3.5 grid grid-cols-2 gap-3 sm:grid-cols-4 font-mono text-xs tabular-nums">
              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Throttle</span>
                  <span className="text-emerald-400">{Math.round(hardwareState.throttle * 100)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-sm bg-[#161B26]">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-75"
                    style={{ width: `${Math.round(hardwareState.throttle * 100)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Brake</span>
                  <span className="text-rose-400">{Math.round(hardwareState.brake * 100)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-sm bg-[#161B26]">
                  <div
                    className="h-full bg-rose-500 transition-all duration-75"
                    style={{ width: `${Math.round(hardwareState.brake * 100)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Clutch</span>
                  <span className="text-cyan-400">{Math.round(hardwareState.clutch * 100)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-sm bg-[#161B26]">
                  <div
                    className="h-full bg-cyan-400 transition-all duration-75"
                    style={{ width: `${Math.round(hardwareState.clutch * 100)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Steer</span>
                  <span className="text-slate-200">{hardwareState.steeringDeg}°</span>
                </div>
                <div className="relative h-2 w-full overflow-hidden rounded-sm bg-[#161B26]">
                  <div className="absolute left-1/2 top-0 h-full w-px bg-slate-600" />
                  <div
                    className="absolute top-0 h-full w-2 -translate-x-1/2 rounded-sm bg-cyan-400 transition-all duration-75"
                    style={{ left: `${50 + hardwareState.steeringNormalized * 46}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Raw Axes Monitor */}
            {hardwareState.axes.length > 0 && (
              <div className="mt-3 border-t border-[#1B2230] pt-2.5 font-mono text-[11px] text-slate-400">
                Raw Axes:{' '}
                {hardwareState.axes.map((a, i) => `A${i}=${a.toFixed(2)}`).join(' · ')}
                {hardwareState.pressedButtons.length > 0 &&
                  ` | Buttons: ${hardwareState.pressedButtons.join(', ')}`}
              </div>
            )}
          </div>

          {/* One-Click Pedal & Wheel Binding */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4 text-xs">
            <div className="flex items-center justify-between">
              <div className="font-display text-sm font-semibold text-slate-100">
                Axis & Pedal Binding
              </div>
              {bindTarget && (
                <span className="font-mono text-xs text-amber-300">
                  Move or press {bindTarget.toUpperCase()} now...
                </span>
              )}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="flex items-center justify-between border-t border-[#1B2230] pt-2">
                <div>
                  <div className="text-slate-200">Steering</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    Axis {hardwareMapping.steeringAxis}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hardwareMapping.invertSteering}
                      onChange={(e) =>
                        onUpdateHardwareMapping({ invertSteering: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    Invert
                  </label>
                  <button
                    type="button"
                    onClick={() => startAxisBind('steering')}
                    className={`rounded border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                      bindTarget === 'steering'
                        ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                        : 'border-[#273145] bg-[#10141D] text-slate-200 hover:border-cyan-500/50'
                    }`}
                  >
                    {bindTarget === 'steering' ? 'Listening...' : 'Bind'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#1B2230] pt-2">
                <div>
                  <div className="text-slate-200">Throttle</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {hardwareMapping.throttleButton !== null
                      ? `Btn ${hardwareMapping.throttleButton}`
                      : `Axis ${hardwareMapping.throttleAxis ?? '—'}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hardwareMapping.invertThrottle}
                      onChange={(e) =>
                        onUpdateHardwareMapping({ invertThrottle: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    Invert
                  </label>
                  <button
                    type="button"
                    onClick={() => startAxisBind('throttle')}
                    className={`rounded border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                      bindTarget === 'throttle'
                        ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                        : 'border-[#273145] bg-[#10141D] text-slate-200 hover:border-cyan-500/50'
                    }`}
                  >
                    {bindTarget === 'throttle' ? 'Listening...' : 'Bind'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#1B2230] pt-2">
                <div>
                  <div className="text-slate-200">Brake</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {hardwareMapping.brakeButton !== null
                      ? `Btn ${hardwareMapping.brakeButton}`
                      : `Axis ${hardwareMapping.brakeAxis ?? '—'}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hardwareMapping.invertBrake}
                      onChange={(e) =>
                        onUpdateHardwareMapping({ invertBrake: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    Invert
                  </label>
                  <button
                    type="button"
                    onClick={() => startAxisBind('brake')}
                    className={`rounded border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                      bindTarget === 'brake'
                        ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                        : 'border-[#273145] bg-[#10141D] text-slate-200 hover:border-cyan-500/50'
                    }`}
                  >
                    {bindTarget === 'brake' ? 'Listening...' : 'Bind'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#1B2230] pt-2">
                <div>
                  <div className="text-slate-200">Clutch</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {hardwareMapping.clutchButton !== null
                      ? `Btn ${hardwareMapping.clutchButton}`
                      : `Axis ${hardwareMapping.clutchAxis ?? '—'}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hardwareMapping.invertClutch}
                      onChange={(e) =>
                        onUpdateHardwareMapping({ invertClutch: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    Invert
                  </label>
                  <button
                    type="button"
                    onClick={() => startAxisBind('clutch')}
                    className={`rounded border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                      bindTarget === 'clutch'
                        ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                        : 'border-[#273145] bg-[#10141D] text-slate-200 hover:border-cyan-500/50'
                    }`}
                  >
                    {bindTarget === 'clutch' ? 'Listening...' : 'Bind'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom 12 Columns: Simulation & Fault Test Lab (moved out of Pit Wall) */}
      {(onTriggerFault || onChangeSessionPhaseOverride) && (
        <section
          className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-12"
          data-testid="sim-fault-test-lab"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3.5">
            <div>
              <h2 className="font-display text-base font-bold text-slate-100">
                Simulation Scenarios &amp; Fault Injection Lab
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Test spotter alerts, tire/brake warnings, fuel calls, manual braking, and session phase transitions offline
              </p>
            </div>
            {onTriggerFault && (
              <button
                type="button"
                onClick={() => {
                  onTriggerFault('none');
                  setManualOverrideActive(false);
                  setManualBrake(0);
                  onManualPedalOverride?.(null, null);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-slate-100 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Clear Fault</span>
              </button>
            )}
          </div>

          <div className="mt-4 space-y-4">
            {onChangeSessionPhaseOverride && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3.5">
                <span className="text-xs font-medium text-slate-300">
                  Session Phase Override (Practice / Qualifying / Race)
                </span>
                <div
                  className="flex flex-wrap items-center gap-1 rounded-md border border-[#1B2230] bg-[#090B10] p-1"
                  data-testid="session-phase-selector"
                >
                  {(
                    [
                      { id: 'auto', label: 'Auto (Live Sim)' },
                      { id: 'practice', label: 'Practice' },
                      { id: 'qualifying', label: 'Qualifying' },
                      { id: 'race', label: 'Race' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onChangeSessionPhaseOverride(opt.id)}
                      data-testid={`session-phase-${opt.id}-btn`}
                      aria-pressed={sessionPhaseOverride === opt.id}
                      className={`rounded px-2.5 py-1 font-mono text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        sessionPhaseOverride === opt.id
                          ? opt.id === 'race'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : opt.id === 'qualifying'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-cyan-500/20 text-cyan-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {onTriggerFault && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                    Spotter &amp; Track Hazards
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { id: 'side_by_side', label: 'Car Left', testid: 'sim-side-by-side-btn', tone: 'rose' },
                      { id: 'side_by_side_right', label: 'Car Right', testid: 'sim-car-right-btn', tone: 'rose' },
                      { id: 'crash_ahead', label: 'Accident Ahead', testid: 'sim-crash-ahead-btn', tone: 'amber' },
                      { id: 'rival_attack', label: 'Rival Passing Behind', testid: 'sim-rival-attack-btn', tone: 'amber' },
                      { id: 'attack_chance', label: 'Attack Opportunity', testid: 'sim-attack-chance-btn', tone: 'emerald' },
                    ].map((btn) => (
                      <button
                        key={btn.id}
                        type="button"
                        onClick={() => onTriggerFault(btn.id as SimScenarioFault)}
                        data-testid={btn.testid}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          activeFault === btn.id
                            ? btn.tone === 'rose'
                              ? 'border-rose-400 bg-rose-500/15 text-rose-200'
                              : btn.tone === 'emerald'
                                ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200'
                                : 'border-amber-400 bg-amber-500/15 text-amber-200'
                            : 'border-[#273145] bg-[#090B10] text-slate-200 hover:border-cyan-500/50'
                        }`}
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                    Driving &amp; Car Faults
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { id: 'late_brake', label: 'Late Brake' },
                      { id: 'lockup', label: 'Front Lockup' },
                      { id: 'snap_oversteer', label: 'Exit Snap' },
                      { id: 'self_crash', label: 'Simulate Crash', testid: 'sim-self-crash-btn', tone: 'rose' },
                      { id: 'cold_tires', label: 'Cold Tires', testid: 'sim-cold-tires-btn' },
                      { id: 'overheat_tires', label: 'Tire Overheat', testid: 'sim-overheat-tires-btn' },
                      { id: 'degraded_tires', label: 'Worn Tires', testid: 'sim-degraded-tires-btn' },
                      { id: 'brake_overheat', label: 'Brake Overheat', testid: 'sim-brake-overheat-btn' },
                      { id: 'low_fuel', label: 'Low Fuel', testid: 'sim-low-fuel-btn' },
                    ].map((btn) => (
                      <button
                        key={btn.id}
                        type="button"
                        onClick={() => onTriggerFault(btn.id as SimScenarioFault)}
                        data-testid={btn.testid}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          activeFault === btn.id
                            ? btn.tone === 'rose'
                              ? 'border-rose-400 bg-rose-500/20 text-rose-200'
                              : 'border-amber-400 bg-amber-500/15 text-amber-200'
                            : btn.tone === 'rose'
                              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:border-rose-400'
                              : 'border-[#273145] bg-[#090B10] text-slate-200 hover:border-cyan-500/50'
                        }`}
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {onManualPedalOverride && (
              <div className="flex flex-wrap items-center gap-4 border-t border-[#1B2230] pt-3.5">
                <label htmlFor="manual-brake-override" className="text-xs font-medium text-slate-300">
                  Manual Brake Override ({manualOverrideActive ? `${Math.round(manualBrake * 100)}%` : 'Auto'})
                </label>
                <input
                  id="manual-brake-override"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(manualBrake * 100)}
                  onChange={(e) => {
                    const v = Number(e.target.value) / 100;
                    setManualBrake(v);
                    setManualOverrideActive(v > 0);
                    onManualPedalOverride(v > 0 ? v : null, null);
                  }}
                  className="h-1.5 w-48 accent-rose-500 cursor-pointer"
                />
                {manualOverrideActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setManualOverrideActive(false);
                      setManualBrake(0);
                      onManualPedalOverride(null, null);
                    }}
                    className="text-xs text-cyan-400 hover:underline cursor-pointer"
                  >
                    Release
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Bottom 12 Columns: Concise Race Engineer Summary + Quick Launch to Settings Modal */}
      <section
        className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-12"
        data-testid="bridge-engineer-summary"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-100">
              Race Engineer Audio, Alerts &amp; Coaching Profiles
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              {settings.voiceEnabled
                ? `Voice ON (${settings.useGeminiTts ? `Gemini HD · ${settings.geminiVoiceName}` : 'Browser Speech'})`
                : 'Voice Muted'}{' '}
              · {getEnabledModulesForPatch(settings).length}/{RADIO_MODULE_CATALOG.length} alert channels active ·{' '}
              Min speak gap {settings.minSpeakIntervalSec}s · Focus:{' '}
              {settings.focusMode === 'all'
                ? 'All Areas'
                : settings.focusMode === 'braking'
                  ? 'Braking'
                  : settings.focusMode === 'apex_line'
                    ? 'Apex Line'
                    : 'Exit Traction'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onTestCallout}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
            >
              <Volume2 className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              <span>Test Voice</span>
            </button>
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                data-testid="bridge-open-settings-btn"
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
              >
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Open Engineer Settings</span>
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
