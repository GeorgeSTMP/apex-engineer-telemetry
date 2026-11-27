export type SimGameId = 'lmu' | 'acc' | 'iracing' | 'rf2';

export type SimSessionType = 'practice' | 'qualifying' | 'race' | 'warmup' | 'unknown';

export type AppView = 'pitwall' | 'cockpit' | 'telemetry' | 'bridge';

export type CalloutSeverity = 'urgent' | 'warning' | 'coaching' | 'info';

export type CoachFocusMode = 'all' | 'braking' | 'apex_line' | 'throttle_exit';

export type CalloutCategory =
  | 'hazard'
  | 'braking'
  | 'lockup'
  | 'traction'
  | 'tires'
  | 'tires_optimal'
  | 'tire_degradation'
  | 'track_limits'
  | 'pre_corner'
  | 'racecraft'
  | 'fuel'
  | 'brakes'
  | 'strategy'
  | 'engineer';

export type DriverSkillTier = 'newcomer' | 'developing' | 'competitive' | 'pro';

export type GreenLineMode = 'auto' | 'pro' | 'learned';
export type GreenLineSource = 'pro' | 'learned' | 'proven_best';
export type CornerArchetype = 'hairpin' | 'medium' | 'sweeper' | 'chicane';

export interface LearnedCornerStats {
  cornerId: string;
  trackId: string;
  attempts: number;
  avgBrakeDeltaM: number;
  avgApexSpeedDeltaKmh: number;
  avgExitSpeedDeltaKmh: number;
  avgTrailScore: number;
  lockupEvents: number;
  exitSnapEvents: number;
  mastery: number; // 0.0 to 1.0
  bestTimeSec?: number;
  bestPassFrames?: CompactTelemetryPoint[];
  updatedAtIso: string;
}

export interface DriverHabitMetrics {
  lapsAnalyzed: number;
  lateBrakeCount: number;
  lockupCount: number;
  exitSnapCount: number;
  offTrackCount: number;
  avgTrailBrakeScore: number;
  avgDeltaSec: number;
  brakingConsistencyPct: number;
}

export interface DriverProfile {
  driverName: string;
  skillTier: DriverSkillTier;
  isNewToGame: boolean;
  primaryGoal: 'consistency' | 'pace' | 'endurance';
  habits: DriverHabitMetrics;
  learnedStrengths: string[];
  learnedWeaknesses: string[];
  cornerMemory?: Record<string, LearnedCornerStats>;
}

export interface ElectronicsSuggestion {
  id: string;
  title: string;
  parameter: 'tcLevel' | 'absLevel' | 'brakeBiasPct';
  currentValue: number;
  recommendedValue: number;
  unit: string;
  reason: string;
  urgency: 'immediate' | 'next_pit';
}

export type PitRaceMode =
  | 'auto'
  | 'short_online'
  | 'standard_online'
  | 'endurance'
  | 'practice_quali';

export type PitTireOverride =
  | 'auto'
  | 'keep'
  | 'fronts_medium'
  | 'all_soft'
  | 'all_medium'
  | 'all_hard'
  | 'all_wet';

export interface PitStrategyPlan {
  raceLengthLaps: number;
  currentLap: number;
  fuelRemainingLiters: number;
  fuelBurnPerLapLiters: number;
  lapsOfFuelLeft: number;
  lapsOfVeLeft?: number;
  stintLimitingFactor?: 'fuel' | 'virtual_energy' | 'tires' | 'damage' | 'none';
  recommendedPitLap: number;
  fuelToAddLiters: number;
  tireAction: 'change_all' | 'fuel_only' | 'change_fronts';
  tireCompound: 'Soft' | 'Medium' | 'Hard' | 'Wet';
  tireAutoSelected: boolean;
  resolvedRaceMode: Exclude<PitRaceMode, 'auto'>;
  raceModeLabel: string;
  detectedSessionType: SimSessionType;
  sessionPhaseDetectedLabel: string;
  crashAlertActive: boolean;
  crashReason: string | null;
  repairsRecommended: boolean;
  pitCallUrgency: 'none' | 'planned' | 'box_now_damage';
  controlModeNote: string;
  pitTireCallHeadline: string;
  tireSelectionReason: string;
  mfdChecklist: string[];
  pitStopDurationEstSec: number;
  setupAdjustmentsAtPit: string[];
  engineerSummary: string;
}

export interface TireCorners {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

export interface TelemetryFrame {
  timestampMs: number;
  lapNumber: number;
  lapDistPct: number; // 0.0 to 1.0
  speedKmh: number;
  rpm: number;
  maxRpm: number;
  gear: number; // 0 = N, 1..7
  throttle: number; // 0.0 to 1.0
  brake: number; // 0.0 to 1.0
  clutch?: number; // 0.0 to 1.0
  steeringRad: number; // -0.6 to +0.6
  latG: number;
  longG: number;
  deltaSec: number; // negative = faster than reference
  fuelLiters: number;
  tireTempC: TireCorners;
  tirePressurePsi: TireCorners;
  tireWearPct: TireCorners;
  brakeTempC: TireCorners;
  frontWheelSlip: number; // 0.0 to 1.0 (lockup if high under braking)
  rearWheelSlip: number; // 0.0 to 1.0 (oversteer/wheelspin if high under throttle)
  absActive: boolean;
  tcActive: boolean;
  offTrackRisk: number; // 0.0 to 1.0
  hazardAhead: boolean;
  hazardDistanceM: number;
  hazardDescription: string;
  flagState: 'green' | 'yellow' | 'blue';
  opponents?: OpponentCar[];
  // Optional auto-detection & live capability metadata from sim collector
  simId?: string;
  trackName?: string;
  trackLengthKm?: number;
  carName?: string;
  carClass?: string;
  telemetrySource?: 'lmu-rest' | 'shared-memory' | 'udp-5606' | 'demo';
  sessionType?: SimSessionType;
  rawSessionName?: string;
  inPitOrGarage?: boolean;
  isPaused?: boolean;
  virtualEnergyPct?: number; // 0..100 LMU Hypercar Virtual Energy tank remaining
  inFormationLap?: boolean;
  penaltyActive?: boolean;
  lapInvalidated?: boolean;
  flatTire?: boolean;
  wheelDetached?: boolean;
  posX?: number;
  posZ?: number;
  playerPosition?: number;
  fieldSize?: number;
  sensorCaps?: {
    pedals: boolean;
    tires: boolean;
    brakes: boolean;
    rpmGear: boolean;
  };
}

export interface SimConnectionStatus {
  gameRunning: boolean;
  simId: SimGameId | null;
  gameName: string | null;
  connectionState: 'offline' | 'menus' | 'in_pit' | 'on_track';
  sessionType?: SimSessionType;
  rawSessionName?: string | null;
  source: 'none' | 'lmu-rest' | 'shared-memory' | 'udp-5606';
  telemetryQuality: 'none' | 'partial_rest' | 'full';
  lastPacketAtMs: number | null;
  rawTrackName: string | null;
  rawCarName: string | null;
  note?: string;
}

export type PitWallMapSize = 'compact' | 'standard' | 'large' | 'full';
export type PitWallMapViewMode = 'circuit' | 'follow';

export interface OpponentCar {
  id: string;
  carNumber: string;
  driverName: string;
  carClass: 'Hypercar' | 'LMP2' | 'LMGT3';
  carName: string;
  lapDistPct: number;
  speedKmh: number;
  gapSeconds: number; // + = ahead of you, - = behind you
  distanceMeters: number; // + = ahead, - = behind
  closingSpeedKmh: number; // + = gap closing rapidly
  lateralSide: 'left' | 'right' | 'center';
  isAlongside: boolean;
  safetyRating: 'clean' | 'aggressive' | 'erratic';
  position?: number;
  lapsCompleted?: number;
  inPits?: boolean;
  sector?: 1 | 2 | 3;
  posX?: number;
  posZ?: number;
}

export type RacecraftPosture =
  | 'clear'
  | 'defend_inside'
  | 'hold_line_car_alongside'
  | 'three_wide'
  | 'attack_opportunity'
  | 'blue_flag_yield';

export interface RacecraftAdvice {
  posture: RacecraftPosture;
  safeToAttack: boolean;
  safeToDefend: boolean;
  headline: string;
  detail: string;
  targetOpponent: OpponentCar | null;
}

export interface HardwareInputMapping {
  steeringAxis: number;
  throttleAxis: number | null; // null when using standard gamepad trigger button
  brakeAxis: number | null; // null when using standard gamepad trigger button
  clutchAxis: number | null;
  throttleButton: number | null; // e.g. 7 (RT) for standard gamepads
  brakeButton: number | null; // e.g. 6 (LT) for standard gamepads
  clutchButton: number | null;
  invertThrottle: boolean;
  invertBrake: boolean;
  invertClutch: boolean;
  invertSteering: boolean;
  throttleRestValue: number; // 0 for standard, +1 or -1 for raw pedals
  brakeRestValue: number;
  clutchRestValue: number;
  gearUpButton: number | null;
  gearDownButton: number | null;
  pttButton: number | null;
  steeringMaxDeg: number; // e.g. 270..540 visual rotation
}

export interface HardwareInputState {
  connected: boolean;
  deviceId: string | null;
  deviceName: string | null;
  isStandardMapping: boolean;
  sourceKind: 'none' | 'gamepad' | 'keyboard';
  steeringNormalized: number; // -1.0 to +1.0
  steeringDeg: number;
  throttle: number; // 0.0 to 1.0
  brake: number; // 0.0 to 1.0
  clutch: number; // 0.0 to 1.0
  gearUpPressed: boolean;
  gearDownPressed: boolean;
  pttPressed: boolean;
  axes: number[];
  pressedButtons: number[];
}

export interface CornerDefinition {
  id: string;
  number: number;
  name: string;
  sector: 1 | 2 | 3;
  startPct: number;
  brakeMarkerPct: number;
  apexPct: number;
  exitPct: number;
  targetBrakePressure: number; // 0..1
  targetEntrySpeedKmh: number;
  targetApexSpeedKmh: number;
  targetGear: number;
  coachingCue: string;
  mapPoint: { x: number; y: number };
}

export interface TrackProfile {
  id: string;
  name: string;
  country: string;
  lengthKm: number;
  referenceLapTimeSec: number;
  svgViewBox: string;
  svgPath: string;
  pathPoints: Array<{ pct: number; x: number; y: number }>;
  corners: CornerDefinition[];
}

export interface CarSetup {
  brakeBiasPct: number; // 48.0 - 65.0
  brakeMigrationPct: number; // -5.0 to +5.0
  frontWingDeg: number;
  rearWingDeg: number;
  frontArbClicks: number; // 1..10
  rearArbClicks: number; // 1..10
  frontRideHeightMm: number;
  rearRideHeightMm: number;
  frontSpringRateNmm: number;
  rearSpringRateNmm: number;
  diffPreloadNm: number;
  diffPowerPct: number;
  diffCoastPct: number;
  tcLevel: number; // 1..10
  absLevel: number; // 1..10
  coldPsi: TireCorners;
  camberDeg: TireCorners;
}

export interface CarProfile {
  id: string;
  name: string;
  carClass: 'Hypercar' | 'LMP2' | 'LMGT3';
  simSupported: SimGameId[];
  maxRpm: number;
  shiftRpm: number;
  topSpeedKmh: number;
  optimalTireTempRange: [number, number];
  defaultSetup: CarSetup;
}

export interface ReferenceSample {
  pct: number;
  speedKmh: number;
  throttle: number;
  brake: number;
  steeringRad: number;
  gear: number;
  rpm: number;
}

export interface LapRecord {
  lapNumber: number;
  lapTimeSec: number;
  sector1Sec: number;
  sector2Sec: number;
  sector3Sec: number;
  valid: boolean;
  maxSpeedKmh: number;
  avgTrailBrakeScore: number;
  frames: TelemetryFrame[];
}

export interface CornerComparison {
  cornerId: string;
  cornerNumber: number;
  cornerName: string;
  sector: 1 | 2 | 3;
  brakingDeltaMeters: number; // + = braked too late, - = braked early
  entrySpeedDeltaKmh: number;
  minApexSpeedDeltaKmh: number;
  exitSpeedDeltaKmh: number;
  trailBrakingScore: number; // 0..100
  timeLostSec: number;
  primaryIssue: string;
}

export interface PriorityCornerDrill {
  cornerId: string;
  cornerNumber: number;
  cornerName: string;
  phase: 'braking' | 'apex' | 'exit';
  timeLostSec: number;
  actionDrill: string;
}

export interface DriverSkillMetrics {
  trailBrakingScore: number; // 0..100
  pedalOverlapPct: number; // % of frames with simultaneous throttle > 12% and brake > 12%
  inputSmoothnessScore: number; // 0..100
  potentialGainSec: number;
  topLossDrills: PriorityCornerDrill[];
}

export interface CoachCallout {
  id: string;
  timestampMs: number;
  lapNumber: number;
  cornerName: string;
  severity: CalloutSeverity;
  category: CalloutCategory;
  message: string;
  spoken: boolean;
  source: 'realtime-engine' | 'gemini-engineer' | 'driver-radio';
  quickReplies?: string[];
}

export type HandlingSymptom =
  | 'late_brake_lockup'
  | 'entry_understeer'
  | 'mid_corner_understeer'
  | 'exit_snap_oversteer'
  | 'high_speed_instability'
  | 'kerb_bouncing'
  | 'tire_overheating';

export interface SetupAdjustment {
  parameterKey: keyof CarSetup | 'coldPsi' | 'camberDeg';
  parameterLabel: string;
  currentValue: string;
  recommendedValue: string;
  deltaLabel: string;
  reason: string;
  numericTarget?: number;
}

export interface SetupDiagnosis {
  symptom: HandlingSymptom;
  summary: string;
  estimatedGainSec: number;
  adjustments: SetupAdjustment[];
  drivingTip: string;
}

export type TrackCondition = 'cool' | 'optimal' | 'hot' | 'damp';
export type StintObjective = 'quali_sprint' | 'balanced_race' | 'endurance_stability';
export type BrakingFeel = 'smooth_early' | 'balanced' | 'aggressive_late';

export interface DriverSetupIntake {
  primarySymptom: HandlingSymptom | 'auto';
  freeTextFeedback: string;
  cornerFocusId: string | 'auto';
  trackCondition: TrackCondition;
  stintObjective: StintObjective;
  brakingFeel: BrakingFeel;
  useTelemetrySignals: boolean;
}

export interface SmartSetupSignal {
  source: 'feedback' | 'telemetry' | 'profile' | 'conditions';
  label: string;
  detail: string;
}

export interface SmartSetupPlan {
  primarySymptom: HandlingSymptom;
  detectedSymptoms: HandlingSymptom[];
  resolvedCornerLabel: string | null;
  confidenceLabel: string;
  signals: SmartSetupSignal[];
  summary: string;
  estimatedGainSec: number;
  adjustments: SetupAdjustment[];
  drivingTip: string;
}

export interface AiSetupAdviceStructured {
  headline: string;
  explanation: string;
  drivingAdaptation: string;
  recommendedAdjustments: SetupAdjustment[];
}

export interface LmuProPreset {
  id: 'endurance_safe' | 'quali_attack' | 'trail_rotation' | 'kerb_highspeed';
  name: string;
  tag: string;
  trackCategory: string;
  summary: string;
  targetDriverStyle: string;
  setup: CarSetup;
}

export interface LmuPresetRecommendation {
  preset: LmuProPreset;
  matchScore: number; // 0..99
  isTopPick: boolean;
  reasons: string[];
  estimatedGainSec: number;
}

export type EngineerAutonomyMode = 'advise' | 'hands_on';

export interface AutonomyActionLog {
  id: string;
  timestampMs: number;
  parameter: 'tcLevel' | 'absLevel' | 'brakeBiasPct';
  title: string;
  previousValue: number;
  appliedValue: number;
  unit: string;
  reason: string;
  reverted?: boolean;
}

export type RadioProtocol = 'pro_terse' | 'endurance_calm' | 'coaching_detail';

export interface CoachSettings {
  voiceEnabled: boolean;
  useGeminiTts: boolean;
  geminiVoiceName: 'Fenrir' | 'Charon' | 'Kore' | 'Puck' | 'Zephyr';
  language: 'en';
  focusMode: CoachFocusMode;
  radioProtocol?: RadioProtocol;
  preCornerCuesEnabled: boolean;
  racecraftAlertsEnabled: boolean;
  multiclassTrafficEnabled?: boolean;
  tireAlertsEnabled?: boolean;
  tirePressureAlertsEnabled?: boolean;
  brakeTempAlertsEnabled?: boolean;
  fuelAlertsEnabled?: boolean;
  pitWindowCountdownEnabled?: boolean;
  autoSelectPitTires?: boolean;
  preselectPitTiresInLmu?: boolean;
  pitRaceMode?: PitRaceMode;
  pitTireOverride?: PitTireOverride;
  fuelSaveCallsEnabled?: boolean;
  fuelTargetLitersPerLap?: number; // 0 = auto from car/track, >0 = explicit L/lap target
  gapSplitsEnabled?: boolean;
  sectorSplitsEnabled?: boolean;
  electronicsCheckEnabled?: boolean;
  trackLimitsAlertsEnabled?: boolean;
  tractionAlertsEnabled?: boolean;
  lapPaceAlertsEnabled?: boolean;
  urgentInterruptsRadio?: boolean;
  autonomyMode: EngineerAutonomyMode;
  radioSquelchFx: boolean;
  verbosity: 'minimal' | 'balanced' | 'detailed';
  minSpeakIntervalSec?: number; // 2 to 30 seconds minimum gap between non-urgent callouts
  lateBrakeThresholdMeters: number;
  hazardAlertsEnabled: boolean;
  speechRate: number; // 0.80 to 1.30
  voiceVolume?: number; // 0.20 to 1.00
}

export interface RaceMistakeFix {
  id: string;
  category: 'braking' | 'lockup' | 'traction' | 'track_limits' | 'overlap' | 'apex_speed';
  severity: 'high' | 'medium' | 'low';
  cornerId?: string;
  cornerLabel: string;
  mistakeTitle: string;
  watchOutDetail: string;
  howToFix: string;
  setupTweak?: string;
  occurrences: number;
  timeGainPerLapSec: number;
}

export interface RaceLapSummary {
  lapNumber: number;
  lapTimeSec: number;
  deltaToRefSec: number;
  valid: boolean;
  trailBrakeScore: number;
}

export interface AiPostRaceBrief {
  headline: string;
  executiveSummary: string;
  watchOutFor: Array<{ title: string; detail: string }>;
  actionPlan: Array<{ step: string; howToFix: string; expectedGainSec: number }>;
  positionGainVerdict: string;
  spokenSummary: string;
}

export interface CompactTelemetryPoint {
  lapDistPct: number;
  speedKmh: number;
  throttle: number;
  brake: number;
  steeringRad: number;
  frontWheelSlip: number;
  rearWheelSlip: number;
  posX?: number;
  posZ?: number;
}

export interface RaceReport {
  id: string;
  createdAtIso: string;
  simId: SimGameId;
  simName: string;
  trackId: string;
  trackName: string;
  trackLengthKm: number;
  carId: string;
  carName: string;
  carClass: 'Hypercar' | 'LMP2' | 'LMGT3';
  sessionMode: 'live_race' | 'practice_stint';
  sessionType?: SimSessionType;
  lapsCompleted: number;
  raceDistanceLaps: number;
  bestLapSec: number;
  avgLapSec: number;
  referenceLapSec: number;
  consistencyPct: number;
  trailBrakingScore: number;
  pedalOverlapPct: number;
  inputSmoothnessScore: number;
  finishPosition: number;
  positionKnown?: boolean;
  projectedPosition: number;
  positionsGained: number;
  fieldSize: number;
  fixableGainPerLapSec: number;
  totalRaceTimeSavedSec: number;
  mistakeCounts: {
    lateBrakes: number;
    lockups: number;
    exitSnaps: number;
    offTracks: number;
  };
  mistakeFixes: RaceMistakeFix[];
  lapSummaries: RaceLapSummary[];
  cornerComparisons: CornerComparison[];
  representativeFrames?: CompactTelemetryPoint[];
  compareFrames?: CompactTelemetryPoint[];
  bestCornerPasses?: Array<{
    cornerId: string;
    timeSec: number;
    frames: CompactTelemetryPoint[];
  }>;
  provenBestLapSec?: number;
  provenGainSec?: number;
  aiBrief?: AiPostRaceBrief | null;
}

export interface PitMfdSyncRequest {
  requestId: string;
  createdAtMs: number;
  tireAction: 'fuel_only' | 'change_fronts' | 'change_all';
  tireCompound: 'Soft' | 'Medium' | 'Hard' | 'Wet';
  repairsRecommended: boolean;
  fuelToAddLiters?: number;
  pitTireCallHeadline: string;
}

export interface PitMfdSyncStatus {
  state: 'idle' | 'pending_bridge' | 'applied' | 'sim_offline' | 'error';
  lastAttemptAtMs: number | null;
  lastAppliedAtMs: number | null;
  appliedHeadline: string | null;
  via: 'local-lmu-rest' | 'remote-bridge' | 'none';
  message: string;
}



