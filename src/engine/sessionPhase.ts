import type { RadioProtocol, SimConnectionStatus, SimSessionType } from '../types/telemetry.ts';

export type SessionPhaseOverride = 'auto' | 'practice' | 'qualifying' | 'race';

/**
 * Parses a raw session string or name from any sim/UDP/REST payload into a normalized phase.
 */
export function parseGenericSessionType(raw: unknown): SimSessionType {
  if (raw === null || raw === undefined) return 'unknown';

  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (!s) return 'unknown';

    if (
      s === 'PRACTICE' ||
      s === 'QUALIFYING' ||
      s === 'RACE' ||
      s === 'WARMUP' ||
      s === 'UNKNOWN'
    ) {
      return s.toLowerCase() as SimSessionType;
    }

    if (
      s.includes('PRACTICE') ||
      s.includes('TEST') ||
      s.includes('HOTLAP') ||
      s.includes('HOTSTINT') ||
      s.includes('TIME_ATTACK') ||
      s.includes('TIME ATTACK') ||
      /^FP[1-4]?$/.test(s)
    ) {
      if (s.includes('SUPERPOLE')) return 'qualifying';
      return 'practice';
    }

    if (
      s.includes('QUAL') ||
      s.includes('HYPERPOLE') ||
      s.includes('SUPERPOLE') ||
      s.includes('SHOOTOUT') ||
      /^Q[1-4]$/.test(s)
    ) {
      return 'qualifying';
    }

    if (s.includes('WARM')) {
      return 'warmup';
    }

    if (
      s.includes('RACE') ||
      s.includes('FORMATION') ||
      s.includes('STANDING') ||
      s === 'GRID' ||
      s.includes('FEATURE') ||
      s.includes('SPRINT')
    ) {
      return 'race';
    }

    const numParsed = Number(s);
    if (Number.isFinite(numParsed)) {
      return parseLmuNumericSession(numParsed);
    }
    return 'unknown';
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return parseLmuNumericSession(raw);
  }

  return 'unknown';
}

/**
 * Maps rFactor 2 / Le Mans Ultimate `mSession` integer values:
 * 0 = Test Day, 1..4 = Practice 1..4, 5..8 = Qualifying 1..4, 9 = Warmup, 10..13 = Race 1..4
 */
export function parseLmuNumericSession(code: number): SimSessionType {
  if (!Number.isFinite(code) || code < 0) return 'unknown';
  if (code >= 0 && code <= 4) return 'practice';
  if (code >= 5 && code <= 8) return 'qualifying';
  if (code === 9) return 'warmup';
  if (code >= 10 && code <= 13) return 'race';
  return 'unknown';
}

/**
 * Maps Assetto Corsa Competizione `AC_SESSION_TYPE` shared-memory enum (`acpmf_graphics` offset 8):
 * 0 = Practice, 1 = Qualifying, 2 = Race, 3 = Hotlap, 4 = Time Attack, 7 = Hotstint, 8 = Superpole
 */
export function parseAccSessionType(code: number): SimSessionType {
  if (!Number.isFinite(code)) return 'unknown';
  switch (code) {
    case 0:
    case 3:
    case 4:
    case 7:
      return 'practice';
    case 1:
    case 8:
      return 'qualifying';
    case 2:
      return 'race';
    default:
      return 'unknown';
  }
}

/**
 * Extracts normalized session type from LMU REST `/rest/watch/sessionInfo` and `/rest/sessions/GetGameState`.
 */
export function parseLmuSessionType(
  sessionInfo?: Record<string, unknown> | null,
  gameState?: Record<string, unknown> | null
): { sessionType: SimSessionType; rawSessionName: string | null } {
  const candidates = [
    sessionInfo?.session,
    sessionInfo?.sessionType,
    sessionInfo?.sessionName,
    gameState?.session,
    gameState?.sessionType,
    gameState?.currentSession,
  ];

  let rawSessionName: string | null = null;
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim()) {
      rawSessionName = cand.trim();
      const parsed = parseGenericSessionType(cand);
      if (parsed !== 'unknown') {
        return { sessionType: parsed, rawSessionName };
      }
    } else if (typeof cand === 'number' && Number.isFinite(cand)) {
      rawSessionName = String(cand);
      const parsed = parseLmuNumericSession(cand);
      if (parsed !== 'unknown') {
        return { sessionType: parsed, rawSessionName };
      }
    }
  }

  // Formation/reconnaissance/countdown phases only appear in Race starts
  const phaseStr = String(
    sessionInfo?.gamePhase ?? gameState?.gamePhase ?? gameState?.state ?? ''
  )
    .trim()
    .toUpperCase();
  if (
    phaseStr.includes('FORMATION') ||
    phaseStr.includes('RECONNAISSANCE') ||
    phaseStr.includes('COUNTDOWN')
  ) {
    return { sessionType: 'race', rawSessionName: rawSessionName ?? phaseStr };
  }

  return { sessionType: 'unknown', rawSessionName };
}

export function formatSessionTypeLabel(
  sessionType?: SimSessionType | null
): 'Practice' | 'Qualifying' | 'Race' | 'Warmup' | null {
  switch (sessionType) {
    case 'practice':
      return 'Practice';
    case 'qualifying':
      return 'Qualifying';
    case 'race':
      return 'Race';
    case 'warmup':
      return 'Warmup';
    default:
      return null;
  }
}

export function getEffectiveSessionType(params: {
  override: SessionPhaseOverride;
  simStatus?: Pick<SimConnectionStatus, 'sessionType' | 'gameRunning'>;
  frameSessionType?: SimSessionType;
}): SimSessionType {
  if (params.override !== 'auto') {
    return params.override;
  }
  if (params.frameSessionType && params.frameSessionType !== 'unknown') {
    return params.frameSessionType;
  }
  if (params.simStatus?.sessionType && params.simStatus.sessionType !== 'unknown') {
    return params.simStatus.sessionType;
  }
  return 'unknown';
}

export function buildSessionTransitionMessage(
  nextType: SimSessionType,
  prevType?: SimSessionType | null,
  protocol: RadioProtocol = 'coaching_detail'
): { cornerLabel: string; message: string } | null {
  if (nextType === 'unknown' || nextType === prevType) {
    return null;
  }
  const direct = protocol === 'pro_terse';
  switch (nextType) {
    case 'practice':
      return {
        cornerLabel: 'Session · Practice',
        message: direct
          ? 'Practice live. Cold slicks — warm slowly, check marks.'
          : 'Practice session detected — no tire warmers in LMU, so build core heat smoothly and verify brake marks and fuel/VE burn.',
      };
    case 'qualifying':
      return {
        cornerLabel: 'Session · Qualifying',
        message: direct
          ? 'Qualifying live. Warm tires on out-lap, respect track limits.'
          : 'Qualifying session live — slicks start cold with no tire warmers. Build temp on the out-lap, leave clean-air gap, and respect exit track limits.',
      };
    case 'warmup':
      return {
        cornerLabel: 'Session · Warmup',
        message: direct
          ? 'Warmup live. Check race bias and MFD fuel/VE.'
          : 'Warmup session detected — check full-tank brake bias, TC map, and pre-set your Pit MFD strategy before the rolling start.',
      };
    case 'race':
      return {
        cornerLabel: 'Session · Race',
        message: direct
          ? 'Race live. Rolling start, cold tires T1 — watch traffic.'
          : 'Race session live — warm cold slicks safely on formation, hold class lane until green at S/F, and manage Fuel/Virtual Energy.',
      };
    default:
      return null;
  }
}
