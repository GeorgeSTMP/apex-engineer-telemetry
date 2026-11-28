import { useState, useMemo } from 'react';
import { Download, RotateCcw, Wrench, Check, Minus, Plus } from 'lucide-react';
import { extractAndPublishAiStatus } from '../utils/aiStatus';
import type {
  AiSetupAdviceStructured,
  BrakingFeel,
  CarProfile,
  CarSetup,
  CoachSettings,
  CornerComparison,
  DriverProfile,
  DriverSetupIntake,
  HandlingSymptom,
  LmuPresetRecommendation,
  PitMfdSyncStatus,
  PitStrategyPlan,
  SimGameId,
  StintObjective,
  TelemetryFrame,
  TrackCondition,
  TrackProfile,
} from '../types/telemetry';
import {
  HANDLING_SYMPTOMS,
  applyRecommendationsToSetup,
  buildSmartSetupPlan,
  exportSetupToLmuText,
  sanitizeAiSetupAdjustments,
} from '../engine/setupPhysics';
import { recommendLmuPresets } from '../engine/lmuProPresets';

interface SetupGarageViewProps {
  simId: SimGameId;
  simName: string;
  track: TrackProfile;
  car: CarProfile;
  setup: CarSetup;
  driverProfile: DriverProfile;
  setupIntake: DriverSetupIntake;
  settings?: CoachSettings;
  pitStrategy: PitStrategyPlan;
  cornerComparisons: CornerComparison[];
  latestFrame: TelemetryFrame;
  language?: 'en';
  onSwitchToLmu: () => void;
  onUpdateSetup: (nextSetup: CarSetup) => void;
  onResetSetup: () => void;
  onUpdateSetupIntake: (patch: Partial<DriverSetupIntake>) => void;
  onUpdateSettings?: (patch: Partial<CoachSettings>) => void;
  onDismissCrashAlert?: () => void;
  pitMfdSyncStatus?: PitMfdSyncStatus;
  onSyncPitMenuToLmu?: () => void;
  onOpenPitWall?: () => void;
}

const TRACK_CONDITIONS: Array<{ id: TrackCondition; label: string }> = [
  { id: 'cool', label: 'Cool (<22°C)' },
  { id: 'optimal', label: 'Optimal' },
  { id: 'hot', label: 'Hot (>32°C)' },
  { id: 'damp', label: 'Damp' },
];

const STINT_OBJECTIVES: Array<{ id: StintObjective; label: string }> = [
  { id: 'quali_sprint', label: 'Quali Attack' },
  { id: 'balanced_race', label: 'Balanced Race' },
  { id: 'endurance_stability', label: 'Endurance Safe' },
];

const BRAKING_FEELS: Array<{ id: BrakingFeel; label: string }> = [
  { id: 'smooth_early', label: 'Smooth / Early' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'aggressive_late', label: 'Late / Hard' },
];

const QUICK_FEEDBACK_PHRASES: Array<{ label: string; phrase: string }> = [
  { label: 'Fronts lock braking', phrase: 'fronts lock under braking' },
  { label: 'Rear snaps on exit', phrase: 'rear snaps exiting corners on throttle' },
  { label: 'Pushes wide mid-corner', phrase: 'understeer washing wide mid-corner' },
  { label: 'Bouncing over kerbs', phrase: 'car bounces over chicane kerbs' },
  { label: 'Slow on straights', phrase: 'too much drag slow on straights' },
];

export function SetupGarageView({
  simId,
  simName,
  track,
  car,
  setup,
  driverProfile,
  setupIntake,
  settings,
  pitStrategy,
  cornerComparisons,
  latestFrame,
  onSwitchToLmu,
  onUpdateSetup,
  onResetSetup,
  onUpdateSetupIntake,
  onDismissCrashAlert,
  pitMfdSyncStatus,
  onSyncPitMenuToLmu,
  onOpenPitWall,
}: SetupGarageViewProps) {
  const [aiAdvice, setAiAdvice] = useState<string | null>(null);
  const [aiStructured, setAiStructured] = useState<AiSetupAdviceStructured | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isLoadingAi, setIsLoadingAi] = useState(false);
  const [appliedBanner, setAppliedBanner] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [aiPresetRec, setAiPresetRec] = useState<{
    recommendedPresetId: string;
    headline: string;
    reasoning: string;
    trackNotes: string;
  } | null>(null);
  const [isLoadingPresetAi, setIsLoadingPresetAi] = useState(false);
  const [presetAiError, setPresetAiError] = useState<string | null>(null);

  const lmuRecommendations: LmuPresetRecommendation[] = useMemo(
    () => recommendLmuPresets(car, track, driverProfile, cornerComparisons, latestFrame),
    [car, track, driverProfile, cornerComparisons, latestFrame]
  );

  const smartPlan = useMemo(
    () =>
      buildSmartSetupPlan({
        setup,
        intake: setupIntake,
        car,
        track,
        driverProfile,
        cornerComparisons,
        latestFrame,
      }),
    [setup, setupIntake, car, track, driverProfile, cornerComparisons, latestFrame]
  );

  const sanitizedAiAdjustments = useMemo(
    () =>
      aiStructured
        ? sanitizeAiSetupAdjustments(aiStructured.recommendedAdjustments, setup, car)
        : [],
    [aiStructured, setup, car]
  );

  const baseline = car.defaultSetup;
  const modifiedCount = useMemo(() => {
    const keys: Array<keyof Omit<CarSetup, 'coldPsi'>> = [
      'brakeBiasPct',
      'brakeMigrationPct',
      'tcLevel',
      'absLevel',
      'frontWingDeg',
      'rearWingDeg',
      'frontRideHeightMm',
      'rearRideHeightMm',
      'frontArbClicks',
      'rearArbClicks',
      'frontSpringRateNmm',
      'rearSpringRateNmm',
      'diffPowerPct',
      'diffCoastPct',
      'diffPreloadNm',
    ];
    return keys.filter((k) => Math.abs((setup[k] as number) - (baseline[k] as number)) > 0.001).length;
  }, [setup, baseline]);

  const handleApplyRecommendations = () => {
    const updated = applyRecommendationsToSetup(setup, smartPlan.adjustments);
    onUpdateSetup(updated);
    setAppliedBanner(
      `Applied ${smartPlan.adjustments.length} setup adjustments for ${car.name}.`
    );
    setTimeout(() => setAppliedBanner(null), 4000);
  };

  const handleApplyAiClicks = () => {
    if (sanitizedAiAdjustments.length === 0) return;
    const updated = applyRecommendationsToSetup(setup, sanitizedAiAdjustments);
    onUpdateSetup(updated);
    setAppliedBanner(
      `Applied ${sanitizedAiAdjustments.length} AI chassis clicks for ${car.name}.`
    );
    setTimeout(() => setAppliedBanner(null), 4000);
  };

  const handleAppendQuickPhrase = (phrase: string) => {
    const current = setupIntake.freeTextFeedback.trim();
    if (current.toLowerCase().includes(phrase.toLowerCase())) return;
    const next = current ? `${current}; ${phrase}` : phrase;
    onUpdateSetupIntake({ freeTextFeedback: next });
  };

  const handleAskAiChassisEngineer = async () => {
    setIsLoadingAi(true);
    setAiError(null);
    try {
      const symptomObj = HANDLING_SYMPTOMS.find((s) => s.id === smartPlan.primarySymptom);
      const topCorners = [...cornerComparisons]
        .sort((a, b) => b.timeLostSec - a.timeLostSec)
        .slice(0, 5)
        .map((c) => ({
          corner: `T${c.cornerNumber} ${c.cornerName}`,
          timeLostSec: c.timeLostSec,
          brakingDeltaM: c.brakingDeltaMeters,
          apexDeltaKmh: c.minApexSpeedDeltaKmh,
          exitDeltaKmh: c.exitSpeedDeltaKmh,
          trailScore: c.trailBrakingScore,
        }));

      const resp = await fetch('/api/coach/setup-advise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          simName,
          trackName: track.name,
          carName: car.name,
          carClass: car.carClass,
          symptomLabel: symptomObj?.label ?? smartPlan.primarySymptom,
          driverNotes:
            setupIntake.freeTextFeedback.trim() ||
            `Primary focus: ${symptomObj?.label ?? smartPlan.primarySymptom}. Corner focus: ${smartPlan.resolvedCornerLabel ?? 'Full lap'}.`,
          intakeContext: {
            primarySymptom: setupIntake.primarySymptom,
            detectedSymptoms: smartPlan.detectedSymptoms,
            resolvedCorner: smartPlan.resolvedCornerLabel,
            trackCondition: setupIntake.trackCondition,
            stintObjective: setupIntake.stintObjective,
            brakingFeel: setupIntake.brakingFeel,
            useTelemetrySignals: setupIntake.useTelemetrySignals,
          },
          driverProfile: {
            skillTier: driverProfile.skillTier,
            isNewToGame: driverProfile.isNewToGame,
            primaryGoal: driverProfile.primaryGoal,
            habits: driverProfile.habits,
            learnedWeaknesses: driverProfile.learnedWeaknesses,
          },
          cornerSummary: topCorners,
          liveTelemetry: setupIntake.useTelemetrySignals
            ? {
                speedKmh: Math.round(latestFrame.speedKmh),
                fuelLiters: Math.round(latestFrame.fuelLiters * 10) / 10,
                virtualEnergyPct: latestFrame.virtualEnergyPct ?? null,
                tireTempC: latestFrame.tireTempC,
                tireWearPct: latestFrame.tireWearPct,
                frontWheelSlip: latestFrame.frontWheelSlip,
                rearWheelSlip: latestFrame.rearWheelSlip,
              }
            : null,
          currentSetup: setup,
        }),
      });
      const data = await resp.json();
      extractAndPublishAiStatus(resp.status, data);
      if (!resp.ok) {
        setAiError(data.error || 'Could not reach AI setup engineer.');
      } else {
        setAiAdvice(data.advice ?? null);
        setAiStructured(data.structured ?? null);
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Network error requesting setup advice.');
    } finally {
      setIsLoadingAi(false);
    }
  };

  const handleApplyLmuPreset = (rec: LmuPresetRecommendation) => {
    onUpdateSetup(rec.preset.setup);
    setActivePresetId(rec.preset.id);
    setAppliedBanner(`Loaded ${rec.preset.name} for ${car.name} @ ${track.name}.`);
    setTimeout(() => setAppliedBanner(null), 4000);
  };

  const handleAskAiPresetMatch = async () => {
    setIsLoadingPresetAi(true);
    setPresetAiError(null);
    try {
      const resp = await fetch('/api/coach/recommend-preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackName: track.name,
          carName: car.name,
          language: 'en',
          driverProfile,
          cornerSummary: cornerComparisons.map((c) => ({
            corner: `T${c.cornerNumber} ${c.cornerName}`,
            brakingDeltaM: c.brakingDeltaMeters,
            apexDeltaKmh: c.minApexSpeedDeltaKmh,
            exitDeltaKmh: c.exitSpeedDeltaKmh,
            trailScore: c.trailBrakingScore,
          })),
          presets: lmuRecommendations.map((r) => ({
            id: r.preset.id,
            name: r.preset.name,
            tag: r.preset.tag,
            targetDriverStyle: r.preset.targetDriverStyle,
            matchScore: r.matchScore,
          })),
        }),
      });
      const data = await resp.json();
      extractAndPublishAiStatus(resp.status, data);
      if (!resp.ok) {
        setPresetAiError(data.error || 'Could not reach AI preset engineer.');
      } else {
        setAiPresetRec(data);
      }
    } catch (err) {
      setPresetAiError(err instanceof Error ? err.message : 'Network error requesting LMU preset AI.');
    } finally {
      setIsLoadingPresetAi(false);
    }
  };

  const handleExportSetup = () => {
    const content = exportSetupToLmuText(setup, car, track);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${car.id}_${track.id}_apex.svm`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const adjustNumber = (key: keyof CarSetup, delta: number, min: number, max: number, precision = 1) => {
    const current = setup[key] as number;
    const next = Math.max(min, Math.min(max, Math.round((current + delta) * Math.pow(10, precision)) / Math.pow(10, precision)));
    onUpdateSetup({ ...setup, [key]: next });
  };

  const resolvedCornerSelectValue =
    setupIntake.cornerFocusId !== 'auto' &&
    track.corners.some((c) => c.id === setupIntake.cornerFocusId)
      ? setupIntake.cornerFocusId
      : 'auto';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left 5 Columns: Smart Driver Intake, Synthesized Diagnosis, Pit Strategy */}
      <div className="flex flex-col gap-5 lg:col-span-5">
        <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-xl font-bold text-slate-100">
                Smart Setup Engineer
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                Describe how {car.name} feels on {track.name} — combined with live telemetry, corner deltas, and conditions.
              </p>
            </div>
          </div>

          {/* Primary Symptom + Target Corner */}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="symptom-select" className="block text-xs font-medium text-slate-300">
                Primary Symptom
              </label>
              <select
                id="symptom-select"
                value={setupIntake.primarySymptom}
                onChange={(e) =>
                  onUpdateSetupIntake({
                    primarySymptom: e.target.value as HandlingSymptom | 'auto',
                  })
                }
                className="mt-1.5 h-9 w-full rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              >
                <option value="auto">Auto (From Notes &amp; Telemetry)</option>
                {HANDLING_SYMPTOMS.map((sym) => (
                  <option key={sym.id} value={sym.id}>
                    {sym.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="corner-focus-select" className="block text-xs font-medium text-slate-300">
                Target Corner
              </label>
              <select
                id="corner-focus-select"
                value={resolvedCornerSelectValue}
                onChange={(e) => onUpdateSetupIntake({ cornerFocusId: e.target.value })}
                className="mt-1.5 h-9 w-full rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              >
                <option value="auto">Auto (Notes / Worst Time Loss)</option>
                {track.corners.map((corner) => (
                  <option key={corner.id} value={corner.id}>
                    T{corner.number} · {corner.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Track Condition / Stint Goal / Braking Feel */}
          <div className="mt-3.5 space-y-2.5">
            <div>
              <div className="text-[11px] font-medium text-slate-400">Track Condition</div>
              <div className="mt-1 grid grid-cols-4 gap-1.5" role="group" aria-label="Track condition">
                {TRACK_CONDITIONS.map((cond) => {
                  const active = setupIntake.trackCondition === cond.id;
                  return (
                    <button
                      key={cond.id}
                      type="button"
                      onClick={() => onUpdateSetupIntake({ trackCondition: cond.id })}
                      data-testid={`track-cond-${cond.id}`}
                      className={`h-8 rounded border px-1.5 text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {cond.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-medium text-slate-400">Stint Goal</div>
              <div className="mt-1 grid grid-cols-3 gap-1.5" role="group" aria-label="Stint goal">
                {STINT_OBJECTIVES.map((obj) => {
                  const active = setupIntake.stintObjective === obj.id;
                  return (
                    <button
                      key={obj.id}
                      type="button"
                      onClick={() => onUpdateSetupIntake({ stintObjective: obj.id })}
                      data-testid={`stint-goal-${obj.id}`}
                      className={`h-8 rounded border px-2 text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {obj.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-medium text-slate-400">Braking Feel</div>
              <div className="mt-1 grid grid-cols-3 gap-1.5" role="group" aria-label="Braking feel">
                {BRAKING_FEELS.map((feel) => {
                  const active = setupIntake.brakingFeel === feel.id;
                  return (
                    <button
                      key={feel.id}
                      type="button"
                      onClick={() => onUpdateSetupIntake({ brakingFeel: feel.id })}
                      data-testid={`braking-feel-${feel.id}`}
                      className={`h-8 rounded border px-2 text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#273145] bg-[#090B10] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {feel.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Natural-Language Handling Feedback + Quick Symptoms */}
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="driver-setup-notes" className="block text-xs font-medium text-slate-300">
                Specific Handling &amp; Corner Feedback
              </label>
              {setupIntake.freeTextFeedback.trim() && (
                <button
                  type="button"
                  onClick={() => onUpdateSetupIntake({ freeTextFeedback: '' })}
                  className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer whitespace-nowrap"
                >
                  Clear notes
                </button>
              )}
            </div>

            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {QUICK_FEEDBACK_PHRASES.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => handleAppendQuickPhrase(item.phrase)}
                  className="rounded border border-[#273145] bg-[#090B10] px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
                >
                  + {item.label}
                </button>
              ))}
            </div>

            <textarea
              id="driver-setup-notes"
              rows={2}
              value={setupIntake.freeTextFeedback}
              onChange={(e) => onUpdateSetupIntake({ freeTextFeedback: e.target.value })}
              placeholder="e.g., Rear snaps exiting Porsche Curves and fronts lock under braking..."
              className="mt-2 w-full rounded-md border border-[#273145] bg-[#090B10] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
            />

            <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={setupIntake.useTelemetrySignals}
                onChange={(e) => onUpdateSetupIntake({ useTelemetrySignals: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-[#273145] bg-[#090B10] accent-cyan-400"
              />
              <span>Blend live telemetry, tire temps &amp; driver habit history</span>
            </label>
          </div>

          {/* Synthesized Setup Plan */}
          <div className="mt-4 rounded-md border border-[#1B2230] bg-[#090B10] p-4" data-testid="setup-diagnosis-card">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-cyan-400">Recommended Setup Changes</span>
              <span className="font-mono tabular-nums text-emerald-400">
                Est. -{smartPlan.estimatedGainSec.toFixed(2)}s / lap
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-400">
              <span>{smartPlan.confidenceLabel}</span>
              {smartPlan.resolvedCornerLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-cyan-300">{smartPlan.resolvedCornerLabel}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{car.carClass} Legal</span>
            </div>

            {/* Detected Multi-Signal Attribution (Zero-Pill Hairline List) */}
            {smartPlan.signals.length > 0 && (
              <div
                className="mt-2.5 divide-y divide-[#1B2230] rounded border border-[#1B2230] bg-[#0B0F17] px-2.5 py-1"
                data-testid="smart-setup-signals"
              >
                {smartPlan.signals.map((sig, idx) => (
                  <div key={`${sig.source}-${idx}`} className="flex items-baseline justify-between gap-3 py-1 text-[11px]">
                    <span className="font-medium text-slate-300 shrink-0">{sig.label}</span>
                    <span className="truncate text-right font-mono text-slate-400">{sig.detail}</span>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-2.5 text-xs leading-relaxed text-slate-300">{smartPlan.summary}</p>

            <div className="mt-3 divide-y divide-[#1B2230]">
              {smartPlan.adjustments.map((adj, idx) => (
                <div key={`${adj.parameterKey}-${idx}`} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-200">{adj.parameterLabel}</span>
                    <span className="font-mono tabular-nums text-cyan-300 whitespace-nowrap">
                      {adj.currentValue} → {adj.recommendedValue} ({adj.deltaLabel})
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{adj.reason}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 border-t border-[#1B2230] pt-3 text-xs text-amber-200">
              Driving Adaptation: {smartPlan.drivingTip}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleApplyRecommendations}
                disabled={smartPlan.adjustments.length === 0}
                data-testid="apply-recommended-clicks-btn"
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Apply Recommended Clicks</span>
              </button>
              <button
                type="button"
                onClick={handleAskAiChassisEngineer}
                disabled={isLoadingAi}
                data-testid="ai-chassis-deep-dive-btn"
                className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#10141D] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isLoadingAi ? 'Consulting...' : 'AI Chassis Deep-Dive'}</span>
              </button>
            </div>

            {appliedBanner && (
              <p className="mt-2.5 text-xs font-medium text-emerald-400" role="status">
                {appliedBanner}
              </p>
            )}
          </div>

          {(aiStructured || aiAdvice || aiError) && (
            <div
              className="mt-3 rounded-md border border-cyan-500/35 bg-[#090B10] p-3.5 text-xs leading-relaxed"
              data-testid="ai-chassis-result"
            >
              {aiError ? (
                <span className="text-rose-400">{aiError}</span>
              ) : aiStructured ? (
                <div className="space-y-2.5">
                  <div className="font-semibold text-cyan-300">{aiStructured.headline}</div>
                  <p className="text-slate-200">{aiStructured.explanation}</p>
                  {sanitizedAiAdjustments.length > 0 && (
                    <div className="divide-y divide-[#1B2230] border-t border-[#1B2230] pt-2">
                      {sanitizedAiAdjustments.map((adj) => (
                        <div key={String(adj.parameterKey)} className="py-1.5 first:pt-0 last:pb-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-200">{adj.parameterLabel}</span>
                            <span className="font-mono tabular-nums text-cyan-300 whitespace-nowrap">
                              {adj.currentValue} → {adj.recommendedValue} ({adj.deltaLabel})
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-400">{adj.reason}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="border-t border-[#1B2230] pt-2 text-amber-200">
                    Track Technique: {aiStructured.drivingAdaptation}
                  </div>
                  {sanitizedAiAdjustments.length > 0 && (
                    <button
                      type="button"
                      onClick={handleApplyAiClicks}
                      data-testid="apply-ai-clicks-btn"
                      className="inline-flex items-center gap-1.5 rounded bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Apply AI Clicks ({sanitizedAiAdjustments.length})</span>
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-slate-200">{aiAdvice}</p>
              )}
            </div>
          )}
        </section>

        {/* Concise Pit Plan Readout (configured on Pit Wall) */}
        <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5" data-testid="garage-pit-strategy-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100">
                Active Pit Plan Summary
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                {pitStrategy.sessionPhaseDetectedLabel} · {pitStrategy.raceModeLabel} · {car.name}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onSyncPitMenuToLmu && (
                <button
                  type="button"
                  data-testid="garage-sync-lmu-mfd-btn"
                  onClick={onSyncPitMenuToLmu}
                  className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 font-mono text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap"
                >
                  Sync MFD Now
                </button>
              )}
              {onOpenPitWall && (
                <button
                  type="button"
                  onClick={onOpenPitWall}
                  className="rounded border border-[#273145] bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
                >
                  Configure on Pit Wall →
                </button>
              )}
            </div>
          </div>

          {pitStrategy.crashAlertActive && (
            <div
              role="alert"
              className="mt-3 flex items-start justify-between gap-2 rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            >
              <div>
                <div className="font-mono text-[11px] font-semibold uppercase text-rose-300">
                  Crash / Damage Pit Call · Repairs ON
                </div>
                <p className="mt-0.5 text-[11px] text-rose-200/90">{pitStrategy.crashReason}</p>
              </div>
              {onDismissCrashAlert && (
                <button
                  type="button"
                  onClick={onDismissCrashAlert}
                  className="rounded border border-rose-400/50 bg-[#090B10] px-2 py-0.5 font-mono text-[10px] font-medium text-rose-200 hover:bg-rose-500/20 cursor-pointer whitespace-nowrap shrink-0"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {((settings?.preselectPitTiresInLmu ?? false) ||
            (pitMfdSyncStatus && pitMfdSyncStatus.state !== 'idle')) &&
            pitMfdSyncStatus && (
              <p
                data-testid="garage-lmu-mfd-sync-status"
                className={`mt-2 font-mono text-[11px] ${
                  pitMfdSyncStatus.state === 'applied'
                    ? 'text-emerald-400'
                    : pitMfdSyncStatus.state === 'error'
                      ? 'text-rose-400'
                      : 'text-amber-300'
                }`}
              >
                {pitMfdSyncStatus.state === 'idle' && (settings?.preselectPitTiresInLmu ?? false)
                  ? 'Armed — waiting for live LMU session (:6397) to preselect pit tires & repairs.'
                  : pitMfdSyncStatus.message}
              </p>
            )}

          <div className="mt-3 grid grid-cols-4 gap-2 rounded-md border border-[#1B2230] bg-[#090B10] p-3 font-mono tabular-nums">
            <div>
              <div className="text-[10px] uppercase text-slate-500">Pit Plan</div>
              <div
                className={`text-xs sm:text-sm font-semibold ${
                  pitStrategy.crashAlertActive
                    ? 'text-rose-400'
                    : pitStrategy.pitNeededThisRace
                      ? 'text-cyan-400'
                      : 'text-emerald-400'
                }`}
              >
                {pitStrategy.crashAlertActive
                  ? 'BOX NOW'
                  : pitStrategy.pitNeededThisRace
                    ? `Box L${pitStrategy.pitWindowStartLap}–${pitStrategy.pitWindowEndLap}`
                    : `No Stop (L${pitStrategy.raceLengthLaps})`}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">Refuel</div>
              <div className="text-xs sm:text-sm font-semibold text-slate-100">{pitStrategy.fuelToAddLiters.toFixed(0)} L</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">Now → Next Tires</div>
              <div className="text-xs sm:text-sm font-semibold text-cyan-300 truncate">
                {pitStrategy.currentCompound} → {pitStrategy.pitTireCallHeadline}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">Est. Stop</div>
              <div className="text-xs sm:text-sm font-semibold text-slate-100">
                {pitStrategy.pitNeededThisRace ? `${pitStrategy.pitStopDurationEstSec}s` : '0s'}
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-300">{pitStrategy.tireSelectionReason}</p>
        </section>
      </div>

      {/* Right 7 Columns: Live Setup Sheet */}
      <section className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5 lg:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1B2230] pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-display text-xl font-bold text-slate-100">
                {car.name} Setup Sheet
              </h2>
              {modifiedCount > 0 && (
                <span className="font-mono text-xs font-medium text-cyan-300" data-testid="setup-modified-count">
                  · {modifiedCount} modified from baseline
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {car.carClass} · {track.name}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onResetSetup}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-300 hover:text-slate-100 cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Reset Baseline</span>
            </button>
            <button
              type="button"
              onClick={handleExportSetup}
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Export LMU Setup (.svm)</span>
            </button>
          </div>
        </div>

        {/* Le Mans Ultimate Pro Setup Presets (Flat Hairline-Separated Block) */}
        <div
          className="mt-5 border-b border-[#1B2230] pb-5"
          data-testid="lmu-pro-presets"
        >
          {simId !== 'lmu' ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#1B2230] bg-[#090B10] p-4">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-200">
                  Le Mans Ultimate Pro Setup Presets
                </h3>
                <p className="mt-0.5 text-xs text-slate-400">
                  AI-tailored Pro Presets are curated for Le Mans Ultimate ({car.name}).
                </p>
              </div>
              <button
                type="button"
                onClick={onSwitchToLmu}
                className="rounded border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap"
              >
                Switch to Le Mans Ultimate
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
                <div>
                  <h3 className="font-display text-sm font-semibold text-slate-100">
                    LMU Pro Setup Presets · AI Driver &amp; Track Match
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Scored from your style ({driverProfile.isNewToGame ? 'Newcomer' : driverProfile.skillTier}, {driverProfile.habits.brakingConsistencyPct}% consistency) on {track.name}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAskAiPresetMatch}
                  disabled={isLoadingPresetAi}
                  data-testid="ai-preset-match-btn"
                  className="inline-flex items-center gap-1.5 rounded border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isLoadingPresetAi ? 'Analyzing...' : 'AI Deep-Match Preset'}</span>
                </button>
              </div>

              {(aiPresetRec || presetAiError) && (
                <div className="mb-3 rounded border border-cyan-500/30 bg-[#090B10] p-3 text-xs">
                  {presetAiError ? (
                    <span className="text-rose-400">{presetAiError}</span>
                  ) : (
                    aiPresetRec && (
                      <div className="space-y-1">
                        <div className="font-semibold text-cyan-300">{aiPresetRec.headline}</div>
                        <p className="text-slate-200">{aiPresetRec.reasoning}</p>
                        <p className="text-slate-400">{aiPresetRec.trackNotes}</p>
                      </div>
                    )
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {lmuRecommendations.map((rec) => {
                  const isLoaded = activePresetId === rec.preset.id;
                  const isAiPick = aiPresetRec?.recommendedPresetId === rec.preset.id || (!aiPresetRec && rec.isTopPick);
                  const s = rec.preset.setup;
                  return (
                    <div
                      key={rec.preset.id}
                      data-testid={`lmu-preset-${rec.preset.id}`}
                      className={`flex flex-col justify-between rounded-md border p-3.5 ${
                        isAiPick
                          ? 'border-cyan-500/60 bg-[#090B10]'
                          : 'border-[#1B2230] bg-[#090B10]'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-xs font-semibold text-slate-100">
                              {rec.preset.name}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                              {rec.preset.tag} · {rec.preset.trackCategory}
                            </div>
                          </div>
                          <span
                            className={`font-mono text-xs font-semibold tabular-nums whitespace-nowrap ${
                              isAiPick ? 'text-cyan-400' : 'text-slate-400'
                            }`}
                          >
                            {isAiPick ? `AI Pick · ${rec.matchScore}%` : `${rec.matchScore}% match`}
                          </span>
                        </div>

                        <p className="mt-2 text-[11px] leading-relaxed text-slate-300">
                          {rec.reasons[0]}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-slate-400">
                          <span>Wing {s.frontWingDeg.toFixed(1)}/{s.rearWingDeg.toFixed(1)}°</span>
                          <span>Bias {s.brakeBiasPct.toFixed(1)}%</span>
                          <span>TC {s.tcLevel}</span>
                          <span>ARB {s.frontArbClicks}/{s.rearArbClicks}</span>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#1B2230] pt-2.5">
                        <span className="font-mono text-[11px] text-emerald-400 tabular-nums">
                          Est. -{rec.estimatedGainSec.toFixed(2)}s / lap
                        </span>
                        <button
                          type="button"
                          onClick={() => handleApplyLmuPreset(rec)}
                          className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                            isLoaded
                              ? 'border border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                              : isAiPick
                                ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
                                : 'border border-[#273145] bg-[#10141D] text-slate-200 hover:border-cyan-500/50 hover:text-cyan-200'
                          }`}
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                          <span>{isLoaded ? 'Loaded' : 'Load LMU Preset'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* Brakes & Electronics */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <h3 className="font-display text-sm font-semibold text-slate-200">
              Brakes & Electronics
            </h3>
            <div className="mt-3 space-y-2.5">
              <SetupStepperRow
                label="Brake Bias (Front)"
                value={`${setup.brakeBiasPct.toFixed(1)}%`}
                baseValue={`${baseline.brakeBiasPct.toFixed(1)}%`}
                modified={Math.abs(setup.brakeBiasPct - baseline.brakeBiasPct) > 0.05}
                testId="setup-brake-bias"
                onDec={() => adjustNumber('brakeBiasPct', -0.2, 48, 64, 1)}
                onInc={() => adjustNumber('brakeBiasPct', 0.2, 48, 64, 1)}
              />
              <SetupStepperRow
                label="Brake Migration"
                value={car.carClass === 'LMGT3' ? 'N/A (LMGT3)' : `${setup.brakeMigrationPct.toFixed(1)}%`}
                baseValue={car.carClass === 'LMGT3' ? 'N/A' : `${baseline.brakeMigrationPct.toFixed(1)}%`}
                modified={car.carClass !== 'LMGT3' && Math.abs(setup.brakeMigrationPct - baseline.brakeMigrationPct) > 0.05}
                onDec={() => adjustNumber('brakeMigrationPct', -0.2, -5, 5, 1)}
                onInc={() => adjustNumber('brakeMigrationPct', 0.2, -5, 5, 1)}
                disabled={car.carClass === 'LMGT3'}
              />
              <SetupStepperRow
                label="Traction Control (TC)"
                value={`Map ${setup.tcLevel}`}
                baseValue={`Map ${baseline.tcLevel}`}
                modified={setup.tcLevel !== baseline.tcLevel}
                testId="setup-tc-level"
                onDec={() => adjustNumber('tcLevel', -1, 1, 10, 0)}
                onInc={() => adjustNumber('tcLevel', 1, 1, 10, 0)}
              />
              <SetupStepperRow
                label="ABS Intervention"
                value={car.carClass !== 'LMGT3' ? `No ABS (${car.carClass})` : `Map ${setup.absLevel}`}
                baseValue={car.carClass !== 'LMGT3' ? 'No ABS' : `Map ${baseline.absLevel}`}
                modified={car.carClass === 'LMGT3' && setup.absLevel !== baseline.absLevel}
                onDec={() => adjustNumber('absLevel', -1, 0, 10, 0)}
                onInc={() => adjustNumber('absLevel', 1, 0, 10, 0)}
                disabled={car.carClass !== 'LMGT3'}
              />
            </div>
          </div>

          {/* Aerodynamics & Ride Height */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <h3 className="font-display text-sm font-semibold text-slate-200">
              Aerodynamics & Ride Height
            </h3>
            <div className="mt-3 space-y-2.5">
              <SetupStepperRow
                label="Front Wing / Diveplane"
                value={`${setup.frontWingDeg.toFixed(1)}°`}
                baseValue={`${baseline.frontWingDeg.toFixed(1)}°`}
                modified={Math.abs(setup.frontWingDeg - baseline.frontWingDeg) > 0.05}
                onDec={() => adjustNumber('frontWingDeg', -0.5, 0, 10, 1)}
                onInc={() => adjustNumber('frontWingDeg', 0.5, 0, 10, 1)}
              />
              <SetupStepperRow
                label="Rear Wing Angle"
                value={`${setup.rearWingDeg.toFixed(1)}°`}
                baseValue={`${baseline.rearWingDeg.toFixed(1)}°`}
                modified={Math.abs(setup.rearWingDeg - baseline.rearWingDeg) > 0.05}
                onDec={() => adjustNumber('rearWingDeg', -0.5, 0, 14, 1)}
                onInc={() => adjustNumber('rearWingDeg', 0.5, 0, 14, 1)}
              />
              <SetupStepperRow
                label="Front Ride Height"
                value={`${setup.frontRideHeightMm} mm`}
                baseValue={`${baseline.frontRideHeightMm} mm`}
                modified={setup.frontRideHeightMm !== baseline.frontRideHeightMm}
                onDec={() => adjustNumber('frontRideHeightMm', -1, 35, 80, 0)}
                onInc={() => adjustNumber('frontRideHeightMm', 1, 35, 80, 0)}
              />
              <SetupStepperRow
                label="Rear Ride Height"
                value={`${setup.rearRideHeightMm} mm`}
                baseValue={`${baseline.rearRideHeightMm} mm`}
                modified={setup.rearRideHeightMm !== baseline.rearRideHeightMm}
                onDec={() => adjustNumber('rearRideHeightMm', -1, 40, 90, 0)}
                onInc={() => adjustNumber('rearRideHeightMm', 1, 40, 90, 0)}
              />
            </div>
          </div>

          {/* Suspension & ARBs */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <h3 className="font-display text-sm font-semibold text-slate-200">
              Suspension & Anti-Roll Bars
            </h3>
            <div className="mt-3 space-y-2.5">
              <SetupStepperRow
                label="Front Anti-Roll Bar"
                value={`${setup.frontArbClicks} clicks`}
                baseValue={`${baseline.frontArbClicks} clicks`}
                modified={setup.frontArbClicks !== baseline.frontArbClicks}
                onDec={() => adjustNumber('frontArbClicks', -1, 1, 10, 0)}
                onInc={() => adjustNumber('frontArbClicks', 1, 1, 10, 0)}
              />
              <SetupStepperRow
                label="Rear Anti-Roll Bar"
                value={`${setup.rearArbClicks} clicks`}
                baseValue={`${baseline.rearArbClicks} clicks`}
                modified={setup.rearArbClicks !== baseline.rearArbClicks}
                onDec={() => adjustNumber('rearArbClicks', -1, 1, 10, 0)}
                onInc={() => adjustNumber('rearArbClicks', 1, 1, 10, 0)}
              />
              <SetupStepperRow
                label="Front Spring Rate"
                value={`${setup.frontSpringRateNmm} N/mm`}
                baseValue={`${baseline.frontSpringRateNmm} N/mm`}
                modified={setup.frontSpringRateNmm !== baseline.frontSpringRateNmm}
                onDec={() => adjustNumber('frontSpringRateNmm', -5, 100, 260, 0)}
                onInc={() => adjustNumber('frontSpringRateNmm', 5, 100, 260, 0)}
              />
              <SetupStepperRow
                label="Rear Spring Rate"
                value={`${setup.rearSpringRateNmm} N/mm`}
                baseValue={`${baseline.rearSpringRateNmm} N/mm`}
                modified={setup.rearSpringRateNmm !== baseline.rearSpringRateNmm}
                onDec={() => adjustNumber('rearSpringRateNmm', -5, 100, 260, 0)}
                onInc={() => adjustNumber('rearSpringRateNmm', 5, 100, 260, 0)}
              />
            </div>
          </div>

          {/* Differential & Cold Tires */}
          <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-4">
            <h3 className="font-display text-sm font-semibold text-slate-200">
              Differential & Tire Pressures
            </h3>
            <div className="mt-3 space-y-2.5">
              <SetupStepperRow
                label="Diff Power Lock"
                value={`${setup.diffPowerPct}%`}
                baseValue={`${baseline.diffPowerPct}%`}
                modified={setup.diffPowerPct !== baseline.diffPowerPct}
                onDec={() => adjustNumber('diffPowerPct', -2, 15, 85, 0)}
                onInc={() => adjustNumber('diffPowerPct', 2, 15, 85, 0)}
              />
              <SetupStepperRow
                label="Diff Coast Lock"
                value={`${setup.diffCoastPct}%`}
                baseValue={`${baseline.diffCoastPct}%`}
                modified={setup.diffCoastPct !== baseline.diffCoastPct}
                onDec={() => adjustNumber('diffCoastPct', -2, 15, 85, 0)}
                onInc={() => adjustNumber('diffCoastPct', 2, 15, 85, 0)}
              />
              <SetupStepperRow
                label="Diff Preload"
                value={`${setup.diffPreloadNm} Nm`}
                baseValue={`${baseline.diffPreloadNm} Nm`}
                modified={setup.diffPreloadNm !== baseline.diffPreloadNm}
                onDec={() => adjustNumber('diffPreloadNm', -5, 10, 150, 0)}
                onInc={() => adjustNumber('diffPreloadNm', 5, 10, 150, 0)}
              />
              <div className="flex items-center justify-between border-t border-[#1B2230] pt-2.5 text-xs">
                <span className="text-slate-400">Cold PSI (FL/FR · RL/RR)</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {setup.coldPsi.fl.toFixed(1)}/{setup.coldPsi.fr.toFixed(1)} · {setup.coldPsi.rl.toFixed(1)}/{setup.coldPsi.rr.toFixed(1)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface SetupStepperRowProps {
  label: string;
  value: string;
  baseValue?: string;
  modified?: boolean;
  onDec: () => void;
  onInc: () => void;
  disabled?: boolean;
  testId?: string;
}

function SetupStepperRow({
  label,
  value,
  baseValue,
  modified,
  onDec,
  onInc,
  disabled,
  testId,
}: SetupStepperRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <div className="min-w-0">
        <div className={modified ? 'font-medium text-cyan-200' : 'text-slate-300'}>{label}</div>
        {modified && baseValue && (
          <div className="font-mono text-[10px] text-slate-500">Base {baseValue}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          disabled={disabled}
          onClick={onDec}
          aria-label={`Decrease ${label}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#273145] bg-[#10141D] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-40 cursor-pointer"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span
          data-testid={testId}
          className={`w-24 text-center font-mono font-semibold tabular-nums ${
            modified ? 'text-cyan-300' : 'text-slate-100'
          }`}
        >
          {value}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onInc}
          aria-label={`Increase ${label}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#273145] bg-[#10141D] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-40 cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
