import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { AlertTriangle, ChevronDown, KeyRound, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import {
  AI_STATUS_EVENT,
  INITIAL_AI_STATUS,
  extractAndPublishAiStatus,
  formatAiStatusDisplay,
  formatAvailableAtClock,
  formatRemainingDuration,
  getNextDailyResetTimestampMs,
  type AiStatusState,
} from './utils/aiStatus';
import {
  CARS,
  SIM_GAMES,
  TRACKS,
  buildReferenceLap,
  buildSampleUserLap,
  getActiveCorner,
  getUpcomingCorner,
} from './data/circuitsAndCars';
import {
  analyzeLapByCorners,
  createInitialCooldowns,
  evaluateDriverSkillMetrics,
  evaluateLiveTelemetry,
  formatCornerLabel,
  type CooldownMap,
} from './engine/coachRules';
import {
  detectSessionFromTelemetry,
  type AutoDetectedSession,
} from './engine/autoDetect';
import {
  buildAdaptiveElectronicsSuggestions,
  computePitStrategy,
  createDefaultDriverProfile,
  createInitialPitStrategyVoiceState,
  evaluateAutonomyAction,
  evaluatePitStrategyVoiceCallout,
  recordCornerLearningFromLap,
  recordDriverObservation,
  type PitStrategyVoiceState,
} from './engine/driverLearning';
import {
  createInitialOpponents,
  evaluateRacecraft,
  stepOpponentsSimulation,
} from './engine/racecraft';
import {
  createInitialOverrides,
  stepTelemetrySimulation,
  type SimDriverOverrides,
  type SimScenarioFault,
} from './engine/telemetrySimulator';
import type { SessionGridMode } from './engine/lmuSinglePlayer';
import {
  buildSessionTransitionMessage,
  formatSessionTypeLabel,
  getEffectiveSessionType,
  type SessionPhaseOverride,
} from './engine/sessionPhase';
import {
  detectTelemetryIncident,
  evaluateCoachRealityCheck,
  resolveSessionTruthStatus,
  type TelemetryIncident,
} from './engine/telemetryTruth';
import type {
  AiPostRaceBrief,
  AppView,
  AutonomyActionLog,
  CarSetup,
  CoachCallout,
  CoachSettings,
  DriverProfile,
  DriverSetupIntake,
  ElectronicsSuggestion,
  HardwareInputMapping,
  HardwareInputState,
  LapRecord,
  PitMfdSyncStatus,
  PitStrategyPlan,
  RaceReport,
  RadioProtocol,
  SimConnectionStatus,
  SimGameId,
  SimSessionType,
  TelemetryFrame,
} from './types/telemetry';
import { buildPostRaceReport } from './engine/raceReport';
import { DEFAULT_DRIVER_SETUP_INTAKE } from './engine/setupPhysics';
import {
  createInitialMappingForGamepad,
  DEFAULT_STANDARD_MAPPING,
  detectBestGamepad,
  EMPTY_HARDWARE_STATE,
  readGamepadHardwareState,
} from './utils/hardwareInputs';
import { speakCoachCallout, stopAllRadioSpeech, unlockAudioPlayback } from './utils/radioAudio';
import {
  LiveCoachVoiceClient,
  type LiveVoiceStatus,
  type LiveVoiceTurnPhase,
} from './utils/liveVoiceClient';
import { TopBar } from './components/TopBar';
import { PitWallView } from './components/PitWallView';
import { CockpitHudView, type LivePedalTraceSample } from './components/CockpitHudView';
import { TelemetryLabView } from './components/TelemetryLabView';
import { SetupGarageView } from './components/SetupGarageView';
import { RaceReportsView } from './components/RaceReportsView';
import {
  EngineerSettingsModal,
  type EngineerSettingsModalSection,
} from './components/EngineerSettingsModal';
import { sampleReferencePedalAtPct } from './engine/telemetryWorkbook';

const STORAGE_KEYS = {
  driverProfile: 'apex_engineer_driver_profile_v1',
  settings: 'apex_engineer_coach_settings_v2',
  hardwareMapping: 'apex_engineer_hw_mapping_v1',
  raceReports: 'apex_engineer_race_reports_v1',
  setupIntake: 'apex-engineer-setup-intake',
};

const DEFAULT_SETTINGS: CoachSettings = {
  voiceEnabled: true,
  useGeminiTts: true,
  geminiVoiceName: 'Fenrir',
  language: 'en',
  focusMode: 'all',
  radioProtocol: 'pro_terse',
  preCornerCuesEnabled: true,
  racecraftAlertsEnabled: true,
  multiclassTrafficEnabled: true,
  tireAlertsEnabled: true,
  tirePressureAlertsEnabled: true,
  brakeTempAlertsEnabled: true,
  fuelAlertsEnabled: true,
  pitWindowCountdownEnabled: true,
  autoSelectPitTires: true,
  preselectPitTiresInLmu: false,
  pitRaceMode: 'auto',
  pitTireOverride: 'auto',
  fuelSaveCallsEnabled: false,
  fuelTargetLitersPerLap: 0,
  gapSplitsEnabled: true,
  sectorSplitsEnabled: true,
  electronicsCheckEnabled: true,
  trackLimitsAlertsEnabled: true,
  tractionAlertsEnabled: true,
  lapPaceAlertsEnabled: true,
  urgentInterruptsRadio: true,
  autonomyMode: 'advise',
  radioSquelchFx: true,
  verbosity: 'balanced',
  minSpeakIntervalSec: 4,
  lateBrakeThresholdMeters: 10,
  hazardAlertsEnabled: true,
  speechRate: 1.06,
  voiceVolume: 0.95,
};

function loadStoredProfile(): DriverProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.driverProfile);
    if (raw) return JSON.parse(raw) as DriverProfile;
  } catch {
    // ignore storage errors
  }
  return createDefaultDriverProfile(true);
}

function loadStoredSettings(): CoachSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) {
      return {
        ...DEFAULT_SETTINGS,
        ...(JSON.parse(raw) as Partial<CoachSettings>),
        language: 'en',
      };
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_SETTINGS;
}

function loadStoredHardwareMapping(): HardwareInputMapping {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.hardwareMapping);
    if (raw) return { ...DEFAULT_STANDARD_MAPPING, ...(JSON.parse(raw) as Partial<HardwareInputMapping>) };
  } catch {
    // ignore storage errors
  }
  return DEFAULT_STANDARD_MAPPING;
}

function loadStoredSetupIntake(): DriverSetupIntake {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.setupIntake);
    if (raw) {
      return {
        ...DEFAULT_DRIVER_SETUP_INTAKE,
        ...(JSON.parse(raw) as Partial<DriverSetupIntake>),
      };
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_DRIVER_SETUP_INTAKE;
}

const GREEK_SCRIPT_RE = /[\u0370-\u03FF\u1F00-\u1FFF]/;

function loadStoredRaceReports(): RaceReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.raceReports);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return (parsed as RaceReport[]).map((rep) => {
          const serialized = JSON.stringify(rep);
          if (!GREEK_SCRIPT_RE.test(serialized)) {
            return rep;
          }
          const trackMatch = TRACKS.find((t) => t.id === rep.trackId) ?? TRACKS[0];
          const carMatch = CARS.find((c) => c.id === rep.carId) ?? CARS[0];
          const ref = buildReferenceLap(trackMatch, carMatch);
          const fallbackLap = buildSampleUserLap(trackMatch, carMatch);
          const repLap: LapRecord =
            rep.representativeFrames && rep.representativeFrames.length >= 20
              ? {
                  lapNumber: 1,
                  lapTimeSec: rep.bestLapSec || fallbackLap.lapTimeSec,
                  sector1Sec: (rep.bestLapSec || fallbackLap.lapTimeSec) * 0.31,
                  sector2Sec: (rep.bestLapSec || fallbackLap.lapTimeSec) * 0.38,
                  sector3Sec: (rep.bestLapSec || fallbackLap.lapTimeSec) * 0.31,
                  valid: true,
                  maxSpeedKmh: Math.round(
                    Math.max(...rep.representativeFrames.map((f) => f.speedKmh))
                  ),
                  avgTrailBrakeScore: rep.trailBrakingScore || 78,
                  frames: rep.representativeFrames.map((pt, idx) => {
                    const baseFrame =
                      fallbackLap.frames[
                        Math.min(idx, fallbackLap.frames.length - 1)
                      ];
                    return {
                      ...baseFrame,
                      lapDistPct: pt.lapDistPct,
                      speedKmh: pt.speedKmh,
                      throttle: pt.throttle,
                      brake: pt.brake,
                      steeringRad: pt.steeringRad,
                      frontWheelSlip: pt.frontWheelSlip,
                      rearWheelSlip: pt.rearWheelSlip,
                    };
                  }),
                }
              : fallbackLap;

          const rebuilt = buildPostRaceReport({
            simId: rep.simId ?? 'lmu',
            simName: rep.simName ?? 'Le Mans Ultimate',
            track: trackMatch,
            car: carMatch,
            setup: carMatch.defaultSetup,
            driverProfile: createDefaultDriverProfile(false),
            laps: [repLap],
            referenceSamples: ref,
            mistakeCounts: rep.mistakeCounts ?? {
              lateBrakes: 2,
              lockups: 1,
              exitSnaps: 1,
              offTracks: 0,
            },
            sessionMode: rep.sessionMode ?? 'practice_stint',
            ...(rep.sessionType ? { sessionType: rep.sessionType } : {}),
            raceDistanceLaps: rep.raceDistanceLaps || 18,
            language: 'en',
          });

          const cleanAiBrief =
            rep.aiBrief && !GREEK_SCRIPT_RE.test(JSON.stringify(rep.aiBrief))
              ? rep.aiBrief
              : undefined;

          return {
            ...rebuilt,
            id: rep.id,
            createdAtIso: rep.createdAtIso,
            lapsCompleted: rep.lapsCompleted || rebuilt.lapsCompleted,
            bestLapSec: rep.bestLapSec || rebuilt.bestLapSec,
            avgLapSec: rep.avgLapSec || rebuilt.avgLapSec,
            finishPosition: rep.finishPosition || rebuilt.finishPosition,
            aiBrief: cleanAiBrief,
          };
        });
      }
    }
  } catch {
    // ignore storage errors
  }
  return [];
}

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('pitwall');
  const [telemetryTab, setTelemetryTab] = useState<'trace' | 'reports'>('trace');
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<EngineerSettingsModalSection>('profiles');
  const [sessionPopoverOpen, setSessionPopoverOpen] = useState<boolean>(false);
  const [selectedSim, setSelectedSim] = useState<SimGameId>('lmu');
  const [selectedTrackId, setSelectedTrackId] = useState<string>('lemans');
  const [selectedCarId, setSelectedCarId] = useState<string>('porsche_963');
  const [isLiveRunning, setIsLiveRunning] = useState<boolean>(false);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [autoDetectEnabled, setAutoDetectEnabled] = useState<boolean>(true);
  const [detectedSession, setDetectedSession] = useState<AutoDetectedSession | null>(null);
  const [externalStreamActive, setExternalStreamActive] = useState<boolean>(false);
  const [simStatus, setSimStatus] = useState<SimConnectionStatus>({
    gameRunning: false,
    simId: null,
    gameName: null,
    connectionState: 'offline',
    source: 'none',
    telemetryQuality: 'none',
    lastPacketAtMs: null,
    rawTrackName: null,
    rawCarName: null,
  });

  // Real-time hardware wheel / pedals / gamepad / keyboard input detection
  const [hardwareState, setHardwareState] = useState<HardwareInputState>(EMPTY_HARDWARE_STATE);
  const [hardwareMapping, setHardwareMapping] = useState<HardwareInputMapping>(() =>
    loadStoredHardwareMapping()
  );
  const [hardwareDriveEnabled, setHardwareDriveEnabled] = useState<boolean>(true);
  const [keyboardDriveEnabled, setKeyboardDriveEnabled] = useState<boolean>(false);

  const track = useMemo(
    () => TRACKS.find((t) => t.id === selectedTrackId) ?? TRACKS[0],
    [selectedTrackId]
  );
  const car = useMemo(
    () => CARS.find((c) => c.id === selectedCarId) ?? CARS[0],
    [selectedCarId]
  );

  const referenceSamples = useMemo(() => buildReferenceLap(track, car), [track, car]);
  const sampleLap = useMemo(() => buildSampleUserLap(track, car), [track, car]);

  const [setup, setSetup] = useState<CarSetup>(() => car.defaultSetup);
  const [driverProfile, setDriverProfile] = useState<DriverProfile>(() => loadStoredProfile());
  const [setupIntake, setSetupIntake] = useState<DriverSetupIntake>(() => loadStoredSetupIntake());
  const [settings, setSettings] = useState<CoachSettings>(() => loadStoredSettings());
  const [autonomyLog, setAutonomyLog] = useState<AutonomyActionLog[]>([]);
  const [isAskingEngineer, setIsAskingEngineer] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const [frame, setFrame] = useState<TelemetryFrame>(() => ({
    ...sampleLap.frames[0],
    timestampMs: Date.now(),
    lapNumber: 1,
    lapDistPct: 0,
    speedKmh: 0,
    rpm: 1100,
    gear: 0,
    throttle: 0,
    brake: 0,
    clutch: 0,
    steeringRad: 0,
    latG: 0,
    longG: 0,
    deltaSec: 0,
    fuelLiters: 54.0,
    ...(car.carClass === 'Hypercar' ? { virtualEnergyPct: 92 } : {}),
    tireTempC: { fl: 82, fr: 82, rl: 80, rr: 80 },
    tireWearPct: { fl: 100, fr: 100, rl: 100, rr: 100 },
    opponents: createInitialOpponents(
      track,
      car,
      0,
      0
    ),
  }));

  const [callouts, setCallouts] = useState<CoachCallout[]>(() => [
    {
      id: 'welcome-radio',
      timestampMs: Date.now(),
      lapNumber: 1,
      cornerName: 'Pit Exit · Standby',
      severity: 'info',
      category: 'engineer',
      message: `Pit radio standing by for ${car.name} at ${track.name}. Waiting for live simulator telemetry (UDP :5606) or wheel/pedals — click Practice Demo anytime to run a test lap.`,
      spoken: false,
      source: 'realtime-engine',
    },
  ]);

  const [sessionGridMode, setSessionGridMode] = useState<SessionGridMode>('grid');
  const sessionGridModeRef = useRef<SessionGridMode>(sessionGridMode);
  sessionGridModeRef.current = sessionGridMode;
  const [sessionPhaseOverride, setSessionPhaseOverride] = useState<SessionPhaseOverride>('auto');
  const prevSessionPhaseRef = useRef<SimSessionType>('unknown');
  const overridesRef = useRef<SimDriverOverrides>(createInitialOverrides());
  const [activeFault, setActiveFault] = useState<SimScenarioFault>('none');
  const cooldownsRef = useRef<CooldownMap>(createInitialCooldowns());
  const prevFrameRef = useRef<TelemetryFrame | null>(null);
  const settingsRef = useRef<CoachSettings>(settings);
  settingsRef.current = settings;
  const driverProfileRef = useRef<DriverProfile>(driverProfile);
  driverProfileRef.current = driverProfile;
  const autoDetectRef = useRef<boolean>(autoDetectEnabled);
  autoDetectRef.current = autoDetectEnabled;
  const selectedTrackIdRef = useRef<string>(selectedTrackId);
  selectedTrackIdRef.current = selectedTrackId;
  const trackRef = useRef(track);
  trackRef.current = track;
  const referenceSamplesRef = useRef(referenceSamples);
  referenceSamplesRef.current = referenceSamples;
  const selectedCarIdRef = useRef<string>(selectedCarId);
  selectedCarIdRef.current = selectedCarId;
  const selectedSimRef = useRef<SimGameId>(selectedSim);
  selectedSimRef.current = selectedSim;
  const lastExternalPacketAtRef = useRef<number>(0);
  const hardwareMappingRef = useRef<HardwareInputMapping>(hardwareMapping);
  hardwareMappingRef.current = hardwareMapping;
  const hardwareDriveRef = useRef<boolean>(hardwareDriveEnabled);
  hardwareDriveRef.current = hardwareDriveEnabled;
  const keyboardDriveRef = useRef<boolean>(keyboardDriveEnabled);
  keyboardDriveRef.current = keyboardDriveEnabled;
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const lastInputActivityAtRef = useRef<number>(0);
  const autoMappedDeviceIdRef = useRef<string | null>(null);
  const lastAutoAppliedAtRef = useRef<number>(0);
  const [recentPedalTrace, setRecentPedalTrace] = useState<LivePedalTraceSample[]>([]);
  const recentPedalTraceRef = useRef<LivePedalTraceSample[]>([]);
  const [recordedLap, setRecordedLap] = useState<LapRecord | null>(null);
  const [sessionLaps, setSessionLaps] = useState<LapRecord[]>([]);
  const sessionLapsRef = useRef<LapRecord[]>([]);
  sessionLapsRef.current = sessionLaps;
  const sessionMistakesRef = useRef({
    lateBrakes: 0,
    lockups: 0,
    exitSnaps: 0,
    offTracks: 0,
  });
  const wasExternalOnTrackRef = useRef<boolean>(false);
  const [recentIncidents, setRecentIncidents] = useState<TelemetryIncident[]>([]);
  const recentIncidentsRef = useRef<TelemetryIncident[]>([]);
  const lastLiveSyncedStateRef = useRef<string>('');
  const lastLiveSyncSentAtRef = useRef<number>(0);
  const latestFrameRef = useRef<TelemetryFrame>(frame);
  latestFrameRef.current = frame;
  const [raceReports, setRaceReports] = useState<RaceReport[]>(() => loadStoredRaceReports());
  const recordedLapFramesRef = useRef<TelemetryFrame[]>([]);
  const latestLapRef = useRef<number>(frame.lapNumber);
  latestLapRef.current = frame.lapNumber;

  const recordTelemetryIncidentIfDetected = useCallback(
    (
      nextFrame: TelemetryFrame,
      prevFrame: TelemetryFrame | null,
      activeCornerForFrame: ReturnType<typeof getActiveCorner>,
      isDrivingSession: boolean
    ) => {
      const candidate = detectTelemetryIncident({
        nextFrame,
        prevFrame,
        track,
        activeCorner: activeCornerForFrame,
        isDrivingSession,
      });
      if (!candidate) return;

      const duplicateRecent = recentIncidentsRef.current.some(
        (inc) =>
          inc.type === candidate.type &&
          inc.cornerNumber === candidate.cornerNumber &&
          candidate.timestampMs - inc.timestampMs < 6000
      );
      if (duplicateRecent) return;

      const recorded: TelemetryIncident = {
        ...candidate,
        id: `inc-${candidate.timestampMs}-${Math.random().toString(36).slice(2, 6)}`,
      };
      const updatedIncidents = [recorded, ...recentIncidentsRef.current].slice(0, 20);
      recentIncidentsRef.current = updatedIncidents;
      setRecentIncidents(updatedIncidents);
      if (
        liveVoiceStatusRef.current === 'listening' ||
        liveVoiceStatusRef.current === 'speaking'
      ) {
        liveClientRef.current?.sendTelemetryState(
          `NEW INCIDENT RECORDED: ${recorded.type} at ${recorded.cornerName}, Lap ${recorded.lapNumber}, speed ${recorded.speedKmh} km/h.`
        );
      }
    },
    [track]
  );

  const pushPedalAndLapSample = useCallback(
    (nextFrame: TelemetryFrame, prevFrame: TelemetryFrame | null) => {
      const refPedal = sampleReferencePedalAtPct(referenceSamplesRef.current, nextFrame.lapDistPct);
      const nextTrace: LivePedalTraceSample[] = [
        ...recentPedalTraceRef.current.slice(-44),
        {
          throttle: nextFrame.throttle,
          brake: nextFrame.brake,
          refThrottle: refPedal.throttle,
          refBrake: refPedal.brake,
        },
      ];
      recentPedalTraceRef.current = nextTrace;
      setRecentPedalTrace(nextTrace);

      // Record live/demo telemetry frames and snapshot lap when crossing Start/Finish
      const crossedFinish =
        prevFrame !== null &&
        ((prevFrame.lapDistPct > 0.82 && nextFrame.lapDistPct < 0.18) ||
          nextFrame.lapNumber > prevFrame.lapNumber);

      if (crossedFinish && recordedLapFramesRef.current.length >= 20) {
        const completed = [...recordedLapFramesRef.current].sort(
          (a, b) => a.lapDistPct - b.lapDistPct
        );
        const startTs = completed[0].timestampMs;
        const endTs = completed[completed.length - 1].timestampMs;
        const lapTimeSec = Math.max(
          25,
          Math.round(((endTs - startTs) / 1000) * 1000) / 1000
        );
        const maxSpeedKmh = Math.round(Math.max(...completed.map((f) => f.speedKmh)));
        const finishedLap: LapRecord = {
          lapNumber: prevFrame.lapNumber,
          lapTimeSec,
          sector1Sec: Math.round((lapTimeSec * 0.31) * 1000) / 1000,
          sector2Sec: Math.round((lapTimeSec * 0.38) * 1000) / 1000,
          sector3Sec: Math.round((lapTimeSec * 0.31) * 1000) / 1000,
          valid: !completed.some((f) => f.offTrackRisk > 0.78),
          maxSpeedKmh,
          avgTrailBrakeScore: 80,
          frames: completed,
        };
        const fuelBurnedLiters = Math.max(
          0,
          completed[0].fuelLiters - completed[completed.length - 1].fuelLiters
        );
        const startMinWear = Math.min(
          completed[0].tireWearPct.fl,
          completed[0].tireWearPct.fr,
          completed[0].tireWearPct.rl,
          completed[0].tireWearPct.rr
        );
        const endMinWear = Math.min(
          completed[completed.length - 1].tireWearPct.fl,
          completed[completed.length - 1].tireWearPct.fr,
          completed[completed.length - 1].tireWearPct.rl,
          completed[completed.length - 1].tireWearPct.rr
        );
        const maxTireWearLostPct = Math.max(0, startMinWear - endMinWear);
        const lastDeltaSec = completed[completed.length - 1].deltaSec;

        setRecordedLap(finishedLap);
        setSessionLaps((prev) => [...prev.slice(-29), finishedLap]);
        setDriverProfile((prevProf) => {
          const cornerUpdated = recordCornerLearningFromLap({
            profile: prevProf,
            track: trackRef.current,
            lap: finishedLap,
            referenceSamples: referenceSamplesRef.current,
          });
          return recordDriverObservation(cornerUpdated, null, {
            deltaSec: lastDeltaSec,
            trailScore: finishedLap.avgTrailBrakeScore,
            fuelBurnedLiters,
            maxTireWearLostPct,
          });
        });
        recordedLapFramesRef.current = [nextFrame];
      } else if (nextFrame.speedKmh > 12) {
        const buf = recordedLapFramesRef.current;
        const last = buf[buf.length - 1];
        if (
          !last ||
          Math.abs(nextFrame.lapDistPct - last.lapDistPct) >= 0.005 ||
          buf.length < 180
        ) {
          if (buf.length < 480) {
            buf.push(nextFrame);
          }
        }
      }
    },
    []
  );

  const [liveVoiceStatus, setLiveVoiceStatus] = useState<LiveVoiceStatus>('disconnected');
  const [liveVoicePhase, setLiveVoicePhase] = useState<LiveVoiceTurnPhase>('idle');
  const [liveVoiceError, setLiveVoiceError] = useState<string | null>(null);
  const liveVoiceStatusRef = useRef<LiveVoiceStatus>('disconnected');
  liveVoiceStatusRef.current = liveVoiceStatus;
  const liveClientRef = useRef<LiveCoachVoiceClient | null>(null);
  const lastLiveVoiceProtocolRef = useRef<RadioProtocol | null>(null);
  const lastLiveVoiceConfigSigRef = useRef<string | null>(null);

  const [aiStatusState, setAiStatusState] = useState<AiStatusState>(INITIAL_AI_STATUS);
  const [aiStatusLoaded, setAiStatusLoaded] = useState<boolean>(false);
  const [aiBannerDismissedForStatus, setAiBannerDismissedForStatus] = useState<string | null>(null);
  const [aiClockMs, setAiClockMs] = useState<number>(() => Date.now());
  const [isRecheckingAi, setIsRecheckingAi] = useState<boolean>(false);
  const prevEffectiveAiStatusRef = useRef<string | null>(null);
  const lastRateLimitRadioAtRef = useRef<number>(0);

  // Reset setup cleanly when track or car changes; preserve live frame during external telemetry auto-detect
  useEffect(() => {
    setSetup(car.defaultSetup);
    lastAutoAppliedAtRef.current = 0;

    const isExternalActive =
      lastExternalPacketAtRef.current > 0 &&
      Date.now() - lastExternalPacketAtRef.current < 3000;

    if (!isExternalActive) {
      setFrame({
        ...sampleLap.frames[0],
        timestampMs: Date.now(),
        lapNumber: 1,
        lapDistPct: 0,
        speedKmh: 0,
        rpm: 1100,
        gear: 0,
        throttle: 0,
        brake: 0,
        clutch: 0,
        steeringRad: 0,
        latG: 0,
        longG: 0,
        deltaSec: 0,
        fuelLiters: 54.0,
        ...(car.carClass === 'Hypercar' ? { virtualEnergyPct: 92 } : {}),
        tireTempC: { fl: 82, fr: 82, rl: 80, rr: 80 },
        tireWearPct: { fl: 100, fr: 100, rl: 100, rr: 100 },
        opponents:
          sessionGridModeRef.current === 'solo' ? [] : createInitialOpponents(track, car, 0, 0),
      });
      cooldownsRef.current = createInitialCooldowns();
      overridesRef.current = {
        ...createInitialOverrides(),
        soloMode: sessionGridModeRef.current === 'solo',
      };
      recordedLapFramesRef.current = [];
      recentPedalTraceRef.current = [];
      setRecentPedalTrace([]);
      setRecordedLap(null);
      setSessionLaps([]);
      sessionMistakesRef.current = { lateBrakes: 0, lockups: 0, exitSnaps: 0, offTracks: 0 };
      recentIncidentsRef.current = [];
      setRecentIncidents([]);
      setAutonomyLog([]);
      setActiveFault('none');
      pitVoiceStateRef.current = createInitialPitStrategyVoiceState();
      prevPitStrategyRef.current = null;
    }
  }, [car, track, sampleLap]);

  useEffect(() => {
    return () => {
      liveClientRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.driverProfile, JSON.stringify(driverProfile));
    } catch {
      // ignore storage errors
    }
  }, [driverProfile]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    } catch {
      // ignore storage errors
    }
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.hardwareMapping, JSON.stringify(hardwareMapping));
    } catch {
      // ignore storage errors
    }
  }, [hardwareMapping]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.raceReports, JSON.stringify(raceReports));
    } catch {
      // ignore storage errors
    }
  }, [raceReports]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.setupIntake, JSON.stringify(setupIntake));
    } catch {
      // ignore storage errors
    }
  }, [setupIntake]);

  const pushCallout = useCallback((callout: CoachCallout, preferGeminiVoice = true) => {
    setCallouts((prev) => [callout, ...prev].slice(0, 40));
    if (
      liveVoiceStatusRef.current === 'listening' ||
      liveVoiceStatusRef.current === 'speaking'
    ) {
      // Forward high-signal Race Engineer & Spotter calls into Live Voice while excluding
      // noisy pre-corner chatter and non-critical system notifications.
      const isSystemNoise =
        callout.cornerName === 'Auto-Detect' ||
        callout.cornerName === 'Gemini API' ||
        callout.cornerName === 'In-Car Dial';
      const isRoutineStrategyInfo =
        callout.category === 'strategy' &&
        callout.severity === 'info' &&
        !callout.id.startsWith('session-phase-') &&
        !callout.cornerName.startsWith('Lap ');
      const shouldForwardToLive =
        callout.source === 'realtime-engine' &&
        callout.category !== 'pre_corner' &&
        !isSystemNoise &&
        !isRoutineStrategyInfo &&
        (callout.severity === 'urgent' ||
          callout.severity === 'warning' ||
          callout.category === 'racecraft' ||
          callout.category === 'fuel' ||
          callout.category === 'brakes' ||
          callout.category === 'track_limits' ||
          callout.category === 'tires' ||
          callout.category === 'lockup' ||
          callout.category === 'traction' ||
          callout.category === 'braking' ||
          callout.category === 'strategy');
      if (shouldForwardToLive) {
        liveClientRef.current?.sendTelemetryEvent(callout.message);
      }
      return;
    }
    speakCoachCallout(callout.message, callout.severity, settingsRef.current, preferGeminiVoice);
  }, []);

  const applyIncomingAiStatus = useCallback(
    (next: AiStatusState) => {
      setAiStatusState(next);
      setAiStatusLoaded(true);
      const now = Date.now();
      setAiClockMs(now);

      const prev = prevEffectiveAiStatusRef.current;
      prevEffectiveAiStatusRef.current = next.aiStatus;

      if (prev === null) {
        return;
      }

      if (next.aiStatus === 'rate_limited' && (prev !== 'rate_limited' || now - lastRateLimitRadioAtRef.current > 20000)) {
        lastRateLimitRadioAtRef.current = now;
        setAiBannerDismissedForStatus(null);

        const targetMs =
          next.availableAtMs ??
          next.rateLimitedUntilMs ??
          (next.isDailyLimit
            ? getNextDailyResetTimestampMs(now)
            : typeof next.retryAfterSec === 'number' && next.retryAfterSec > 0
              ? now + next.retryAfterSec * 1000
              : null);

        const clockStr = targetMs ? formatAvailableAtClock(targetMs, now, 'en') : null;
        const durStr = targetMs ? formatRemainingDuration(targetMs, now, 'en') : null;

        let rateLimitMsg = '';
        if (next.isDailyLimit) {
          rateLimitMsg = `Google daily quota reached (1,500 RPD). Available again ${clockStr ?? 'at midnight UTC'}${durStr ? ` (in ${durStr})` : ''}. Telemetry, radar, and setups continue normally.`;
        } else if (next.isExactGoogleDelay && typeof next.retryAfterSec === 'number' && next.retryAfterSec > 0) {
          const limit = next.quotaLimit || 'RPM quota';
          rateLimitMsg = `Google rate limit (${limit}) — available again ${clockStr ?? `in ${next.retryAfterSec}s`}${durStr ? ` (in ${durStr})` : ''}. Telemetry, radar, and setups continue normally.`;
        } else {
          rateLimitMsg = `Google Gemini quota exceeded (${next.googleMessage || 'RESOURCE_EXHAUSTED'}).${clockStr ? ` Available again ${clockStr} (in ${durStr}).` : ''} Telemetry, radar, and setups continue normally.`;
        }
        pushCallout(
          {
            id: `ai-rate-limit-${now}`,
            timestampMs: now,
            lapNumber: latestLapRef.current,
            cornerName: 'Gemini API',
            severity: 'warning',
            category: 'strategy',
            message: rateLimitMsg,
            spoken: false,
            source: 'realtime-engine',
          },
          false
        );
      } else if (next.aiStatus === 'auth_error' && prev !== 'auth_error') {
        setAiBannerDismissedForStatus(null);
        pushCallout(
          {
            id: `ai-auth-err-${now}`,
            timestampMs: now,
            lapNumber: latestLapRef.current,
            cornerName: 'Gemini API',
            severity: 'warning',
            category: 'strategy',
            message: 'Gemini API key was rejected. Please verify the key in 00_ADD_API_KEY_HERE.txt.',
            spoken: false,
            source: 'realtime-engine',
          },
          false
        );
      } else if (next.aiStatus === 'ready' && (prev === 'unconfigured' || prev === 'rate_limited' || prev === 'auth_error')) {
        setAiBannerDismissedForStatus(null);
        pushCallout(
          {
            id: `ai-ready-${now}`,
            timestampMs: now,
            lapNumber: latestLapRef.current,
            cornerName: 'Gemini API',
            severity: 'info',
            category: 'strategy',
            message: 'Gemini API key active — AI Race Engineer and live pit radio are ready.',
            spoken: false,
            source: 'realtime-engine',
          },
          false
        );
      }
    },
    [pushCallout]
  );

  const refreshAiHealth = useCallback(async () => {
    try {
      const resp = await fetch('/api/health');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.simStatus && typeof data.simStatus === 'object') {
        setSimStatus(data.simStatus as SimConnectionStatus);
      }
      if (typeof data.aiStatus === 'string') {
        applyIncomingAiStatus({
          aiConfigured: Boolean(data.aiConfigured),
          aiStatus: data.aiStatus,
          keySource: data.keySource ?? 'none',
          rateLimitedUntilMs: data.rateLimitedUntilMs ?? data.availableAtMs ?? null,
          availableAtMs: data.availableAtMs ?? data.rateLimitedUntilMs ?? null,
          availableAtIso: data.availableAtIso ?? null,
          retryAfterSec: typeof data.retryAfterSec === 'number' ? data.retryAfterSec : null,
          isExactGoogleDelay: Boolean(data.isExactGoogleDelay),
          isDailyLimit: Boolean(data.isDailyLimit),
          quotaLimit: data.quotaLimit ?? null,
          googleMessage: data.googleMessage ?? null,
          lastRateLimitMessage: data.lastRateLimitMessage ?? null,
          authErrorMessage: data.authErrorMessage ?? null,
          lastSuccessAtMs: data.lastSuccessAtMs ?? null,
          rateLimitHits: typeof data.rateLimitHits === 'number' ? data.rateLimitHits : 0,
        });
      }
    } catch {
      // ignore transient network failure
    }
  }, [applyIncomingAiStatus]);

  useEffect(() => {
    refreshAiHealth();
    const intervalId = window.setInterval(refreshAiHealth, 15000);
    const handleFocus = () => {
      refreshAiHealth();
    };
    const handleAiEvent = (event: Event) => {
      const custom = event as CustomEvent<AiStatusState>;
      if (custom.detail) {
        applyIncomingAiStatus(custom.detail);
      }
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener(AI_STATUS_EVENT, handleAiEvent);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(AI_STATUS_EVENT, handleAiEvent);
    };
  }, [refreshAiHealth, applyIncomingAiStatus]);

  useEffect(() => {
    if (aiStatusState.aiStatus !== 'rate_limited') return;
    const tick = window.setInterval(() => {
      const now = Date.now();
      setAiClockMs(now);
      if (aiStatusState.rateLimitedUntilMs && now >= aiStatusState.rateLimitedUntilMs) {
        refreshAiHealth();
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [aiStatusState.aiStatus, aiStatusState.rateLimitedUntilMs, refreshAiHealth]);

  // Apply automatic Sim, Track, and Car detection from incoming bridge packets
  const applyAutoDetectedSession = useCallback(
    (meta: Partial<TelemetryFrame> & { simName?: string; trackId?: string; carId?: string }) => {
      if (!meta.simId && !meta.simName && !meta.trackName && !meta.carName && !meta.trackLengthKm) {
        return;
      }
      const detected = detectSessionFromTelemetry(meta);
      setDetectedSession(detected);

      if (!autoDetectRef.current) return;

      let changedTrackOrCar = false;
      let nextSim = selectedSimRef.current;
      let nextTrackName = TRACKS.find((t) => t.id === selectedTrackIdRef.current)?.name ?? '';
      let nextCarName = CARS.find((c) => c.id === selectedCarIdRef.current)?.name ?? '';

      if (detected.simId && detected.simId !== selectedSimRef.current) {
        nextSim = detected.simId;
        setSelectedSim(detected.simId);
      }
      if (detected.track && detected.track.id !== selectedTrackIdRef.current) {
        setSelectedTrackId(detected.track.id);
        nextTrackName = detected.track.name;
        changedTrackOrCar = true;
      }
      if (detected.car && detected.car.id !== selectedCarIdRef.current) {
        setSelectedCarId(detected.car.id);
        nextCarName = detected.car.name;
        changedTrackOrCar = true;
      }

      if (changedTrackOrCar) {
        const simLabel = SIM_GAMES.find((s) => s.id === nextSim)?.shortName ?? 'SIM';
        pushCallout(
          {
            id: `autodetect-${Date.now()}`,
            timestampMs: Date.now(),
            lapNumber: 1,
            cornerName: 'Auto-Detect',
            severity: 'info',
            category: 'strategy',
            message: `Auto-detected ${simLabel} session: ${nextCarName} at ${nextTrackName}. Corner markers and baseline setup synced.`,
            spoken: false,
            source: 'realtime-engine',
          },
          false
        );
      }
    },
    [pushCallout]
  );

  // Process any incoming frame (from either local simulator or real WebSocket sim bridge)
  const processTelemetryFrame = useCallback(
    (rawFrame: Partial<TelemetryFrame>) => {
      const safeCorners = (
        val: Partial<TelemetryFrame['tireTempC']> | undefined,
        dflt: number
      ) => ({
        fl: typeof val?.fl === 'number' && Number.isFinite(val.fl) ? val.fl : dflt,
        fr: typeof val?.fr === 'number' && Number.isFinite(val.fr) ? val.fr : dflt,
        rl: typeof val?.rl === 'number' && Number.isFinite(val.rl) ? val.rl : dflt,
        rr: typeof val?.rr === 'number' && Number.isFinite(val.rr) ? val.rr : dflt,
      });
      const safeNum = (v: unknown, dflt: number) =>
        typeof v === 'number' && Number.isFinite(v) ? v : dflt;

      const nextFrame: TelemetryFrame = {
        ...rawFrame,
        timestampMs: safeNum(rawFrame.timestampMs, Date.now()),
        lapNumber: safeNum(rawFrame.lapNumber, 1),
        lapDistPct: Math.min(0.9999, Math.max(0, safeNum(rawFrame.lapDistPct, 0))),
        speedKmh: safeNum(rawFrame.speedKmh, 0),
        rpm: safeNum(rawFrame.rpm, 1100),
        maxRpm: safeNum(rawFrame.maxRpm, car.maxRpm),
        gear: safeNum(rawFrame.gear, 0),
        throttle: safeNum(rawFrame.throttle, 0),
        brake: safeNum(rawFrame.brake, 0),
        clutch: safeNum(rawFrame.clutch, 0),
        steeringRad: safeNum(rawFrame.steeringRad, 0),
        latG: safeNum(rawFrame.latG, 0),
        longG: safeNum(rawFrame.longG, 0),
        deltaSec: safeNum(rawFrame.deltaSec, 0),
        fuelLiters: safeNum(rawFrame.fuelLiters, 50),
        tireTempC: safeCorners(rawFrame.tireTempC, 84),
        tirePressurePsi: safeCorners(rawFrame.tirePressurePsi, 26.5),
        tireWearPct: safeCorners(rawFrame.tireWearPct, 98),
        brakeTempC: safeCorners(rawFrame.brakeTempC, 420),
        frontWheelSlip: safeNum(rawFrame.frontWheelSlip, 0),
        rearWheelSlip: safeNum(rawFrame.rearWheelSlip, 0),
        absActive: Boolean(rawFrame.absActive),
        tcActive: Boolean(rawFrame.tcActive),
        offTrackRisk: safeNum(rawFrame.offTrackRisk, 0),
        hazardAhead: Boolean(rawFrame.hazardAhead),
        hazardDistanceM: safeNum(rawFrame.hazardDistanceM, 999),
        hazardDescription:
          typeof rawFrame.hazardDescription === 'string' ? rawFrame.hazardDescription : '',
        flagState:
          rawFrame.flagState === 'yellow' || rawFrame.flagState === 'blue'
            ? rawFrame.flagState
            : 'green',
        ...(rawFrame.inFormationLap ? { inFormationLap: true } : {}),
        ...(rawFrame.penaltyActive ? { penaltyActive: true } : {}),
        ...(rawFrame.lapInvalidated ? { lapInvalidated: true } : {}),
        opponents: Array.isArray(rawFrame.opponents) ? rawFrame.opponents : [],
      };

      lastExternalPacketAtRef.current = Date.now();
      setExternalStreamActive(true);
      if (rawFrame.telemetrySource && rawFrame.telemetrySource !== 'demo') {
        const src = rawFrame.telemetrySource;
        const nextConnState: SimConnectionStatus['connectionState'] =
          rawFrame.inPitOrGarage || rawFrame.isPaused ? 'in_pit' : 'on_track';
        setSimStatus((prev) =>
          prev.source === src && prev.connectionState === nextConnState && prev.gameRunning
            ? prev
            : {
                ...prev,
                gameRunning: true,
                connectionState: nextConnState,
                source: src,
                telemetryQuality:
                  src === 'lmu-rest' && rawFrame.sensorCaps?.pedals === false
                    ? 'partial_rest'
                    : 'full',
                lastPacketAtMs: Date.now(),
                rawTrackName: rawFrame.trackName ?? prev.rawTrackName,
                rawCarName: rawFrame.carName ?? prev.rawCarName,
              }
        );
      }
      applyAutoDetectedSession(nextFrame);

      const activeC = getActiveCorner(track, nextFrame.lapDistPct);
      recordTelemetryIncidentIfDetected(
        nextFrame,
        prevFrameRef.current,
        activeC,
        !rawFrame.inPitOrGarage && !rawFrame.isPaused
      );
      const refIdx = Math.min(
        referenceSamples.length - 1,
        Math.max(0, Math.floor(nextFrame.lapDistPct * referenceSamples.length))
      );
      const refSample = referenceSamples[refIdx];

      const effectiveSettings: CoachSettings = {
        ...settingsRef.current,
        lateBrakeThresholdMeters: driverProfileRef.current.isNewToGame
          ? Math.max(7, settingsRef.current.lateBrakeThresholdMeters - 2)
          : settingsRef.current.lateBrakeThresholdMeters,
      };

      const { callout, nextCooldowns } = evaluateLiveTelemetry(
        nextFrame,
        prevFrameRef.current,
        track,
        activeC,
        refSample,
        effectiveSettings,
        cooldownsRef.current,
        driverProfileRef.current,
        car,
        {
          sessionType: detectedSessionTypeRef.current,
          pitStrategy: pitStrategyRef.current,
        }
      );
      cooldownsRef.current = nextCooldowns;

      if (callout) {
        if (callout.category === 'braking') sessionMistakesRef.current.lateBrakes += 1;
        if (callout.category === 'lockup') sessionMistakesRef.current.lockups += 1;
        if (callout.category === 'traction') sessionMistakesRef.current.exitSnaps += 1;
        if (callout.category === 'track_limits') sessionMistakesRef.current.offTracks += 1;
        pushCallout(callout, false);
        setDriverProfile((prevProf) => recordDriverObservation(prevProf, callout));
      } else if (
        prevFrameRef.current &&
        nextFrame.lapNumber > prevFrameRef.current.lapNumber &&
        recordedLapFramesRef.current.length < 20
      ) {
        const fallbackFuel = Math.max(0, prevFrameRef.current.fuelLiters - nextFrame.fuelLiters);
        setDriverProfile((prevProf) =>
          recordDriverObservation(prevProf, null, {
            deltaSec: prevFrameRef.current?.deltaSec ?? 0.5,
            trailScore: 78,
            fuelBurnedLiters: fallbackFuel > 0.3 ? fallbackFuel : undefined,
          })
        );
      }

      pushPedalAndLapSample(nextFrame, prevFrameRef.current);
      prevFrameRef.current = nextFrame;
      setFrame(nextFrame);
    },
    [
      track,
      car,
      referenceSamples,
      pushCallout,
      applyAutoDetectedSession,
      pushPedalAndLapSample,
      recordTelemetryIncidentIfDetected,
    ]
  );

  // Real-time browser hardware input detection loop (Steering Wheel, Pedals, Gamepad + Optional Keyboard)
  useEffect(() => {
    const handleGamepadConnected = (e: GamepadEvent) => {
      if (autoMappedDeviceIdRef.current !== e.gamepad.id) {
        autoMappedDeviceIdRef.current = e.gamepad.id;
        setHardwareMapping(createInitialMappingForGamepad(e.gamepad));
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!keyboardDriveRef.current) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      pressedKeysRef.current.add(e.key.toLowerCase());
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      pressedKeysRef.current.delete(e.key.toLowerCase());
    };

    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    const pollTimer = window.setInterval(() => {
      const pad = detectBestGamepad();
      let nextState: HardwareInputState = EMPTY_HARDWARE_STATE;

      if (pad) {
        if (autoMappedDeviceIdRef.current !== pad.id) {
          autoMappedDeviceIdRef.current = pad.id;
          setHardwareMapping(createInitialMappingForGamepad(pad));
        }
        nextState = readGamepadHardwareState(pad, hardwareMappingRef.current);
      } else if (keyboardDriveRef.current) {
        const keys = pressedKeysRef.current;
        const throttle = keys.has('w') || keys.has('arrowup') ? 1 : 0;
        const brake = keys.has('s') || keys.has('arrowdown') ? 1 : 0;
        const clutch = keys.has('shift') ? 1 : 0;
        const steer =
          (keys.has('d') || keys.has('arrowright') ? 0.65 : 0) -
          (keys.has('a') || keys.has('arrowleft') ? 0.65 : 0);

        nextState = {
          connected: true,
          deviceId: 'keyboard',
          deviceName: 'Keyboard Drive (W/A/S/D or Arrows)',
          isStandardMapping: true,
          sourceKind: 'keyboard',
          steeringNormalized: steer,
          steeringDeg: Math.round(steer * 135),
          throttle,
          brake,
          clutch,
          gearUpPressed: keys.has('e'),
          gearDownPressed: keys.has('q'),
          pttPressed: false,
          axes: [steer],
          pressedButtons: [],
        };
      }

      setHardwareState(nextState);

      // Simultaneous injection into live simulation overrides whenever driver presses wheel/pedals/keys
      if (hardwareDriveRef.current && nextState.connected) {
        const hasPedalOrSteerInput =
          nextState.throttle > 0.03 ||
          nextState.brake > 0.03 ||
          nextState.clutch > 0.03 ||
          Math.abs(nextState.steeringNormalized) > 0.05;

        if (hasPedalOrSteerInput) {
          lastInputActivityAtRef.current = Date.now();
          setIsLiveRunning(true);
          overridesRef.current = {
            ...overridesRef.current,
            manualThrottleOverride: nextState.throttle,
            manualBrakeOverride: nextState.brake,
            manualClutchOverride: nextState.clutch,
            manualSteeringOverride: Math.round(nextState.steeringNormalized * 0.55 * 1000) / 1000,
          };
        } else if (
          lastInputActivityAtRef.current > 0 &&
          Date.now() - lastInputActivityAtRef.current > 1800
        ) {
          lastInputActivityAtRef.current = 0;
          overridesRef.current = {
            ...overridesRef.current,
            manualThrottleOverride: null,
            manualBrakeOverride: null,
            manualClutchOverride: null,
            manualSteeringOverride: null,
          };
        }
      }
    }, 50);

    return () => {
      window.removeEventListener('gamepadconnected', handleGamepadConnected);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.clearInterval(pollTimer);
    };
  }, []);

  // Live 10Hz telemetry simulator loop (yields automatically when external sim bridge frames arrive)
  useEffect(() => {
    if (!isLiveRunning) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (lastExternalPacketAtRef.current > 0 && now - lastExternalPacketAtRef.current < 2600) {
        return;
      }
      if (lastExternalPacketAtRef.current > 0 && now - lastExternalPacketAtRef.current >= 2600) {
        setExternalStreamActive(false);
      }

      setFrame((current) => {
        const { frame: nextFrame, nextOverrides } = stepTelemetrySimulation(
          current,
          track,
          car,
          referenceSamples,
          overridesRef.current,
          120
        );
        overridesRef.current = nextOverrides;
        if (nextOverrides.activeFault !== activeFault) {
          setActiveFault(nextOverrides.activeFault);
        }

        queueMicrotask(() => {
          const activeC = getActiveCorner(track, nextFrame.lapDistPct);
          recordTelemetryIncidentIfDetected(nextFrame, prevFrameRef.current, activeC, true);
          const refIdx = Math.min(
            referenceSamples.length - 1,
            Math.max(0, Math.floor(nextFrame.lapDistPct * referenceSamples.length))
          );
          const refSample = referenceSamples[refIdx];
          const { callout, nextCooldowns } = evaluateLiveTelemetry(
            nextFrame,
            prevFrameRef.current,
            track,
            activeC,
            refSample,
            settingsRef.current,
            cooldownsRef.current,
            driverProfileRef.current,
            car,
            {
              sessionType: detectedSessionTypeRef.current,
              pitStrategy: pitStrategyRef.current,
            }
          );
          cooldownsRef.current = nextCooldowns;
          if (callout) {
            if (callout.category === 'braking') sessionMistakesRef.current.lateBrakes += 1;
            if (callout.category === 'lockup') sessionMistakesRef.current.lockups += 1;
            if (callout.category === 'traction') sessionMistakesRef.current.exitSnaps += 1;
            if (callout.category === 'track_limits') sessionMistakesRef.current.offTracks += 1;
            pushCallout(callout, false);
            setDriverProfile((prevProf) => recordDriverObservation(prevProf, callout));
          }
          pushPedalAndLapSample(nextFrame, prevFrameRef.current);
          prevFrameRef.current = nextFrame;
        });

        return nextFrame;
      });
    }, 140);

    return () => window.clearInterval(timer);
  }, [
    isLiveRunning,
    track,
    car,
    referenceSamples,
    activeFault,
    pushCallout,
    pushPedalAndLapSample,
    recordTelemetryIncidentIfDetected,
  ]);

  // Automatically clear externalStreamActive if no packets arrive for >2.6s (even when Demo is stopped)
  useEffect(() => {
    if (!externalStreamActive) return;
    const id = window.setInterval(() => {
      if (
        lastExternalPacketAtRef.current > 0 &&
        Date.now() - lastExternalPacketAtRef.current >= 2600
      ) {
        setExternalStreamActive(false);
        setSimStatus((prev) =>
          prev.connectionState === 'on_track' &&
          Date.now() - lastExternalPacketAtRef.current >= 4000
            ? {
                ...prev,
                connectionState: prev.gameRunning ? 'menus' : 'offline',
              }
            : prev
        );
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [externalStreamActive]);

  const processTelemetryFrameRef = useRef(processTelemetryFrame);
  processTelemetryFrameRef.current = processTelemetryFrame;
  const applyAutoDetectedSessionRef = useRef(applyAutoDetectedSession);
  applyAutoDetectedSessionRef.current = applyAutoDetectedSession;

  // Persistent WebSocket listener for live external UDP/LMU telemetry bridge & auto-detected sessions
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;
    let socket: WebSocket | null = null;

    try {
      socket = new WebSocket(wsUrl);
      socket.onopen = () => setWsConnected(true);
      socket.onclose = () => setWsConnected(false);
      socket.onerror = () => setWsConnected(false);
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'session_detected' && msg.session) {
            applyAutoDetectedSessionRef.current(msg.session);
          } else if (msg.type === 'sim_status' && msg.status) {
            const incoming = msg.status as SimConnectionStatus;
            setSimStatus(incoming);
            if (!incoming.gameRunning || incoming.connectionState === 'offline' || incoming.connectionState === 'menus') {
              setExternalStreamActive(false);
              setFrame((prev) => (prev.inPitOrGarage ? { ...prev, inPitOrGarage: false, isPaused: false } : prev));
            }
          } else if (msg.type === 'telemetry_frame' && msg.frame) {
            processTelemetryFrameRef.current(msg.frame as TelemetryFrame);
          }
        } catch {
          // ignore malformed frames
        }
      };
    } catch {
      setWsConnected(false);
    }

    return () => {
      socket?.close();
    };
  }, []);

  const activeCorner = useMemo(
    () => getActiveCorner(track, frame.lapDistPct),
    [track, frame.lapDistPct]
  );
  const upcomingCorner = useMemo(
    () => getUpcomingCorner(track, frame.lapDistPct),
    [track, frame.lapDistPct]
  );

  const electronicsSuggestions = useMemo(
    () => buildAdaptiveElectronicsSuggestions(driverProfile, setup, car),
    [driverProfile, setup, car]
  );

  const activeCornerRef = useRef(activeCorner);
  activeCornerRef.current = activeCorner;

  // Hands-On Engineer Autonomy: automatically apply immediate TC/ABS/Brake Bias suggestions with cooldown protection
  useEffect(() => {
    if (settings.autonomyMode !== 'hands_on' || !isLiveRunning) return;
    if (electronicsSuggestions.length === 0) return;

    const now = Date.now();
    const { nextSetup, appliedAction, calloutMessage } = evaluateAutonomyAction(
      settings.autonomyMode,
      electronicsSuggestions,
      setup,
      lastAutoAppliedAtRef.current,
      now,
      'en'
    );

    if (!appliedAction || !calloutMessage) return;

    lastAutoAppliedAtRef.current = now;
    setSetup(nextSetup);
    setAutonomyLog((prev) => [appliedAction, ...prev].slice(0, 10));
    pushCallout(
      {
        id: appliedAction.id,
        timestampMs: now,
        lapNumber: latestLapRef.current,
        cornerName: formatCornerLabel(activeCornerRef.current, 'en', 'Pit Wall'),
        severity: 'info',
        category: 'strategy',
        message: calloutMessage,
        spoken: false,
        source: 'realtime-engine',
      },
      false
    );
  }, [
    settings.autonomyMode,
    isLiveRunning,
    electronicsSuggestions,
    setup,
    pushCallout,
  ]);

  const detectedSessionType = useMemo<SimSessionType>(
    () =>
      getEffectiveSessionType({
        override: sessionPhaseOverride,
        simStatus,
        frameSessionType: frame.sessionType,
      }),
    [sessionPhaseOverride, simStatus, frame.sessionType]
  );
  const detectedSessionTypeRef = useRef<SimSessionType>(detectedSessionType);
  detectedSessionTypeRef.current = detectedSessionType;
  const sessionPhaseLabel = formatSessionTypeLabel(detectedSessionType);

  const resolvedRaceLengthLaps = useMemo<number | undefined>(() => {
    if (
      typeof frame.sessionTotalLaps === 'number' &&
      Number.isFinite(frame.sessionTotalLaps) &&
      frame.sessionTotalLaps >= 1
    ) {
      return Math.round(frame.sessionTotalLaps);
    }
    if (
      typeof frame.sessionTimeRemainingSec === 'number' &&
      Number.isFinite(frame.sessionTimeRemainingSec) &&
      frame.sessionTimeRemainingSec > 0 &&
      track.referenceLapTimeSec > 20
    ) {
      return Math.max(
        frame.lapNumber + 1,
        frame.lapNumber + Math.ceil(frame.sessionTimeRemainingSec / track.referenceLapTimeSec)
      );
    }
    return undefined;
  }, [frame.sessionTotalLaps, frame.sessionTimeRemainingSec, frame.lapNumber, track.referenceLapTimeSec]);

  const pitStrategy = useMemo(
    () =>
      computePitStrategy(frame, track, car, driverProfile, setup, resolvedRaceLengthLaps, {
        autoSelectPitTires: settings.autoSelectPitTires ?? true,
        preselectPitTiresInLmu: settings.preselectPitTiresInLmu ?? false,
        pitRaceMode: settings.pitRaceMode ?? 'auto',
        pitTireOverride: settings.pitTireOverride ?? 'auto',
        sessionType: detectedSessionType,
        sessionPhaseSource: sessionPhaseOverride === 'auto' ? 'auto' : 'manual',
        trackCondition: setupIntake.trackCondition,
        recentIncidents,
      }),
    [
      frame,
      track,
      car,
      driverProfile,
      setup,
      resolvedRaceLengthLaps,
      settings.autoSelectPitTires,
      settings.preselectPitTiresInLmu,
      settings.pitRaceMode,
      settings.pitTireOverride,
      detectedSessionType,
      sessionPhaseOverride,
      setupIntake.trackCondition,
      recentIncidents,
    ]
  );
  const pitStrategyRef = useRef<PitStrategyPlan>(pitStrategy);
  pitStrategyRef.current = pitStrategy;

  const handleDismissCrashAlert = useCallback(() => {
    const filtered = recentIncidentsRef.current.filter((inc) => inc.type !== 'crash_impact');
    recentIncidentsRef.current = filtered;
    setRecentIncidents(filtered);
  }, []);

  const [pitMfdSyncStatus, setPitMfdSyncStatus] = useState<PitMfdSyncStatus>({
    state: 'idle',
    lastAttemptAtMs: null,
    lastAppliedAtMs: null,
    appliedHeadline: null,
    via: 'none',
    message: 'Off — Enable Preselect in LMU to push pit tires into LMU (:6397).',
  });
  const lastAutoSyncedPitKeyRef = useRef<string>('');

  const syncPitMenuToLmu = useCallback(
    async (plan: Pick<typeof pitStrategy, 'tireAction' | 'tireCompound' | 'repairsRecommended' | 'fuelToAddLiters' | 'pitTireCallHeadline'>) => {
      try {
        const resp = await fetch('/api/lmu/pit-menu/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tireAction: plan.tireAction,
            tireCompound: plan.tireCompound,
            repairsRecommended: plan.repairsRecommended,
            fuelToAddLiters: Math.round(plan.fuelToAddLiters),
            pitTireCallHeadline: plan.pitTireCallHeadline,
          }),
        });
        const data = (await resp.json()) as { status?: PitMfdSyncStatus; error?: string };
        if (data?.status) {
          setPitMfdSyncStatus(data.status);
        } else if (!resp.ok) {
          setPitMfdSyncStatus({
            state: 'error',
            lastAttemptAtMs: Date.now(),
            lastAppliedAtMs: null,
            appliedHeadline: null,
            via: 'none',
            message: data?.error || 'Could not reach Pit MFD sync endpoint.',
          });
        }
      } catch (err) {
        setPitMfdSyncStatus({
          state: 'error',
          lastAttemptAtMs: Date.now(),
          lastAppliedAtMs: null,
          appliedHeadline: null,
          via: 'none',
          message: err instanceof Error ? err.message : 'Network error syncing LMU Pit MFD.',
        });
      }
    },
    []
  );

  // Deduplicated auto-preselect into LMU Pit MFD (:6397) only when opted in and strategy changes
  useEffect(() => {
    if (!(settings.preselectPitTiresInLmu ?? false)) {
      lastAutoSyncedPitKeyRef.current = '';
      setPitMfdSyncStatus((prev) =>
        prev.state === 'idle' &&
        prev.message === 'Off — Enable Preselect in LMU to push pit tires into LMU (:6397).'
          ? prev
          : {
              state: 'idle',
              lastAttemptAtMs: prev.lastAttemptAtMs,
              lastAppliedAtMs: prev.lastAppliedAtMs,
              appliedHeadline: prev.appliedHeadline,
              via: 'none',
              message: 'Off — Enable Preselect in LMU to push pit tires into LMU (:6397).',
            }
      );
      return;
    }
    if (!simStatus?.gameRunning || simStatus.simId !== 'lmu') {
      setPitMfdSyncStatus((prev) =>
        prev.state === 'idle'
          ? {
              ...prev,
              message: 'Armed — waiting for live LMU session (:6397) to preselect pit tires & repairs.',
            }
          : prev
      );
      return;
    }
    const syncKey = `${pitStrategy.tireAction}:${pitStrategy.tireCompound}:${pitStrategy.repairsRecommended}`;
    if (lastAutoSyncedPitKeyRef.current === syncKey) return;
    lastAutoSyncedPitKeyRef.current = syncKey;
    void syncPitMenuToLmu(pitStrategy);
  }, [
    settings.preselectPitTiresInLmu,
    simStatus?.gameRunning,
    simStatus?.simId,
    pitStrategy.tireAction,
    pitStrategy.tireCompound,
    pitStrategy.repairsRecommended,
    pitStrategy.fuelToAddLiters,
    pitStrategy.pitTireCallHeadline,
    syncPitMenuToLmu,
  ]);

  // Poll /api/lmu/pit-menu/status only while waiting for remote Windows bridge confirmation
  useEffect(() => {
    if (pitMfdSyncStatus.state !== 'pending_bridge') return;
    const timer = window.setInterval(async () => {
      try {
        const resp = await fetch('/api/lmu/pit-menu/status');
        if (!resp.ok) return;
        const data = (await resp.json()) as { status?: PitMfdSyncStatus };
        if (data?.status) {
          setPitMfdSyncStatus(data.status);
        }
      } catch {
        // ignore transient poll failures
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [pitMfdSyncStatus.state]);

  const wasInPitForTireAutoRef = useRef<boolean>(Boolean(frame.inPitOrGarage));
  const lastPitTireAutoCalloutAtRef = useRef<number>(0);
  const lastCrashPitRadioAtRef = useRef<number>(0);
  const prevCrashAlertRef = useRef<boolean>(false);

  // Urgent radio alert when a crash/flat tire triggers an emergency pit recommendation
  useEffect(() => {
    const wasCrash = prevCrashAlertRef.current;
    prevCrashAlertRef.current = pitStrategy.crashAlertActive;
    if (
      !wasCrash &&
      pitStrategy.crashAlertActive &&
      (isLiveRunning || externalStreamActive)
    ) {
      const now = Date.now();
      if (now - lastCrashPitRadioAtRef.current > 15000) {
        lastCrashPitRadioAtRef.current = now;
        pushCallout(
          {
            id: `pit-crash-alert-${now}`,
            timestampMs: now,
            lapNumber: frame.lapNumber,
            cornerName: 'Emergency Pit Strategy',
            severity: 'urgent',
            category: 'strategy',
            message: pitStrategy.engineerSummary,
            spoken: false,
            source: 'realtime-engine',
          },
          true
        );
      }
    }
  }, [
    pitStrategy.crashAlertActive,
    pitStrategy.engineerSummary,
    frame.lapNumber,
    isLiveRunning,
    externalStreamActive,
    pushCallout,
  ]);

  const prevPitStrategyRef = useRef<PitStrategyPlan | null>(null);
  const pitVoiceStateRef = useRef<PitStrategyVoiceState>(createInitialPitStrategyVoiceState());

  // Proactive AI voice pit calls: pit window opening, Box this lap, casual no-stop confirmation, and dynamic learned shifts
  useEffect(() => {
    if (!isLiveRunning && !externalStreamActive) {
      prevPitStrategyRef.current = pitStrategy;
      return;
    }
    const evalResult = evaluatePitStrategyVoiceCallout({
      strategy: pitStrategy,
      prevStrategy: prevPitStrategyRef.current,
      frame,
      settings: settingsRef.current,
      voiceState: pitVoiceStateRef.current,
      nowMs: Date.now(),
      carClass: car.carClass,
    });
    pitVoiceStateRef.current = evalResult.nextState;
    prevPitStrategyRef.current = pitStrategy;
    if (evalResult.callout) {
      pushCallout(evalResult.callout, true);
    }
  }, [
    pitStrategy,
    frame.lapNumber,
    frame.lapDistPct,
    frame.inPitOrGarage,
    frame.isPaused,
    frame.inFormationLap,
    car.carClass,
    isLiveRunning,
    externalStreamActive,
    pushCallout,
  ]);

  useEffect(() => {
    const currentlyInPits = Boolean(frame.inPitOrGarage);
    const prevInPits = wasInPitForTireAutoRef.current;
    wasInPitForTireAutoRef.current = currentlyInPits;

    // Clear post-crash pit flag once driver exits pits after servicing
    if (prevInPits && !currentlyInPits && recentIncidentsRef.current.some((i) => i.type === 'crash_impact')) {
      const filtered = recentIncidentsRef.current.filter((inc) => inc.type !== 'crash_impact');
      recentIncidentsRef.current = filtered;
      setRecentIncidents(filtered);
    }

    if (
      !prevInPits &&
      currentlyInPits &&
      (isLiveRunning || externalStreamActive) &&
      (settings.autoSelectPitTires ?? true)
    ) {
      const now = Date.now();
      if (now - lastPitTireAutoCalloutAtRef.current > 20000) {
        lastPitTireAutoCalloutAtRef.current = now;
        const msg = pitStrategy.crashAlertActive
          ? `Pit entry repairs (${pitStrategy.raceModeLabel}): Set Repairs ON, ${pitStrategy.pitTireCallHeadline}, +${pitStrategy.fuelToAddLiters.toFixed(0)}L in LMU Pit MFD.`
          : `Pit entry (${pitStrategy.raceModeLabel}): Set ${pitStrategy.pitTireCallHeadline} + ${pitStrategy.fuelToAddLiters.toFixed(0)}L in LMU Pit MFD — ${pitStrategy.tireSelectionReason}`;
        pushCallout(
          {
            id: `pit-auto-tires-${now}`,
            timestampMs: now,
            lapNumber: frame.lapNumber,
            cornerName: 'Pit Entry Strategy',
            severity: pitStrategy.crashAlertActive ? 'urgent' : 'coaching',
            category: 'strategy',
            message: msg,
            spoken: false,
            source: 'realtime-engine',
          },
          true
        );
      }
    }
  }, [
    frame.inPitOrGarage,
    frame.lapNumber,
    isLiveRunning,
    externalStreamActive,
    settings.autoSelectPitTires,
    pitStrategy.crashAlertActive,
    pitStrategy.raceModeLabel,
    pitStrategy.pitTireCallHeadline,
    pitStrategy.fuelToAddLiters,
    pitStrategy.tireSelectionReason,
    pushCallout,
  ]);

  const cornerComparisons = useMemo(
    () => analyzeLapByCorners((recordedLap ?? sampleLap).frames, referenceSamples, track),
    [recordedLap, sampleLap, referenceSamples, track]
  );

  const skillMetrics = useMemo(
    () =>
      evaluateDriverSkillMetrics(
        (recordedLap ?? sampleLap).frames,
        cornerComparisons,
        'en'
      ),
    [recordedLap, sampleLap, cornerComparisons]
  );

  const racecraftAdvice = useMemo(
    () => evaluateRacecraft(frame, track, car, upcomingCorner, 'en'),
    [frame, track, car, upcomingCorner]
  );

  const handleToggleLive = () => {
    if (isLiveRunning) {
      setIsLiveRunning(false);
      stopAllRadioSpeech();
    } else {
      unlockAudioPlayback();
      setIsLiveRunning(true);
    }
  };

  const handleChangeSessionGridMode = useCallback(
    (mode: SessionGridMode) => {
      setSessionGridMode(mode);
      sessionGridModeRef.current = mode;
      const isSolo = mode === 'solo';
      const isTrafficFault =
        overridesRef.current.activeFault === 'rival_attack' ||
        overridesRef.current.activeFault === 'attack_chance' ||
        overridesRef.current.activeFault === 'side_by_side' ||
        overridesRef.current.activeFault === 'side_by_side_right';

      overridesRef.current = {
        ...overridesRef.current,
        soloMode: isSolo,
        ...(isSolo && isTrafficFault ? { activeFault: 'none', faultTicksRemaining: 0 } : {}),
      };
      if (isSolo && isTrafficFault) {
        setActiveFault('none');
      }

      if (!externalStreamActive) {
        setFrame((prev) => ({
          ...prev,
          opponents: isSolo
            ? []
            : (prev.opponents?.length ?? 0) > 0
              ? prev.opponents
              : createInitialOpponents(track, car, prev.lapDistPct, prev.speedKmh),
        }));
      }
    },
    [externalStreamActive, track, car]
  );

  const handleTriggerFault = (fault: SimScenarioFault) => {
    if (fault === 'none') {
      overridesRef.current = {
        ...createInitialOverrides(),
        soloMode: sessionGridModeRef.current === 'solo',
      };
      setActiveFault('none');
      setFrame((prev) => ({
        ...prev,
        inFormationLap: false,
        inPitOrGarage: false,
        fuelLiters: Math.max(prev.fuelLiters, 42),
        tireTempC: { fl: 85, fr: 84, rl: 82, rr: 81 },
        tireWearPct: { fl: 96, fr: 96, rl: 97, rr: 97 },
        brakeTempC: { fl: 460, fr: 455, rl: 380, rr: 375 },
      }));
      return;
    }

    const isTrafficFault =
      fault === 'rival_attack' ||
      fault === 'attack_chance' ||
      fault === 'side_by_side' ||
      fault === 'side_by_side_right';
    if (isTrafficFault && sessionGridModeRef.current === 'solo') {
      setSessionGridMode('grid');
      sessionGridModeRef.current = 'grid';
    }

    unlockAudioPlayback();
    setIsLiveRunning(true);
    const ticks =
      fault === 'crash_ahead' || isTrafficFault
        ? 28
        : 18;
    overridesRef.current = {
      ...overridesRef.current,
      soloMode: isTrafficFault ? false : sessionGridModeRef.current === 'solo',
      activeFault: fault,
      faultTicksRemaining: ticks,
    };
    setActiveFault(fault);

    cooldownsRef.current = createInitialCooldowns();

    if (fault === 'cold_tires') {
      setFrame((prev) => ({
        ...prev,
        tireTempC: { fl: 63, fr: 62, rl: 60, rr: 60 },
      }));
    } else if (fault === 'overheat_tires') {
      setFrame((prev) => ({
        ...prev,
        tireTempC: { fl: 111, fr: 110, rl: 107, rr: 106 },
      }));
    } else if (fault === 'degraded_tires') {
      setFrame((prev) => ({
        ...prev,
        tireTempC: { fl: 89, fr: 88, rl: 86, rr: 85 },
        tireWearPct: { fl: 63.4, fr: 64.1, rl: 68.2, rr: 68.8 },
      }));
    } else if (fault === 'brake_overheat') {
      setFrame((prev) => ({
        ...prev,
        brakeTempC: { fl: 790, fr: 775, rl: 590, rr: 580 },
      }));
    } else if (fault === 'low_fuel') {
      setFrame((prev) => ({
        ...prev,
        fuelLiters: 4.8,
        ...(car.carClass === 'Hypercar' ? { virtualEnergyPct: 11 } : {}),
      }));
    } else if (fault === 'late_brake' || fault === 'lockup') {
      const targetCorner = activeCorner ?? upcomingCorner;
      setFrame((prev) => ({
        ...prev,
        lapDistPct: targetCorner.brakeMarkerPct + 0.0045,
        speedKmh: targetCorner.targetEntrySpeedKmh + 14,
      }));
    } else if (fault === 'snap_oversteer') {
      const targetCorner = activeCorner ?? upcomingCorner;
      setFrame((prev) => ({
        ...prev,
        lapDistPct: targetCorner.apexPct + 0.006,
      }));
    } else if (
      fault === 'rival_attack' ||
      fault === 'attack_chance' ||
      fault === 'side_by_side' ||
      fault === 'side_by_side_right'
    ) {
      setFrame((prev) => ({
        ...prev,
        opponents: stepOpponentsSimulation(
          prev.opponents,
          prev.lapDistPct,
          prev.speedKmh,
          track,
          car,
          referenceSamples,
          fault,
          ticks,
          120
        ),
      }));
    } else if (fault === 'self_crash') {
      setFrame((prev) => ({
        ...prev,
        inPitOrGarage: false,
        speedKmh: Math.max(prev.speedKmh, 148),
      }));
    } else if (fault === 'formation_lap') {
      setFrame((prev) => ({
        ...prev,
        inPitOrGarage: false,
        inFormationLap: true,
        speedKmh: 95,
        tireTempC: { fl: 44, fr: 44, rl: 43, rr: 43 },
      }));
    } else if (fault === 'pit_speeding') {
      setFrame((prev) => ({
        ...prev,
        inFormationLap: false,
        inPitOrGarage: true,
        speedKmh: 78,
      }));
    }
  };

  const handleManualPedalOverride = (brake: number | null, throttle: number | null) => {
    overridesRef.current = {
      ...overridesRef.current,
      manualBrakeOverride: brake,
      manualThrottleOverride: throttle,
    };
  };

  const handleCalibrateHardwareRest = () => {
    if (!hardwareState.connected || hardwareState.sourceKind !== 'gamepad') return;
    setHardwareMapping((prev) => ({
      ...prev,
      throttleRestValue:
        prev.throttleAxis !== null ? (hardwareState.axes[prev.throttleAxis] ?? 0) : 0,
      brakeRestValue:
        prev.brakeAxis !== null ? (hardwareState.axes[prev.brakeAxis] ?? 0) : 0,
      clutchRestValue:
        prev.clutchAxis !== null ? (hardwareState.axes[prev.clutchAxis] ?? 0) : 0,
    }));
  };

  const handleToggleNewToGame = (isNew: boolean) => {
    setDriverProfile((prev) => ({
      ...prev,
      isNewToGame: isNew,
      skillTier: isNew ? 'newcomer' : prev.skillTier === 'newcomer' ? 'competitive' : prev.skillTier,
      primaryGoal: isNew ? 'consistency' : 'pace',
    }));
    pushCallout(
      {
        id: `profile-mode-${Date.now()}`,
        timestampMs: Date.now(),
        lapNumber: frame.lapNumber,
        cornerName: 'Strategy',
        severity: 'coaching',
        category: 'strategy',
        message: isNew
          ? `Newcomer mode active. I'll call braking markers earlier and recommend higher Traction Control and safer Brake Bias as we learn your style.`
          : `Experienced pace mode active. Focusing on late-apex trail braking, minimum apex speed, and tenth-saving setup clicks.`,
        spoken: false,
        source: 'realtime-engine',
      },
      false
    );
  };

  const handleApplyElectronicsSuggestion = (sug: ElectronicsSuggestion) => {
    setSetup((prev) => ({
      ...prev,
      [sug.parameter]: sug.recommendedValue,
    }));
    pushCallout(
      {
        id: `apply-elec-${Date.now()}`,
        timestampMs: Date.now(),
        lapNumber: frame.lapNumber,
        cornerName: 'In-Car Dial',
        severity: 'info',
        category: 'strategy',
        message: `Confirmed: ${sug.title} set to ${sug.recommendedValue}${sug.unit === '%' ? '%' : ''}.`,
        spoken: false,
        source: 'realtime-engine',
      },
      false
    );
  };

  const handleUndoAutonomyAction = (action: AutonomyActionLog) => {
    if (action.reverted) return;
    // Give driver 18s grace window before auto-apply acts again
    lastAutoAppliedAtRef.current = Date.now() + 8000;
    setSetup((prev) => ({
      ...prev,
      [action.parameter]: action.previousValue,
    }));
    setAutonomyLog((prev) =>
      prev.map((entry) => (entry.id === action.id ? { ...entry, reverted: true } : entry))
    );
    const unitSuffix = action.unit === '%' ? '%' : '';
    pushCallout(
      {
        id: `undo-auto-${Date.now()}`,
        timestampMs: Date.now(),
        lapNumber: frame.lapNumber,
        cornerName: 'Pit Wall',
        severity: 'info',
        category: 'strategy',
        message: `Reverted Auto-Apply: ${action.title} restored to ${action.previousValue}${unitSuffix}.`,
        spoken: false,
        source: 'realtime-engine',
      },
      false
    );
  };

  const handleAskEngineer = async (question: string) => {
    const realityCheck = evaluateCoachRealityCheck({
      question,
      language: 'en',
      externalStreamActive,
      isLiveRunning,
      simStatus,
      sessionType: detectedSessionTypeRef.current,
      frame,
      track,
      activeCorner,
      upcomingCorner,
      incidents: recentIncidentsRef.current,
    });

    const driverCornerLabel =
      realityCheck.sessionStatus === 'standby_offline'
        ? 'Standby · Offline'
        : realityCheck.sessionStatus === 'game_in_menus'
          ? 'In Menus'
          : realityCheck.sessionStatus === 'in_garage_or_pits'
            ? 'In Garage / Pits'
            : activeCorner?.name ?? 'On Track';

    const driverMsg: CoachCallout = {
      id: `driver-${Date.now()}`,
      timestampMs: Date.now(),
      lapNumber: frame.lapNumber,
      cornerName: driverCornerLabel,
      severity: 'info',
      category: 'engineer',
      message: question,
      spoken: true,
      source: 'driver-radio',
    };
    setCallouts((prev) => [driverMsg, ...prev].slice(0, 40));

    setIsAskingEngineer(true);
    try {
      const simName = SIM_GAMES.find((s) => s.id === selectedSim)?.name ?? 'Le Mans Ultimate';
      const resp = await fetch('/api/coach/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          simName,
          trackName: track.name,
          carName: car.name,
          language: 'en',
          activeCorner:
            realityCheck.sessionStatus === 'on_track_live' ||
            realityCheck.sessionStatus === 'practice_demo'
              ? formatCornerLabel(activeCorner ?? upcomingCorner, 'en')
              : driverCornerLabel,
          telemetrySummary: {
            sessionStatus: realityCheck.sessionStatus,
            sessionPhase: detectedSessionTypeRef.current,
            carClass: car.carClass,
            hasAbs: car.carClass === 'LMGT3',
            hasVirtualEnergy: car.carClass === 'Hypercar',
            virtualEnergyPct: frame.virtualEnergyPct,
            radioProtocol: settings.radioProtocol ?? 'pro_terse',
            verbosity: settings.verbosity,
            externalTelemetryActive: externalStreamActive,
            isPracticeDemo: !externalStreamActive && isLiveRunning,
            gameRunning: simStatus.gameRunning,
            connectionState: simStatus.connectionState,
            telemetrySource: simStatus.source,
            telemetryQuality: simStatus.telemetryQuality,
            groundTruthBrief: realityCheck.groundTruthBrief,
            claimVerification: {
              truthStatus: realityCheck.truthStatus,
              contradicted: realityCheck.contradicted,
              claimedIncident: realityCheck.claimedIncident,
            },
            recentIncidents: realityCheck.recentIncidents,
            lapNumber: frame.lapNumber,
            lapDistPct: Math.round(frame.lapDistPct * 1000) / 1000,
            speedKmh: Math.round(frame.speedKmh),
            gear: frame.gear,
            rpm: Math.round(frame.rpm),
            throttle: Math.round(frame.throttle * 100) / 100,
            brake: Math.round(frame.brake * 100) / 100,
            longG: frame.longG,
            latG: frame.latG,
            brakeBiasPct: setup.brakeBiasPct,
            tcLevel: setup.tcLevel,
            ...(car.carClass === 'LMGT3' ? { absLevel: setup.absLevel } : {}),
            tireTempC: frame.tireTempC,
            tireWearPct: frame.tireWearPct,
            tirePressurePsi: frame.tirePressurePsi,
            optimalTireTempRange: car.optimalTireTempRange,
            driverSkillTier: driverProfile.skillTier,
            isNewToGame: driverProfile.isNewToGame,
            autonomyMode: settings.autonomyMode,
            pitWindowLap: pitStrategy.recommendedPitLap,
            autoSelectPitTires: settings.autoSelectPitTires ?? true,
            pitRaceMode: pitStrategy.resolvedRaceMode,
            pitTireChoice: pitStrategy.pitTireCallHeadline,
            pitTireReason: pitStrategy.tireSelectionReason,
            pitCrashAlert: pitStrategy.crashAlertActive,
            pitRepairsRecommended: pitStrategy.repairsRecommended,
            racecraftPosture: racecraftAdvice.posture,
            safeToAttack: racecraftAdvice.safeToAttack,
            safeToDefend: racecraftAdvice.safeToDefend,
            nearbyOpponents: (frame.opponents ?? []).slice(0, 4).map((o) => ({
              carNumber: o.carNumber,
              carClass: o.carClass,
              distanceMeters: o.distanceMeters,
              closingSpeedKmh: o.closingSpeedKmh,
              isAlongside: o.isAlongside,
              lateralSide: o.lateralSide,
              safetyRating: o.safetyRating,
            })),
          },
        }),
      });
      const data = await resp.json();
      extractAndPublishAiStatus(resp.status, data);
      const buildTireFallbackAdvice = (): string | null => {
        if (realityCheck.truthFallbackReply) {
          return realityCheck.truthFallbackReply;
        }
        const q = question.toLowerCase();
        const minWear = Math.round(
          Math.min(
            frame.tireWearPct.fl,
            frame.tireWearPct.fr,
            frame.tireWearPct.rl,
            frame.tireWearPct.rr
          )
        );
        const isDirectVoice = (settings.radioProtocol ?? 'pro_terse') === 'pro_terse';
        if (/understeer|front/.test(q)) {
          return isDirectVoice
            ? `Bias -0.8% rear (${setup.brakeBiasPct.toFixed(1)}%), bleed brake earlier.`
            : `Copy that (${minWear}% tire life). Shift Brake Bias 0.8% rearward from ${setup.brakeBiasPct.toFixed(1)}% and release entry brake slightly earlier.`;
        }
        if (/rear|exit|oversteer/.test(q)) {
          return isDirectVoice
            ? `TC Map ${Math.min(10, setup.tcLevel + 1)}, progressive exit throttle.`
            : `Copy that (${minWear}% tire life). Bump TC up to Map ${Math.min(10, setup.tcLevel + 1)} and feed throttle progressively on exit.`;
        }
        if (/pit|box|tire|tyre|ve|energy|fuel/.test(q)) {
          const veHint =
            car.carClass === 'Hypercar' && typeof frame.virtualEnergyPct === 'number'
              ? `, VE ${Math.round(frame.virtualEnergyPct)}%`
              : '';
          return isDirectVoice
            ? `Box Lap ${pitStrategy.recommendedPitLap} — tires ${minWear}%${veHint}.`
            : `Stay out and manage pace — target pit window is Lap ${pitStrategy.recommendedPitLap} (lowest tire life ${minWear}%${veHint}).`;
        }
        if (/okay|good|grip/.test(q)) {
          return isDirectVoice
            ? `Hold TC ${setup.tcLevel}, Bias ${setup.brakeBiasPct.toFixed(1)}%. Box L${pitStrategy.recommendedPitLap}.`
            : `Copy, keep it smooth on TC Map ${setup.tcLevel} and Bias ${setup.brakeBiasPct.toFixed(1)}% — ready for fresh tires on Lap ${pitStrategy.recommendedPitLap}.`;
        }
        return null;
      };

      let replyText = '';
      if (resp.ok) {
        replyText = data.reply;
      } else if (resp.status === 429) {
        const now = Date.now();
        const targetMs =
          data.availableAtMs ??
          data.rateLimitedUntilMs ??
          (data.isDailyLimit
            ? getNextDailyResetTimestampMs(now)
            : typeof data.retryAfterSec === 'number' && data.retryAfterSec > 0
              ? now + data.retryAfterSec * 1000
              : null);
        const clockStr = targetMs ? formatAvailableAtClock(targetMs, now, 'en') : null;
        const durStr = targetMs ? formatRemainingDuration(targetMs, now, 'en') : null;
        const localAdvice = buildTireFallbackAdvice();

        if (data.isDailyLimit) {
          replyText =
            localAdvice ??
            `Google daily quota limit reached (1,500 RPD). Available again ${clockStr ?? 'at midnight UTC'}${durStr ? ` (in ${durStr})` : ''}. Hold TC Map ${setup.tcLevel} and Brake Bias ${setup.brakeBiasPct.toFixed(1)}%.`;
        } else if (data.retryAfterSec) {
          replyText =
            localAdvice ??
            `Google rate limit (${data.quotaLimit || 'RPM'}): available again ${clockStr ?? `in ${data.retryAfterSec}s`}${durStr ? ` (in ${durStr})` : ''}. Hold TC Map ${setup.tcLevel} and Brake Bias ${setup.brakeBiasPct.toFixed(1)}%.`;
        } else {
          replyText =
            localAdvice ??
            `Google quota limit active.${clockStr ? ` Available again ${clockStr} (in ${durStr}).` : ''} Hold TC Map ${setup.tcLevel} and Brake Bias ${setup.brakeBiasPct.toFixed(1)}%.`;
        }
      } else {
        replyText =
          buildTireFallbackAdvice() ??
          `Pit wall offline coach: hold Brake Bias ${setup.brakeBiasPct.toFixed(1)}% and TC Map ${setup.tcLevel}.`;
      }

      pushCallout(
        {
          id: `eng-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: frame.lapNumber,
          cornerName: driverCornerLabel,
          severity: realityCheck.contradicted || resp.status === 429 ? 'warning' : 'coaching',
          category: 'engineer',
          message: replyText,
          spoken: false,
          source: resp.ok ? 'gemini-engineer' : 'realtime-engine',
        },
        resp.ok
      );
    } catch {
      pushCallout(
        {
          id: `eng-err-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: frame.lapNumber,
          cornerName: 'Pit Wall',
          severity: 'warning',
          category: 'engineer',
          message:
            realityCheck.truthFallbackReply ??
            'Pit radio interference — try again on the next straight.',
          spoken: false,
          source: 'realtime-engine',
        },
        false
      );
    } finally {
      setIsAskingEngineer(false);
    }
  };

  const handleTranscribeAndAsk = async (audioBase64: string, mimeType: string) => {
    setIsAskingEngineer(true);
    try {
      const resp = await fetch('/api/coach/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64, mimeType }),
      });
      const data = await resp.json();
      extractAndPublishAiStatus(resp.status, data);
      const transcript = typeof data.transcript === 'string' ? data.transcript.trim() : '';
      if (resp.ok && transcript) {
        await handleAskEngineer(transcript);
      } else {
        pushCallout(
          {
            id: `mic-empty-${Date.now()}`,
            timestampMs: Date.now(),
            lapNumber: latestLapRef.current,
            cornerName: 'Driver Mic',
            severity: 'info',
            category: 'engineer',
            message:
              typeof data?.error === 'string' && data.error.trim()
                ? data.error
                : 'Did not catch clear voice audio — try holding the mic closer or typing in Pit Radio.',
            spoken: false,
            source: 'realtime-engine',
          },
          false
        );
      }
    } catch {
      pushCallout(
        {
          id: `mic-err-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: latestLapRef.current,
          cornerName: 'Driver Mic',
          severity: 'warning',
          category: 'engineer',
          message: 'Voice transcription failed — check your microphone connection or type in Pit Radio.',
          spoken: false,
          source: 'realtime-engine',
        },
        false
      );
    } finally {
      setIsAskingEngineer(false);
    }
  };

  const handleUpdateSettings = (patch: Partial<CoachSettings>) => {
    if (patch.autonomyMode === 'hands_on') {
      lastAutoAppliedAtRef.current = 0;
    }
    setSettings((prev) => ({ ...prev, ...patch, language: 'en' }));
  };

  const handleResetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  const handleTestEngineerCallout = () => {
    const cornerLabel = formatCornerLabel(upcomingCorner, 'en');
    pushCallout(
      {
        id: `test-${Date.now()}`,
        timestampMs: Date.now(),
        lapNumber: frame.lapNumber,
        cornerName: cornerLabel,
        severity: 'warning',
        category: 'braking',
        message: `Radio check into ${cornerLabel}. Tire temperatures look sharp — push cleanly on exit!`,
        spoken: false,
        source: 'realtime-engine',
      },
      settings.useGeminiTts
    );
  };

  const simDisplayName = SIM_GAMES.find((s) => s.id === selectedSim)?.name ?? 'Le Mans Ultimate';

  const handleToggleLiveVoice = async () => {
    if (
      liveVoiceStatus === 'listening' ||
      liveVoiceStatus === 'speaking' ||
      liveVoiceStatus === 'connecting'
    ) {
      liveClientRef.current?.disconnect();
      lastLiveVoiceProtocolRef.current = null;
      lastLiveVoiceConfigSigRef.current = null;
      lastLiveSyncedStateRef.current = '';
      lastLiveSyncSentAtRef.current = 0;
      setLiveVoiceStatus('disconnected');
      setLiveVoicePhase('idle');
      setLiveVoiceError(null);
      return;
    }

    stopAllRadioSpeech();
    setLiveVoiceError(null);
    setLiveVoicePhase('idle');
    const client = new LiveCoachVoiceClient({
      onStatusChange: (status, detail) => {
        setLiveVoiceStatus(status);
        if (status === 'error' && detail) {
          setLiveVoiceError(detail);
        } else if (status === 'listening' || status === 'speaking') {
          setLiveVoiceError(null);
        }
      },
      onTurnPhaseChange: (phase) => {
        setLiveVoicePhase(phase);
      },
      onInputTranscript: (text) => {
        const cornerLabel = formatCornerLabel(activeCornerRef.current, 'en', 'Live Mic');
        const entry: CoachCallout = {
          id: `live-in-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: latestLapRef.current,
          cornerName: cornerLabel,
          severity: 'info',
          category: 'engineer',
          message: text,
          spoken: true,
          source: 'driver-radio',
        };
        setCallouts((prev) => [entry, ...prev].slice(0, 40));
      },
      onOutputTranscript: (text) => {
        const cornerLabel = formatCornerLabel(activeCornerRef.current, 'en', 'Live Engineer');
        const entry: CoachCallout = {
          id: `live-out-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: latestLapRef.current,
          cornerName: cornerLabel,
          severity: 'coaching',
          category: 'engineer',
          message: text,
          spoken: true,
          source: 'gemini-engineer',
        };
        setCallouts((prev) => [entry, ...prev].slice(0, 40));
      },
    });
    liveClientRef.current = client;
    const initialSessionState = resolveSessionTruthStatus({
      externalStreamActive,
      isLiveRunning,
      simStatus,
      frame,
    });
    const currentCornerText =
      initialSessionState === 'on_track_live' || initialSessionState === 'practice_demo'
        ? formatCornerLabel(activeCornerRef.current ?? upcomingCorner, 'en')
        : initialSessionState;

    const activeVoiceProfile = settings.radioProtocol ?? 'pro_terse';
    lastLiveVoiceProtocolRef.current = activeVoiceProfile;
    lastLiveVoiceConfigSigRef.current = [
      activeVoiceProfile,
      settings.geminiVoiceName,
      settings.autonomyMode,
      String(driverProfile.isNewToGame),
      track.id,
      car.id,
      selectedSim,
    ].join('|');
    lastLiveSyncedStateRef.current = '';
    lastLiveSyncSentAtRef.current = 0;

    await client.connect({
      simName: simDisplayName,
      trackName: track.name,
      carName: car.name,
      carClass: car.carClass,
      voiceName: settings.geminiVoiceName,
      radioProtocol: activeVoiceProfile,
      sessionPhase: detectedSessionTypeRef.current,
      virtualEnergyPct: frame.virtualEnergyPct,
      language: 'en',
      isNewToGame: driverProfile.isNewToGame,
      autonomyMode: settings.autonomyMode,
      sessionState: initialSessionState,
      speedKmh: frame.speedKmh,
      currentCorner: currentCornerText,
    });
  };

  // Auto-reconnect active Live Voice when Voice Profile, Voice Name, Autonomy, Skill, Track, Car, or Sim changes mid-call
  useEffect(() => {
    const nextProtocol = settings.radioProtocol ?? 'pro_terse';
    if (liveVoiceStatus === 'disconnected' || liveVoiceStatus === 'error') {
      lastLiveVoiceProtocolRef.current = null;
      lastLiveVoiceConfigSigRef.current = null;
      return;
    }
    if (liveVoiceStatus !== 'listening' && liveVoiceStatus !== 'speaking') {
      return;
    }
    const nextConfigSig = [
      nextProtocol,
      settings.geminiVoiceName,
      settings.autonomyMode,
      String(driverProfile.isNewToGame),
      track.id,
      car.id,
      selectedSim,
    ].join('|');

    if (
      lastLiveVoiceConfigSigRef.current &&
      lastLiveVoiceConfigSigRef.current !== nextConfigSig &&
      liveClientRef.current
    ) {
      lastLiveVoiceProtocolRef.current = nextProtocol;
      lastLiveVoiceConfigSigRef.current = nextConfigSig;
      lastLiveSyncedStateRef.current = '';
      lastLiveSyncSentAtRef.current = 0;
      const curFrame = latestFrameRef.current;
      const curStatus = resolveSessionTruthStatus({
        externalStreamActive,
        isLiveRunning,
        simStatus,
        frame: curFrame,
      });
      const cornerLabelNow =
        curStatus === 'on_track_live' || curStatus === 'practice_demo'
          ? formatCornerLabel(activeCornerRef.current ?? upcomingCorner, 'en')
          : curStatus;
      stopAllRadioSpeech();
      void liveClientRef.current.reconnectWithConfig({
        simName: simDisplayName,
        trackName: track.name,
        carName: car.name,
        carClass: car.carClass,
        voiceName: settings.geminiVoiceName,
        radioProtocol: nextProtocol,
        sessionPhase: detectedSessionTypeRef.current,
        virtualEnergyPct: curFrame.virtualEnergyPct,
        isNewToGame: driverProfile.isNewToGame,
        autonomyMode: settings.autonomyMode,
        sessionState: curStatus,
        speedKmh: curFrame.speedKmh,
        currentCorner: cornerLabelNow,
      });
    }
  }, [
    liveVoiceStatus,
    settings.radioProtocol,
    settings.geminiVoiceName,
    settings.autonomyMode,
    driverProfile.isNewToGame,
    track.id,
    track.name,
    car.id,
    car.name,
    car.carClass,
    selectedSim,
    simDisplayName,
  ]);

  // Sync live telemetry state (session, tires, fuel, brakes, electronics, corner, gaps) into active Live Voice AI
  useEffect(() => {
    if (liveVoiceStatus !== 'listening' && liveVoiceStatus !== 'speaking') {
      lastLiveSyncedStateRef.current = '';
      return;
    }
    const statusNow = resolveSessionTruthStatus({
      externalStreamActive,
      isLiveRunning,
      simStatus,
      frame,
    });
    const detectedPhase = getEffectiveSessionType({
      override: sessionPhaseOverride,
      simStatus,
      frameSessionType: frame.sessionType,
    });
    const voiceMode = settings.radioProtocol ?? 'pro_terse';
    const cornerFocus = activeCorner ?? upcomingCorner;
    const cornerLabel =
      statusNow === 'on_track_live' || statusNow === 'practice_demo'
        ? `${formatCornerLabel(cornerFocus, 'en')} (${Math.round(frame.lapDistPct * 100)}%)`
        : statusNow;

    const discreteSignature = [
      statusNow,
      detectedPhase,
      track.id,
      car.id,
      car.carClass,
      voiceMode,
      settings.autonomyMode,
      String(simStatus.gameRunning),
      String(frame.lapNumber),
      Math.round(frame.speedKmh) > 5 ? 'moving' : 'stopped',
      cornerFocus?.id ?? 'none',
      frame.flagState,
      String(Boolean(frame.inFormationLap)),
      String(Boolean(frame.penaltyActive)),
      String(racecraftAdvice.posture),
      String(recentIncidentsRef.current.length),
      String(pitStrategy.pitNeededThisRace),
      String(pitStrategy.recommendedPitLap),
      pitStrategy.pitTireCallHeadline,
      String(pitStrategy.crashAlertActive),
      String(pitStrategy.raceLengthLaps),
    ].join(':');

    const nowMs = Date.now();
    const isDrivingNow = statusNow === 'on_track_live' || statusNow === 'practice_demo';
    const periodicDue = isDrivingNow && nowMs - lastLiveSyncSentAtRef.current >= 2800;

    if (discreteSignature !== lastLiveSyncedStateRef.current || periodicDue) {
      lastLiveSyncedStateRef.current = discreteSignature;
      lastLiveSyncSentAtRef.current = nowMs;

      const nearbyOpponents = (frame.opponents ?? [])
        .filter((o) => !o.inPits && Math.abs(o.distanceMeters) <= 260)
        .sort((a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters))
        .slice(0, 2)
        .map((o) => {
          const dir = o.distanceMeters >= 0 ? 'ahead' : 'behind';
          return `#${o.carNumber} ${o.carClass} ${Math.abs(Math.round(o.distanceMeters))}m ${dir} (${o.lateralSide})`;
        })
        .join('; ');

      const deltaStr = `${frame.deltaSec >= 0 ? '+' : ''}${frame.deltaSec.toFixed(2)}s`;
      const veStr =
        typeof frame.virtualEnergyPct === 'number' && Number.isFinite(frame.virtualEnergyPct)
          ? `${Math.round(frame.virtualEnergyPct)}%`
          : 'N/A';

      liveClientRef.current?.sendTelemetryState(
        [
          `SessionStatus=${statusNow}`,
          `SessionPhase=${detectedPhase}`,
          `MatchMode=${pitStrategy.raceModeLabel}`,
          `RaceLengthLaps=${pitStrategy.raceLengthLaps}`,
          `Track=${track.name}`,
          `Car=${car.name}`,
          `Class=${car.carClass} (${car.carClass === 'LMGT3' ? 'HAS_ABS' : 'NO_ABS'})`,
          `VoiceProfile=${voiceMode}`,
          `Autonomy=${settings.autonomyMode}`,
          `GameRunning=${simStatus.gameRunning}`,
          `Speed=${Math.round(frame.speedKmh)} km/h`,
          `Gear=${frame.gear}`,
          `Lap=${frame.lapNumber}/${pitStrategy.raceLengthLaps}`,
          `Corner=${cornerLabel}`,
          `Delta=${deltaStr}`,
          `Flag=${frame.flagState}`,
          ...(frame.inFormationLap ? ['FormationLap=true'] : []),
          ...(frame.penaltyActive ? ['PenaltyActive=true'] : []),
          `Fuel=${frame.fuelLiters.toFixed(1)}L (${pitStrategy.fuelBurnPerLapLiters.toFixed(1)}L/lap, ~${pitStrategy.lapsOfFuelLeft.toFixed(1)} laps left)`,
          `PitNeeded=${pitStrategy.pitNeededThisRace}`,
          `PitWindow=${pitStrategy.pitNeededThisRace ? `L${pitStrategy.pitWindowStartLap}-L${pitStrategy.pitWindowEndLap} (Box L${pitStrategy.recommendedPitLap})` : 'NoStop_ToFlag'}`,
          `PitTires=Current:${pitStrategy.currentCompound} -> Next:${pitStrategy.pitTireCallHeadline} (+${pitStrategy.fuelToAddLiters.toFixed(0)}L)${pitStrategy.crashAlertActive ? ' CRASH_BOX_NOW_REPAIRS_ON' : ''}`,
          `ProjectedFlagWear=${pitStrategy.estimatedWearAtFlagPct}%`,
          `CliffLap=${pitStrategy.estimatedCliffLap !== null ? `L${pitStrategy.estimatedCliffLap}` : 'None'}`,
          `DriverHabits=Lockups:${driverProfile.habits.lockupCount} ExitSnaps:${driverProfile.habits.exitSnapCount} Consistency:${driverProfile.habits.brakingConsistencyPct}%`,
          ...(pitStrategy.learnedAdaptationNote ? [`AdaptationNote=${pitStrategy.learnedAdaptationNote}`] : []),
          `VirtualEnergyPct=${veStr}`,
          `TireTempC=FL:${Math.round(frame.tireTempC.fl)} FR:${Math.round(frame.tireTempC.fr)} RL:${Math.round(frame.tireTempC.rl)} RR:${Math.round(frame.tireTempC.rr)}`,
          `TireWearPct=FL:${Math.round(frame.tireWearPct.fl)} FR:${Math.round(frame.tireWearPct.fr)} RL:${Math.round(frame.tireWearPct.rl)} RR:${Math.round(frame.tireWearPct.rr)}`,
          `TirePsi=FL:${frame.tirePressurePsi.fl.toFixed(1)} FR:${frame.tirePressurePsi.fr.toFixed(1)} RL:${frame.tirePressurePsi.rl.toFixed(1)} RR:${frame.tirePressurePsi.rr.toFixed(1)}`,
          `BrakeTempC=FL:${Math.round(frame.brakeTempC.fl)} FR:${Math.round(frame.brakeTempC.fr)} RL:${Math.round(frame.brakeTempC.rl)} RR:${Math.round(frame.brakeTempC.rr)}`,
          `Electronics=Bias:${setup.brakeBiasPct.toFixed(1)}% TC:${setup.tcLevel} ABS:${car.carClass === 'LMGT3' ? setup.absLevel : 'N/A'}`,
          `Racecraft=${racecraftAdvice.posture}${nearbyOpponents ? ` | Opponents=${nearbyOpponents}` : ''}`,
          `IncidentsRecorded=${recentIncidentsRef.current.length}`,
        ].join(', ')
      );
    }
  }, [
    liveVoiceStatus,
    externalStreamActive,
    isLiveRunning,
    simStatus,
    sessionPhaseOverride,
    frame,
    track.id,
    track.name,
    car.id,
    car.name,
    car.carClass,
    settings.radioProtocol,
    settings.autonomyMode,
    activeCorner,
    upcomingCorner,
    driverProfile.habits.lockupCount,
    driverProfile.habits.exitSnapCount,
    driverProfile.habits.brakingConsistencyPct,
    pitStrategy.lapsOfFuelLeft,
    pitStrategy.fuelBurnPerLapLiters,
    pitStrategy.fuelToAddLiters,
    pitStrategy.pitNeededThisRace,
    pitStrategy.pitWindowStartLap,
    pitStrategy.pitWindowEndLap,
    pitStrategy.recommendedPitLap,
    pitStrategy.pitTireCallHeadline,
    pitStrategy.currentCompound,
    pitStrategy.estimatedWearAtFlagPct,
    pitStrategy.estimatedCliffLap,
    pitStrategy.learnedAdaptationNote,
    pitStrategy.raceLengthLaps,
    pitStrategy.raceModeLabel,
    pitStrategy.crashAlertActive,
    setup.brakeBiasPct,
    setup.tcLevel,
    setup.absLevel,
    racecraftAdvice.posture,
  ]);

  const handleGenerateRaceReport = useCallback(
    (openView = true, isAutoSessionEnd = false, overrideSessionType?: SimSessionType) => {
      const lapsToAnalyze =
        sessionLapsRef.current.length > 0
          ? sessionLapsRef.current
          : recordedLap
            ? [recordedLap]
            : [sampleLap];

      const isSoloReport =
        (!externalStreamActive && sessionGridModeRef.current === 'solo') ||
        (externalStreamActive && (frame.opponents?.length ?? 0) === 0);

      const resolvedSessionType =
        overrideSessionType ??
        (detectedSessionTypeRef.current !== 'unknown' ? detectedSessionTypeRef.current : undefined);

      let effectiveProfile = driverProfile;
      const hasTrackMemory = Object.keys(driverProfile.cornerMemory ?? {}).some((k) =>
        k.startsWith(`${track.id}:`)
      );
      if (!hasTrackMemory && lapsToAnalyze.length > 0) {
        effectiveProfile = recordCornerLearningFromLap({
          profile: driverProfile,
          track,
          lap: lapsToAnalyze[0],
          referenceSamples,
        });
        setDriverProfile(effectiveProfile);
      }

      const mistakes = sessionMistakesRef.current;
      const report = buildPostRaceReport({
        simId: selectedSim,
        simName: simDisplayName,
        track,
        car,
        setup,
        driverProfile: effectiveProfile,
        laps: lapsToAnalyze,
        referenceSamples,
        mistakeCounts:
          sessionLapsRef.current.length > 0 || isAutoSessionEnd
            ? mistakes
            : {
                lateBrakes: Math.max(mistakes.lateBrakes, effectiveProfile.habits.lateBrakeCount),
                lockups: Math.max(mistakes.lockups, effectiveProfile.habits.lockupCount),
                exitSnaps: Math.max(mistakes.exitSnaps, effectiveProfile.habits.exitSnapCount),
                offTracks: Math.max(mistakes.offTracks, effectiveProfile.habits.offTrackCount),
              },
        sessionMode:
          sessionLapsRef.current.length > 0 || externalStreamActive
            ? 'live_race'
            : 'practice_stint',
        ...(resolvedSessionType ? { sessionType: resolvedSessionType } : {}),
        opponents: frame.opponents,
        officialFinishPosition: frame.playerPosition,
        fieldSize: frame.fieldSize ?? (isSoloReport ? 1 : undefined),
        language: 'en',
      });

      setRaceReports((prev) => [report, ...prev].slice(0, 20));
      sessionMistakesRef.current = { lateBrakes: 0, lockups: 0, exitSnaps: 0, offTracks: 0 };
      if (openView) {
        setTelemetryTab('reports');
        setActiveView('telemetry');
        window.scrollTo({ top: 0 });
      }
      return report;
    },
    [
      selectedSim,
      simDisplayName,
      track,
      car,
      setup,
      driverProfile,
      recordedLap,
      sampleLap,
      referenceSamples,
      externalStreamActive,
      frame.opponents,
      frame.playerPosition,
      frame.fieldSize,
    ]
  );

  // Detect Practice -> Qualifying -> Race transitions, archive completed stint, and announce phase on Pit Radio
  useEffect(() => {
    if (detectedSessionType === 'unknown') {
      if (!simStatus.gameRunning && !externalStreamActive && sessionPhaseOverride === 'auto') {
        prevSessionPhaseRef.current = 'unknown';
      }
      return;
    }

    const prevPhase = prevSessionPhaseRef.current;
    if (prevPhase === detectedSessionType) return;
    prevSessionPhaseRef.current = detectedSessionType;

    // If transitioning out of an active Practice or Qualifying stint with driven laps, auto-save its report first
    if (
      prevPhase !== 'unknown' &&
      (sessionLapsRef.current.length >= 1 || recordedLapFramesRef.current.length >= 25)
    ) {
      const archived = handleGenerateRaceReport(false, true, prevPhase);
      recordedLapFramesRef.current = [];
      sessionLapsRef.current = [];
      setSessionLaps([]);
      setRecordedLap(null);
      cooldownsRef.current = createInitialCooldowns();
      recentIncidentsRef.current = [];
      setRecentIncidents([]);
      const prevLabel = formatSessionTypeLabel(prevPhase) ?? 'Session';
      pushCallout(
        {
          id: `phase-archive-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: frame.lapNumber,
          cornerName: `${prevLabel} Saved`,
          severity: 'info',
          category: 'strategy',
          message: `${prevLabel} report archived (${archived.trackName}) — -${archived.fixableGainPerLapSec.toFixed(2)}s/lap findable pace.`,
          spoken: false,
          source: 'realtime-engine',
        },
        false
      );
    }

    const transition = buildSessionTransitionMessage(
      detectedSessionType,
      prevPhase,
      settings.radioProtocol
    );
    if (transition) {
      pushCallout(
        {
          id: `session-phase-${detectedSessionType}-${Date.now()}`,
          timestampMs: Date.now(),
          lapNumber: frame.lapNumber,
          cornerName: transition.cornerLabel,
          severity: 'coaching',
          category: 'strategy',
          message: transition.message,
          spoken: false,
          source: 'realtime-engine',
        },
        true
      );
    }
  }, [
    detectedSessionType,
    simStatus.gameRunning,
    externalStreamActive,
    sessionPhaseOverride,
    handleGenerateRaceReport,
    pushCallout,
    frame.lapNumber,
  ]);

  // Auto-generate Post-Race Report when external simulator finishes an on-track stint
  useEffect(() => {
    if (simStatus.connectionState === 'on_track') {
      wasExternalOnTrackRef.current = true;
      return;
    }
    if (
      wasExternalOnTrackRef.current &&
      (simStatus.connectionState === 'menus' ||
        simStatus.connectionState === 'offline' ||
        simStatus.connectionState === 'in_pit')
    ) {
      wasExternalOnTrackRef.current = false;
      if (sessionLapsRef.current.length >= 1 || recordedLapFramesRef.current.length >= 25) {
        const rep = handleGenerateRaceReport(false, true);
        pushCallout(
          {
            id: `post-race-auto-${Date.now()}`,
            timestampMs: Date.now(),
            lapNumber: frame.lapNumber,
            cornerName: 'Race Report',
            severity: 'coaching',
            category: 'strategy',
            message: `Post-Race Report saved (${rep.trackName}): fix ${rep.mistakeFixes.length} areas for -${rep.fixableGainPerLapSec.toFixed(2)}s/lap (+${rep.positionsGained} positions). Open Race Reports.`,
            spoken: false,
            source: 'realtime-engine',
          },
          false
        );
      }
    }
  }, [simStatus.connectionState, handleGenerateRaceReport, pushCallout, frame.lapNumber]);

  const handleUpdateReportAiBrief = useCallback((reportId: string, brief: AiPostRaceBrief) => {
    setRaceReports((prev) =>
      prev.map((r) => (r.id === reportId ? { ...r, aiBrief: brief } : r))
    );
  }, []);

  const handleDeleteReport = useCallback((reportId: string) => {
    setRaceReports((prev) => prev.filter((r) => r.id !== reportId));
  }, []);

  const handleUpdateSetupIntake = useCallback((patch: Partial<DriverSetupIntake>) => {
    setSetupIntake((prev) => ({ ...prev, ...patch }));
    if (patch.stintObjective) {
      const nextGoal: DriverProfile['primaryGoal'] =
        patch.stintObjective === 'quali_sprint'
          ? 'pace'
          : patch.stintObjective === 'endurance_stability'
            ? 'endurance'
            : 'consistency';
      setDriverProfile((prevProf) =>
        prevProf.primaryGoal === nextGoal ? prevProf : { ...prevProf, primaryGoal: nextGoal }
      );
    }
  }, []);

  const aiDisplay = useMemo(
    () => formatAiStatusDisplay(aiStatusState, 'en', aiClockMs),
    [aiStatusState, aiClockMs]
  );

  return (
    <div className="min-h-screen bg-canvas text-text">
      <TopBar
        activeView={activeView}
        onSelectView={(view) => {
          setActiveView(view);
          window.scrollTo({ top: 0 });
        }}
        isLiveRunning={isLiveRunning}
        externalStreamActive={externalStreamActive}
        simStatus={simStatus}
        liveVoiceStatus={liveVoiceStatus}
        liveVoicePhase={liveVoicePhase}
        onToggleLiveVoice={handleToggleLiveVoice}
        onToggleLive={handleToggleLive}
        onOpenSettings={() => {
          setSettingsInitialSection('profiles');
          setIsSettingsOpen(true);
        }}
        onOpenSimBridge={() => {
          setSettingsInitialSection('sim_bridge');
          setIsSettingsOpen(true);
        }}
      />

      {/* Single-Line Context Strip & On-Demand Session Switcher Popover */}
      <div className="relative border-b border-[#1B2230] bg-[#0B0F17]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 sm:px-6 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-200">{simDisplayName}</span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="text-slate-300">{track.name}</span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="text-cyan-300 font-medium">{car.name}</span>
            <span className="text-slate-600 hidden sm:inline" aria-hidden="true">·</span>
            <span className="hidden sm:inline font-mono text-[11px] text-slate-500">
              Auto-Detect {autoDetectEnabled ? 'ON' : 'OFF'}
            </span>

            <button
              type="button"
              onClick={() => setSessionPopoverOpen((v) => !v)}
              aria-expanded={sessionPopoverOpen}
              data-testid="session-switcher-btn"
              className={`ml-1 inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                sessionPopoverOpen
                  ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                  : 'border-[#273145] bg-[#0F1420] text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200'
              }`}
            >
              <SlidersHorizontal className="h-3 w-3 text-cyan-400" aria-hidden="true" />
              <span>Change Session</span>
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400">
            {detectedSession && (detectedSession.rawCarName || detectedSession.rawTrackName) && (
              <span className="sr-only" data-testid="detected-session-label">
                {detectedSession.car?.name ?? detectedSession.rawCarName ?? 'Car'} ·{' '}
                {detectedSession.track?.name ?? detectedSession.rawTrackName ?? 'Track'}
              </span>
            )}
            <span
              data-testid="sim-connection-readout"
              className={
                externalStreamActive && simStatus.connectionState !== 'in_pit'
                  ? 'text-emerald-300'
                  : simStatus.gameRunning || externalStreamActive
                    ? 'text-amber-300'
                    : isLiveRunning
                      ? 'text-cyan-300'
                      : 'text-slate-400'
              }
            >
              {externalStreamActive && simStatus.connectionState !== 'in_pit'
                ? sessionPhaseLabel
                  ? `On track · ${sessionPhaseLabel}`
                  : 'On track'
                : simStatus.gameRunning || externalStreamActive
                  ? simStatus.connectionState === 'in_pit'
                    ? `${simStatus.gameName ?? 'Simulator'} · Garage`
                    : `${simStatus.gameName ?? 'Simulator'} · Menus`
                  : isLiveRunning
                    ? 'Demo Stint Active'
                    : 'Standby · Waiting for Sim'}
            </span>
            {aiStatusLoaded && (
              <>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span
                  data-testid="ai-key-status-pill"
                  title={`${aiDisplay.sourceLabel}`}
                  className={`font-medium whitespace-nowrap ${
                    aiDisplay.tone === 'emerald'
                      ? 'text-emerald-400'
                      : aiDisplay.tone === 'amber'
                        ? 'text-amber-300'
                        : aiDisplay.tone === 'rose'
                          ? 'text-rose-400'
                          : 'text-slate-400'
                  }`}
                >
                  {aiDisplay.pillLabel}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Interactive Session Switcher Popover */}
        {sessionPopoverOpen && (
          <div
            data-testid="session-switcher-popover"
            className="border-t border-[#1B2230] bg-[#0F1420] shadow-xl"
          >
            <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-3 sm:px-6 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap">
                  <span>Sim</span>
                  <select
                    id="sim-select"
                    aria-label="Sim"
                    value={selectedSim}
                    onChange={(e) => setSelectedSim(e.target.value as SimGameId)}
                    className="h-8 rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
                  >
                    {SIM_GAMES.map((sim) => (
                      <option key={sim.id} value={sim.id} className="bg-[#0F1420] text-slate-100">
                        {sim.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap">
                  <span>Circuit</span>
                  <select
                    id="track-select"
                    aria-label="Circuit"
                    value={selectedTrackId}
                    onChange={(e) => setSelectedTrackId(e.target.value)}
                    className="h-8 max-w-[230px] truncate rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
                  >
                    {TRACKS.map((t) => (
                      <option key={t.id} value={t.id} className="bg-[#0F1420] text-slate-100">
                        {t.name} ({t.lengthKm.toFixed(1)} km)
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap">
                  <span>Car</span>
                  <select
                    id="car-select"
                    aria-label="Car"
                    value={selectedCarId}
                    onChange={(e) => setSelectedCarId(e.target.value)}
                    className="h-8 max-w-[230px] truncate rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
                  >
                    {CARS.map((c) => (
                      <option key={c.id} value={c.id} className="bg-[#0F1420] text-slate-100">
                        {c.name} ({c.carClass})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap">
                  <span>Session</span>
                  <select
                    id="session-phase-select"
                    aria-label="Session phase"
                    data-testid="session-phase-select"
                    value={sessionPhaseOverride}
                    onChange={(e) => setSessionPhaseOverride(e.target.value as SessionPhaseOverride)}
                    className="h-8 rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
                  >
                    <option value="auto" className="bg-[#0F1420] text-slate-100">
                      Auto ({formatSessionTypeLabel(detectedSessionType) ?? 'Sim'})
                    </option>
                    <option value="practice" className="bg-[#0F1420] text-slate-100">Practice</option>
                    <option value="qualifying" className="bg-[#0F1420] text-slate-100">Qualifying</option>
                    <option value="race" className="bg-[#0F1420] text-slate-100">Race</option>
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => setAutoDetectEnabled((v) => !v)}
                  data-testid="auto-detect-toggle"
                  className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    autoDetectEnabled
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Auto-Detect: {autoDetectEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setSessionPopoverOpen(false)}
                className="rounded border border-[#273145] bg-[#090B10] px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-slate-100 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Live API Key / Rate-Limit Notification Banner */}
      {aiStatusLoaded &&
        aiDisplay.bannerTitle &&
        aiBannerDismissedForStatus !== aiDisplay.effectiveStatus && (
          <div
            role="status"
            data-testid="ai-status-banner"
            className={`border-b ${
              aiDisplay.tone === 'amber'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                : aiDisplay.tone === 'rose'
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                  : 'border-[#1B2230] bg-[#0F1420] text-slate-200'
            }`}
          >
            <div className="mx-auto flex max-w-[1600px] items-start justify-between gap-4 px-6 py-2.5 text-xs">
              <div className="flex items-start gap-2.5">
                {aiDisplay.tone === 'amber' || aiDisplay.tone === 'rose' ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
                )}
                <div>
                  <div className="font-semibold">{aiDisplay.bannerTitle}</div>
                  {aiDisplay.bannerDetail && (
                    <p className="mt-0.5 text-[11px] opacity-90">{aiDisplay.bannerDetail}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isRecheckingAi}
                  onClick={async () => {
                    setIsRecheckingAi(true);
                    try {
                      const resp = await fetch('/api/coach/recheck', { method: 'POST' });
                      const data = await resp.json();
                      extractAndPublishAiStatus(resp.status, data);
                    } catch {
                      await refreshAiHealth();
                    } finally {
                      setIsRecheckingAi(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded border border-current/25 px-2.5 py-1 text-[11px] font-medium hover:bg-white/5 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${isRecheckingAi ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>
                    {isRecheckingAi ? 'Checking...' : 'Check with Google'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setAiBannerDismissedForStatus(aiDisplay.effectiveStatus)}
                  aria-label="Dismiss notification"
                  className="rounded p-1 opacity-70 hover:opacity-100 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        )}

      {/* Main Content Stage (4 Pro Workbooks) */}
      <main className="mx-auto max-w-[1600px] px-3 sm:px-6 py-4 sm:py-5">
        {activeView === 'pitwall' && (
          <PitWallView
            track={track}
            car={car}
            setup={setup}
            frame={frame}
            activeCorner={activeCorner}
            upcomingCorner={upcomingCorner}
            callouts={callouts}
            isLiveRunning={isLiveRunning}
            settings={settings}
            driverProfile={driverProfile}
            electronicsSuggestions={electronicsSuggestions}
            autonomyLog={autonomyLog}
            racecraftAdvice={racecraftAdvice}
            pitStrategy={pitStrategy}
            liveVoiceStatus={liveVoiceStatus}
            liveVoicePhase={liveVoicePhase}
            liveVoiceError={liveVoiceError}
            externalStreamActive={externalStreamActive}
            simStatus={simStatus}
            onToggleLiveVoice={handleToggleLiveVoice}
            onToggleLive={handleToggleLive}
            onToggleNewToGame={handleToggleNewToGame}
            onApplyElectronicsSuggestion={handleApplyElectronicsSuggestion}
            onUndoAutonomyAction={handleUndoAutonomyAction}
            onUpdateSettings={handleUpdateSettings}
            onAskEngineer={handleAskEngineer}
            onTranscribeAndAsk={handleTranscribeAndAsk}
            onReplayCallout={(c) => speakCoachCallout(c.message, c.severity, settings, true)}
            isAskingEngineer={isAskingEngineer}
            recentPedalTrace={recentPedalTrace}
            skillMetrics={skillMetrics}
            onOpenSettings={() => {
              setSettingsInitialSection('profiles');
              setIsSettingsOpen(true);
            }}
            onOpenSimBridge={() => {
              setSettingsInitialSection('sim_bridge');
              setIsSettingsOpen(true);
            }}
            onOpenCockpitHud={() => setActiveView('cockpit')}
            onInspectDrillCorner={() => {
              setTelemetryTab('trace');
              setActiveView('telemetry');
            }}
            onFinishStintReport={() => handleGenerateRaceReport(true)}
            sessionGridMode={sessionGridMode}
            onChangeSessionGridMode={handleChangeSessionGridMode}
            sessionType={detectedSessionType}
            sessionPhaseOverride={sessionPhaseOverride}
            onChangeSessionPhaseOverride={setSessionPhaseOverride}
            onDismissCrashAlert={handleDismissCrashAlert}
            pitMfdSyncStatus={pitMfdSyncStatus}
            onSyncPitMenuToLmu={() => void syncPitMenuToLmu(pitStrategy)}
          />
        )}

        {activeView === 'cockpit' && (
          <CockpitHudView
            track={track}
            car={car}
            frame={frame}
            activeCorner={activeCorner}
            upcomingCorner={upcomingCorner}
            pitStrategy={pitStrategy}
            callouts={callouts}
            recentPedalTrace={recentPedalTrace}
            isLiveRunning={isLiveRunning}
            externalStreamActive={externalStreamActive}
            simStatus={simStatus}
            settings={settings}
            liveVoiceStatus={liveVoiceStatus}
            liveVoicePhase={liveVoicePhase}
            isAskingEngineer={isAskingEngineer}
            onToggleLiveVoice={handleToggleLiveVoice}
            onUpdateSettings={handleUpdateSettings}
            onAskEngineer={handleAskEngineer}
            onOpenPitWall={() => setActiveView('pitwall')}
          />
        )}

        {activeView === 'telemetry' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3">
              <div
                className="inline-flex rounded-md border border-[#273145] bg-[#0B0F17] p-0.5 text-xs"
                role="tablist"
                aria-label="Telemetry workbook views"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={telemetryTab === 'trace'}
                  onClick={() => setTelemetryTab('trace')}
                  data-testid="telemetry-subtab-trace"
                  className={`rounded px-3 py-1.5 font-medium cursor-pointer whitespace-nowrap ${
                    telemetryTab === 'trace'
                      ? 'bg-[#1D273B] text-cyan-200 border border-cyan-500/35'
                      : 'text-slate-400 hover:text-slate-100 border border-transparent'
                  }`}
                >
                  Trace &amp; Corner Zoom
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={telemetryTab === 'reports'}
                  onClick={() => setTelemetryTab('reports')}
                  data-testid="telemetry-subtab-reports"
                  className={`rounded px-3 py-1.5 font-medium cursor-pointer whitespace-nowrap ${
                    telemetryTab === 'reports'
                      ? 'bg-[#1D273B] text-cyan-200 border border-cyan-500/35'
                      : 'text-slate-400 hover:text-slate-100 border border-transparent'
                  }`}
                >
                  Post-Race Reports ({raceReports.length})
                </button>
              </div>
              <span className="font-mono text-[11px] text-slate-500">
                {track.name} · {car.name}
              </span>
            </div>

            {telemetryTab === 'trace' ? (
              <TelemetryLabView
                simName={simDisplayName}
                track={track}
                car={car}
                setup={setup}
                lap={sampleLap}
                recordedLap={recordedLap}
                referenceSamples={referenceSamples}
                language="en"
                onSpeakText={(txt) => speakCoachCallout(txt, 'coaching', settings, true)}
              />
            ) : (
              <RaceReportsView
                reports={raceReports}
                activeTrackName={track.name}
                activeCarName={car.name}
                capturedLapsCount={sessionLaps.length}
                language="en"
                coachSettings={settings}
                driverProfile={driverProfile}
                onGenerateReport={() => handleGenerateRaceReport(true)}
                onUpdateReportAiBrief={handleUpdateReportAiBrief}
                onDeleteReport={handleDeleteReport}
                onSpeakText={(txt) => speakCoachCallout(txt, 'coaching', settings, true)}
                onOpenTelemetry={() => setTelemetryTab('trace')}
              />
            )}
          </div>
        )}

        {activeView === 'bridge' && (
          <SetupGarageView
            simId={selectedSim}
            simName={simDisplayName}
            track={track}
            car={car}
            setup={setup}
            driverProfile={driverProfile}
            setupIntake={setupIntake}
            pitStrategy={pitStrategy}
            cornerComparisons={cornerComparisons}
            latestFrame={frame}
            language="en"
            onSwitchToLmu={() => setSelectedSim('lmu')}
            onUpdateSetup={setSetup}
            onResetSetup={() => setSetup(car.defaultSetup)}
            onUpdateSetupIntake={handleUpdateSetupIntake}
            onDismissCrashAlert={handleDismissCrashAlert}
            pitMfdSyncStatus={pitMfdSyncStatus}
            onSyncPitMenuToLmu={() => void syncPitMenuToLmu(pitStrategy)}
            onOpenPitWall={() => setActiveView('pitwall')}
          />
        )}
      </main>

      <EngineerSettingsModal
        isOpen={isSettingsOpen}
        initialSection={settingsInitialSection}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onTestCallout={handleTestEngineerCallout}
        onResetDefaults={handleResetSettings}
        simBridgeProps={{
          selectedSim,
          track,
          car,
          wsConnected,
          externalStreamActive,
          simStatus,
          autoDetectEnabled,
          detectedSession,
          hardwareState,
          hardwareMapping,
          hardwareDriveEnabled,
          keyboardDriveEnabled,
          activeFault,
          sessionPhaseOverride,
          onToggleAutoDetect: () => setAutoDetectEnabled((v) => !v),
          onToggleHardwareDrive: () => setHardwareDriveEnabled((v) => !v),
          onToggleKeyboardDrive: () => setKeyboardDriveEnabled((v) => !v),
          onUpdateHardwareMapping: (patch) =>
            setHardwareMapping((prev) => ({ ...prev, ...patch })),
          onCalibrateHardwareRest: handleCalibrateHardwareRest,
          onResetSettings: handleResetSettings,
          onTriggerFault: handleTriggerFault,
          onManualPedalOverride: handleManualPedalOverride,
          onChangeSessionPhaseOverride: setSessionPhaseOverride,
        }}
      />
    </div>
  );
}
