export type AiServiceStatus = 'ready' | 'rate_limited' | 'unconfigured' | 'auth_error';
export type AiKeySource = 'env' | 'key_file' | 'none';

export interface AiStatusState {
  aiConfigured: boolean;
  aiStatus: AiServiceStatus;
  keySource: AiKeySource;
  rateLimitedUntilMs: number | null;
  availableAtMs?: number | null;
  availableAtIso?: string | null;
  retryAfterSec: number | null;
  isExactGoogleDelay: boolean;
  isDailyLimit: boolean;
  quotaLimit: string | null;
  googleMessage: string | null;
  lastRateLimitMessage: string | null;
  authErrorMessage: string | null;
  lastSuccessAtMs: number | null;
  rateLimitHits: number;
}

export const INITIAL_AI_STATUS: AiStatusState = {
  aiConfigured: false,
  aiStatus: 'unconfigured',
  keySource: 'none',
  rateLimitedUntilMs: null,
  availableAtMs: null,
  availableAtIso: null,
  retryAfterSec: null,
  isExactGoogleDelay: false,
  isDailyLimit: false,
  quotaLimit: null,
  googleMessage: null,
  lastRateLimitMessage: null,
  authErrorMessage: null,
  lastSuccessAtMs: null,
  rateLimitHits: 0,
};

export const AI_STATUS_EVENT = 'apex-ai-status';

export interface GoogleRateLimitParsed {
  retryAfterSec: number | null;
  isExactGoogleDelay: boolean;
  quotaLimit: string | null;
  isDailyLimit: boolean;
  googleMessage: string;
}

/**
 * Calculates the upcoming midnight UTC timestamp for daily quota resets (Google Cloud Generative Language API).
 */
export function getNextDailyResetTimestampMs(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Formats a target timestamp into the local clock time (e.g., "at 14:15:30" or "tomorrow at 02:00:00").
 */
export function formatAvailableAtClock(
  targetMs: number,
  nowMs = Date.now(),
  _language: 'en' = 'en'
): string {
  const target = new Date(targetMs);
  const now = new Date(nowMs);
  const timeStr = target.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const isTomorrow = target.toDateString() !== now.toDateString();
  if (isTomorrow) {
    return `tomorrow at ${timeStr}`;
  }
  return `at ${timeStr}`;
}

/**
 * Formats the remaining time until targetMs into human-friendly duration text (e.g. "25s", "3m 20s", "6h 15m").
 */
export function formatRemainingDuration(
  targetMs: number,
  nowMs = Date.now(),
  _language: 'en' = 'en'
): string {
  const diffSec = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  if (diffSec <= 1) {
    return '1s';
  }
  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  if (diffSec < 3600) {
    const min = Math.floor(diffSec / 60);
    const sec = diffSec % 60;
    return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  }

  const hours = Math.floor(diffSec / 3600);
  const min = Math.floor((diffSec % 3600) / 60);
  return min > 0 ? `${hours}h ${min}m` : `${hours}h`;
}

/**
 * Extracts the EXACT rate limit delay, quota limit name, and Google violation text
 * directly from Google Cloud / Gemini API response objects, headers, or messages.
 * Never invents a random number or arbitrary fallback.
 */
export function parseGoogleRateLimit(
  err: unknown,
  fallbackMessage = 'Google Gemini rate limit'
): GoogleRateLimitParsed {
  let retryAfterSec: number | null = null;
  let isExactGoogleDelay = false;
  let quotaLimit: string | null = null;
  let googleViolationText: string | null = null;
  let isDailyLimit = false;

  const rawMessage = err instanceof Error ? err.message : String(err || fallbackMessage);

  // 1. Inspect HTTP Headers if provided on the error object
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const headers = (obj.headers || obj.responseHeaders) as
      | { get?: (k: string) => string | null; [k: string]: unknown }
      | undefined;
    if (headers) {
      const retryHeader =
        typeof headers.get === 'function'
          ? headers.get('retry-after')
          : (headers['retry-after'] || headers['Retry-After']);
      if (typeof retryHeader === 'string' && retryHeader.trim()) {
        const parsedNum = parseFloat(retryHeader);
        if (Number.isFinite(parsedNum) && parsedNum > 0) {
          retryAfterSec = Math.ceil(parsedNum);
          isExactGoogleDelay = true;
        } else {
          const parsedDate = Date.parse(retryHeader);
          if (Number.isFinite(parsedDate) && parsedDate > Date.now()) {
            retryAfterSec = Math.ceil((parsedDate - Date.now()) / 1000);
            isExactGoogleDelay = true;
          }
        }
      }
    }
  }

  // 2. Inspect structured Google error payload (err.error, err.body, etc.)
  let payload: Record<string, unknown> | null = null;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (obj.error && typeof obj.error === 'object') {
      payload = obj.error as Record<string, unknown>;
    } else if (typeof obj.body === 'string') {
      try {
        const parsed = JSON.parse(obj.body);
        payload = parsed.error || parsed;
      } catch {
        // ignore JSON parse error
      }
    }
  }

  if (payload && Array.isArray(payload.details)) {
    for (const detail of payload.details) {
      if (!detail || typeof detail !== 'object') continue;
      const type = String(detail['@type'] || '');
      if (type.includes('RetryInfo') && detail.retryDelay) {
        if (typeof detail.retryDelay === 'string') {
          const match = detail.retryDelay.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
          if (match) {
            retryAfterSec = Math.ceil(parseFloat(match[1]));
            isExactGoogleDelay = true;
          }
        } else if (typeof detail.retryDelay === 'object' && detail.retryDelay.seconds) {
          retryAfterSec = Math.ceil(Number(detail.retryDelay.seconds));
          isExactGoogleDelay = true;
        }
      } else if (type.includes('QuotaFailure') && Array.isArray(detail.violations)) {
        for (const v of detail.violations) {
          if (v && typeof v.description === 'string') {
            googleViolationText = v.description;
          }
        }
      } else if (type.includes('ErrorInfo') && detail.metadata) {
        const meta = detail.metadata as Record<string, unknown>;
        if (typeof meta.quota_limit === 'string') {
          quotaLimit = meta.quota_limit;
        }
      }
    }
  }

  // 3. Inspect text in rawMessage & violation text
  const fullText = (googleViolationText ? googleViolationText + ' ' : '') + rawMessage;

  if (retryAfterSec === null) {
    const matchSec =
      fullText.match(/retry\s*(?:in|after)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:seconds|s)\b/i) ||
      fullText.match(/retryDelay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)s/i);
    if (matchSec) {
      retryAfterSec = Math.ceil(parseFloat(matchSec[1]));
      isExactGoogleDelay = true;
    }
  }

  if (retryAfterSec === null) {
    const matchDate = fullText.match(/retry\s*(?:after)?\s*(\d{4}-\d{2}-\d{2}T[\d:\.Z]+)/i);
    if (matchDate) {
      const parsedDate = Date.parse(matchDate[1]);
      if (Number.isFinite(parsedDate) && parsedDate > Date.now()) {
        retryAfterSec = Math.ceil((parsedDate - Date.now()) / 1000);
        isExactGoogleDelay = true;
      }
    }
  }

  if (/requests per day|per day|day quota|1500 RPD/i.test(fullText)) {
    isDailyLimit = true;
  }

  if (!quotaLimit) {
    if (/requests per minute|GenerateContentRequestsPerMinute/i.test(fullText)) {
      quotaLimit = 'Requests per minute (RPM)';
    } else if (isDailyLimit) {
      quotaLimit = 'Requests per day (RPD)';
    } else if (/tokens per minute/i.test(fullText)) {
      quotaLimit = 'Tokens per minute (TPM)';
    }
  }

  let cleanGoogleMessage = googleViolationText || rawMessage;
  try {
    const jsonMatch = cleanGoogleMessage.match(/\{[\s\S]*"message"\s*:\s*"([\s\S]*?)"[\s\S]*\}/);
    if (jsonMatch) {
      cleanGoogleMessage = jsonMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
    } else if (cleanGoogleMessage.trim().startsWith('{')) {
      const parsed = JSON.parse(cleanGoogleMessage);
      if (parsed.error?.message) {
        cleanGoogleMessage = String(parsed.error.message).replace(/\\n/g, ' ').trim();
      }
    }
  } catch {
    // ignore
  }

  if (cleanGoogleMessage.length > 280) {
    cleanGoogleMessage = cleanGoogleMessage.slice(0, 277) + '...';
  }

  return {
    retryAfterSec,
    isExactGoogleDelay,
    quotaLimit,
    isDailyLimit,
    googleMessage: cleanGoogleMessage,
  };
}

export function computeRemainingCooldownSec(
  state: AiStatusState,
  nowMs = Date.now()
): number {
  if (state.aiStatus !== 'rate_limited') return 0;
  if (state.isDailyLimit) return 0; // Daily quotas reset at 00:00 UTC; no arbitrary seconds countdown
  if (state.rateLimitedUntilMs) {
    if (state.rateLimitedUntilMs <= nowMs) return 0;
    return Math.max(1, Math.ceil((state.rateLimitedUntilMs - nowMs) / 1000));
  }
  if (typeof state.retryAfterSec === 'number' && state.retryAfterSec > 0) {
    return state.retryAfterSec;
  }
  return 0;
}

export function getEffectiveAiStatus(
  state: AiStatusState,
  nowMs = Date.now()
): AiServiceStatus {
  if (state.aiStatus === 'rate_limited') {
    if (state.rateLimitedUntilMs && state.rateLimitedUntilMs <= nowMs) {
      return state.aiConfigured ? 'ready' : 'unconfigured';
    }
  }
  return state.aiStatus;
}

export function publishAiStatus(status: AiStatusState): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AiStatusState>(AI_STATUS_EVENT, { detail: status }));
}

export function extractAndPublishAiStatus(
  httpStatus: number,
  data: unknown
): AiStatusState | null {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (record.aiStatus && typeof record.aiStatus === 'object') {
      const snapshot = record.aiStatus as AiStatusState;
      publishAiStatus(snapshot);
      return snapshot;
    }

    if (httpStatus === 429 || record.code === 'RATE_LIMIT' || record.rateLimited === true) {
      const parsed = parseGoogleRateLimit(
        typeof record.error === 'string' ? record.error : record
      );
      const retrySec = typeof record.retryAfterSec === 'number' ? record.retryAfterSec : parsed.retryAfterSec;
      const isExact = record.isExactGoogleDelay === true || parsed.isExactGoogleDelay;
      const isDaily = record.isDailyLimit === true || parsed.isDailyLimit;

      const now = Date.now();
      const targetUntilMs =
        typeof record.rateLimitedUntilMs === 'number'
          ? record.rateLimitedUntilMs
          : typeof record.availableAtMs === 'number'
            ? record.availableAtMs
            : retrySec !== null && retrySec > 0
              ? now + retrySec * 1000
              : isDaily
                ? getNextDailyResetTimestampMs(now)
                : null;

      const snapshot: AiStatusState = {
        aiConfigured: true,
        aiStatus: 'rate_limited',
        keySource: 'env',
        rateLimitedUntilMs: targetUntilMs,
        availableAtMs: targetUntilMs,
        availableAtIso: targetUntilMs ? new Date(targetUntilMs).toISOString() : null,
        retryAfterSec: retrySec,
        isExactGoogleDelay: isExact,
        isDailyLimit: isDaily,
        quotaLimit: typeof record.quotaLimit === 'string' ? record.quotaLimit : parsed.quotaLimit,
        googleMessage: parsed.googleMessage,
        lastRateLimitMessage: parsed.googleMessage,
        authErrorMessage: null,
        lastSuccessAtMs: null,
        rateLimitHits: 1,
      };
      publishAiStatus(snapshot);
      return snapshot;
    }

    if (httpStatus === 401 || record.code === 'INVALID_KEY') {
      const snapshot: AiStatusState = {
        aiConfigured: true,
        aiStatus: 'auth_error',
        keySource: 'env',
        rateLimitedUntilMs: null,
        availableAtMs: null,
        availableAtIso: null,
        retryAfterSec: null,
        isExactGoogleDelay: false,
        isDailyLimit: false,
        quotaLimit: null,
        googleMessage: null,
        lastRateLimitMessage: null,
        authErrorMessage:
          typeof record.error === 'string' ? record.error : 'Gemini API key rejected.',
        lastSuccessAtMs: null,
        rateLimitHits: 0,
      };
      publishAiStatus(snapshot);
      return snapshot;
    }
  }
  return null;
}

export interface AiStatusDisplay {
  effectiveStatus: AiServiceStatus;
  remainingSec: number;
  availableAtMs: number | null;
  availableAtClock: string | null;
  remainingDurationText: string | null;
  tone: 'emerald' | 'amber' | 'rose' | 'slate';
  pillLabel: string;
  sourceLabel: string;
  bannerTitle: string | null;
  bannerDetail: string | null;
}

export function formatAiStatusDisplay(
  state: AiStatusState,
  _language: 'en' = 'en',
  nowMs = Date.now()
): AiStatusDisplay {
  const effectiveStatus = getEffectiveAiStatus(state, nowMs);
  const remainingSec = effectiveStatus === 'rate_limited' ? computeRemainingCooldownSec(state, nowMs) : 0;

  const targetAvailableMs =
    effectiveStatus === 'rate_limited'
      ? state.rateLimitedUntilMs ??
        (state.isDailyLimit
          ? getNextDailyResetTimestampMs(nowMs)
          : state.retryAfterSec && state.retryAfterSec > 0
            ? nowMs + state.retryAfterSec * 1000
            : null)
      : null;

  const availableAtClock = targetAvailableMs
    ? formatAvailableAtClock(targetAvailableMs, nowMs, 'en')
    : null;
  const remainingDurationText = targetAvailableMs
    ? formatRemainingDuration(targetAvailableMs, nowMs, 'en')
    : null;

  const sourceLabel =
    state.keySource === 'key_file'
      ? '00_ADD_API_KEY_HERE.txt'
      : state.keySource === 'env'
        ? 'Environment (.env / Secrets)'
        : 'Not configured';

  if (effectiveStatus === 'rate_limited') {
    const timeDetailSuffix =
      availableAtClock && remainingDurationText
        ? `Available again ${availableAtClock} (in ${remainingDurationText})`
        : null;

    if (state.isDailyLimit) {
      return {
        effectiveStatus,
        remainingSec,
        availableAtMs: targetAvailableMs,
        availableAtClock,
        remainingDurationText,
        tone: 'amber',
        pillLabel: availableAtClock ? `Daily limit (${availableAtClock})` : 'Google: Daily limit',
        sourceLabel,
        bannerTitle: `Google Daily Requests Limit Reached (1,500 RPD) — ${timeDetailSuffix ?? 'Resets midnight UTC'}`,
        bannerDetail: `Google free-tier daily requests limit reached. Available again ${availableAtClock ?? 'at midnight UTC'} (in ${remainingDurationText ?? 'a few hours'}). Telemetry, racecraft radar, setups, and browser voice continue normally.`,
      };
    }

    if (state.isExactGoogleDelay && remainingSec > 0) {
      const limitName = state.quotaLimit || 'Requests per minute';
      return {
        effectiveStatus,
        remainingSec,
        availableAtMs: targetAvailableMs,
        availableAtClock,
        remainingDurationText,
        tone: 'amber',
        pillLabel: availableAtClock
          ? `Google Rate Limit (${availableAtClock} · ${remainingSec}s)`
          : `Google Rate Limit (${remainingSec}s)`,
        sourceLabel,
        bannerTitle: `Google Rate Limit (${limitName}) — ${timeDetailSuffix ?? `retry in ${remainingSec}s`}`,
        bannerDetail: `Google requested waiting until ${availableAtClock ?? `in ${remainingSec}s`} (${remainingDurationText ?? `${remainingSec}s`} remaining). Telemetry, radar, LMU setups, and browser voice continue normally.`,
      };
    }

    return {
      effectiveStatus,
      remainingSec,
      availableAtMs: targetAvailableMs,
      availableAtClock,
      remainingDurationText,
      tone: 'amber',
      pillLabel: availableAtClock ? `Google Quota (${availableAtClock})` : 'Google Quota Exceeded',
      sourceLabel,
      bannerTitle: `Google Gemini Quota Limit Exceeded (RESOURCE_EXHAUSTED)${timeDetailSuffix ? ` — ${timeDetailSuffix}` : ''}`,
      bannerDetail:
        state.googleMessage ||
        'Google quota temporarily exhausted. Click "Check with Google" to probe status now.',
    };
  }

  if (effectiveStatus === 'auth_error') {
    return {
      effectiveStatus,
      remainingSec: 0,
      availableAtMs: null,
      availableAtClock: null,
      remainingDurationText: null,
      tone: 'rose',
      pillLabel: 'API Key Invalid',
      sourceLabel,
      bannerTitle: 'Gemini API key was rejected (Invalid / Expired)',
      bannerDetail:
        'Verify the key saved in 00_ADD_API_KEY_HERE.txt and save (Ctrl+S). Telemetry and local coaching rules remain active.',
    };
  }

  if (effectiveStatus === 'ready') {
    return {
      effectiveStatus,
      remainingSec: 0,
      availableAtMs: null,
      availableAtClock: null,
      remainingDurationText: null,
      tone: 'emerald',
      pillLabel: 'API Key: Active',
      sourceLabel,
      bannerTitle: null,
      bannerDetail: null,
    };
  }

  return {
    effectiveStatus,
    remainingSec: 0,
    availableAtMs: null,
    availableAtClock: null,
    remainingDurationText: null,
    tone: 'slate',
    pillLabel: 'API Key: Not Set',
    sourceLabel,
    bannerTitle: 'Gemini API key not configured yet (Offline Coaching Active)',
    bannerDetail:
      'Open 00_ADD_API_KEY_HERE.txt in the app folder to add your free Gemini API key. Without a key, telemetry, racecraft radar, LMU setups, and browser voice still work offline.',
  };
}
