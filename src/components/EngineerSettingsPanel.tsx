import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  CheckCircle2,
  Copy,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
  Sliders,
  Trash2,
  Volume2,
} from 'lucide-react';
import type { CoachFocusMode, CoachSettings, PitRaceMode, RadioProtocol } from '../types/telemetry';
import {
  createCustomPresetFromFactory,
  createCustomPresetFromSettings,
  detectSettingsConflicts,
  extractPresetPatch,
  FACTORY_ENGINEER_PRESETS,
  getEnabledModulesForPatch,
  getModuleFocusConflictReason,
  matchesPresetExact,
  RADIO_MODULE_CATALOG,
  RADIO_MODULE_CATEGORY_LABELS,
  RADIO_PROTOCOL_META,
  setModuleCategoryInPatch,
  type CustomEngineerPreset,
  type RadioModuleCategory,
  type RadioModuleKey,
} from '../engine/engineerPresets';
import { VOICE_PROFILE_DEFS } from '../engine/lmuKnowledge';

export type EngineerSettingsSection = 'profiles' | 'voice' | 'frequency' | 'all';

interface EngineerSettingsPanelProps {
  settings: CoachSettings;
  onUpdateSettings: (patch: Partial<CoachSettings>) => void;
  onTestCallout: () => void;
  onResetDefaults?: () => void;
  section?: EngineerSettingsSection;
}

const PRESETS_STORAGE_KEY = 'apex-engineer-presets';

function loadStoredCustomPresets(): CustomEngineerPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomEngineerPreset[]) : [];
  } catch {
    return [];
  }
}

export function EngineerSettingsPanel({
  settings,
  onUpdateSettings,
  onTestCallout,
  onResetDefaults,
  section = 'all',
}: EngineerSettingsPanelProps) {
  const [customPresets, setCustomPresets] = useState<CustomEngineerPreset[]>(loadStoredCustomPresets);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [lastCustomPresetId, setLastCustomPresetId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(customPresets));
    } catch {
      // ignore storage quota errors
    }
  }, [customPresets]);

  const editingPreset = useMemo(
    () => customPresets.find((p) => p.id === editingPresetId) ?? null,
    [customPresets, editingPresetId]
  );

  const activeFactoryPreset = useMemo(
    () => FACTORY_ENGINEER_PRESETS.find((p) => matchesPresetExact(settings, p.patch)) ?? null,
    [settings]
  );

  const activeCustomPreset = useMemo(
    () => customPresets.find((p) => matchesPresetExact(settings, p.patch)) ?? null,
    [customPresets, settings]
  );

  const trackedCustomPreset = useMemo(
    () =>
      activeCustomPreset ??
      customPresets.find((p) => p.id === lastCustomPresetId) ??
      null,
    [activeCustomPreset, customPresets, lastCustomPresetId]
  );

  const hasUnsavedCustomPresetChanges =
    editingPreset === null &&
    trackedCustomPreset !== null &&
    !matchesPresetExact(settings, trackedCustomPreset.patch);

  const conflicts = useMemo(() => detectSettingsConflicts(settings), [settings]);

  const handleSaveCurrentAsPreset = () => {
    const name = newPresetName.trim();
    if (!name) return;
    const created = createCustomPresetFromSettings(
      name,
      settings,
      customPresets.map((p) => p.name)
    );
    setCustomPresets((prev) => [...prev, created]);
    setNewPresetName('');
    setEditingPresetId(created.id);
    setLastCustomPresetId(created.id);
  };

  const handleCreateBlankPreset = () => {
    const created = createCustomPresetFromSettings(
      'Team Radio Setup',
      {
        ...settings,
        radioProtocol: 'pro_terse',
        verbosity: 'minimal',
        minSpeakIntervalSec: 10,
      },
      customPresets.map((p) => p.name)
    );
    setCustomPresets((prev) => [...prev, created]);
    setEditingPresetId(created.id);
    setLastCustomPresetId(created.id);
    onUpdateSettings(created.patch);
  };

  const handleCopyFactoryAndEdit = (factory: (typeof FACTORY_ENGINEER_PRESETS)[number]) => {
    const created = createCustomPresetFromFactory(
      factory,
      customPresets.map((p) => p.name)
    );
    setCustomPresets((prev) => [...prev, created]);
    setEditingPresetId(created.id);
    setLastCustomPresetId(created.id);
    onUpdateSettings(created.patch);
  };

  const handleDuplicateCustomPreset = (preset: CustomEngineerPreset) => {
    const created = createCustomPresetFromSettings(
      `${preset.name} Copy`,
      { ...settings, ...preset.patch },
      customPresets.map((p) => p.name)
    );
    setCustomPresets((prev) => [...prev, created]);
    setEditingPresetId(created.id);
    setLastCustomPresetId(created.id);
    onUpdateSettings(created.patch);
  };

  const handleDeleteCustomPreset = (id: string) => {
    setCustomPresets((prev) => prev.filter((p) => p.id !== id));
    if (editingPresetId === id) {
      setEditingPresetId(null);
    }
    if (lastCustomPresetId === id) {
      setLastCustomPresetId(null);
    }
  };

  const handleClearCustomPresets = () => {
    setCustomPresets([]);
    setEditingPresetId(null);
    setLastCustomPresetId(null);
  };

  const updateEditingPresetPatch = (
    presetId: string,
    nextPatchOrUpdater:
      | Partial<CoachSettings>
      | ((prevPatch: Partial<CoachSettings>) => Partial<CoachSettings>)
  ) => {
    const target = customPresets.find((p) => p.id === presetId);
    if (!target) return;
    const nextPatch =
      typeof nextPatchOrUpdater === 'function'
        ? nextPatchOrUpdater(target.patch)
        : { ...target.patch, ...nextPatchOrUpdater };
    setCustomPresets((prev) =>
      prev.map((p) => (p.id === presetId ? { ...p, patch: nextPatch } : p))
    );
    setLastCustomPresetId(presetId);
    onUpdateSettings(nextPatch);
  };

  const applySettingPatch = (patch: Partial<CoachSettings>) => {
    if (editingPreset) {
      const nextPatch = { ...editingPreset.patch, ...patch };
      setCustomPresets((prev) =>
        prev.map((p) => (p.id === editingPreset.id ? { ...p, patch: nextPatch } : p))
      );
    }
    onUpdateSettings(patch);
  };

  const updateEditingPresetName = (presetId: string, nextName: string) => {
    setCustomPresets((prev) =>
      prev.map((p) => (p.id === presetId ? { ...p, name: nextName } : p))
    );
  };

  const speakGap = settings.minSpeakIntervalSec ?? 5;
  const volumePct = Math.round((settings.voiceVolume ?? 0.95) * 100);
  const urgentInterruptsOn = settings.urgentInterruptsRadio ?? true;
  const activeProtocol: RadioProtocol = settings.radioProtocol ?? 'coaching_detail';
  const fuelTarget = settings.fuelTargetLitersPerLap ?? 0;

  const speakFrequencyHint =
    speakGap <= 3
      ? 'Very frequent (active coaching)'
      : speakGap <= 8
        ? 'Balanced (normal pit radio)'
        : speakGap <= 16
          ? 'Calm (fewer interruptions)'
          : 'Quiet (rare updates only)';

  const categories: RadioModuleCategory[] = [
    'pit_wall',
    'car_electronics',
    'traffic_safety',
    'driving_coach',
  ];

  const isModuleOn = (key: RadioModuleKey): boolean => Boolean(settings[key]);

  const activePresetSummary = activeCustomPreset
    ? `Active Preset: ${activeCustomPreset.name}`
    : activeFactoryPreset
      ? `Active Preset: ${activeFactoryPreset.label}`
      : hasUnsavedCustomPresetChanges && trackedCustomPreset
        ? `Modified from "${trackedCustomPreset.name}"`
        : 'Live Configuration (Custom)';

  return (
    <div className="space-y-5" data-testid="engineer-settings-panel">
      {/* Header actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3.5">
        <div>
          <h3 className="font-display text-base font-bold text-text">
            Race Engineer Settings (Presets, Voice, Timing &amp; Alerts)
          </h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {activePresetSummary} · Changes apply immediately to your live pit wall engineer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasUnsavedCustomPresetChanges && trackedCustomPreset && (
            <button
              type="button"
              onClick={() =>
                updateEditingPresetPatch(trackedCustomPreset.id, extractPresetPatch(settings))
              }
              data-testid="sync-active-preset-btn"
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 cursor-pointer whitespace-nowrap"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Save to &ldquo;{trackedCustomPreset.name}&rdquo;</span>
            </button>
          )}
          {onResetDefaults && (
            <button
              type="button"
              onClick={() => {
                setEditingPresetId(null);
                setLastCustomPresetId(null);
                onResetDefaults();
              }}
              data-testid="reset-engineer-settings-btn"
              className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-canvas px-3 py-1.5 text-xs font-medium text-text-muted hover:border-slate-500 hover:text-text cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Reset</span>
            </button>
          )}
          <button
            type="button"
            onClick={onTestCallout}
            data-testid="test-engineer-voice-btn"
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-dim px-3 py-1.5 text-xs font-semibold text-accent hover:bg-cyan-500/25 cursor-pointer whitespace-nowrap"
          >
            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Test Voice</span>
          </button>
        </div>
      </div>

      {/* Live Cross-Settings Conflict & Filter Checker */}
      {conflicts.length === 0 ? (
        <div
          data-testid="settings-conflicts-clean"
          className="flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>No conflicts detected — every enabled alert and threshold is active as configured.</span>
        </div>
      ) : (
        <div
          data-testid="settings-conflicts-banner"
          className="space-y-1.5 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2.5"
        >
          <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Settings Interaction Notice ({conflicts.length})</span>
          </div>
          {conflicts.map((conflict) => (
            <div
              key={conflict.id}
              data-testid={`settings-conflict-${conflict.id}`}
              className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-100"
            >
              <span>{conflict.message}</span>
              <button
                type="button"
                onClick={() => applySettingPatch(conflict.resolvePatch)}
                data-testid={`fix-conflict-${conflict.id}`}
                className="rounded border border-amber-400/45 bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/30 cursor-pointer shrink-0"
              >
                {conflict.fixLabel}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Section 0: Unified Profiles & Live Alert Channels */}
      {(section === 'profiles' || section === 'all') && (
        <div className="space-y-5" data-testid="settings-profiles-section">
          {/* Part A: Pro Team Profiles */}
          <div className="space-y-3">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-xs font-semibold uppercase tracking-wider text-accent">
                  Team Profiles (Quick Load or Save Your Own)
                </div>
                <button
                  type="button"
                  onClick={handleCreateBlankPreset}
                  data-testid="new-custom-preset-btn"
                  className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-dim px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-cyan-500/25 cursor-pointer"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  <span>New Custom Profile</span>
                </button>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">
                Profiles set all switches below in one click. Load a team profile, or click <strong className="text-slate-200">Copy &amp; Edit</strong> to toggle the switches below into your own saved profile.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {FACTORY_ENGINEER_PRESETS.map((preset) => {
                const active = !editingPreset && matchesPresetExact(settings, preset.patch);
                const moduleCount = getEnabledModulesForPatch(preset.patch).length;
                return (
                  <div
                    key={preset.id}
                    data-testid={`factory-preset-${preset.id}`}
                    className={`flex flex-col justify-between rounded-md border px-3 py-2.5 transition-colors ${
                      active ? 'border-accent bg-accent-dim' : 'border-border bg-canvas hover:border-border-strong'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setLastCustomPresetId(null);
                        setEditingPresetId(null);
                        onUpdateSettings(preset.patch);
                      }}
                      className="w-full text-left cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-text">{preset.label}</span>
                        <span className="font-mono text-[10px] font-medium text-cyan-400">
                          {preset.teamTag}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] leading-snug text-text-muted">{preset.hint}</div>
                    </button>
                    <div className="mt-2 flex items-center justify-between border-t border-[#1B2230]/80 pt-1.5">
                      <span className="font-mono text-[10px] text-slate-500">
                        {moduleCount} alerts · {preset.patch.minSpeakIntervalSec}s
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyFactoryAndEdit(preset)}
                        data-testid={`preset-copy-${preset.id}-btn`}
                        className="inline-flex items-center gap-1 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/20 cursor-pointer"
                      >
                        <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                        <span>Copy &amp; Edit</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Your Custom Profiles */}
            <div className="space-y-2 rounded-lg border border-[#1B2230] bg-[#090B10] p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-200">
                  Your Custom Team Profiles ({customPresets.length})
                </div>
                {customPresets.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearCustomPresets}
                    className="text-[11px] text-slate-400 hover:text-rose-300 cursor-pointer"
                  >
                    Clear all
                  </button>
                )}
              </div>

              {customPresets.length === 0 ? (
                <p className="text-[11px] text-slate-500">
                  No custom profiles saved yet. Adjust any alert switches below and save them here, or click <span className="text-cyan-300">Copy &amp; Edit</span> on a team profile above.
                </p>
              ) : (
                <div className="space-y-2">
                  {customPresets.map((preset) => {
                    const active = matchesPresetExact(settings, preset.patch);
                    const isEditing = editingPresetId === preset.id;
                    const enabledCount = getEnabledModulesForPatch(preset.patch).length;
                    const protoLabel =
                      RADIO_PROTOCOL_META[preset.patch.radioProtocol ?? 'coaching_detail'].label;

                    return (
                      <div
                        key={preset.id}
                        data-testid={`custom-preset-row-${preset.id}`}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
                          isEditing
                            ? 'border-cyan-400 bg-cyan-500/10'
                            : active
                              ? 'border-accent bg-accent-dim'
                              : 'border-[#1B2230] bg-[#0B0F17]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setLastCustomPresetId(preset.id);
                            onUpdateSettings(preset.patch);
                          }}
                          className="flex min-w-0 flex-1 flex-col text-left cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-semibold text-slate-100">
                              {preset.name}
                            </span>
                            {isEditing ? (
                              <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-cyan-300">
                                Editing live below
                              </span>
                            ) : active ? (
                              <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-emerald-400">
                                <Check className="h-3 w-3" aria-hidden="true" />
                                Active
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                            {enabledCount}/{RADIO_MODULE_CATALOG.length} alerts · {protoLabel} ·{' '}
                            {preset.patch.minSpeakIntervalSec ?? 5}s gap
                          </div>
                        </button>

                        <div className="flex items-center gap-1.5 text-[11px]">
                          <button
                            type="button"
                            onClick={() => {
                              if (isEditing) {
                                setEditingPresetId(null);
                              } else {
                                setEditingPresetId(preset.id);
                                setLastCustomPresetId(preset.id);
                                onUpdateSettings(preset.patch);
                              }
                            }}
                            data-testid={`edit-custom-preset-${preset.id}-btn`}
                            className={`inline-flex items-center gap-1 rounded border px-2 py-1 font-medium cursor-pointer ${
                              isEditing
                                ? 'border-cyan-400 bg-cyan-500 text-slate-950'
                                : 'border-[#273145] bg-[#10141D] text-cyan-300 hover:border-cyan-400'
                            }`}
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                            <span>{isEditing ? 'Done' : 'Edit'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDuplicateCustomPreset(preset)}
                            aria-label={`Duplicate ${preset.name}`}
                            className="rounded border border-[#273145] bg-[#10141D] p-1.5 text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer"
                          >
                            <Copy className="h-3 w-3" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCustomPreset(preset.id)}
                            aria-label={`Delete ${preset.name}`}
                            data-testid={`delete-custom-preset-${preset.id}-btn`}
                            className="rounded border border-[#273145] bg-[#10141D] p-1.5 text-slate-400 hover:border-rose-500/40 hover:text-rose-300 cursor-pointer"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveCurrentAsPreset();
                  }}
                  placeholder="Save current switches below as profile (e.g. GT3 Spa Endurance)"
                  aria-label="New profile name"
                  className="h-8 flex-1 rounded-md border border-[#273145] bg-[#0B0F17] px-2.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveCurrentAsPreset}
                  data-testid="save-current-as-preset-btn"
                  className="h-8 rounded-md border border-accent/40 bg-accent-dim px-3 text-xs font-semibold text-accent hover:bg-cyan-500/25 cursor-pointer whitespace-nowrap"
                >
                  Save Profile
                </button>
              </div>
            </div>
          </div>

          {/* Active Custom Profile Edit Banner (edits bind directly to the single Alert list below) */}
          {editingPreset && (
            <div
              data-testid="preset-inline-editor"
              className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-cyan-500/45 bg-cyan-500/10 px-3.5 py-2.5"
            >
              <div className="flex flex-1 min-w-[240px] flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan-300 shrink-0">
                  Editing Profile:
                </span>
                <input
                  value={editingPreset.name}
                  onChange={(e) => updateEditingPresetName(editingPreset.id, e.target.value)}
                  aria-label="Editing profile name"
                  data-testid="editing-preset-name-input"
                  className="h-8 flex-1 min-w-[180px] rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs font-semibold text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
                <span className="text-[11px] text-cyan-200/80">
                  Every alert, threshold, voice &amp; timing change saves automatically into this profile.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditingPresetId(null)}
                data-testid="close-preset-editor-btn"
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 cursor-pointer shrink-0"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Done Editing</span>
              </button>
            </div>
          )}

          {/* Part B: Single Unified Alert Checklist & Thresholds */}
          <div
            data-testid="settings-alerts-section"
            className="space-y-4 border-t border-border pt-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider text-accent">
                <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {editingPreset
                    ? `Alert Channels for "${editingPreset.name}"`
                    : 'Alert Channels & Thresholds'}
                </span>
              </div>
              <span className="text-[11px] text-slate-400">
                Enabled channels operate independently without overriding each other.
              </span>
            </div>

            {categories.map((cat) => {
              const catMods = RADIO_MODULE_CATALOG.filter((m) => m.category === cat);
              return (
                <div key={cat} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      {RADIO_MODULE_CATEGORY_LABELS[cat]}
                    </span>
                    <div className="flex items-center gap-2 text-[10px]">
                      <button
                        type="button"
                        onClick={() => applySettingPatch(setModuleCategoryInPatch(settings, cat, true))}
                        className="text-cyan-400 hover:underline cursor-pointer"
                      >
                        Enable all
                      </button>
                      <button
                        type="button"
                        onClick={() => applySettingPatch(setModuleCategoryInPatch(settings, cat, false))}
                        className="text-slate-500 hover:text-rose-300 hover:underline cursor-pointer"
                      >
                        Disable all
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {catMods.map((mod) => {
                      const checked = isModuleOn(mod.key);
                      const focusPauseReason = checked
                        ? getModuleFocusConflictReason(mod.key, settings.focusMode ?? 'all')
                        : null;
                      return (
                        <label
                          key={mod.key}
                          className={`flex items-center justify-between rounded-md border px-3 py-2.5 cursor-pointer ${
                            focusPauseReason
                              ? 'border-amber-500/40 bg-amber-500/5'
                              : 'border-[#1B2230] bg-[#090B10]'
                          }`}
                        >
                          <div className="pr-2">
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <span className="text-xs font-medium text-slate-100">{mod.label}</span>
                              <span className="font-mono text-[10px] text-cyan-400">
                                · {mod.proTag}
                              </span>
                              {focusPauseReason && (
                                <span
                                  data-testid={`alert-paused-${mod.key}`}
                                  className="font-mono text-[10px] font-medium text-amber-300"
                                >
                                  · {focusPauseReason}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-400">{mod.description}</div>
                          </div>
                          <input
                            type="checkbox"
                            data-testid={`alert-toggle-${mod.key}`}
                            aria-label={`Enable ${mod.label}`}
                            checked={checked}
                            onChange={(e) => applySettingPatch({ [mod.key]: e.target.checked })}
                            className="h-4 w-4 accent-cyan-500 cursor-pointer shrink-0"
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 rounded-md border border-[#1B2230] bg-[#090B10] p-3">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-slate-100">Auto-Select Best Pit Tires</div>
                  <div className="text-[11px] text-slate-400">
                    Automatically picks Keep, 2x Fronts, or 4x Soft/Med/Hard/Wet for every mode
                  </div>
                </div>
                <input
                  type="checkbox"
                  data-testid="settings-auto-pit-tires"
                  aria-label="Auto-Select Best Pit Tires"
                  checked={settings.autoSelectPitTires ?? true}
                  onChange={(e) => applySettingPatch({ autoSelectPitTires: e.target.checked })}
                  className="h-4 w-4 accent-cyan-500 cursor-pointer shrink-0"
                />
              </label>

              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-slate-100">Preselect Tires in LMU Pit MFD</div>
                  <div className="text-[11px] text-slate-400">
                    Writes tire &amp; repair selections into LMU (:6397) so pressing Pit already has them queued
                  </div>
                </div>
                <input
                  type="checkbox"
                  data-testid="settings-preselect-lmu-tires"
                  aria-label="Preselect Tires in LMU Pit MFD"
                  checked={settings.preselectPitTiresInLmu ?? false}
                  onChange={(e) => applySettingPatch({ preselectPitTiresInLmu: e.target.checked })}
                  className="h-4 w-4 accent-cyan-500 cursor-pointer shrink-0"
                />
              </label>

              <div className="sm:col-span-2">
                <label htmlFor="settings-pit-race-mode" className="block text-xs font-medium text-slate-300">
                  Pit Strategy Game Mode
                </label>
                <select
                  id="settings-pit-race-mode"
                  data-testid="settings-pit-race-mode"
                  value={settings.pitRaceMode ?? 'auto'}
                  onChange={(e) =>
                    applySettingPatch({ pitRaceMode: e.target.value as PitRaceMode })
                  }
                  className="mt-1 h-8 w-full rounded-md border border-[#273145] bg-[#10141D] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                >
                  <option value="auto">Auto (Detect Session &amp; Newbie/Pace Mode)</option>
                  <option value="short_online">Short Online / Beginner Race (15–25m)</option>
                  <option value="standard_online">Normal Online Race (40–60m)</option>
                  <option value="endurance">Endurance Stint (2h+)</option>
                  <option value="practice_quali">Practice / Qualifying</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 pt-1">
              <div>
                <label htmlFor="autonomy-mode-select" className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                  <Sliders className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                  <span>Engineer Setup Autonomy</span>
                </label>
                <select
                  id="autonomy-mode-select"
                  value={settings.autonomyMode}
                  onChange={(e) =>
                    applySettingPatch({
                      autonomyMode: e.target.value as CoachSettings['autonomyMode'],
                    })
                  }
                  className="mt-1.5 h-9 w-full rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                >
                  <option value="advise">Advise-Only (Radio calls only)</option>
                  <option value="hands_on">Auto-Apply (Tunes in-app TC / ABS / Bias)</option>
                </select>
              </div>

              <div
                className={`rounded-md border px-3 py-2 ${
                  settings.focusMode !== 'all' && settings.focusMode !== 'braking'
                    ? 'border-amber-500/35 bg-amber-500/5'
                    : 'border-[#1B2230] bg-[#090B10]'
                }`}
              >
                <div className="flex justify-between text-xs">
                  <label htmlFor="late-brake-threshold" className="font-medium text-slate-300">
                    Late Braking Threshold
                  </label>
                  <span className="font-mono text-cyan-400">{settings.lateBrakeThresholdMeters}m</span>
                </div>
                <input
                  id="late-brake-threshold"
                  type="range"
                  min={5}
                  max={25}
                  step={1}
                  value={settings.lateBrakeThresholdMeters}
                  onChange={(e) =>
                    applySettingPatch({ lateBrakeThresholdMeters: Number(e.target.value) })
                  }
                  className="mt-2 h-1.5 w-full accent-cyan-500 cursor-pointer"
                />
                {settings.focusMode !== 'all' && settings.focusMode !== 'braking' && (
                  <div className="mt-1 text-[10px] text-amber-300">
                    Paused while Focus Area skips braking
                  </div>
                )}
              </div>

              <div
                className={`rounded-md border px-3 py-2 ${
                  fuelTarget > 0 && !settings.pitWindowCountdownEnabled && !settings.fuelSaveCallsEnabled
                    ? 'border-amber-500/35 bg-amber-500/5'
                    : 'border-[#1B2230] bg-[#090B10]'
                }`}
              >
                <div className="flex justify-between text-xs">
                  <label htmlFor="fuel-target-input" className="font-medium text-slate-300">
                    Fuel Target (L/lap)
                  </label>
                  <span className="font-mono text-cyan-400">
                    {fuelTarget > 0 ? `${fuelTarget.toFixed(1)} L` : 'Auto'}
                  </span>
                </div>
                <input
                  id="fuel-target-input"
                  type="range"
                  min={0}
                  max={7.5}
                  step={0.1}
                  value={fuelTarget}
                  onChange={(e) =>
                    applySettingPatch({ fuelTargetLitersPerLap: Number(e.target.value) })
                  }
                  className="mt-2 h-1.5 w-full accent-cyan-500 cursor-pointer"
                />
                {!settings.pitWindowCountdownEnabled && !settings.fuelSaveCallsEnabled && (
                  <div className="mt-1 text-[10px] text-slate-400">
                    Enable Pit Window or Lift &amp; Coast above to use
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section 1: Voice & Radio Phrasing */}
      {(section === 'voice' || section === 'all') && (
        <div
          className={`space-y-3 ${section === 'all' ? 'border-t border-border pt-4' : ''}`}
          data-testid="settings-voice-section"
        >
          <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider text-accent">
            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Voice Audio &amp; Phrasing Style</span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="flex items-center justify-between rounded-md border border-[#1B2230] bg-[#090B10] px-3.5 py-2.5 cursor-pointer">
              <div>
                <div className="text-xs font-medium text-slate-100">Spoken Pit Radio</div>
                <div className="text-[11px] text-slate-400">Speak coaching callouts aloud</div>
              </div>
              <input
                type="checkbox"
                aria-label="Enable spoken pit radio"
                checked={settings.voiceEnabled}
                onChange={(e) => applySettingPatch({ voiceEnabled: e.target.checked })}
                className="h-4 w-4 accent-cyan-500 cursor-pointer"
              />
            </label>

            <label
              className={`flex items-center justify-between rounded-md border border-[#1B2230] bg-[#090B10] px-3.5 py-2.5 cursor-pointer ${
                !settings.voiceEnabled ? 'opacity-60' : ''
              }`}
            >
              <div>
                <div className="text-xs font-medium text-slate-100">Gemini HD Engineer Voice</div>
                <div className="text-[11px] text-slate-400">
                  {settings.useGeminiTts
                    ? 'Using natural Gemini TTS voice'
                    : 'Off — using local English browser speech'}
                </div>
              </div>
              <input
                type="checkbox"
                aria-label="Enable Gemini HD voice"
                checked={settings.useGeminiTts}
                onChange={(e) => applySettingPatch({ useGeminiTts: e.target.checked })}
                className="h-4 w-4 accent-cyan-500 cursor-pointer"
              />
            </label>

            <label
              className={`flex items-center justify-between rounded-md border border-[#1B2230] bg-[#090B10] px-3.5 py-2.5 cursor-pointer ${
                !settings.voiceEnabled ? 'opacity-60' : ''
              }`}
            >
              <div>
                <div className="text-xs font-medium text-slate-100">Pit Radio Squelch Beeps</div>
                <div className="text-[11px] text-slate-400">Open/close chirp around callouts</div>
              </div>
              <input
                type="checkbox"
                aria-label="Enable radio squelch beeps"
                checked={settings.radioSquelchFx}
                onChange={(e) => applySettingPatch({ radioSquelchFx: e.target.checked })}
                className="h-4 w-4 accent-cyan-500 cursor-pointer"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="engineer-voice-select" className="block text-xs font-medium text-slate-300">
                Gemini Voice Persona
              </label>
              <select
                id="engineer-voice-select"
                value={settings.geminiVoiceName}
                onChange={(e) =>
                  applySettingPatch({
                    geminiVoiceName: e.target.value as CoachSettings['geminiVoiceName'],
                  })
                }
                className="mt-1.5 h-9 w-full rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              >
                <option value="Fenrir">Fenrir (Authoritative Engineer)</option>
                <option value="Charon">Charon (Deep Tactical)</option>
                <option value="Kore">Kore (Clear &amp; Calm)</option>
                <option value="Puck">Puck (Energetic Spotter)</option>
                <option value="Zephyr">Zephyr (Balanced Native)</option>
              </select>
              {!settings.useGeminiTts && (
                <p className="mt-1 text-[10px] text-slate-500">
                  Applies to Live Voice / Gemini HD TTS when enabled above.
                </p>
              )}
            </div>

            <div className="sm:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="block text-xs font-medium text-slate-300">
                  Voice Profile (Immediacy &amp; Word Count)
                </span>
                {activeProtocol !== 'pro_terse' && (
                  <button
                    type="button"
                    data-testid="activate-race-direct-btn"
                    onClick={() =>
                      applySettingPatch({
                        radioProtocol: 'pro_terse',
                        verbosity: settings.verbosity === 'detailed' ? 'minimal' : settings.verbosity,
                        minSpeakIntervalSec: Math.min(settings.minSpeakIntervalSec ?? 4, 4),
                        urgentInterruptsRadio: true,
                      })
                    }
                    className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap"
                  >
                    Switch to Race Direct (Immediate)
                  </button>
                )}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Voice profile">
                {(['pro_terse', 'endurance_calm', 'coaching_detail'] as RadioProtocol[]).map((modeId) => {
                  const def = VOICE_PROFILE_DEFS[modeId];
                  const isActive = activeProtocol === modeId;
                  return (
                    <button
                      key={modeId}
                      type="button"
                      data-testid={`voice-profile-${modeId}`}
                      aria-pressed={isActive}
                      onClick={() => applySettingPatch({ radioProtocol: modeId })}
                      className={`rounded-md border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                        isActive
                          ? 'border-cyan-400 bg-cyan-500/10 text-slate-100'
                          : 'border-[#1B2230] bg-[#090B10] text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-100">{def.label}</span>
                        {isActive && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden="true" />
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-cyan-300">{def.maxWordsGuide}</div>
                      <p className="mt-1 text-[11px] leading-snug text-slate-400">{def.hint}</p>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-400">
                Active: {RADIO_PROTOCOL_META[activeProtocol].label} — {RADIO_PROTOCOL_META[activeProtocol].hint}
              </p>
            </div>

            <div className={`rounded-md border border-[#1B2230] bg-[#090B10] px-3 py-2 ${!settings.voiceEnabled ? 'opacity-60' : ''}`}>
              <div className="flex justify-between text-xs">
                <label htmlFor="speech-rate-slider" className="font-medium text-slate-300">
                  Speech Speed
                </label>
                <span className="font-mono text-cyan-400">{settings.speechRate.toFixed(2)}x</span>
              </div>
              <input
                id="speech-rate-slider"
                data-testid="speech-rate-slider"
                type="range"
                min={0.8}
                max={1.3}
                step={0.02}
                value={settings.speechRate}
                onChange={(e) => applySettingPatch({ speechRate: Number(e.target.value) })}
                className="mt-2 h-1.5 w-full accent-cyan-500 cursor-pointer"
              />
            </div>

            <div className={`rounded-md border border-[#1B2230] bg-[#090B10] px-3 py-2 ${!settings.voiceEnabled ? 'opacity-60' : ''}`}>
              <div className="flex justify-between text-xs">
                <label htmlFor="voice-volume-slider" className="font-medium text-slate-300">
                  Voice Volume
                </label>
                <span className="font-mono text-cyan-400">{volumePct}%</span>
              </div>
              <input
                id="voice-volume-slider"
                data-testid="voice-volume-slider"
                type="range"
                min={20}
                max={100}
                step={5}
                value={volumePct}
                onChange={(e) => applySettingPatch({ voiceVolume: Number(e.target.value) / 100 })}
                className="mt-2 h-1.5 w-full accent-cyan-500 cursor-pointer"
              />
            </div>
          </div>
        </div>
      )}

      {/* Section 2: Talk Frequency & Driving Focus */}
      {(section === 'frequency' || section === 'all') && (
        <div
          data-testid="settings-frequency-section"
          className={`space-y-3 ${section === 'all' ? 'border-t border-border pt-4' : ''}`}
        >
          <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider text-accent">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Timing &amp; Coaching Focus</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="verbosity-select" className="block text-xs font-medium text-slate-300">
                Extra Commentary Level
              </label>
              <select
                id="verbosity-select"
                data-testid="verbosity-select"
                value={settings.verbosity}
                onChange={(e) =>
                  applySettingPatch({
                    verbosity: e.target.value as CoachSettings['verbosity'],
                  })
                }
                className="mt-1.5 h-9 w-full rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              >
                <option value="minimal">Enabled Alerts Only (No extra chatter)</option>
                <option value="balanced">Alerts + Optimal Tire Window Updates</option>
                <option value="detailed">Alerts + Optimal Window &amp; Corner Entry Tips</option>
              </select>
              <p className="mt-1 text-[10px] text-slate-400">
                Never disables your checked Alerts — only adds optional window and corner-entry tips.
              </p>
            </div>

            <div>
              <label htmlFor="focus-mode-select" className="block text-xs font-medium text-slate-300">
                Coaching Focus Area
              </label>
              <select
                id="focus-mode-select"
                data-testid="focus-mode-select"
                value={settings.focusMode}
                onChange={(e) =>
                  applySettingPatch({
                    focusMode: e.target.value as CoachFocusMode,
                  })
                }
                className="mt-1.5 h-9 w-full rounded-md border border-[#273145] bg-[#090B10] px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              >
                <option value="all">All Areas (Braking, Apex &amp; Exit)</option>
                <option value="braking">Braking &amp; Lockups Only</option>
                <option value="apex_line">Racing Line &amp; Apex Speed Only</option>
                <option value="throttle_exit">Throttle &amp; Exit Traction Only</option>
              </select>
              <p className="mt-1 text-[10px] text-slate-400">
                Scopes driving feedback only; safety, flags, fuel, and tire alerts always run.
              </p>
            </div>

            <div className="rounded-md border border-[#1B2230] bg-[#090B10] px-3 py-2 sm:col-span-2">
              <div className="flex justify-between text-xs">
                <label htmlFor="speak-interval-slider" className="font-medium text-slate-300">
                  Minimum Gap Between Non-Urgent Calls
                </label>
                <span className="font-mono text-cyan-400" data-testid="speak-interval-value">
                  {speakGap}s
                </span>
              </div>
              <input
                id="speak-interval-slider"
                data-testid="speak-interval-slider"
                type="range"
                min={2}
                max={30}
                step={1}
                value={speakGap}
                onChange={(e) => applySettingPatch({ minSpeakIntervalSec: Number(e.target.value) })}
                className="mt-2 h-1.5 w-full accent-cyan-500 cursor-pointer"
              />
              <div className="mt-1 font-mono text-[10px] text-slate-400">{speakFrequencyHint}</div>
            </div>
          </div>

          <label className="flex items-center justify-between rounded-md border border-[#1B2230] bg-[#090B10] px-3.5 py-2.5 cursor-pointer">
            <div>
              <div className="text-xs font-medium text-slate-100">
                Urgent Warnings Interrupt Quiet Interval
              </div>
              <div className="text-[11px] text-slate-400">
                Crashes, front lockups, critical fuel, and side-by-side spotter calls speak immediately
              </div>
            </div>
            <input
              type="checkbox"
              aria-label="Urgent warnings interrupt quiet interval"
              checked={urgentInterruptsOn}
              onChange={(e) => applySettingPatch({ urgentInterruptsRadio: e.target.checked })}
              className="h-4 w-4 accent-cyan-500 cursor-pointer"
            />
          </label>
        </div>
      )}
    </div>
  );
}
