import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRemainingCooldownSec,
  formatAiStatusDisplay,
  formatAvailableAtClock,
  formatRemainingDuration,
  getNextDailyResetTimestampMs,
  getEffectiveAiStatus,
  parseGoogleRateLimit,
  type AiStatusState,
} from '../utils/aiStatus.ts';

test('parseGoogleRateLimit extracts exact Google delay and never invents arbitrary fallback', () => {
  // Test 1: Real Google Gemini 429 quota message with decimal seconds
  const googleMsg =
    "Quota exceeded for quota metric 'GenerateContent Requests' and limit 'Requests per minute' of service 'generativelanguage.googleapis.com' for consumer 'project_number:567508227297'. Please retry in 34.21543s.";
  const p1 = parseGoogleRateLimit(new Error(googleMsg));
  assert.equal(p1.isExactGoogleDelay, true);
  assert.equal(p1.retryAfterSec, 35);
  assert.equal(p1.quotaLimit, 'Requests per minute (RPM)');
  assert.equal(p1.isDailyLimit, false);

  // Test 2: Google RetryInfo detail in RPC error payload
  const rpcErr = {
    error: {
      details: [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '18.2s' },
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ description: 'Quota exceeded' }] },
      ],
    },
  };
  const p2 = parseGoogleRateLimit(rpcErr);
  assert.equal(p2.isExactGoogleDelay, true);
  assert.equal(p2.retryAfterSec, 19);

  // Test 3: Google HTTP Retry-After header
  const p3 = parseGoogleRateLimit({ headers: { 'retry-after': '24' } });
  assert.equal(p3.isExactGoogleDelay, true);
  assert.equal(p3.retryAfterSec, 24);

  // Test 4: Google Daily Quota (Requests per day / 1500 RPD) -> MUST NOT invent a fake second number
  const dailyErr = new Error(
    "Quota exceeded for quota metric 'GenerateContent Requests' and limit 'Requests per day' of service 'generativelanguage.googleapis.com'."
  );
  const p4 = parseGoogleRateLimit(dailyErr);
  assert.equal(p4.isDailyLimit, true);
  assert.equal(p4.retryAfterSec, null); // Strictly NO random numbers when Google says daily limit
  assert.equal(p4.quotaLimit, 'Requests per day (RPD)');

  // Test 5: Plain error with no Google delay info -> strictly null (no fake fallback)
  const plainErr = new Error('429 RESOURCE_EXHAUSTED');
  const p5 = parseGoogleRateLimit(plainErr);
  assert.equal(p5.isExactGoogleDelay, false);
  assert.equal(p5.retryAfterSec, null);
});

test('formatAiStatusDisplay reports active key status clearly in English', () => {
  const readyState: AiStatusState = {
    aiConfigured: true,
    aiStatus: 'ready',
    keySource: 'key_file',
    rateLimitedUntilMs: null,
    retryAfterSec: null,
    isExactGoogleDelay: false,
    isDailyLimit: false,
    quotaLimit: null,
    googleMessage: null,
    lastRateLimitMessage: null,
    authErrorMessage: null,
    lastSuccessAtMs: 1_000_000,
    rateLimitHits: 0,
  };

  const en = formatAiStatusDisplay(readyState, 'en', 1_000_500);

  assert.equal(en.effectiveStatus, 'ready');
  assert.equal(en.tone, 'emerald');
  assert.equal(en.pillLabel, 'API Key: Active');
  assert.equal(en.sourceLabel, '00_ADD_API_KEY_HERE.txt');
  assert.equal(en.bannerTitle, null);
});

test('formatAiStatusDisplay uses exact Google delay and auto-recovers after expiry', () => {
  const now = 5_000_000;
  const limitedState: AiStatusState = {
    aiConfigured: true,
    aiStatus: 'rate_limited',
    keySource: 'env',
    rateLimitedUntilMs: now + 32_000,
    retryAfterSec: 32,
    isExactGoogleDelay: true,
    isDailyLimit: false,
    quotaLimit: 'Requests per minute (RPM)',
    googleMessage: 'Please retry in 32s',
    lastRateLimitMessage: 'Please retry in 32s',
    authErrorMessage: null,
    lastSuccessAtMs: null,
    rateLimitHits: 1,
  };

  const active = formatAiStatusDisplay(limitedState, 'en', now + 2_000);
  assert.equal(active.effectiveStatus, 'rate_limited');
  assert.equal(active.tone, 'amber');
  assert.equal(active.remainingSec, 30);
  assert.match(active.pillLabel, /Google Rate Limit/);
  assert.match(active.pillLabel, /30s/);
  assert.ok(active.availableAtClock);
  assert.equal(active.remainingDurationText, '30s');
  assert.match(active.bannerTitle ?? '', /Google Rate Limit/);
  assert.match(active.bannerTitle ?? '', /30s/);
  assert.match(active.bannerDetail ?? '', /30s remaining/);

  // After Google cooldown expires, status automatically returns to ready
  assert.equal(getEffectiveAiStatus(limitedState, now + 33_000), 'ready');
  assert.equal(computeRemainingCooldownSec(limitedState, now + 33_000), 0);
});

test('formatAiStatusDisplay shows daily limit with midnight reset clock time and no fake countdown seconds', () => {
  const dailyState: AiStatusState = {
    aiConfigured: true,
    aiStatus: 'rate_limited',
    keySource: 'env',
    rateLimitedUntilMs: null,
    retryAfterSec: null,
    isExactGoogleDelay: false,
    isDailyLimit: true,
    quotaLimit: 'Requests per day (RPD)',
    googleMessage: "Quota exceeded for limit 'Requests per day'",
    lastRateLimitMessage: "Quota exceeded for limit 'Requests per day'",
    authErrorMessage: null,
    lastSuccessAtMs: null,
    rateLimitHits: 1,
  };

  const daily = formatAiStatusDisplay(dailyState, 'en');
  assert.equal(daily.tone, 'amber');
  assert.equal(daily.remainingSec, 0); // Strictly 0, not a fake 45s!
  assert.match(daily.pillLabel, /Daily limit/);
  assert.ok(daily.availableAtClock);
  assert.ok(daily.remainingDurationText);
  assert.match(daily.bannerTitle ?? '', /Daily Requests Limit/);
  assert.match(daily.bannerDetail ?? '', /Available again/);
});

test('formatAiStatusDisplay flags invalid API keys clearly', () => {
  const invalidState: AiStatusState = {
    aiConfigured: true,
    aiStatus: 'auth_error',
    keySource: 'key_file',
    rateLimitedUntilMs: null,
    retryAfterSec: null,
    isExactGoogleDelay: false,
    isDailyLimit: false,
    quotaLimit: null,
    googleMessage: null,
    lastRateLimitMessage: null,
    authErrorMessage: 'API_KEY_INVALID',
    lastSuccessAtMs: null,
    rateLimitHits: 0,
  };

  const invalidDisplay = formatAiStatusDisplay(invalidState, 'en');
  assert.equal(invalidDisplay.tone, 'rose');
  assert.equal(invalidDisplay.pillLabel, 'API Key Invalid');
  assert.match(invalidDisplay.bannerDetail ?? '', /00_ADD_API_KEY_HERE\.txt/);
});

test('formatAvailableAtClock and formatRemainingDuration format exact times accurately in English', () => {
  const baseTime = Date.UTC(2026, 10, 16, 12, 0, 0); // 12:00:00 UTC

  // 35 seconds later
  const in35s = baseTime + 35_000;
  const clock35s = formatAvailableAtClock(in35s, baseTime, 'en');
  assert.match(clock35s, /at \d{2}:\d{2}:\d{2}/);
  const dur35sEn = formatRemainingDuration(in35s, baseTime, 'en');
  assert.equal(dur35sEn, '35s');

  // 4 minutes 20 seconds later
  const in4m20s = baseTime + (4 * 60 + 20) * 1000;
  const dur4mEn = formatRemainingDuration(in4m20s, baseTime, 'en');
  assert.equal(dur4mEn, '4m 20s');

  // Next daily reset at 00:00 UTC tomorrow
  const nextReset = getNextDailyResetTimestampMs(baseTime);
  const diffHours = (nextReset - baseTime) / (3600 * 1000);
  assert.equal(diffHours, 12);
  const durDailyEn = formatRemainingDuration(nextReset, baseTime, 'en');
  assert.equal(durDailyEn, '12h');
  const clockDailyEn = formatAvailableAtClock(nextReset, baseTime, 'en');
  assert.match(clockDailyEn, /tomorrow at \d{2}:\d{2}:\d{2}/);
});
