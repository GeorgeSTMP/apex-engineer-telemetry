import type { PitMfdSyncRequest } from '../types/telemetry';

export interface LmuPitMenuSettingOption {
  text?: string;
  name?: string;
  label?: string;
  value?: string | number;
  [key: string]: unknown;
}

export interface LmuPitMenuCategory {
  name?: string;
  pmcName?: string;
  category?: string;
  currentSetting?: number;
  settings?: Array<LmuPitMenuSettingOption | string>;
  options?: Array<LmuPitMenuSettingOption | string>;
  [key: string]: unknown;
}

export interface LmuPitMenuApplyResult {
  updatedMenu: unknown;
  changedCount: number;
  matchedCategories: string[];
  summary: string;
}

function getOptionText(opt: LmuPitMenuSettingOption | string): string {
  if (typeof opt === 'string') return opt.trim();
  if (!opt || typeof opt !== 'object') return '';
  return String(opt.text ?? opt.name ?? opt.label ?? opt.value ?? '').trim();
}

function getCategoryName(cat: LmuPitMenuCategory): string {
  return String(cat.name ?? cat.pmcName ?? cat.category ?? '').trim();
}

function findSettingIndex(
  options: Array<LmuPitMenuSettingOption | string>,
  predicate: (text: string) => boolean
): number {
  for (let i = 0; i < options.length; i++) {
    const txt = getOptionText(options[i]);
    if (txt && predicate(txt)) {
      return i;
    }
  }
  return -1;
}

function isBrakeReplaceCategory(name: string): boolean {
  return /brake/i.test(name);
}

function classifyTireCategory(name: string): 'front' | 'rear' | 'all' | null {
  if (!name || isBrakeReplaceCategory(name)) return null;
  if (!/(t[iy]re)/i.test(name)) return null;
  if (/\b(fl|fr|front|f\s+t[iy]re|lf|rf)\b/i.test(name) || /^(fl|fr|front)/i.test(name)) {
    return 'front';
  }
  if (/\b(rl|rr|rear|r\s+t[iy]re|lr|back)\b/i.test(name) || /^(rl|rr|rear)/i.test(name)) {
    return 'rear';
  }
  return 'all';
}

function isRepairCategory(name: string): boolean {
  if (!name || isBrakeReplaceCategory(name)) return false;
  return /\b(repair|damage|body)\b/i.test(name);
}

/**
 * Pure mapper that updates LMU's /rest/garage/PitMenu/receivePitMenu structure
 * to pre-select tires (No Change / Fronts / 4x Compound) and Repairs while
 * leaving Brake replacement & unrelated items untouched.
 */
export function applyTirePlanToLmuPitMenu(
  pitMenuRaw: unknown,
  plan: Pick<
    PitMfdSyncRequest,
    'tireAction' | 'tireCompound' | 'repairsRecommended' | 'pitTireCallHeadline'
  >
): LmuPitMenuApplyResult {
  let wrapperKey: 'pitMenu' | 'items' | null = null;
  let list: LmuPitMenuCategory[] | null = null;

  if (Array.isArray(pitMenuRaw)) {
    list = pitMenuRaw as LmuPitMenuCategory[];
  } else if (pitMenuRaw && typeof pitMenuRaw === 'object') {
    const obj = pitMenuRaw as Record<string, unknown>;
    if (Array.isArray(obj.pitMenu)) {
      wrapperKey = 'pitMenu';
      list = obj.pitMenu as LmuPitMenuCategory[];
    } else if (Array.isArray(obj.items)) {
      wrapperKey = 'items';
      list = obj.items as LmuPitMenuCategory[];
    }
  }

  if (!list || list.length === 0) {
    return {
      updatedMenu: pitMenuRaw,
      changedCount: 0,
      matchedCategories: [],
      summary: 'LMU PitMenu returned no configurable categories.',
    };
  }

  let changedCount = 0;
  const matchedCategories: string[] = [];

  const nextList = list.map((rawCat) => {
    if (!rawCat || typeof rawCat !== 'object') return rawCat;
    const cat = { ...rawCat };
    const name = getCategoryName(cat);
    const opts = Array.isArray(cat.settings)
      ? cat.settings
      : Array.isArray(cat.options)
        ? cat.options
        : null;
    if (!opts || opts.length === 0) return cat;

    const tireRole = classifyTireCategory(name);
    if (tireRole) {
      const wantKeep =
        plan.tireAction === 'fuel_only' ||
        (plan.tireAction === 'change_fronts' && tireRole === 'rear');

      const targetIdx = wantKeep
        ? findSettingIndex(opts, (txt) => /^(no\s*change|none|keep|don'?t\s*change)/i.test(txt))
        : findSettingIndex(opts, (txt) =>
            new RegExp(`\\b${plan.tireCompound}\\b`, 'i').test(txt)
          );

      if (targetIdx >= 0) {
        matchedCategories.push(name);
        if (cat.currentSetting !== targetIdx) {
          cat.currentSetting = targetIdx;
          changedCount += 1;
        }
      }
      return cat;
    }

    if (isRepairCategory(name)) {
      let targetIdx = -1;
      if (plan.repairsRecommended) {
        targetIdx = findSettingIndex(
          opts,
          (txt) =>
            !/^(do\s*not|no\s*repair|none|off)/i.test(txt) &&
            /(repair\s*all|\ball\b|full)/i.test(txt)
        );
        if (targetIdx < 0) {
          targetIdx = findSettingIndex(
            opts,
            (txt) =>
              !/^(do\s*not|no\s*repair|none|off)/i.test(txt) && /(body|yes|on)/i.test(txt)
          );
        }
      } else {
        targetIdx = findSettingIndex(opts, (txt) => /^(do\s*not|no\s*repair|none|off)/i.test(txt));
      }

      if (targetIdx >= 0) {
        matchedCategories.push(name);
        if (cat.currentSetting !== targetIdx) {
          cat.currentSetting = targetIdx;
          changedCount += 1;
        }
      }
      return cat;
    }

    return cat;
  });

  const updatedMenu =
    wrapperKey && pitMenuRaw && typeof pitMenuRaw === 'object'
      ? { ...(pitMenuRaw as Record<string, unknown>), [wrapperKey]: nextList }
      : nextList;

  const summary =
    matchedCategories.length === 0
      ? 'Connected to LMU PitMenu, but no matching tire categories were found in current screen.'
      : changedCount === 0
        ? `LMU Pit MFD already pre-selected to ${plan.pitTireCallHeadline}.`
        : `Pre-selected ${plan.pitTireCallHeadline}${plan.repairsRecommended ? ' + Repairs ON' : ''} in LMU Pit MFD (${matchedCategories.join(', ')}).`;

  return {
    updatedMenu,
    changedCount,
    matchedCategories,
    summary,
  };
}
