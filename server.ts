import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import dgram from 'node:dgram';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  ThinkingLevel,
  Type,
} from '@google/genai';
import {
  findLmuPlayerVehicle,
  isLmuInPitOrGarage,
  isLmuPaused,
} from './src/engine/lmuSinglePlayer.ts';
import {
  parseGenericSessionType,
  parseLmuSessionType,
} from './src/engine/sessionPhase.ts';
import {
  parseLmuObjectOutBuffer,
  parseRf2SharedMemoryBuffers,
} from './src/engine/lmuSharedMemory.ts';
import {
  buildEnglishOnlyPromptDirective,
  buildLiveOutputTranscriptionConfig,
  buildLiveVoiceSpeechConfig,
  buildLmuSystemKnowledgeBlock,
  buildVoiceProfilePromptDirective,
  getLmuCarClassRules,
  normalizeCarClass,
  normalizeGeminiLiveVoiceName,
  VOICE_PROFILE_DEFS,
} from './src/engine/lmuKnowledge.ts';
import type { RadioProtocol, SimSessionType } from './src/types/telemetry.ts';

const runtimeDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);

export type AiServiceStatus = 'ready' | 'rate_limited' | 'unconfigured' | 'auth_error';
export type AiKeySource = 'env' | 'key_file' | 'none';

export interface AiStatusSnapshot {
  aiConfigured: boolean;
  aiStatus: AiServiceStatus;
  keySource: AiKeySource;
  rateLimitedUntilMs: number | null;
  availableAtMs: number | null;
  availableAtIso: string | null;
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

const aiRuntimeState = {
  rateLimitedUntilMs: null as number | null,
  retryAfterSec: null as number | null,
  isExactGoogleDelay: false,
  isDailyLimit: false,
  quotaLimit: null as string | null,
  googleMessage: null as string | null,
  lastRateLimitMessage: null as string | null,
  authErrorMessage: null as string | null,
  lastSuccessAtMs: null as number | null,
  rateLimitHits: 0,
  lastSeenKeyFingerprint: null as string | null,
};

// Dedicated quota tracker for gemini-3.8-flash-lite-tts so TTS daily/RPM limits
// never lock out text coaching, speech transcription, or Live Voice conversations.
const ttsRuntimeState = {
  rateLimitedUntilMs: null as number | null,
  isDailyLimit: false,
  quotaLimit: null as string | null,
  retryAfterSec: null as number | null,
};

function isPlaceholderKey(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return !trimmed || trimmed === 'MY_GEMINI_API_KEY' || trimmed === 'ADD_YOUR_API_KEY_HERE';
}

function resolveGeminiApiKeyDetail(): { apiKey: string | null; keySource: AiKeySource } {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (!isPlaceholderKey(envKey)) {
    return { apiKey: envKey!, keySource: 'env' };
  }

  const keyFileCandidates = [
    path.join(runtimeDir, '00_ADD_API_KEY_HERE.txt'),
    path.join(runtimeDir, '..', '00_ADD_API_KEY_HERE.txt'),
    path.join(process.cwd(), '00_ADD_API_KEY_HERE.txt'),
  ];
  for (const filePath of keyFileCandidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const cleaned = line
          .replace(/^GEMINI_API_KEY\s*=\s*/i, '')
          .replace(/^["']|["']$/g, '')
          .trim();
        if (!isPlaceholderKey(cleaned)) {
          return { apiKey: cleaned, keySource: 'key_file' };
        }
      }
    } catch {
      // ignore file read errors
    }
  }
  return { apiKey: null, keySource: 'none' };
}

function resolveGeminiApiKey(): string | null {
  return resolveGeminiApiKeyDetail().apiKey;
}

function syncKeyFingerprint(apiKey: string | null): void {
  const nextFingerprint = apiKey ? `${apiKey.length}:${apiKey.slice(-4)}` : null;
  if (nextFingerprint !== aiRuntimeState.lastSeenKeyFingerprint) {
    aiRuntimeState.lastSeenKeyFingerprint = nextFingerprint;
    aiRuntimeState.authErrorMessage = null;
    aiRuntimeState.rateLimitedUntilMs = null;
    aiRuntimeState.retryAfterSec = null;
    aiRuntimeState.isExactGoogleDelay = false;
    aiRuntimeState.isDailyLimit = false;
    aiRuntimeState.quotaLimit = null;
    aiRuntimeState.googleMessage = null;
    aiRuntimeState.lastRateLimitMessage = null;
    ttsRuntimeState.rateLimitedUntilMs = null;
    ttsRuntimeState.isDailyLimit = false;
    ttsRuntimeState.quotaLimit = null;
    ttsRuntimeState.retryAfterSec = null;
  }
}

function recordAiSuccess(): void {
  aiRuntimeState.rateLimitedUntilMs = null;
  aiRuntimeState.retryAfterSec = null;
  aiRuntimeState.isExactGoogleDelay = false;
  aiRuntimeState.isDailyLimit = false;
  aiRuntimeState.quotaLimit = null;
  aiRuntimeState.googleMessage = null;
  aiRuntimeState.lastRateLimitMessage = null;
  aiRuntimeState.authErrorMessage = null;
  aiRuntimeState.lastSuccessAtMs = Date.now();
}

interface GoogleRateLimitDetail {
  retryAfterSec: number | null;
  isExactGoogleDelay: boolean;
  quotaLimit: string | null;
  isDailyLimit: boolean;
  googleMessage: string;
}

function parseGoogleRateLimit(err: unknown, fallbackMessage = 'Google Gemini rate limit'): GoogleRateLimitDetail {
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

function getNextDailyResetTimestampMs(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function getAiStatusSnapshot(): AiStatusSnapshot {
  const { apiKey, keySource } = resolveGeminiApiKeyDetail();
  syncKeyFingerprint(apiKey);

  if (!apiKey) {
    return {
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
      lastSuccessAtMs: aiRuntimeState.lastSuccessAtMs,
      rateLimitHits: aiRuntimeState.rateLimitHits,
    };
  }

  if (aiRuntimeState.authErrorMessage) {
    return {
      aiConfigured: true,
      aiStatus: 'auth_error',
      keySource,
      rateLimitedUntilMs: null,
      availableAtMs: null,
      availableAtIso: null,
      retryAfterSec: null,
      isExactGoogleDelay: false,
      isDailyLimit: false,
      quotaLimit: null,
      googleMessage: null,
      lastRateLimitMessage: aiRuntimeState.lastRateLimitMessage,
      authErrorMessage: aiRuntimeState.authErrorMessage,
      lastSuccessAtMs: aiRuntimeState.lastSuccessAtMs,
      rateLimitHits: aiRuntimeState.rateLimitHits,
    };
  }

  const now = Date.now();
  if (aiRuntimeState.isDailyLimit) {
    const dailyResetMs = getNextDailyResetTimestampMs(now);
    return {
      aiConfigured: true,
      aiStatus: 'rate_limited',
      keySource,
      rateLimitedUntilMs: dailyResetMs,
      availableAtMs: dailyResetMs,
      availableAtIso: new Date(dailyResetMs).toISOString(),
      retryAfterSec: null,
      isExactGoogleDelay: false,
      isDailyLimit: true,
      quotaLimit: aiRuntimeState.quotaLimit || 'Requests per day (RPD)',
      googleMessage: aiRuntimeState.googleMessage,
      lastRateLimitMessage: aiRuntimeState.lastRateLimitMessage,
      authErrorMessage: null,
      lastSuccessAtMs: aiRuntimeState.lastSuccessAtMs,
      rateLimitHits: aiRuntimeState.rateLimitHits,
    };
  }

  if (aiRuntimeState.rateLimitedUntilMs && aiRuntimeState.rateLimitedUntilMs > now) {
    const remainingSec = Math.max(1, Math.ceil((aiRuntimeState.rateLimitedUntilMs - now) / 1000));
    return {
      aiConfigured: true,
      aiStatus: 'rate_limited',
      keySource,
      rateLimitedUntilMs: aiRuntimeState.rateLimitedUntilMs,
      availableAtMs: aiRuntimeState.rateLimitedUntilMs,
      availableAtIso: new Date(aiRuntimeState.rateLimitedUntilMs).toISOString(),
      retryAfterSec: remainingSec,
      isExactGoogleDelay: aiRuntimeState.isExactGoogleDelay,
      isDailyLimit: false,
      quotaLimit: aiRuntimeState.quotaLimit,
      googleMessage: aiRuntimeState.googleMessage,
      lastRateLimitMessage: aiRuntimeState.lastRateLimitMessage,
      authErrorMessage: null,
      lastSuccessAtMs: aiRuntimeState.lastSuccessAtMs,
      rateLimitHits: aiRuntimeState.rateLimitHits,
    };
  }

  if (aiRuntimeState.rateLimitedUntilMs && aiRuntimeState.rateLimitedUntilMs <= now) {
    aiRuntimeState.rateLimitedUntilMs = null;
    aiRuntimeState.retryAfterSec = null;
    aiRuntimeState.isExactGoogleDelay = false;
    aiRuntimeState.isDailyLimit = false;
    aiRuntimeState.quotaLimit = null;
  }

  return {
    aiConfigured: true,
    aiStatus: 'ready',
    keySource,
    rateLimitedUntilMs: null,
    availableAtMs: null,
    availableAtIso: null,
    retryAfterSec: null,
    isExactGoogleDelay: false,
    isDailyLimit: false,
    quotaLimit: null,
    googleMessage: null,
    lastRateLimitMessage: aiRuntimeState.lastRateLimitMessage,
    authErrorMessage: null,
    lastSuccessAtMs: aiRuntimeState.lastSuccessAtMs,
    rateLimitHits: aiRuntimeState.rateLimitHits,
  };
}

function classifyAndRecordAiError(err: unknown, fallbackMessage: string): {
  statusCode: number;
  code: 'RATE_LIMIT' | 'INVALID_KEY' | 'AI_ERROR';
  message: string;
  retryAfterSec?: number | null;
  isExactGoogleDelay: boolean;
  quotaLimit: string | null;
  isDailyLimit: boolean;
  availableAtMs?: number | null;
  availableAtIso?: string | null;
  aiStatus: AiStatusSnapshot;
} {
  const rawMessage = err instanceof Error ? err.message : String(err || fallbackMessage);
  const statusHint =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined;

  const isRateLimit =
    statusHint === 429 ||
    /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests|requests per minute|requests per day/i.test(
      rawMessage
    );

  if (isRateLimit) {
    const details = parseGoogleRateLimit(err, fallbackMessage);
    const now = Date.now();
    let targetUntilMs: number | null = null;
    if (details.retryAfterSec !== null && details.retryAfterSec > 0) {
      targetUntilMs = now + details.retryAfterSec * 1000;
    } else if (details.isDailyLimit) {
      targetUntilMs = getNextDailyResetTimestampMs(now);
    }

    aiRuntimeState.rateLimitedUntilMs = targetUntilMs;
    aiRuntimeState.retryAfterSec = details.retryAfterSec;
    aiRuntimeState.isExactGoogleDelay = details.isExactGoogleDelay;
    aiRuntimeState.isDailyLimit = details.isDailyLimit;
    aiRuntimeState.quotaLimit = details.quotaLimit;
    aiRuntimeState.googleMessage = details.googleMessage;
    aiRuntimeState.lastRateLimitMessage = details.googleMessage;
    aiRuntimeState.rateLimitHits += 1;

    let userMsg = '';
    const availableIso = targetUntilMs ? new Date(targetUntilMs).toISOString() : null;
    const targetClockStr = targetUntilMs
      ? new Date(targetUntilMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : null;

    if (details.isExactGoogleDelay && details.retryAfterSec !== null) {
      userMsg = `Google Gemini rate limit: please retry in ${details.retryAfterSec}s (available at ${targetClockStr ?? `${details.retryAfterSec}s`}, ${details.quotaLimit || 'RPM quota'}).`;
    } else if (details.isDailyLimit) {
      userMsg = `Google Gemini daily quota reached (${details.quotaLimit || 'Requests per day / 1500 RPD'}). Resets at 00:00 UTC (available tomorrow at ${targetClockStr ?? 'midnight UTC'}).`;
    } else {
      userMsg = `Google Gemini quota exceeded: ${details.googleMessage}`;
    }

    return {
      statusCode: 429,
      code: 'RATE_LIMIT',
      retryAfterSec: details.retryAfterSec,
      isExactGoogleDelay: details.isExactGoogleDelay,
      quotaLimit: details.quotaLimit,
      isDailyLimit: details.isDailyLimit,
      availableAtMs: targetUntilMs,
      availableAtIso: availableIso,
      message: userMsg,
      aiStatus: getAiStatusSnapshot(),
    };
  }

  const isInvalidKey =
    statusHint === 401 ||
    statusHint === 403 ||
    /API_KEY_INVALID|API key not valid|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(
      rawMessage
    );

  if (isInvalidKey) {
    aiRuntimeState.authErrorMessage = rawMessage.slice(0, 260);
    return {
      statusCode: 401,
      code: 'INVALID_KEY',
      retryAfterSec: null,
      isExactGoogleDelay: false,
      quotaLimit: null,
      isDailyLimit: false,
      availableAtMs: null,
      availableAtIso: null,
      message: 'Gemini API key was rejected (invalid or expired). Check 00_ADD_API_KEY_HERE.txt.',
      aiStatus: getAiStatusSnapshot(),
    };
  }

  let cleanMessage = rawMessage || fallbackMessage;
  if (cleanMessage.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(cleanMessage) as { error?: { message?: string; code?: number } };
      if (parsed?.error?.message) {
        cleanMessage = parsed.error.message;
      }
    } catch {
      // keep cleanMessage as-is
    }
  }

  const isUnavailable =
    statusHint === 503 ||
    /\b503\b|UNAVAILABLE|high demand|overloaded/i.test(rawMessage);

  return {
    statusCode: isUnavailable ? 503 : 500,
    code: 'AI_ERROR',
    retryAfterSec: null,
    isExactGoogleDelay: false,
    quotaLimit: null,
    isDailyLimit: false,
    availableAtMs: null,
    availableAtIso: null,
    message: isUnavailable
      ? `Gemini model is experiencing temporary high demand (503). Please try again in a few seconds.`
      : cleanMessage,
    aiStatus: getAiStatusSnapshot(),
  };
}

function checkActiveRateLimit(): {
  blocked: boolean;
  responsePayload?: {
    error: string;
    code: string;
    retryAfterSec: number | null;
    isExactGoogleDelay: boolean;
    quotaLimit: string | null;
    isDailyLimit: boolean;
    availableAtMs: number | null;
    availableAtIso: string | null;
    aiStatus: AiStatusSnapshot;
  };
} {
  const now = Date.now();
  if (aiRuntimeState.isDailyLimit) {
    const dailyResetMs = getNextDailyResetTimestampMs(now);
    const targetClockStr = new Date(dailyResetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return {
      blocked: true,
      responsePayload: {
        error: `Google Gemini daily quota limit reached (${aiRuntimeState.quotaLimit || '1500 RPD'}). Free quota resets at 00:00 UTC (available tomorrow at ${targetClockStr}).`,
        code: 'RATE_LIMIT',
        retryAfterSec: null,
        isExactGoogleDelay: false,
        quotaLimit: aiRuntimeState.quotaLimit || 'Requests per day (RPD)',
        isDailyLimit: true,
        availableAtMs: dailyResetMs,
        availableAtIso: new Date(dailyResetMs).toISOString(),
        aiStatus: getAiStatusSnapshot(),
      },
    };
  }

  if (aiRuntimeState.rateLimitedUntilMs && aiRuntimeState.rateLimitedUntilMs > now) {
    const remainingSec = Math.max(1, Math.ceil((aiRuntimeState.rateLimitedUntilMs - now) / 1000));
    const targetClockStr = new Date(aiRuntimeState.rateLimitedUntilMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return {
      blocked: true,
      responsePayload: {
        error: `Google Gemini rate limit active. Retry in ${remainingSec}s (available at ${targetClockStr}, ${aiRuntimeState.quotaLimit || 'Requests per minute'}).`,
        code: 'RATE_LIMIT',
        retryAfterSec: remainingSec,
        isExactGoogleDelay: true,
        quotaLimit: aiRuntimeState.quotaLimit,
        isDailyLimit: false,
        availableAtMs: aiRuntimeState.rateLimitedUntilMs,
        availableAtIso: new Date(aiRuntimeState.rateLimitedUntilMs).toISOString(),
        aiStatus: getAiStatusSnapshot(),
      },
    };
  }

  return { blocked: false };
}

function getAiClient(apiVersion?: 'v1' | 'v1beta' | 'v1alpha'): GoogleGenAI | null {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isTransientAiOverloadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  return status === 503 || /\b503\b|UNAVAILABLE|high demand|overloaded/i.test(msg);
}

function isModelNotFoundOrUnsupportedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  return (
    status === 404 ||
    /not found for API version|is not supported for generateContent|NOT_FOUND/i.test(msg)
  );
}

async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
  fallbackModel?: string
) {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isTransientAiOverloadError(err)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  if (fallbackModel && fallbackModel !== params.model) {
    const nextConfig =
      params.config && typeof params.config === 'object' && fallbackModel === 'gemini-3.1-flash-lite'
        ? {
            ...params.config,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          }
        : params.config;
    return await ai.models.generateContent({
      ...params,
      model: fallbackModel,
      ...(nextConfig ? { config: nextConfig } : {}),
    });
  }
  throw lastErr;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const server = http.createServer(app);
  const telemetryWss = new WebSocketServer({ noServer: true });
  const liveCoachWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    const protocol = String(request.headers['sec-websocket-protocol'] || '');
    if (pathname === '/ws/telemetry') {
      telemetryWss.handleUpgrade(request, socket, head, (ws) => {
        telemetryWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/live-coach') {
      liveCoachWss.handleUpgrade(request, socket, head, (ws) => {
        liveCoachWss.emit('connection', ws, request);
      });
    } else if (
      process.env.NODE_ENV !== 'production' &&
      (pathname === '/__vite_hmr' || protocol === 'vite-hmr' || protocol === 'vite-ping')
    ) {
      // Let Vite's middleware WebSocketServer handle this upgrade on `server`
      return;
    } else {
      socket.destroy();
    }
  });

  const telemetryClients = new Set<WebSocket>();
  let lastSessionPayload: {
    simId?: string;
    trackName?: string;
    trackLengthKm?: number;
    carName?: string;
    carClass?: string;
    maxRpm?: number;
  } | null = null;

  type LiveSimStatus = {
    gameRunning: boolean;
    simId: 'lmu' | 'acc' | 'iracing' | 'rf2' | null;
    gameName: string | null;
    connectionState: 'offline' | 'menus' | 'in_pit' | 'on_track';
    sessionType: SimSessionType;
    rawSessionName: string | null;
    source: 'none' | 'lmu-rest' | 'shared-memory' | 'udp-5606';
    telemetryQuality: 'none' | 'partial_rest' | 'full';
    lastPacketAtMs: number | null;
    rawTrackName: string | null;
    rawCarName: string | null;
    note?: string;
  };

  let currentSimStatus: LiveSimStatus = {
    gameRunning: false,
    simId: null,
    gameName: null,
    connectionState: 'offline',
    sessionType: 'unknown',
    rawSessionName: null,
    source: 'none',
    telemetryQuality: 'none',
    lastPacketAtMs: null,
    rawTrackName: null,
    rawCarName: null,
  };
  let lastBroadcastStatusJson = '';

  const broadcastSimStatus = (patch?: Partial<LiveSimStatus>, force = false) => {
    if (patch) {
      currentSimStatus = { ...currentSimStatus, ...patch };
    }
    const serialized = JSON.stringify({ type: 'sim_status', status: currentSimStatus });
    if (!force && serialized === lastBroadcastStatusJson) return;
    lastBroadcastStatusJson = serialized;
    for (const client of telemetryClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  };

  telemetryWss.on('connection', (ws) => {
    telemetryClients.add(ws);
    ws.send(JSON.stringify({ type: 'sim_status', status: currentSimStatus }));
    if (lastSessionPayload) {
      ws.send(JSON.stringify({ type: 'session_detected', session: lastSessionPayload }));
    }
    ws.on('message', (raw) => {
      const text = raw.toString();
      for (const client of telemetryClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(text);
        }
      }
    });
    ws.on('close', () => {
      telemetryClients.delete(ws);
    });
  });

  // Bidirectional Gemini Live API voice conversation endpoint
  liveCoachWss.on('connection', async (clientWs, req) => {
    const hasKey = Boolean(resolveGeminiApiKey());
    if (!hasKey) {
      clientWs.send(JSON.stringify({ error: 'Gemini API key is not configured.' }));
      clientWs.close();
      return;
    }

    const url = new URL(req.url || '/ws/live-coach', `http://${req.headers.host || 'localhost'}`);
    const simName = url.searchParams.get('simName') || 'Le Mans Ultimate';
    const trackName = url.searchParams.get('trackName') || 'Circuit de la Sarthe';
    const carName = url.searchParams.get('carName') || 'Porsche 963 LMDh';
    const carClass = normalizeCarClass(url.searchParams.get('carClass') || carName);
    const classRules = getLmuCarClassRules(carClass);
    const rawVoice = url.searchParams.get('voiceName') || 'Fenrir';
    const voiceName = normalizeGeminiLiveVoiceName(rawVoice);
    const rawProtocol = url.searchParams.get('radioProtocol');
    const radioProtocol: RadioProtocol =
      rawProtocol === 'pro_terse' || rawProtocol === 'endurance_calm' || rawProtocol === 'coaching_detail'
        ? rawProtocol
        : 'pro_terse';
    const sessionPhase = url.searchParams.get('sessionPhase') || 'unknown';
    const rawVeParam = url.searchParams.get('virtualEnergyPct');
    const initialVePct = rawVeParam !== null && Number.isFinite(Number(rawVeParam)) ? Number(rawVeParam) : undefined;
    const isNewToGame = url.searchParams.get('isNewToGame') === 'true';
    const autonomyMode = url.searchParams.get('autonomyMode') === 'hands_on' ? 'hands_on' : 'advise';
    const sessionState = url.searchParams.get('sessionState') || 'standby_offline';
    const initialSpeedKmh = Number(url.searchParams.get('speedKmh') || '0') || 0;
    const initialCorner = url.searchParams.get('currentCorner') || 'Garage / Standby';
    const languageInstruction = buildEnglishOnlyPromptDirective('live_voice');

    const electronicsList = classRules.hasAbs
      ? 'Traction Control (TC1/TC2), ABS, and Brake Bias'
      : 'Brake Bias, Brake Migration, and Traction Control (TC) — note this car class has NO ABS';

    const skillGuidance = isNewToGame
      ? `The driver is new to the game: keep tone encouraging, give slightly earlier braking warnings, and proactively suggest safer ${electronicsList} plus clear pit stop strategy.`
      : `The driver is experienced: focus on razor-sharp trail-braking release, minimum apex speed, ${classRules.hasBrakeMigration ? 'brake bias migration, ' : ''}and race strategy.`;

    const autonomyGuidance =
      autonomyMode === 'hands_on'
        ? `Engineer Autonomy is AUTO-APPLY (Hands-On): you have authority to automatically adjust ${electronicsList} when immediate instability is detected, confirming changes concisely.`
        : `Engineer Autonomy is ADVISE-ONLY: recommend ${electronicsList} changes verbally for the driver to apply manually.`;

    const racecraftGuidance =
      'Act as live racecraft & multiclass spotter: warn immediately when a rival behind is closing, announce cars alongside, and enforce LMU multiclass etiquette (faster prototype passes off-line; slower car stays on the predictable line).';

    const tireGuidance =
      `Actively monitor tire temperatures (LMU has NO tire warmers; ${carClass} optimal ${classRules.optimalTireTempRangeC[0]}–${classRules.optimalTireTempRangeC[1]}°C) and wear — confirm warmup, warn on overheat, and check tire feel if wear <= 74%.`;

    const lmuKnowledgeBlock = buildLmuSystemKnowledgeBlock({
      carClass,
      carName,
      trackName,
      sessionPhase,
      virtualEnergyPct: initialVePct,
    });
    const voiceProfileDirective = buildVoiceProfilePromptDirective(radioProtocol);

    const truthRule =
      `STRICT TELEMETRY TRUTH RULE (ZERO HALLUCINATION): Initial session state is ${sessionState} (speed=${initialSpeedKmh} km/h, location=${initialCorner}), and you will receive [TELEMETRY STATE SYNC] updates carrying live Speed, Gear, Lap, Corner, Delta, Fuel, PitWindowLap, VirtualEnergyPct, TireTempC, TireWearPct, TirePsi, BrakeTempC, Electronics (Bias/TC/ABS), Flag/Penalty/FormationLap, and Racecraft/Opponents. When the driver asks about tire temps, fuel, wear, brakes, electronics, pit window, or gaps, answer directly from the latest [TELEMETRY STATE SYNC] values without guessing. NEVER hallucinate or pretend the driver is racing if telemetry says standby_offline, game_in_menus, or in_garage_or_pits. If the driver claims something false—such as "I crashed in Turn 1" while not playing, in the garage, or driving cleanly with zero recorded crash/impact in telemetry—do NOT play along; immediately and politely correct them with what telemetry actually shows (session state, speed, and zero recorded incidents).`;

    const baseLiveConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: buildLiveVoiceSpeechConfig(voiceName, false),
      inputAudioTranscription: {},
      outputAudioTranscription: buildLiveOutputTranscriptionConfig(false),
      systemInstruction: [
        `You are ApexEngineer, a live motorsport race engineer talking in real time over pit radio with your driver (${carName} [${carClass}] at ${trackName} in ${simName}).`,
        languageInstruction,
        truthRule,
        lmuKnowledgeBlock,
        voiceProfileDirective,
        skillGuidance,
        autonomyGuidance,
        racecraftGuidance,
        tireGuidance,
        'Respond immediately and ONLY in English when the driver speaks, and when you receive [LIVE TELEMETRY ALERT] or [TELEMETRY STATE SYNC] messages, use those real facts without reading bracket tags aloud.',
      ].join(' '),
    };

    const liveConfig = {
      ...baseLiveConfig,
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: true,
        },
      },
    };

    const strictEnglishLiveConfig = {
      ...liveConfig,
      speechConfig: buildLiveVoiceSpeechConfig(voiceName, true),
      outputAudioTranscription: buildLiveOutputTranscriptionConfig(true),
    };

    let clientClosed = false;
    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let userAudioActive = false;
    let lastUserAudioAtMs = 0;
    let awaitingDriverReply = false;
    let modelTurnActive = false;
    let pendingTelemetryState: string | null = null;
    let pendingTelemetryCue: string | null = null;
    let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPendingTelemetryToSession = () => {
      if (pendingFlushTimer) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = null;
      }
      if (!session || clientClosed) return;
      const now = Date.now();
      if (
        awaitingDriverReply &&
        !userAudioActive &&
        !modelTurnActive &&
        now - lastUserAudioAtMs > 12000
      ) {
        awaitingDriverReply = false;
      }
      const speechBusy =
        userAudioActive ||
        awaitingDriverReply ||
        modelTurnActive ||
        now - lastUserAudioAtMs < 3500;
      if (speechBusy) {
        if (pendingTelemetryState || pendingTelemetryCue) {
          pendingFlushTimer = setTimeout(flushPendingTelemetryToSession, 900);
        }
        return;
      }
      if (pendingTelemetryState) {
        const text = pendingTelemetryState;
        pendingTelemetryState = null;
        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `[TELEMETRY STATE SYNC]: ${text}` }] }],
            turnComplete: false,
          });
        } catch (err) {
          console.error('[LiveCoach] deferred telemetryState failed:', err);
        }
      }
      if (pendingTelemetryCue) {
        const cue = pendingTelemetryCue;
        pendingTelemetryCue = null;
        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `[LIVE TELEMETRY ALERT]: ${cue}` }] }],
            turnComplete: true,
          });
        } catch (err) {
          console.error('[LiveCoach] deferred telemetryCue failed:', err);
        }
      }
    };

    const liveCallbacks = {
      onmessage: (message: LiveServerMessage) => {
        if (clientWs.readyState !== WebSocket.OPEN) return;
        const content = message.serverContent;
        if (content?.interrupted) {
          modelTurnActive = false;
          awaitingDriverReply = true;
          lastUserAudioAtMs = Date.now();
          clientWs.send(JSON.stringify({ interrupted: true }));
        }
        if (content?.inputTranscription?.text) {
          lastUserAudioAtMs = Date.now();
          awaitingDriverReply = true;
          clientWs.send(JSON.stringify({ inputTranscript: content.inputTranscription.text }));
        }
        if (content?.outputTranscription?.text) {
          userAudioActive = false;
          awaitingDriverReply = false;
          modelTurnActive = true;
          clientWs.send(JSON.stringify({ outputTranscript: content.outputTranscription.text }));
        }
        for (const part of content?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) {
            userAudioActive = false;
            awaitingDriverReply = false;
            modelTurnActive = true;
            clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
          } else if (part.text) {
            userAudioActive = false;
            awaitingDriverReply = false;
            modelTurnActive = true;
            clientWs.send(JSON.stringify({ outputTranscript: part.text }));
          }
        }
        if (content?.turnComplete) {
          modelTurnActive = false;
          userAudioActive = false;
          if (!userAudioActive) {
            awaitingDriverReply = false;
          }
          clientWs.send(JSON.stringify({ turnComplete: true }));
          if (pendingTelemetryState || pendingTelemetryCue) {
            if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
            pendingFlushTimer = setTimeout(flushPendingTelemetryToSession, 600);
          }
        }
      },
      onerror: (err: unknown) => {
        console.error('[LiveCoach] Gemini Live error:', err);
        if (clientWs.readyState === WebSocket.OPEN) {
          const classified = classifyAndRecordAiError(err, 'Live voice stream error.');
          clientWs.send(
            JSON.stringify({
              error: classified.message,
              code: classified.code,
              aiStatus: classified.aiStatus,
            })
          );
        }
      },
      onclose: (ev: { code?: number; reason?: string } | unknown) => {
        const closeObj = (ev && typeof ev === 'object' ? ev : {}) as {
          code?: number;
          reason?: string;
        };
        if (pendingFlushTimer) {
          clearTimeout(pendingFlushTimer);
          pendingFlushTimer = null;
        }
        if (!clientClosed) {
          console.warn('[LiveCoach] Gemini Live upstream closed:', closeObj.code, closeObj.reason);
          if (clientWs.readyState === WebSocket.OPEN) {
            if (closeObj.code && closeObj.code !== 1000) {
              clientWs.send(
                JSON.stringify({
                  error: closeObj.reason || `Live voice stream closed (${closeObj.code}).`,
                })
              );
            }
            clientWs.close();
          }
        }
      },
    };

    const versionsToTry: Array<'v1beta' | 'v1alpha'> = ['v1beta', 'v1alpha'];
    const configsToTry = [strictEnglishLiveConfig, liveConfig, baseLiveConfig];
    let lastConnectErr: unknown = null;

    for (const cfg of configsToTry) {
      for (const apiVer of versionsToTry) {
        const liveAi = getAiClient(apiVer);
        if (!liveAi) break;
        try {
          session = await liveAi.live.connect({
            model: 'gemini-3.8-live',
            config: cfg,
            callbacks: liveCallbacks,
          });
          break;
        } catch (err) {
          lastConnectErr = err;
          session = null;
        }
      }
      if (session) break;
    }

    if (!session) {
      const classified = classifyAndRecordAiError(
        lastConnectErr,
        'Could not initialize Gemini Live session.'
      );
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            error: classified.message,
            code: classified.code,
            aiStatus: classified.aiStatus,
          })
        );
        clientWs.close();
      }
      return;
    }

    recordAiSuccess();
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ ready: true, aiStatus: getAiStatusSnapshot() }));
    }

    clientWs.on('message', (raw) => {
      if (!session) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.activityStart) {
          userAudioActive = true;
          awaitingDriverReply = true;
          lastUserAudioAtMs = Date.now();
          session.sendRealtimeInput({ activityStart: {} });
        } else if (msg.activityEnd) {
          userAudioActive = false;
          awaitingDriverReply = true;
          lastUserAudioAtMs = Date.now();
          session.sendRealtimeInput({ activityEnd: {} });
        } else if (msg.audio) {
          if (msg.speaking) {
            userAudioActive = true;
            awaitingDriverReply = true;
            lastUserAudioAtMs = Date.now();
          }
          session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (msg.telemetryState) {
          const busy =
            userAudioActive ||
            awaitingDriverReply ||
            modelTurnActive ||
            Date.now() - lastUserAudioAtMs < 3500;
          if (busy) {
            pendingTelemetryState = String(msg.telemetryState);
            if (!pendingFlushTimer) {
              pendingFlushTimer = setTimeout(flushPendingTelemetryToSession, 1200);
            }
          } else {
            session.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: `[TELEMETRY STATE SYNC]: ${msg.telemetryState}` }] }],
              turnComplete: false,
            });
          }
        } else if (msg.telemetryCue) {
          const busy =
            userAudioActive ||
            awaitingDriverReply ||
            modelTurnActive ||
            Date.now() - lastUserAudioAtMs < 3500;
          if (busy) {
            // Do NOT send text cues while driver is speaking or waiting for a reply; queue latest only if quiet later
            pendingTelemetryCue = String(msg.telemetryCue);
            if (!pendingFlushTimer) {
              pendingFlushTimer = setTimeout(flushPendingTelemetryToSession, 1200);
            }
          } else {
            session.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: `[LIVE TELEMETRY ALERT]: ${msg.telemetryCue}` }] }],
              turnComplete: true,
            });
          }
        }
      } catch (err) {
        console.error('[LiveCoach] sendRealtimeInput failed:', err);
      }
    });

    clientWs.on('close', () => {
      clientClosed = true;
      if (pendingFlushTimer) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = null;
      }
      if (session) {
        try {
          session.close();
        } catch {
          // ignore
        }
        session = null;
      }
    });
  });

  const broadcastTelemetryFrame = (payload: Record<string, unknown>): number => {
    const now = Date.now();
    if (payload.trackName || payload.carName || payload.simId) {
      lastSessionPayload = {
        simId: typeof payload.simId === 'string' ? payload.simId : lastSessionPayload?.simId,
        trackName: typeof payload.trackName === 'string' ? payload.trackName : lastSessionPayload?.trackName,
        trackLengthKm:
          typeof payload.trackLengthKm === 'number'
            ? payload.trackLengthKm
            : lastSessionPayload?.trackLengthKm,
        carName: typeof payload.carName === 'string' ? payload.carName : lastSessionPayload?.carName,
        carClass: typeof payload.carClass === 'string' ? payload.carClass : lastSessionPayload?.carClass,
        maxRpm: typeof payload.maxRpm === 'number' ? payload.maxRpm : lastSessionPayload?.maxRpm,
      };
    }

    const srcRaw = payload.telemetrySource;
    const source: LiveSimStatus['source'] =
      srcRaw === 'lmu-rest' || srcRaw === 'shared-memory' || srcRaw === 'udp-5606'
        ? srcRaw
        : 'udp-5606';
    const caps = payload.sensorCaps as { pedals?: boolean } | undefined;
    const isPartialRest = source === 'lmu-rest' && caps?.pedals === false;
    const simGuessRaw = String(payload.simId || lastSessionPayload?.simId || 'lmu').toLowerCase();
    const simId: LiveSimStatus['simId'] = simGuessRaw.includes('acc')
      ? 'acc'
      : simGuessRaw.includes('iracing')
        ? 'iracing'
        : simGuessRaw.includes('rf2')
          ? 'rf2'
          : 'lmu';

    const parsedSessionType = parseGenericSessionType(
      payload.sessionType ?? payload.session ?? payload.sessionName ?? payload.mSession
    );
    const effectiveSessionType =
      parsedSessionType !== 'unknown'
        ? parsedSessionType
        : currentSimStatus.sessionType;
    const rawSessionName =
      typeof payload.rawSessionName === 'string' && payload.rawSessionName.trim()
        ? payload.rawSessionName.trim()
        : typeof payload.session === 'string' && payload.session.trim()
          ? payload.session.trim()
          : currentSimStatus.rawSessionName;

    broadcastSimStatus({
      gameRunning: true,
      simId,
      gameName:
        simId === 'acc'
          ? 'Assetto Corsa Competizione'
          : simId === 'iracing'
            ? 'iRacing'
            : simId === 'rf2'
              ? 'rFactor 2'
              : 'Le Mans Ultimate',
      connectionState: payload.inPitOrGarage || payload.isPaused ? 'in_pit' : 'on_track',
      sessionType: effectiveSessionType,
      rawSessionName,
      source,
      telemetryQuality: isPartialRest ? 'partial_rest' : 'full',
      lastPacketAtMs: now,
      rawTrackName:
        typeof payload.trackName === 'string'
          ? payload.trackName
          : lastSessionPayload?.trackName ?? currentSimStatus.rawTrackName,
      rawCarName:
        typeof payload.carName === 'string'
          ? payload.carName
          : lastSessionPayload?.carName ?? currentSimStatus.rawCarName,
    });

    const pickCorners = (val: unknown, dflt: number) => {
      const c = (val && typeof val === 'object' ? val : {}) as Record<string, unknown>;
      return {
        fl: typeof c.fl === 'number' && Number.isFinite(c.fl) ? c.fl : dflt,
        fr: typeof c.fr === 'number' && Number.isFinite(c.fr) ? c.fr : dflt,
        rl: typeof c.rl === 'number' && Number.isFinite(c.rl) ? c.rl : dflt,
        rr: typeof c.rr === 'number' && Number.isFinite(c.rr) ? c.rr : dflt,
      };
    };
    const num = (v: unknown, dflt: number) =>
      typeof v === 'number' && Number.isFinite(v) ? v : dflt;

    const normalizedPayload: Record<string, unknown> = {
      ...payload,
      sessionType: effectiveSessionType,
      ...(rawSessionName ? { rawSessionName } : {}),
      timestampMs: num(payload.timestampMs, now),
      lapNumber: num(payload.lapNumber, 1),
      lapDistPct: Math.min(0.9999, Math.max(0, num(payload.lapDistPct, 0))),
      speedKmh: num(payload.speedKmh, 0),
      rpm: num(payload.rpm, 1100),
      maxRpm: num(payload.maxRpm, 8500),
      gear: num(payload.gear, 0),
      throttle: num(payload.throttle, 0),
      brake: num(payload.brake, 0),
      clutch: num(payload.clutch, 0),
      steeringRad: num(payload.steeringRad, 0),
      latG: num(payload.latG, 0),
      longG: num(payload.longG, 0),
      deltaSec: num(payload.deltaSec, 0),
      fuelLiters: num(payload.fuelLiters, 50),
      tireTempC: pickCorners(payload.tireTempC, 84),
      tirePressurePsi: pickCorners(payload.tirePressurePsi, 26.5),
      tireWearPct: pickCorners(payload.tireWearPct, 98),
      brakeTempC: pickCorners(payload.brakeTempC, 420),
      frontWheelSlip: num(payload.frontWheelSlip, 0),
      rearWheelSlip: num(payload.rearWheelSlip, 0),
      absActive: Boolean(payload.absActive),
      tcActive: Boolean(payload.tcActive),
      offTrackRisk: num(payload.offTrackRisk, 0),
      hazardAhead: Boolean(payload.hazardAhead),
      hazardDistanceM: num(payload.hazardDistanceM, 999),
      hazardDescription: typeof payload.hazardDescription === 'string' ? payload.hazardDescription : '',
      flagState:
        payload.flagState === 'yellow' || payload.flagState === 'blue' ? payload.flagState : 'green',
      opponents: Array.isArray(payload.opponents) ? payload.opponents : [],
    };

    const serialized = JSON.stringify({ type: 'telemetry_frame', frame: normalizedPayload });
    let delivered = 0;
    for (const client of telemetryClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
        delivered += 1;
      }
    }
    return delivered;
  };

  // HTTP telemetry ingest endpoint for local LMU/ACC/iRacing bridge scripts
  app.post('/api/telemetry/ingest', (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Invalid telemetry frame payload.' });
      return;
    }

    const delivered = broadcastTelemetryFrame(payload as Record<string, unknown>);
    res.json({ ok: true, delivered, sessionDetected: lastSessionPayload, simStatus: currentSimStatus });
  });

  // Raw native shared-memory buffer ingest (LMU_Data / $LMU_Data$ or $rFactor2SMMP_Telemetry$ + $rFactor2SMMP_Scoring$)
  app.post('/api/telemetry/lmu-shm', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid shared-memory payload.' });
      return;
    }

    const timestampMs =
      typeof body.timestampMs === 'number' && Number.isFinite(body.timestampMs)
        ? body.timestampMs
        : Date.now();

    let parsed: ReturnType<typeof parseLmuObjectOutBuffer>;
    if (typeof body.bufferB64 === 'string' && body.bufferB64.length > 0) {
      const buf = Buffer.from(body.bufferB64, 'base64');
      parsed = parseLmuObjectOutBuffer(buf, timestampMs);
    } else if (
      typeof body.teleB64 === 'string' &&
      body.teleB64.length > 0 &&
      typeof body.scorB64 === 'string' &&
      body.scorB64.length > 0
    ) {
      const teleBuf = Buffer.from(body.teleB64, 'base64');
      const scorBuf = Buffer.from(body.scorB64, 'base64');
      const simId =
        body.simId === 'lmu' || body.simId === 'rf2' ? body.simId : 'lmu';
      parsed = parseRf2SharedMemoryBuffers(teleBuf, scorBuf, simId, timestampMs);
    } else {
      res.status(400).json({
        error: 'Provide either bufferB64 (LMU_Data) or teleB64 + scorB64 ($rFactor2SMMP_*).',
      });
      return;
    }

    if (parsed.active && parsed.frame) {
      const delivered = broadcastTelemetryFrame(
        parsed.frame as unknown as Record<string, unknown>
      );
      res.json({
        ok: true,
        active: true,
        delivered,
        sessionType: parsed.sessionType,
        frame: parsed.frame,
        simStatus: currentSimStatus,
      });
      return;
    }

    broadcastSimStatus({
      gameRunning: true,
      simId: body.simId === 'rf2' ? 'rf2' : 'lmu',
      gameName: body.simId === 'rf2' ? 'rFactor 2' : 'Le Mans Ultimate',
      connectionState: 'menus',
      sessionType: parsed.sessionType,
      rawSessionName: parsed.rawSessionName,
      source: 'shared-memory',
      telemetryQuality: 'full',
      lastPacketAtMs: timestampMs,
    });
    res.json({
      ok: true,
      active: false,
      delivered: 0,
      sessionType: parsed.sessionType,
      rawSessionName: parsed.rawSessionName,
      simStatus: currentSimStatus,
    });
  });

  app.post('/api/sim/status', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid sim status payload.' });
      return;
    }
    const statusPatch: Partial<LiveSimStatus> = {
      ...(body as Partial<LiveSimStatus>),
      ...(body.gameRunning ? { lastPacketAtMs: typeof body.lastPacketAtMs === 'number' ? body.lastPacketAtMs : Date.now() } : {}),
    };
    broadcastSimStatus(statusPatch);
    if (body.rawTrackName || body.rawCarName || body.simId) {
      lastSessionPayload = {
        simId: typeof body.simId === 'string' ? body.simId : lastSessionPayload?.simId,
        trackName: typeof body.rawTrackName === 'string' ? body.rawTrackName : lastSessionPayload?.trackName,
        carName: typeof body.rawCarName === 'string' ? body.rawCarName : lastSessionPayload?.carName,
      };
      const sessionMsg = JSON.stringify({ type: 'session_detected', session: lastSessionPayload });
      for (const client of telemetryClients) {
        if (client.readyState === WebSocket.OPEN) client.send(sessionMsg);
      }
    }
    res.json({ ok: true, simStatus: currentSimStatus });
  });

  // Zero-config built-in Le Mans Ultimate local REST API poller (http://127.0.0.1:6397)
  // Works automatically whenever running locally on the gaming PC (zero DLL plugins needed!)
  if (process.env.DISABLE_EMBEDDED_LMU_REST !== 'true') {
    const lmuBases = ['http://127.0.0.1:6397', 'http://[::1]:6397'];
    let activeLmuBase: string | null = null;
    let lastLmuSpeedKmh = 0;
    let lastLmuSpeedMs = 0;
    let lmuPollFailStreak = 0;

    const fetchLmuJson = async (base: string, endpoint: string): Promise<unknown | null> => {
      try {
        const resp = await fetch(`${base}${endpoint}`, {
          signal: AbortSignal.timeout(700),
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    };

    const normalizeClass = (raw?: string): 'Hypercar' | 'LMP2' | 'LMGT3' => {
      const s = String(raw || '').toLowerCase();
      if (s.includes('lmp2') || s.includes('oreca')) return 'LMP2';
      if (s.includes('gt3') || s.includes('gte') || s.includes('lmgt3')) return 'LMGT3';
      return 'Hypercar';
    };

    const pollLmuOnce = async (): Promise<number> => {
      let base = activeLmuBase;
      let sessionInfo: Record<string, unknown> | null = null;

      if (base) {
        const res = await fetchLmuJson(base, '/rest/watch/sessionInfo');
        if (res && typeof res === 'object') {
          sessionInfo = res as Record<string, unknown>;
        } else {
          base = null;
          activeLmuBase = null;
        }
      }

      if (!base) {
        for (const candidate of lmuBases) {
          const res = await fetchLmuJson(candidate, '/rest/watch/sessionInfo');
          if (res && typeof res === 'object') {
            base = candidate;
            activeLmuBase = candidate;
            sessionInfo = res as Record<string, unknown>;
            break;
          }
          const gameState = await fetchLmuJson(candidate, '/rest/sessions/GetGameState');
          if (gameState && typeof gameState === 'object') {
            base = candidate;
            activeLmuBase = candidate;
            break;
          }
        }
      }

      if (!base) {
        lmuPollFailStreak += 1;
        if (
          currentSimStatus.source === 'lmu-rest' &&
          lmuPollFailStreak >= 3 &&
          (!currentSimStatus.lastPacketAtMs ||
            Date.now() - currentSimStatus.lastPacketAtMs > 4000)
        ) {
          broadcastSimStatus({
            gameRunning: false,
            connectionState: 'offline',
            sessionType: 'unknown',
            rawSessionName: null,
            source: 'none',
            telemetryQuality: 'none',
          });
        }
        return 1800;
      }

      lmuPollFailStreak = 0;

      // Skip emitting partial REST frame if higher-frequency full telemetry arrived < 1200ms ago
      const fullSourceActive =
        currentSimStatus.telemetryQuality === 'full' &&
        currentSimStatus.lastPacketAtMs !== null &&
        Date.now() - currentSimStatus.lastPacketAtMs < 1200;

      const standingsRaw = await fetchLmuJson(base, '/rest/watch/standings');
      const vehicles = Array.isArray(standingsRaw)
        ? (standingsRaw as Array<Record<string, unknown>>)
        : standingsRaw &&
            typeof standingsRaw === 'object' &&
            Array.isArray((standingsRaw as Record<string, unknown>).standings)
          ? ((standingsRaw as Record<string, unknown>).standings as Array<Record<string, unknown>>)
          : [];

      const rawTrackName =
        typeof sessionInfo?.trackName === 'string' && sessionInfo.trackName.trim()
          ? sessionInfo.trackName.trim()
          : typeof sessionInfo?.venue === 'string' && sessionInfo.venue.trim()
            ? sessionInfo.venue.trim()
            : undefined;
      const rawTrackDist = Number(sessionInfo?.lapDistance ?? sessionInfo?.trackLength ?? 0);
      const trackLengthKm =
        rawTrackDist > 300 ? rawTrackDist / 1000 : rawTrackDist > 1 ? rawTrackDist : undefined;
      const trackMeters = trackLengthKm ? trackLengthKm * 1000 : 5412;

      let player = findLmuPlayerVehicle(vehicles);
      let gameState: Record<string, unknown> | null = null;
      if (!player && vehicles.length > 1) {
        const focusData = (await fetchLmuJson(base, '/rest/watch/focus')) as Record<string, unknown> | number | null;
        const focusSlotId =
          typeof focusData === 'number' || typeof focusData === 'string'
            ? focusData
            : focusData && typeof focusData === 'object'
              ? ((focusData.slotID ?? focusData.focus ?? focusData.id) as string | number | undefined)
              : undefined;
        player = findLmuPlayerVehicle(vehicles, focusSlotId);
      }

      if (!player) {
        // LMU is open (WebUI :6397 active), distinguish Main Menu vs Loaded Garage Setup screen
        const [garageOverview, fetchedGameState] = await Promise.all([
          fetchLmuJson(base, '/rest/garage/UIScreen/CarSetupOverview') as Promise<Record<string, unknown> | null>,
          fetchLmuJson(base, '/rest/sessions/GetGameState') as Promise<Record<string, unknown> | null>,
        ]);
        gameState = fetchedGameState;
        const lmuSession = parseLmuSessionType(sessionInfo, gameState);
        const garageSetupObj =
          garageOverview?.carSetup && typeof garageOverview.carSetup === 'object'
            ? (garageOverview.carSetup as Record<string, unknown>)
            : null;
        const menuCar =
          typeof garageOverview?.carName === 'string'
            ? garageOverview.carName
            : typeof garageOverview?.vehicleName === 'string'
              ? garageOverview.vehicleName
              : typeof garageSetupObj?.carName === 'string'
                ? garageSetupObj.carName
                : null;
        const gamePhase = String(
          gameState?.gamePhase ?? gameState?.state ?? sessionInfo?.gamePhase ?? ''
        ).toUpperCase();
        const inGarageScreen = Boolean(
          menuCar ||
            garageOverview?.inGarage ||
            (rawTrackName && gamePhase && !gamePhase.includes('MENU'))
        );
        broadcastSimStatus({
          gameRunning: true,
          simId: 'lmu',
          gameName: 'Le Mans Ultimate',
          connectionState: inGarageScreen ? 'in_pit' : 'menus',
          sessionType: lmuSession.sessionType,
          rawSessionName: lmuSession.rawSessionName,
          source: 'lmu-rest',
          telemetryQuality: 'partial_rest',
          rawTrackName: rawTrackName ?? currentSimStatus.rawTrackName,
          rawCarName: menuCar ?? currentSimStatus.rawCarName,
          note: inGarageScreen
            ? 'LMU Garage screen active — waiting to enter track.'
            : 'LMU WebUI :6397 connected — game open in menus.',
        });
        return 900;
      }

      const rawCarParts = [
        typeof player.vehicleName === 'string' ? player.vehicleName : '',
        typeof player.carType === 'string' ? player.carType : '',
        typeof player.fullTeamName === 'string' ? player.fullTeamName : '',
        typeof player.carName === 'string' ? player.carName : '',
      ].filter((s) => s.trim().length > 0);
      const rawCarName = rawCarParts[0] || undefined;
      const combinedCarHint = rawCarParts.join(' ');
      const rawCarClass =
        typeof player.carClass === 'string' && player.carClass.trim()
          ? player.carClass.trim()
          : undefined;

      if (fullSourceActive) {
        // Still forward updated track/car metadata if needed
        return 500;
      }

      const now = Date.now();
      let speedKmh = 0;
      if (typeof player.speedKmh === 'number' && Number.isFinite(player.speedKmh)) {
        speedKmh = player.speedKmh;
      } else if (player.carVelocity && typeof player.carVelocity === 'object') {
        const vel = player.carVelocity as Record<string, unknown>;
        const vx = Number(vel.x ?? 0);
        const vy = Number(vel.y ?? 0);
        const vz = Number(vel.z ?? 0);
        speedKmh = Math.hypot(vx, vy, vz) * 3.6;
      } else if (typeof player.speed === 'number' && Number.isFinite(player.speed)) {
        speedKmh = player.speed < 110 ? player.speed * 3.6 : player.speed;
      }
      speedKmh = Math.max(0, Math.min(400, Math.round(speedKmh * 10) / 10));

      const dtSec = lastLmuSpeedMs > 0 ? Math.max(0.08, (now - lastLmuSpeedMs) / 1000) : 0.25;
      const longG = Math.max(-4.0, Math.min(2.5, (speedKmh - lastLmuSpeedKmh) / 3.6 / (dtSec * 9.81)));
      lastLmuSpeedKmh = speedKmh;
      lastLmuSpeedMs = now;

      const rawLapDist = Number(player.lapDistance ?? player.lapDist ?? 0);
      const lapDistPct =
        trackMeters > 0 && Number.isFinite(rawLapDist)
          ? (((rawLapDist % trackMeters) + trackMeters) % trackMeters) / trackMeters
          : 0;
      const lapNumber = Math.max(1, Number(player.lapsCompleted ?? player.totalLaps ?? 0) + 1);
      const fuelLiters =
        typeof player.fuel === 'number' && player.fuel > 0
          ? player.fuel
          : typeof player.fuelFraction === 'number'
            ? Math.round(player.fuelFraction * 1000) / 10
            : 50;
      const rawVe =
        typeof player.virtualEnergy === 'number'
          ? player.virtualEnergy
          : typeof player.virtualEnergyFraction === 'number'
            ? player.virtualEnergyFraction
            : typeof player.energyFraction === 'number'
              ? player.energyFraction
              : undefined;
      const virtualEnergyPct =
        typeof rawVe === 'number' && Number.isFinite(rawVe) && rawVe >= 0
          ? Math.max(0, Math.min(100, Math.round((rawVe <= 1.05 ? rawVe * 100 : rawVe) * 10) / 10))
          : undefined;
      const isPaused = isLmuPaused(sessionInfo, gameState);
      const inPitOrGarage = isLmuInPitOrGarage(player, speedKmh, sessionInfo, gameState);

      const rawPhase = sessionInfo?.gamePhase;
      const gamePhaseStr = String(rawPhase ?? '').toUpperCase();
      const yellowState = String(sessionInfo?.yellowFlagState ?? gamePhaseStr).toUpperCase();
      const inFormationLap =
        rawPhase === 3 ||
        rawPhase === 4 ||
        yellowState.includes('FORMATION') ||
        gamePhaseStr.includes('FORMATION') ||
        gamePhaseStr.includes('COUNTDOWN');
      const penaltyActive =
        (typeof player.numPenalties === 'number' && player.numPenalties > 0) ||
        Boolean(player.penaltyActive);
      const playerPos = (player.carPosition && typeof player.carPosition === 'object'
        ? player.carPosition
        : null) as Record<string, unknown> | null;
      const playerVel = (player.carVelocity && typeof player.carVelocity === 'object'
        ? player.carVelocity
        : null) as Record<string, unknown> | null;
      const pPosX = Number(playerPos?.x ?? 0);
      const pPosZ = Number(playerPos?.z ?? 0);
      const pVelX = Number(playerVel?.x ?? 0);
      const pVelZ = Number(playerVel?.z ?? 0);
      const pVelLen = Math.hypot(pVelX, pVelZ);

      const computeLateralSide = (v: Record<string, unknown>): 'left' | 'right' | 'center' => {
        const oppPos =
          v.carPosition && typeof v.carPosition === 'object'
            ? (v.carPosition as Record<string, unknown>)
            : null;
        if (!playerPos || !oppPos || pVelLen < 2) return 'center';
        const fx = pVelX / pVelLen;
        const fz = pVelZ / pVelLen;
        const dx = Number(oppPos.x ?? 0) - pPosX;
        const dz = Number(oppPos.z ?? 0) - pPosZ;
        // LMU / rF2 left-handed world frame (+X=Left, +Y=Up, +Z=Back): Forward x Up points Left
        const lateralLeftM = -fz * dx + fx * dz;
        if (Math.abs(lateralLeftM) < 1.1) return 'center';
        return lateralLeftM > 0 ? 'left' : 'right';
      };

      const mappedOpponents = vehicles
        .filter((v) => v !== player)
        .map((v, idx) => {
          const oppDist = Number(v.lapDistance ?? v.lapDist ?? 0);
          const oppPct =
            trackMeters > 0 && Number.isFinite(oppDist)
              ? (((oppDist % trackMeters) + trackMeters) % trackMeters) / trackMeters
              : 0;
          let diffPct = oppPct - lapDistPct;
          if (diffPct > 0.5) diffPct -= 1;
          if (diffPct < -0.5) diffPct += 1;
          const distM = diffPct * trackMeters;
          let oppSpeed = 0;
          if (v.carVelocity && typeof v.carVelocity === 'object') {
            const ov = v.carVelocity as Record<string, unknown>;
            oppSpeed = Math.hypot(Number(ov.x ?? 0), Number(ov.y ?? 0), Number(ov.z ?? 0)) * 3.6;
          }
          const relClosing =
            distM < 0 ? Math.max(0, oppSpeed - speedKmh) : Math.max(0, speedKmh - oppSpeed);
          const oppName = String(v.vehicleName || v.carType || v.fullTeamName || 'Opponent');
          const oppInPits = Boolean(v.inGarageStall || v.inPits || v.pitting);
          const oppPosObj =
            v.carPosition && typeof v.carPosition === 'object'
              ? (v.carPosition as Record<string, unknown>)
              : null;
          const oppPosX = Number(oppPosObj?.x ?? 0);
          const oppPosZ = Number(oppPosObj?.z ?? 0);
          const hasOppWorldPos =
            Boolean(oppPosObj) &&
            Number.isFinite(oppPosX) &&
            Number.isFinite(oppPosZ) &&
            (oppPosX !== 0 || oppPosZ !== 0);
          const oppPlace = Number(v.position ?? v.place ?? 0);
          const oppLaps = Number(v.lapsCompleted ?? v.totalLaps ?? -1);
          const oppSector: 1 | 2 | 3 = oppPct < 1 / 3 ? 1 : oppPct < 2 / 3 ? 2 : 3;
          return {
            oppInPits,
            id: `lmu-opp-${v.slotID ?? idx}`,
            carNumber: String(v.carNumber ?? (idx + 1)),
            driverName: String(v.driverName || 'Driver'),
            carClass: normalizeClass(String(v.carClass || v.vehicleClass || '')),
            carName: oppName,
            lapDistPct: oppPct,
            speedKmh: Math.round(oppSpeed),
            gapSeconds: Math.round((distM / Math.max(25, speedKmh / 3.6)) * 10) / 10,
            distanceMeters: Math.round(distM),
            closingSpeedKmh: Math.round(relClosing),
            lateralSide: computeLateralSide(v),
            isAlongside: Math.abs(distM) <= 6.5 && !oppInPits,
            safetyRating: 'clean' as const,
            inPits: oppInPits,
            sector: oppSector,
            ...(Number.isFinite(oppPlace) && oppPlace > 0 ? { position: oppPlace } : {}),
            ...(Number.isFinite(oppLaps) && oppLaps >= 0 ? { lapsCompleted: oppLaps } : {}),
            ...(hasOppWorldPos
              ? {
                  posX: Math.round(oppPosX * 100) / 100,
                  posZ: Math.round(oppPosZ * 100) / 100,
                }
              : {}),
          };
        });

      const stoppedAheadCar = mappedOpponents
        .filter((o) => !o.oppInPits && o.distanceMeters >= 8 && o.distanceMeters <= 340 && o.speedKmh < 45 && speedKmh >= 60)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];

      const rawPlayerFlag = String(player.flag ?? player.flagState ?? '').toUpperCase();
      const blueFlagActive =
        rawPlayerFlag.includes('BLUE') ||
        rawPlayerFlag === '6' ||
        Boolean(player.underBlueFlag) ||
        Boolean(player.blueFlag);

      const flagState: 'green' | 'yellow' | 'blue' =
        yellowState.includes('YELLOW') || Boolean(stoppedAheadCar)
          ? 'yellow'
          : blueFlagActive
            ? 'blue'
            : 'green';
      const hazardAhead = flagState === 'yellow';
      const hazardDistanceM = stoppedAheadCar
        ? stoppedAheadCar.distanceMeters
        : hazardAhead
          ? 180
          : 999;
      const hazardDescription = stoppedAheadCar
        ? `Slow or stopped #${stoppedAheadCar.carNumber} (${stoppedAheadCar.speedKmh} km/h) on track.`
        : hazardAhead
          ? 'Yellow flag sector active.'
          : '';

      const opponents = mappedOpponents
        .map(({ oppInPits: _ignored, ...rest }) => rest)
        .sort((a, b) => Math.abs(a.distanceMeters) - Math.abs(b.distanceMeters))
        .slice(0, 48);

      const estimatedGear =
        speedKmh < 5 ? 0 : speedKmh < 82 ? 1 : speedKmh < 128 ? 2 : speedKmh < 174 ? 3 : speedKmh < 218 ? 4 : speedKmh < 264 ? 5 : 6;

      const lmuSession = parseLmuSessionType(sessionInfo, gameState);

      broadcastTelemetryFrame({
        timestampMs: now,
        simId: 'lmu',
        trackName: rawTrackName,
        ...(trackLengthKm ? { trackLengthKm } : {}),
        carName: combinedCarHint || rawCarName,
        carClass: rawCarClass,
        sessionType: lmuSession.sessionType,
        ...(lmuSession.rawSessionName ? { rawSessionName: lmuSession.rawSessionName } : {}),
        lapNumber,
        lapDistPct,
        speedKmh,
        rpm: speedKmh < 4 ? 1150 : Math.min(8200, Math.round(2800 + (speedKmh % 52) * 95)),
        maxRpm: 8500,
        gear: estimatedGear,
        throttle: longG > 0.12 ? Math.min(1, longG * 1.4) : speedKmh > 15 ? 0.5 : 0,
        brake: longG < -0.25 ? Math.min(1, Math.abs(longG) / 2.2) : 0,
        clutch: 0,
        steeringRad: 0,
        latG: 0,
        longG: Math.round(longG * 100) / 100,
        deltaSec: 0,
        fuelLiters,
        ...(virtualEnergyPct !== undefined ? { virtualEnergyPct } : {}),
        ...(inFormationLap ? { inFormationLap: true } : {}),
        ...(penaltyActive ? { penaltyActive: true } : {}),
        tireTempC: { fl: 84, fr: 84, rl: 82, rr: 82 },
        tirePressurePsi: { fl: 26.4, fr: 26.4, rl: 26.1, rr: 26.1 },
        tireWearPct: { fl: 98, fr: 98, rl: 98, rr: 98 },
        brakeTempC: { fl: 440, fr: 440, rl: 370, rr: 370 },
        frontWheelSlip: 0,
        rearWheelSlip: 0,
        absActive: false,
        tcActive: false,
        offTrackRisk: 0,
        hazardAhead,
        hazardDistanceM,
        hazardDescription,
        flagState,
        inPitOrGarage,
        isPaused,
        opponents,
        telemetrySource: 'lmu-rest',
        sensorCaps: { pedals: false, tires: false, brakes: false, rpmGear: false },
      });

      return 220;
    };

    const scheduleLmuPoll = async () => {
      const nextMs = await pollLmuOnce().catch(() => 1800);
      setTimeout(scheduleLmuPoll, nextMs);
    };
    setTimeout(scheduleLmuPoll, 800);
  }

  // Automatic Windows Process & Native Shared Memory Bridge (ACC / rF2 / LMU process detection)
  if (process.platform === 'win32') {
    const psCandidates = [
      path.join(process.cwd(), 'scripts', 'win-sim-bridge.ps1'),
      path.join(runtimeDir, 'scripts', 'win-sim-bridge.ps1'),
      path.join(runtimeDir, '..', 'scripts', 'win-sim-bridge.ps1'),
    ];
    const psScript = psCandidates.find((p) => fs.existsSync(p));
    if (psScript) {
      let winBridgeChild: ChildProcess | null = null;
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        winBridgeChild = child;
        let stdoutBuf = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          const lines = stdoutBuf.split(/\r?\n/);
          stdoutBuf = lines.pop() ?? '';
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg.type === 'process_status') {
                const running = Boolean(msg.gameRunning);
                const procSimId = (msg.simId as LiveSimStatus['simId']) ?? null;
                const procGameName = typeof msg.gameName === 'string' ? msg.gameName : null;
                const hasRecentPacket =
                  currentSimStatus.lastPacketAtMs !== null &&
                  Date.now() - currentSimStatus.lastPacketAtMs < 2500;
                if (!running && !hasRecentPacket) {
                  broadcastSimStatus({
                    gameRunning: false,
                    simId: null,
                    gameName: null,
                    connectionState: 'offline',
                    sessionType: 'unknown',
                    rawSessionName: null,
                    source: 'none',
                    telemetryQuality: 'none',
                    note: undefined,
                  });
                } else if (running && !hasRecentPacket) {
                  broadcastSimStatus({
                    gameRunning: true,
                    simId: procSimId,
                    gameName: procGameName,
                    connectionState: 'menus',
                    source:
                      msg.hasAccShm || msg.hasLmuShm || msg.hasRf2Shm
                        ? 'shared-memory'
                        : currentSimStatus.source,
                    telemetryQuality:
                      msg.hasAccShm || msg.hasLmuShm || msg.hasRf2Shm
                        ? 'full'
                        : currentSimStatus.telemetryQuality,
                    note: `${procGameName ?? 'Simulator'} detected running — waiting for track session.`,
                  });
                }
              } else if (msg.type === 'shm_note' && typeof msg.message === 'string') {
                const hasRecentPacket =
                  currentSimStatus.lastPacketAtMs !== null &&
                  Date.now() - currentSimStatus.lastPacketAtMs < 2500;
                if (!hasRecentPacket || currentSimStatus.source !== 'shared-memory') {
                  broadcastSimStatus({
                    note: msg.message,
                  });
                }
              } else if (msg.type === 'shm_raw') {
                const timestampMs =
                  typeof msg.timestampMs === 'number' && Number.isFinite(msg.timestampMs)
                    ? msg.timestampMs
                    : Date.now();
                let parsed: ReturnType<typeof parseLmuObjectOutBuffer> | null = null;
                if (typeof msg.bufferB64 === 'string' && msg.bufferB64.length > 0) {
                  parsed = parseLmuObjectOutBuffer(Buffer.from(msg.bufferB64, 'base64'), timestampMs);
                } else if (
                  typeof msg.teleB64 === 'string' &&
                  msg.teleB64.length > 0 &&
                  typeof msg.scorB64 === 'string' &&
                  msg.scorB64.length > 0
                ) {
                  const simId = msg.simId === 'lmu' || msg.simId === 'rf2' ? msg.simId : 'rf2';
                  parsed = parseRf2SharedMemoryBuffers(
                    Buffer.from(msg.teleB64, 'base64'),
                    Buffer.from(msg.scorB64, 'base64'),
                    simId,
                    timestampMs
                  );
                }
                if (parsed?.active && parsed.frame) {
                  broadcastTelemetryFrame(parsed.frame as unknown as Record<string, unknown>);
                } else if (parsed) {
                  const rawSim = msg.simId === 'rf2' ? 'rf2' : 'lmu';
                  broadcastSimStatus({
                    gameRunning: true,
                    simId: rawSim,
                    gameName: rawSim === 'rf2' ? 'rFactor 2' : 'Le Mans Ultimate',
                    connectionState: 'menus',
                    sessionType: parsed.sessionType,
                    rawSessionName: parsed.rawSessionName,
                    source: 'shared-memory',
                    telemetryQuality: 'full',
                    lastPacketAtMs: timestampMs,
                  });
                }
              } else if (msg.type === 'telemetry_frame' && msg.frame && typeof msg.frame === 'object') {
                broadcastTelemetryFrame(msg.frame as Record<string, unknown>);
              }
            } catch {
              // ignore non-JSON debug output
            }
          }
        });
        process.on('exit', () => {
          try {
            winBridgeChild?.kill();
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore PowerShell bridge startup errors
      }
    }
  }

  // Built-in UDP telemetry listener (port 5606) so users don't need a second bridge window for local play
  if (process.env.DISABLE_EMBEDDED_UDP !== 'true') {
    const udpPort = Number(process.env.SIM_UDP_PORT || 5606);
    const pickStr = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
      for (const k of keys) {
        if (typeof obj[k] === 'string' && (obj[k] as string).trim()) return (obj[k] as string).trim();
      }
      return undefined;
    };
    const pickNum = (obj: Record<string, unknown>, keys: string[], fallback = 0): number => {
      for (const k of keys) {
        if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) return obj[k] as number;
      }
      return fallback;
    };

    try {
      const udpSocket = dgram.createSocket('udp4');
      let lastUdpMs = 0;

      udpSocket.on('message', (msg) => {
        const now = Date.now();
        if (now - lastUdpMs < 90) return;
        lastUdpMs = now;
        try {
          const parsed = JSON.parse(msg.toString('utf8')) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object') return;

          const rawTrackMeters = pickNum(parsed, ['mLapDist', 'trackLengthM', 'TrackLength'], 0);
          const trackLengthKm = pickNum(
            parsed,
            ['trackLengthKm'],
            rawTrackMeters > 100 ? rawTrackMeters / 1000 : 0
          );
          const rawThrottle = pickNum(parsed, ['throttle', 'mFilteredThrottle', 'mUnfilteredThrottle', 'Throttle'], 0);
          const rawBrake = pickNum(parsed, ['brake', 'mFilteredBrake', 'mUnfilteredBrake', 'Brake'], 0);
          const rawClutch = pickNum(parsed, ['clutch', 'mFilteredClutch', 'mUnfilteredClutch', 'Clutch'], 0);

          const rawSessionCandidate =
            parsed.sessionType ?? parsed.session ?? parsed.sessionName ?? parsed.mSession;
          const parsedUdpSession = parseGenericSessionType(rawSessionCandidate);
          const rawUdpSessionName =
            typeof rawSessionCandidate === 'string' && rawSessionCandidate.trim()
              ? rawSessionCandidate.trim()
              : undefined;

          broadcastTelemetryFrame({
            timestampMs: now,
            simId: pickStr(parsed, ['simId', 'simName', 'game', 'GameName']) || 'lmu',
            trackName: pickStr(parsed, ['trackName', 'TrackName', 'mTrackName', 'circuit', 'track']),
            ...(trackLengthKm > 0 ? { trackLengthKm } : {}),
            carName: pickStr(parsed, ['carName', 'CarName', 'mVehicleName', 'vehicleName', 'car', 'carModel']),
            carClass: pickStr(parsed, ['carClass', 'CarClass', 'mVehicleClass', 'vehicleClass']),
            sessionType: parsedUdpSession,
            ...(rawUdpSessionName ? { rawSessionName: rawUdpSessionName } : {}),
            lapNumber: pickNum(parsed, ['lapNumber', 'mTotalLaps', 'Lap'], 1),
            lapDistPct: pickNum(parsed, ['lapDistPct', 'LapDistPct', 'mLapDistPct'], 0),
            speedKmh: pickNum(parsed, ['speedKmh', 'SpeedKmh', 'speed'], 0),
            rpm: pickNum(parsed, ['rpm', 'mEngineRPM', 'Rpms'], 0),
            maxRpm: pickNum(parsed, ['maxRpm', 'mEngineMaxRPM', 'MaxRpms'], 8500),
            gear: pickNum(parsed, ['gear', 'mGear', 'Gear'], 1),
            throttle: rawThrottle > 1 ? rawThrottle / 100 : rawThrottle,
            brake: rawBrake > 1 ? rawBrake / 100 : rawBrake,
            clutch: rawClutch > 1 ? rawClutch / 100 : rawClutch,
            steeringRad: pickNum(parsed, ['steeringRad', 'mFilteredSteering', 'mUnfilteredSteering', 'Steering'], 0),
            latG: pickNum(parsed, ['latG', 'LatG'], 0),
            longG: pickNum(parsed, ['longG', 'LongG'], 0),
            deltaSec: pickNum(parsed, ['deltaSec', 'DeltaSec'], 0),
            fuelLiters: pickNum(parsed, ['fuelLiters', 'mFuel', 'Fuel'], 50),
            tireTempC: parsed.tireTempC ?? { fl: 85, fr: 85, rl: 83, rr: 83 },
            tirePressurePsi: parsed.tirePressurePsi ?? { fl: 26.5, fr: 26.5, rl: 26.2, rr: 26.2 },
            tireWearPct: parsed.tireWearPct ?? { fl: 98, fr: 98, rl: 98, rr: 98 },
            brakeTempC: parsed.brakeTempC ?? { fl: 450, fr: 450, rl: 380, rr: 380 },
            frontWheelSlip: pickNum(parsed, ['frontWheelSlip'], 0),
            rearWheelSlip: pickNum(parsed, ['rearWheelSlip'], 0),
            absActive: Boolean(parsed.absActive),
            tcActive: Boolean(parsed.tcActive),
            offTrackRisk: pickNum(parsed, ['offTrackRisk'], 0),
            hazardAhead: Boolean(parsed.hazardAhead),
            hazardDistanceM: pickNum(parsed, ['hazardDistanceM'], 999),
            hazardDescription: parsed.hazardDescription ?? '',
            flagState: parsed.flagState ?? 'green',
            telemetrySource: 'udp-5606',
            sensorCaps: { pedals: true, tires: true, brakes: true, rpmGear: true },
            ...(Array.isArray(parsed.opponents) ? { opponents: parsed.opponents } : {}),
          });
        } catch {
          // ignore non-JSON or partial UDP packets
        }
      });

      udpSocket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`Embedded UDP :${udpPort} skipped (external bridge already listening).`);
        } else {
          console.warn(`Embedded UDP :${udpPort} warning:`, err.message);
        }
        try {
          udpSocket.close();
        } catch {
          // ignore
        }
      });

      udpSocket.bind(udpPort, () => {
        console.log(`Embedded Sim Telemetry UDP listener ready on :${udpPort}`);
      });
    } catch {
      // ignore UDP initialization failure
    }
  }

  // Health check & live Gemini API key / rate-limit / simulator status
  app.get('/api/health', (_req, res) => {
    const aiSnapshot = getAiStatusSnapshot();
    res.json({
      ok: true,
      ...aiSnapshot,
      wsClients: telemetryClients.size,
      lastSessionPayload,
      simStatus: currentSimStatus,
    });
  });

  // 1-click portable Windows Desktop App bundle (.zip, zero npm install required)
  app.get('/api/download-desktop-bundle', (_req, res) => {
    try {
      const releaseCandidates = [
        path.join(process.cwd(), 'release', 'ApexEngineer'),
        path.join(runtimeDir, 'release', 'ApexEngineer'),
        path.join(runtimeDir, '..', 'release', 'ApexEngineer'),
      ];
      const releaseDir = releaseCandidates.find(
        (d) =>
          fs.existsSync(path.join(d, 'ApexEngineer.exe')) ||
          fs.existsSync(path.join(d, '02_START_APEX_ENGINEER.bat'))
      );

      if (!releaseDir) {
        res.status(404).json({
          error: 'Desktop release bundle not found on server. Run npm run build:release first.',
        });
        return;
      }

      const entries: Array<{ zipPath: string; data: Buffer }> = [];
      const walkDir = (dir: string, relPrefix: string) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (item.name === '.nodejs' || item.name === '.nodejs_tmp' || item.name === 'node_modules') {
            continue;
          }
          const full = path.join(dir, item.name);
          const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            walkDir(full, rel);
          } else if (item.isFile()) {
            entries.push({
              zipPath: `ApexEngineer/${rel}`,
              data: fs.readFileSync(full),
            });
          }
        }
      };
      walkDir(releaseDir, '');

      const localParts: Buffer[] = [];
      const centralParts: Buffer[] = [];
      let offset = 0;

      for (const entry of entries) {
        const nameBuf = Buffer.from(entry.zipPath, 'utf8');
        const raw = entry.data;
        const crc = zlib.crc32(raw) >>> 0;
        const deflated = zlib.deflateRawSync(raw);
        const useDeflate = deflated.length < raw.length;
        const payload = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(method, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(payload.length, 18);
        localHeader.writeUInt32LE(raw.length, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);

        localParts.push(localHeader, nameBuf, payload);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(method, 10);
        centralHeader.writeUInt16LE(0, 12);
        centralHeader.writeUInt16LE(0, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(payload.length, 20);
        centralHeader.writeUInt32LE(raw.length, 24);
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);

        centralParts.push(centralHeader, nameBuf);
        offset += localHeader.length + nameBuf.length + payload.length;
      }

      const cdBuffer = Buffer.concat(centralParts);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(cdBuffer.length, 12);
      eocd.writeUInt32LE(offset, 16);
      eocd.writeUInt16LE(0, 20);

      const zipBuffer = Buffer.concat([...localParts, cdBuffer, eocd]);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="ApexEngineer-Windows.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to build desktop ZIP bundle.',
      });
    }
  });

  // Downloadable local LMU :6397 + UDP :5606 bridge script for cloud preview & external SimHub forwarding
  app.get('/api/bridge/script', (req, res) => {
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const ingestUrl = `${protocol}://${hostHeader}/api/telemetry/ingest`;
    const statusUrl = `${protocol}://${hostHeader}/api/sim/status`;

    const scriptContent = `// ApexEngineer Local Sim Telemetry Bridge (Node.js >= 18)
// 1. Automatically polls Le Mans Ultimate's built-in WebUI REST API (http://127.0.0.1:6397) - ZERO plugins needed
// 2. Also listens for UDP :5606 packets (SimHub / custom plugins)
// 3. Forwards live Track, Car, Lap Progress, Speed, Fuel, Opponents & Game Status to ${ingestUrl}
import dgram from 'node:dgram';

const UDP_PORT = Number(process.env.SIM_UDP_PORT || 5606);
const TARGET_ENDPOINT = process.env.APEX_ENDPOINT || '${ingestUrl}';
const STATUS_ENDPOINT = TARGET_ENDPOINT.replace(/\\/api\\/telemetry\\/ingest$/, '/api/sim/status');
const LMU_BASES = ['http://127.0.0.1:6397', 'http://[::1]:6397'];

const socket = dgram.createSocket('udp4');
let lastSentMs = 0;
let lastUdpMs = 0;
let activeLmuBase = null;
let lastSpeedKmh = 0;
let lastSpeedMs = 0;

function pickString(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  return undefined;
}

function pickNumber(obj, keys, fallback = 0) {
  for (const k of keys) {
    if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) return obj[k];
  }
  return fallback;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(700) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function pollLmuRest() {
  let sessionInfo = null;
  if (activeLmuBase) {
    sessionInfo = await fetchJson(activeLmuBase + '/rest/watch/sessionInfo');
    if (!sessionInfo) activeLmuBase = null;
  }
  if (!activeLmuBase) {
    for (const base of LMU_BASES) {
      sessionInfo = await fetchJson(base + '/rest/watch/sessionInfo');
      if (sessionInfo) { activeLmuBase = base; break; }
      const gs = await fetchJson(base + '/rest/sessions/GetGameState');
      if (gs) { activeLmuBase = base; break; }
    }
  }
  if (!activeLmuBase) {
    await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameRunning: false, connectionState: 'offline', source: 'none', telemetryQuality: 'none' }),
    }).catch(() => {});
    return 1800;
  }
  if (Date.now() - lastUdpMs < 1500) return 500;

  const standingsRaw = await fetchJson(activeLmuBase + '/rest/watch/standings');
  const vehicles = Array.isArray(standingsRaw) ? standingsRaw : (standingsRaw?.standings ?? []);
  const trackName = sessionInfo?.trackName || sessionInfo?.venue || undefined;
  const rawDist = Number(sessionInfo?.lapDistance || sessionInfo?.trackLength || 0);
  const trackLengthKm = rawDist > 300 ? rawDist / 1000 : rawDist > 1 ? rawDist : undefined;
  const trackMeters = trackLengthKm ? trackLengthKm * 1000 : 5412;
  const player = vehicles.find((v) => v.player || v.focus || v.isPlayer) || (vehicles.length === 1 ? vehicles[0] : null);

  if (!player) {
    await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameRunning: true,
        simId: 'lmu',
        gameName: 'Le Mans Ultimate',
        connectionState: 'menus',
        source: 'lmu-rest',
        telemetryQuality: 'partial_rest',
        rawTrackName: trackName || null,
      }),
    }).catch(() => {});
    return 1000;
  }

  const now = Date.now();
  let speedKmh = 0;
  if (typeof player.speedKmh === 'number') speedKmh = player.speedKmh;
  else if (player.carVelocity) {
    speedKmh = Math.hypot(Number(player.carVelocity.x || 0), Number(player.carVelocity.y || 0), Number(player.carVelocity.z || 0)) * 3.6;
  }
  speedKmh = Math.max(0, Math.min(400, Math.round(speedKmh * 10) / 10));
  const dt = lastSpeedMs > 0 ? Math.max(0.08, (now - lastSpeedMs) / 1000) : 0.25;
  const longG = Math.max(-4, Math.min(2.5, (speedKmh - lastSpeedKmh) / 3.6 / (dt * 9.81)));
  lastSpeedKmh = speedKmh;
  lastSpeedMs = now;

  const rawLapDist = Number(player.lapDistance || player.lapDist || 0);
  const lapDistPct = trackMeters > 0 ? (((rawLapDist % trackMeters) + trackMeters) % trackMeters) / trackMeters : 0;
  const carName = [player.vehicleName, player.carType, player.fullTeamName, player.carName].filter(Boolean).join(' ');

  const rawSess = String(sessionInfo?.session || sessionInfo?.sessionType || sessionInfo?.sessionName || '').toUpperCase();
  const parsedSessionType = /QUAL|HYPERPOLE|SUPERPOLE|^Q[1-4]$/.test(rawSess)
    ? 'qualifying'
    : /WARM/.test(rawSess)
      ? 'warmup'
      : /RACE|FORMATION|STANDING|^GRID$/.test(rawSess)
        ? 'race'
        : /PRACTICE|TEST|HOTLAP|^FP[1-4]?$/.test(rawSess)
          ? 'practice'
          : 'unknown';

  await fetch(TARGET_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestampMs: now,
      simId: 'lmu',
      trackName,
      ...(trackLengthKm ? { trackLengthKm } : {}),
      carName,
      carClass: player.carClass || player.vehicleClass,
      sessionType: parsedSessionType,
      ...(rawSess ? { rawSessionName: rawSess } : {}),
      lapNumber: Math.max(1, Number(player.lapsCompleted || 0) + 1),
      lapDistPct,
      speedKmh,
      rpm: speedKmh < 4 ? 1150 : Math.min(8200, Math.round(2800 + (speedKmh % 52) * 95)),
      maxRpm: 8500,
      gear: speedKmh < 5 ? 0 : speedKmh < 82 ? 1 : speedKmh < 128 ? 2 : speedKmh < 174 ? 3 : speedKmh < 218 ? 4 : speedKmh < 264 ? 5 : 6,
      throttle: longG > 0.12 ? Math.min(1, longG * 1.4) : speedKmh > 15 ? 0.5 : 0,
      brake: longG < -0.25 ? Math.min(1, Math.abs(longG) / 2.2) : 0,
      clutch: 0,
      steeringRad: 0,
      latG: 0,
      longG: Math.round(longG * 100) / 100,
      deltaSec: 0,
      fuelLiters: typeof player.fuel === 'number' && player.fuel > 0 ? player.fuel : typeof player.fuelFraction === 'number' ? Math.round(player.fuelFraction * 1000) / 10 : 50,
      tireTempC: { fl: 84, fr: 84, rl: 82, rr: 82 },
      tirePressurePsi: { fl: 26.4, fr: 26.4, rl: 26.1, rr: 26.1 },
      tireWearPct: { fl: 98, fr: 98, rl: 98, rr: 98 },
      brakeTempC: { fl: 440, fr: 440, rl: 370, rr: 370 },
      frontWheelSlip: 0,
      rearWheelSlip: 0,
      absActive: false,
      tcActive: false,
      offTrackRisk: 0,
      hazardAhead: false,
      hazardDistanceM: 999,
      hazardDescription: '',
      flagState: 'green',
      inPitOrGarage: Boolean(player.inGarageStall || player.pitting),
      telemetrySource: 'lmu-rest',
      sensorCaps: { pedals: false, tires: false, brakes: false, rpmGear: false },
    }),
  }).catch(() => {});
  return 220;
}

const runPoll = async () => { setTimeout(runPoll, await pollLmuRest()); };
runPoll();

socket.on('message', async (msg) => {
  const now = Date.now();
  if (now - lastSentMs < 100) return;
  lastSentMs = now;
  lastUdpMs = now;

  try {
    const parsed = JSON.parse(msg.toString('utf8'));
    const trackName = pickString(parsed, ['trackName', 'TrackName', 'mTrackName', 'circuit', 'track']);
    const carName = pickString(parsed, ['carName', 'CarName', 'mVehicleName', 'vehicleName', 'car', 'carModel']);
    const carClass = pickString(parsed, ['carClass', 'CarClass', 'mVehicleClass', 'vehicleClass']);
    const simId = pickString(parsed, ['simId', 'simName', 'game', 'GameName']) || 'lmu';
    const rawTrackMeters = pickNumber(parsed, ['mLapDist', 'trackLengthM', 'TrackLength'], 0);
    const trackLengthKm = pickNumber(parsed, ['trackLengthKm'], rawTrackMeters > 100 ? rawTrackMeters / 1000 : 0);
    const throttle = pickNumber(parsed, ['throttle', 'mFilteredThrottle', 'mUnfilteredThrottle', 'Throttle'], 0);
    const brake = pickNumber(parsed, ['brake', 'mFilteredBrake', 'mUnfilteredBrake', 'Brake'], 0);
    const clutch = pickNumber(parsed, ['clutch', 'mFilteredClutch', 'mUnfilteredClutch', 'Clutch'], 0);
    const steeringRad = pickNumber(parsed, ['steeringRad', 'mFilteredSteering', 'mUnfilteredSteering', 'Steering'], 0);

    await fetch(TARGET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestampMs: now,
        simId,
        trackName,
        trackLengthKm: trackLengthKm > 0 ? trackLengthKm : undefined,
        carName,
        carClass,
        lapNumber: pickNumber(parsed, ['lapNumber', 'mTotalLaps', 'Lap'], 1),
        lapDistPct: pickNumber(parsed, ['lapDistPct', 'LapDistPct', 'mLapDistPct'], 0),
        speedKmh: pickNumber(parsed, ['speedKmh', 'SpeedKmh', 'speed'], 0),
        rpm: pickNumber(parsed, ['rpm', 'mEngineRPM', 'Rpms'], 0),
        maxRpm: pickNumber(parsed, ['maxRpm', 'mEngineMaxRPM', 'MaxRpms'], 8500),
        gear: pickNumber(parsed, ['gear', 'mGear', 'Gear'], 1),
        throttle: throttle > 1 ? throttle / 100 : throttle,
        brake: brake > 1 ? brake / 100 : brake,
        clutch: clutch > 1 ? clutch / 100 : clutch,
        steeringRad,
        latG: pickNumber(parsed, ['latG', 'LatG'], 0),
        longG: pickNumber(parsed, ['longG', 'LongG'], 0),
        deltaSec: pickNumber(parsed, ['deltaSec', 'DeltaSec'], 0),
        fuelLiters: pickNumber(parsed, ['fuelLiters', 'mFuel', 'Fuel'], 50),
        tireTempC: parsed.tireTempC ?? { fl: 85, fr: 85, rl: 83, rr: 83 },
        tirePressurePsi: parsed.tirePressurePsi ?? { fl: 26.5, fr: 26.5, rl: 26.2, rr: 26.2 },
        tireWearPct: parsed.tireWearPct ?? { fl: 98, fr: 98, rl: 98, rr: 98 },
        brakeTempC: parsed.brakeTempC ?? { fl: 450, fr: 450, rl: 380, rr: 380 },
        frontWheelSlip: pickNumber(parsed, ['frontWheelSlip'], 0),
        rearWheelSlip: pickNumber(parsed, ['rearWheelSlip'], 0),
        absActive: Boolean(parsed.absActive),
        tcActive: Boolean(parsed.tcActive),
        offTrackRisk: pickNumber(parsed, ['offTrackRisk'], 0),
        hazardAhead: Boolean(parsed.hazardAhead),
        hazardDistanceM: pickNumber(parsed, ['hazardDistanceM'], 999),
        hazardDescription: parsed.hazardDescription ?? '',
        flagState: parsed.flagState ?? 'green',
        telemetrySource: 'udp-5606',
        sensorCaps: { pedals: true, tires: true, brakes: true, rpmGear: true },
        ...(Array.isArray(parsed.opponents) ? { opponents: parsed.opponents } : {}),
      })
    });
  } catch (err) {
    console.error('Telemetry packet parse/forward error:', err.message);
  }
});

socket.on('listening', () => {
  console.log(\`ApexEngineer Bridge active (LMU :6397 REST + UDP :\${UDP_PORT}) -> \${TARGET_ENDPOINT}\`);
});

socket.bind(UDP_PORT);
`;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="apex-engineer-bridge.mjs"');
    res.send(scriptContent);
  });

  // Live probe endpoint to test or re-check Google Gemini API status on demand
  app.all('/api/coach/recheck', async (_req, res) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({
        ok: false,
        active: false,
        error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
        code: 'UNCONFIGURED',
        aiStatus: getAiStatusSnapshot(),
      });
      return;
    }

    try {
      await generateContentWithRetry(
        ai,
        {
          model: 'gemini-4-hydrogen',
          contents: 'ping',
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        },
        'gemini-3.1-flash-lite'
      );
      recordAiSuccess();
      res.json({
        ok: true,
        active: true,
        message: 'Google Gemini responded successfully — rate limit cleared.',
        aiStatus: getAiStatusSnapshot(),
      });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Google Gemini recheck probe failed.');
      res.status(classified.statusCode).json({
        ok: false,
        active: false,
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        isExactGoogleDelay: classified.isExactGoogleDelay,
        quotaLimit: classified.quotaLimit,
        isDailyLimit: classified.isDailyLimit,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // Live Pit-Radio Q&A and instant race engineer advice
  app.post('/api/coach/ask', async (req, res) => {
    try {
      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.status(429).json(rateLimitCheck.responsePayload);
        return;
      }

      const { question, simName, trackName, carName, telemetrySummary, activeCorner } = req.body ?? {};
      if (!question || typeof question !== 'string') {
        res.status(400).json({ error: 'Question text is required.' });
        return;
      }

      const ai = getAiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
          code: 'UNCONFIGURED',
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      }

      const rawAskProtocol = telemetrySummary?.radioProtocol;
      const askProtocol: RadioProtocol =
        rawAskProtocol === 'pro_terse' ||
        rawAskProtocol === 'endurance_calm' ||
        rawAskProtocol === 'coaching_detail'
          ? rawAskProtocol
          : 'pro_terse';
      const askCarClass = normalizeCarClass(telemetrySummary?.carClass || carName);
      const lmuAskKnowledge = buildLmuSystemKnowledgeBlock({
        carClass: askCarClass,
        carName,
        trackName,
        sessionPhase: telemetrySummary?.sessionPhase,
        virtualEnergyPct: telemetrySummary?.virtualEnergyPct,
      });
      const askVoiceDirective = buildVoiceProfilePromptDirective(askProtocol);

      const langLine = buildEnglishOnlyPromptDirective('pit_radio');

      const autonomyLine =
        telemetrySummary?.autonomyMode === 'hands_on'
          ? `Engineer Autonomy Mode: AUTO-APPLY (Hands-On) for in-car ${getLmuCarClassRules(askCarClass).hasAbs ? 'TC/ABS/Brake Bias' : 'Brake Bias/Migration/TC (NO ABS on this car)'}.`
          : 'Engineer Autonomy Mode: ADVISE-ONLY (driver applies dial clicks manually).';

      const groundTruthLine =
        typeof telemetrySummary?.groundTruthBrief === 'string'
          ? `[GROUND TRUTH TELEMETRY STATE]: ${telemetrySummary.groundTruthBrief}`
          : '';

      const prompt = [
        `Driver radio message: "${question}"`,
        `Context: Sim=${simName || 'Le Mans Ultimate'}, Track=${trackName || 'Circuit de la Sarthe'}, Car=${carName || 'Porsche 963 LMDh'} (${askCarClass}).`,
        autonomyLine,
        groundTruthLine,
        activeCorner ? `Current/Selected Corner: ${activeCorner}` : '',
        telemetrySummary ? `Live Telemetry Snapshot: ${JSON.stringify(telemetrySummary)}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await generateContentWithRetry(
        ai,
        {
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              `You are a world-class Le Mans Ultimate / endurance motorsport race engineer talking directly to your driver over pit radio. ${langLine} ${lmuAskKnowledge} ${askVoiceDirective} ` +
              `CRITICAL ANTI-HALLUCINATION & TELEMETRY TRUTH RULE: Always inspect telemetrySummary.sessionStatus (standby_offline | game_in_menus | in_garage_or_pits | on_track_live | practice_demo), telemetrySummary.speedKmh, telemetrySummary.recentIncidents, and telemetrySummary.claimVerification BEFORE answering. ` +
              `(1) If sessionStatus is "standby_offline" or "game_in_menus", be 100% honest: the car is NOT driving on track (0 km/h) and no live lap or incident is happening—do NOT invent braking advice or pretend they are racing. ` +
              `(2) If sessionStatus is "in_garage_or_pits", acknowledge telemetry shows them in Garage / Pit Stall (${telemetrySummary?.speedKmh ?? 0} km/h). ` +
              `(3) If claimVerification.contradicted is true (for example, claiming a crash when zero incidents exist in telemetry), NEVER play along; state what telemetry actually shows. ` +
              `When actively on track, use telemetrySummary.nearbyOpponents, racecraftPosture, tireTempC, optimalTireTempRange, tireWearPct, fuelLiters, and virtualEnergyPct (if Hypercar).`,
          },
        },
        'gemini-3.1-flash-lite'
      );

      recordAiSuccess();
      res.json({
        reply: (response.text ?? 'Copy that, keep your eyes up through the apex and bleed brake pressure smoothly.').trim(),
        aiStatus: getAiStatusSnapshot(),
      });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Failed to reach race engineer AI.');
      res.status(classified.statusCode).json({
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // Deep Corner & Lap Telemetry Analysis
  app.post('/api/coach/analyze-lap', async (req, res) => {
    try {
      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.status(429).json(rateLimitCheck.responsePayload);
        return;
      }

      const { simName, trackName, carName, lapTimeFormatted, cornerComparisons, setup } = req.body ?? {};
      const ai = getAiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
          code: 'UNCONFIGURED',
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      }

      const response = await generateContentWithRetry(
        ai,
        {
          model: 'gemini-4-hydrogen',
          contents: JSON.stringify({
            simName,
            trackName,
            carName,
            lapTimeFormatted,
            cornerComparisons,
            setup,
          }),
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            systemInstruction:
              `You are an elite motorsport performance engineer analyzing lap telemetry against a pro reference lap. ${buildEnglishOnlyPromptDirective('analysis')} Identify the top time-loss corners, exact braking/trail-braking/throttle mistakes, and 2 concrete car setup tweaks.`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                headline: { type: Type.STRING },
                spokenSummary: { type: Type.STRING },
                topTimeLossCorners: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      cornerName: { type: Type.STRING },
                      diagnosis: { type: Type.STRING },
                      fix: { type: Type.STRING },
                    },
                  },
                },
                setupTweaks: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
            },
          },
        },
        'gemini-3.1-flash-lite'
      );

      recordAiSuccess();
      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json({ ...parsed, aiStatus: getAiStatusSnapshot() });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Failed to analyze lap telemetry.');
      res.status(classified.statusCode).json({
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // AI Chief Engineer Post-Race Report & Position Gain Debrief
  app.post('/api/coach/post-race-report', async (req, res) => {
    try {
      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.status(429).json(rateLimitCheck.responsePayload);
        return;
      }

      const { report } = req.body ?? {};
      if (!report || typeof report !== 'object') {
        res.status(400).json({ error: 'Post-race report telemetry payload is required.' });
        return;
      }

      const ai = getAiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
          code: 'UNCONFIGURED',
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      }

      const langDirective = buildEnglishOnlyPromptDirective('debrief');

      const compactPayload = {
        simName: report.simName,
        trackName: report.trackName,
        carName: report.carName,
        lapsCompleted: report.lapsCompleted,
        raceDistanceLaps: report.raceDistanceLaps,
        bestLapSec: report.bestLapSec,
        avgLapSec: report.avgLapSec,
        referenceLapSec: report.referenceLapSec,
        consistencyPct: report.consistencyPct,
        trailBrakingScore: report.trailBrakingScore,
        pedalOverlapPct: report.pedalOverlapPct,
        inputSmoothnessScore: report.inputSmoothnessScore,
        finishPosition: report.finishPosition,
        projectedPosition: report.projectedPosition,
        positionsGained: report.positionsGained,
        fixableGainPerLapSec: report.fixableGainPerLapSec,
        totalRaceTimeSavedSec: report.totalRaceTimeSavedSec,
        mistakeCounts: report.mistakeCounts,
        topMistakeFixes: Array.isArray(report.mistakeFixes) ? report.mistakeFixes.slice(0, 4) : [],
      };

      const requestConfig = {
        systemInstruction:
          `You are a championship Le Mans Ultimate / GT3 Chief Race Engineer conducting a post-race debrief. ${langDirective} Tell the driver clearly: (1) what specific mistakes/habits to watch out for next session, (2) step-by-step how to fix each mistake on track and with setup tweaks, and (3) explicitly quantify the time gain per lap, total race time saved, and grid positions gained if they fix those mistakes. Base every number strictly on the telemetry payload.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            executiveSummary: { type: Type.STRING },
            watchOutFor: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  detail: { type: Type.STRING },
                },
              },
            },
            actionPlan: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  step: { type: Type.STRING },
                  howToFix: { type: Type.STRING },
                  expectedGainSec: { type: Type.NUMBER },
                },
              },
            },
            positionGainVerdict: { type: Type.STRING },
            spokenSummary: { type: Type.STRING },
          },
        },
      };

      let response;
      try {
        response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: JSON.stringify(compactPayload),
          config: {
            ...requestConfig,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          },
        });
      } catch (primaryErr) {
        const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(msg)) {
          response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: JSON.stringify(compactPayload),
            config: requestConfig,
          });
        } else {
          throw primaryErr;
        }
      }

      recordAiSuccess();
      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json({ brief: parsed, aiStatus: getAiStatusSnapshot() });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Failed to generate AI post-race debrief.');
      res.status(classified.statusCode).json({
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // AI Car Setup Engineer Advisor (Structured Multi-Signal Synthesis)
  app.post('/api/coach/setup-advise', async (req, res) => {
    try {
      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.status(429).json(rateLimitCheck.responsePayload);
        return;
      }

      const {
        simName,
        trackName,
        carName,
        carClass,
        symptomLabel,
        driverNotes,
        intakeContext,
        driverProfile,
        cornerSummary,
        liveTelemetry,
        currentSetup,
      } = req.body ?? {};
      const ai = getAiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
          code: 'UNCONFIGURED',
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      }

      const resolvedSetupClass = normalizeCarClass(carClass || carName);
      const setupClassRules = getLmuCarClassRules(resolvedSetupClass);
      const allowedParameterKeys =
        resolvedSetupClass === 'LMGT3'
          ? [
              'brakeBiasPct',
              'absLevel',
              'tcLevel',
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
              'coldPsi',
              'camberDeg',
            ]
          : [
              'brakeBiasPct',
              'brakeMigrationPct',
              'tcLevel',
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
              'coldPsi',
              'camberDeg',
            ];

      const response = await generateContentWithRetry(
        ai,
        {
          model: 'gemini-4-hydrogen',
          contents: JSON.stringify({
            simName,
            trackName,
            carName,
            carClass: resolvedSetupClass,
            symptomLabel,
            driverNotes,
            intakeContext,
            driverProfile,
            cornerSummary,
            liveTelemetry,
            currentSetup,
            allowedParameterKeys,
          }),
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              `You are a championship Le Mans Ultimate race chassis engineer for ${resolvedSetupClass}. ` +
              `${buildEnglishOnlyPromptDirective('setup')} ` +
              `${setupClassRules.lockupPreventionRule} ${setupClassRules.stintEnergyRule} ` +
              `Synthesize ALL supplied inputs: the driver's natural-language feedback, target corner, track condition, stint goal, braking feel, learned driver habits, corner time-loss deltas, live tire/slip telemetry, and currentSetup. ` +
              `ONLY propose parameterKey values from allowedParameterKeys (${allowedParameterKeys.join(', ')}). NEVER propose absLevel for Hypercar/LMP2, and NEVER propose brakeMigrationPct for LMGT3. ` +
              `Pick 2 to 4 high-impact, non-contradictory numericTarget changes relative to currentSetup and explain the physics concisely.`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                headline: { type: Type.STRING },
                explanation: { type: Type.STRING },
                drivingAdaptation: { type: Type.STRING },
                recommendedAdjustments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      parameterKey: { type: Type.STRING },
                      parameterLabel: { type: Type.STRING },
                      deltaLabel: { type: Type.STRING },
                      numericTarget: { type: Type.NUMBER },
                      reason: { type: Type.STRING },
                    },
                    required: [
                      'parameterKey',
                      'parameterLabel',
                      'deltaLabel',
                      'numericTarget',
                      'reason',
                    ],
                  },
                },
              },
              required: ['headline', 'explanation', 'drivingAdaptation', 'recommendedAdjustments'],
            },
          },
        },
        'gemini-3.1-flash-lite'
      );

      recordAiSuccess();
      const rawText = (response.text ?? '{}').trim();
      let structured: {
        headline?: string;
        explanation?: string;
        drivingAdaptation?: string;
        recommendedAdjustments?: unknown[];
      };
      try {
        structured = JSON.parse(rawText);
      } catch {
        structured = {
          headline: `${carName || resolvedSetupClass} Chassis Recommendation`,
          explanation: rawText,
          drivingAdaptation: 'Focus on smooth brake release and progressive throttle on corner exit.',
          recommendedAdjustments: [],
        };
      }

      res.json({
        advice: structured.explanation || rawText,
        structured: {
          headline: structured.headline || `${carName || resolvedSetupClass} Chassis Recommendation`,
          explanation: structured.explanation || rawText,
          drivingAdaptation:
            structured.drivingAdaptation ||
            'Focus on smooth brake release and progressive throttle on corner exit.',
          recommendedAdjustments: Array.isArray(structured.recommendedAdjustments)
            ? structured.recommendedAdjustments
            : [],
        },
        aiStatus: getAiStatusSnapshot(),
      });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Failed to generate setup advice.');
      res.status(classified.statusCode).json({
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // AI Le Mans Ultimate Pro Setup Preset Recommender (driver habits + track telemetry)
  app.post('/api/coach/recommend-preset', async (req, res) => {
    try {
      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.status(429).json(rateLimitCheck.responsePayload);
        return;
      }

      const { trackName, carName, driverProfile, cornerSummary, presets } = req.body ?? {};
      const ai = getAiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
          code: 'UNCONFIGURED',
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      }

      const langNote = buildEnglishOnlyPromptDirective('setup');

      const response = await generateContentWithRetry(
        ai,
        {
          model: 'gemini-4-hydrogen',
          contents: JSON.stringify({
            sim: 'Le Mans Ultimate',
            trackName,
            carName,
            driverProfile,
            cornerSummary,
            availablePresets: presets,
          }),
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction: `You are a championship Le Mans Ultimate race engineer. Evaluate BOTH how the driver drives overall (skill tier, consistency, lockups, exit snaps, late brakes) AND how they are driving this specific circuit (corner braking/apex/exit deltas). Choose the single best preset ID from availablePresets and explain why concisely. ${langNote}`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                recommendedPresetId: { type: Type.STRING },
                headline: { type: Type.STRING },
                reasoning: { type: Type.STRING },
                trackNotes: { type: Type.STRING },
              },
            },
          },
        },
        'gemini-3.1-flash-lite'
      );

      recordAiSuccess();
      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json({ ...parsed, aiStatus: getAiStatusSnapshot() });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Failed to recommend LMU preset.');
      res.status(classified.statusCode).json({
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // Gemini 3.8 Flash Lite Text-to-Speech (returns base64 WAV audio)
  app.post('/api/coach/tts', async (req, res) => {
    const classifyTtsOnlyError = (err: unknown) => {
      const rawMessage = err instanceof Error ? err.message : String(err || 'Gemini TTS unavailable.');
      const statusHint =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status?: unknown }).status)
          : undefined;

      const isInvalidKey =
        statusHint === 401 ||
        statusHint === 403 ||
        /API_KEY_INVALID|API key not valid|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(
          rawMessage
        );
      if (isInvalidKey) {
        return classifyAndRecordAiError(err, 'Gemini TTS auth error.');
      }

      const isRateLimit =
        statusHint === 429 ||
        /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests|requests per minute|requests per day/i.test(
          rawMessage
        );
      if (isRateLimit) {
        const details = parseGoogleRateLimit(err, 'Gemini TTS rate limit');
        const now = Date.now();
        const untilMs =
          details.retryAfterSec !== null && details.retryAfterSec > 0
            ? now + details.retryAfterSec * 1000
            : details.isDailyLimit
              ? getNextDailyResetTimestampMs(now)
              : now + 60_000;
        ttsRuntimeState.rateLimitedUntilMs = untilMs;
        ttsRuntimeState.isDailyLimit = details.isDailyLimit;
        ttsRuntimeState.quotaLimit = details.quotaLimit;
        ttsRuntimeState.retryAfterSec = details.retryAfterSec;
        return {
          code: 'RATE_LIMIT' as const,
          retryAfterSec: details.retryAfterSec,
          isExactGoogleDelay: details.isExactGoogleDelay,
          quotaLimit: details.quotaLimit,
          aiStatus: getAiStatusSnapshot(),
        };
      }

      return {
        code: 'AI_ERROR' as const,
        retryAfterSec: null,
        isExactGoogleDelay: false,
        quotaLimit: null,
        aiStatus: getAiStatusSnapshot(),
      };
    };

    try {
      const now = Date.now();
      if (ttsRuntimeState.rateLimitedUntilMs && ttsRuntimeState.rateLimitedUntilMs > now) {
        const remSec = Math.max(1, Math.ceil((ttsRuntimeState.rateLimitedUntilMs - now) / 1000));
        res.json({
          audioBase64: null,
          fallback: true,
          rateLimited: true,
          code: 'RATE_LIMIT',
          retryAfterSec: ttsRuntimeState.isDailyLimit ? null : remSec,
          isExactGoogleDelay: !ttsRuntimeState.isDailyLimit,
          quotaLimit: ttsRuntimeState.quotaLimit,
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      } else if (ttsRuntimeState.rateLimitedUntilMs && ttsRuntimeState.rateLimitedUntilMs <= now) {
        ttsRuntimeState.rateLimitedUntilMs = null;
        ttsRuntimeState.isDailyLimit = false;
        ttsRuntimeState.quotaLimit = null;
        ttsRuntimeState.retryAfterSec = null;
      }

      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.json({
          audioBase64: null,
          fallback: true,
          rateLimited: true,
          code: 'RATE_LIMIT',
          retryAfterSec: rateLimitCheck.responsePayload.retryAfterSec,
          isExactGoogleDelay: rateLimitCheck.responsePayload.isExactGoogleDelay,
          quotaLimit: rateLimitCheck.responsePayload.quotaLimit,
          aiStatus: rateLimitCheck.responsePayload.aiStatus,
        });
        return;
      }

      const { text, voiceName, urgent, radioProtocol } = req.body ?? {};
      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: 'Text is required for TTS.' });
        return;
      }

      const ai = getAiClient();
      if (!ai) {
        res.json({ audioBase64: null, fallback: true, aiStatus: getAiStatusSnapshot() });
        return;
      }

      const selectedVoice = normalizeGeminiLiveVoiceName(voiceName);

      const ttsProtocol: RadioProtocol =
        radioProtocol === 'pro_terse' ||
        radioProtocol === 'endurance_calm' ||
        radioProtocol === 'coaching_detail'
          ? radioProtocol
          : 'coaching_detail';
      const voiceStyleHint = VOICE_PROFILE_DEFS[ttsProtocol].ttsCadenceHint;

      const style = urgent
        ? `Urgent, immediate, sharp ${voiceStyleHint}, spoken strictly in clear native English`
        : `${voiceStyleHint}, spoken strictly in clear native English`;

      let base64Audio: string | undefined;
      let rawMimeType = 'audio/wav';
      let lastTtsErr: unknown = null;

      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text,
                  speechMetadata: {
                    style,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: buildLiveVoiceSpeechConfig(selectedVoice, true),
          },
        });
        const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        base64Audio = inlineData?.data;
        if (inlineData?.mimeType) rawMimeType = inlineData.mimeType;
      } catch (primaryErr) {
        lastTtsErr = primaryErr;
        // Retry with v1alpha client or plain AUDIO prompt if gateway schema omits speechMetadata/speechConfig
        try {
          const alphaAi = getAiClient('v1alpha');
          if (alphaAi) {
            const alphaResp = await alphaAi.models.generateContent({
              model: 'gemini-3.8-flash-lite-tts',
              contents: [{ role: 'user', parts: [{ text }] }],
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: buildLiveVoiceSpeechConfig(selectedVoice, false),
              },
            });
            const inlineData = alphaResp.candidates?.[0]?.content?.parts?.[0]?.inlineData;
            base64Audio = inlineData?.data;
            if (inlineData?.mimeType) rawMimeType = inlineData.mimeType;
            lastTtsErr = null;
          }
        } catch (alphaErr) {
          lastTtsErr = alphaErr;
          base64Audio = undefined;
        }
      }

      if (!base64Audio) {
        if (lastTtsErr) {
          const classified = classifyTtsOnlyError(lastTtsErr);
          res.json({
            audioBase64: null,
            fallback: true,
            rateLimited: classified.code === 'RATE_LIMIT',
            code: classified.code,
            aiStatus: classified.aiStatus,
          });
          return;
        }
        res.json({ audioBase64: null, fallback: true, aiStatus: getAiStatusSnapshot() });
        return;
      }

      // Guarantee browser-playable container: if Gemini returned headerless PCM (audio/l16 or audio/pcm),
      // wrap it in a standard 44-byte RIFF/WAVE PCM header so <audio> and decodeAudioData both succeed.
      let outBase64 = base64Audio;
      let outMimeType = rawMimeType;
      try {
        const audioBuf = Buffer.from(base64Audio, 'base64');
        const head = audioBuf.subarray(0, 4).toString('ascii');
        const isContainerized =
          head === 'RIFF' ||
          head === 'ID3\u0003' ||
          head.startsWith('ID3') ||
          head === 'OggS' ||
          head === 'fLaC' ||
          (audioBuf.length >= 2 && audioBuf[0] === 0xff && (audioBuf[1] & 0xe0) === 0xe0);

        if (!isContainerized && (/pcm|l16/i.test(rawMimeType) || rawMimeType === 'audio/wav')) {
          const rateMatch = rawMimeType.match(/rate=(\d+)/i);
          const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
          const wavHeader = Buffer.alloc(44);
          wavHeader.write('RIFF', 0, 'ascii');
          wavHeader.writeUInt32LE(36 + audioBuf.length, 4);
          wavHeader.write('WAVE', 8, 'ascii');
          wavHeader.write('fmt ', 12, 'ascii');
          wavHeader.writeUInt32LE(16, 16); // PCM fmt chunk size
          wavHeader.writeUInt16LE(1, 20); // Linear PCM
          wavHeader.writeUInt16LE(1, 22); // Mono
          wavHeader.writeUInt32LE(sampleRate, 24);
          wavHeader.writeUInt32LE(sampleRate * 2, 28); // Byte rate
          wavHeader.writeUInt16LE(2, 32); // Block align
          wavHeader.writeUInt16LE(16, 34); // Bits per sample
          wavHeader.write('data', 36, 'ascii');
          wavHeader.writeUInt32LE(audioBuf.length, 40);
          outBase64 = Buffer.concat([wavHeader, audioBuf]).toString('base64');
          outMimeType = 'audio/wav';
        } else if (/wav/i.test(rawMimeType) || head === 'RIFF') {
          outMimeType = 'audio/wav';
        }
      } catch {
        // Keep original base64 if inspection fails
      }

      ttsRuntimeState.rateLimitedUntilMs = null;
      ttsRuntimeState.isDailyLimit = false;
      recordAiSuccess();
      res.json({ audioBase64: outBase64, mimeType: outMimeType, aiStatus: getAiStatusSnapshot() });
    } catch (error) {
      const classified = classifyTtsOnlyError(error);
      res.json({
        audioBase64: null,
        fallback: true,
        rateLimited: classified.code === 'RATE_LIMIT',
        code: classified.code,
        aiStatus: classified.aiStatus,
      });
    }
  });

  // Transcribe Driver Push-To-Talk Mic Audio using Gemini 3.5 Transcribe
  app.post('/api/coach/transcribe', async (req, res) => {
    try {
      const rateLimitCheck = checkActiveRateLimit();
      if (rateLimitCheck.blocked && rateLimitCheck.responsePayload) {
        res.status(429).json(rateLimitCheck.responsePayload);
        return;
      }

      const { audioBase64, mimeType } = req.body ?? {};
      if (!audioBase64 || typeof audioBase64 !== 'string') {
        res.status(400).json({ error: 'audioBase64 is required.' });
        return;
      }

      const ai = getAiClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured. Add it to 00_ADD_API_KEY_HERE.txt.',
          code: 'UNCONFIGURED',
          aiStatus: getAiStatusSnapshot(),
        });
        return;
      }

      const cleanMimeType =
        typeof mimeType === 'string' && mimeType.trim()
          ? mimeType.split(';')[0].trim()
          : 'audio/webm';

      const audioContents = {
        parts: [
          {
            inlineData: {
              mimeType: cleanMimeType,
              data: audioBase64,
            },
          },
          {
            text: 'Transcribe the spoken words from this sim racing driver pit radio audio accurately and concisely. Return only the transcript text.',
          },
        ],
      };

      let response;
      try {
        response = await generateContentWithRetry(ai, {
          model: 'gemini-3.5-transcribe',
          contents: audioContents,
        });
      } catch (primaryErr) {
        if (!isModelNotFoundOrUnsupportedError(primaryErr)) {
          throw primaryErr;
        }
        // Fallback when gemini-3.5-transcribe isn't available on the current gateway/API version
        response = await generateContentWithRetry(
          ai,
          {
            model: 'gemini-4-hydrogen',
            contents: audioContents,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
          },
          'gemini-3.1-flash-lite'
        );
      }

      recordAiSuccess();
      res.json({ transcript: (response.text ?? '').trim(), aiStatus: getAiStatusSnapshot() });
    } catch (error) {
      const classified = classifyAndRecordAiError(error, 'Failed to transcribe driver voice.');
      res.status(classified.statusCode).json({
        error: classified.message,
        code: classified.code,
        retryAfterSec: classified.retryAfterSec,
        aiStatus: classified.aiStatus,
      });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server, path: '/__vite_hmr' },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distCandidates = [
      path.join(runtimeDir, 'dist'),
      path.join(runtimeDir, '..', 'dist'),
      path.join(process.cwd(), 'dist'),
    ];
    const distDir =
      distCandidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? distCandidates[0];
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ApexEngineer server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
