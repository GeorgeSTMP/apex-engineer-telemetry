import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEnglishSpeechVoice,
  pickEnglishVoice,
  speakWithBrowserSynthesis,
  type SpeechVoiceLike,
} from '../utils/radioAudio';
import type { CoachSettings } from '../types/telemetry';

const TEST_SETTINGS: CoachSettings = {
  voiceEnabled: true,
  useGeminiTts: false,
  geminiVoiceName: 'Fenrir',
  language: 'en',
  focusMode: 'all',
  preCornerCuesEnabled: true,
  racecraftAlertsEnabled: true,
  tireAlertsEnabled: true,
  tirePressureAlertsEnabled: true,
  brakeTempAlertsEnabled: true,
  fuelAlertsEnabled: true,
  trackLimitsAlertsEnabled: true,
  tractionAlertsEnabled: true,
  lapPaceAlertsEnabled: true,
  urgentInterruptsRadio: true,
  autonomyMode: 'advise',
  radioSquelchFx: false,
  verbosity: 'balanced',
  minSpeakIntervalSec: 4,
  lateBrakeThresholdMeters: 10,
  hazardAlertsEnabled: true,
  speechRate: 1.05,
  voiceVolume: 0.9,
};

test('pickEnglishVoice rejects Greek-only OS voices and never falls back to default voice', () => {
  const greekOnly: SpeechVoiceLike[] = [
    { name: 'Microsoft Stefanos - Greek (Greece)', lang: 'el-GR', default: true },
    { name: 'Microsoft Athina - Greek (Greece)', lang: 'el-GR', default: false },
    { name: 'Microsoft Nestoras Online (Natural) - Greek (Greece)', lang: 'el_GR', default: false },
  ];

  const picked = pickEnglishVoice(greekOnly);
  assert.equal(picked.hasLanguageVoice, false);
  assert.equal(picked.voice, null);
});

test('pickEnglishVoice returns null for empty voice list', () => {
  const picked = pickEnglishVoice([]);
  assert.equal(picked.hasLanguageVoice, false);
  assert.equal(picked.voice, null);
});

test('pickEnglishVoice picks natural UK/US English voice over Greek OS default', () => {
  const mixed: SpeechVoiceLike[] = [
    { name: 'Microsoft Stefanos - Greek (Greece)', lang: 'el-GR', default: true },
    { name: 'Microsoft David - English (United States)', lang: 'en-US', default: false },
    { name: 'Google UK English Male', lang: 'en-GB', default: false },
    { name: 'Google US English', lang: 'en-US', default: false },
  ];

  const picked = pickEnglishVoice(mixed);
  assert.equal(picked.hasLanguageVoice, true);
  assert.equal(picked.voice?.name, 'Google UK English Male');
  assert.equal(picked.voice?.lang, 'en-GB');
});

test('pickEnglishVoice normalizes underscores and rejects banned Greek names regardless of lang', () => {
  assert.equal(isEnglishSpeechVoice({ name: 'Google US English', lang: 'en_US', default: false }), true);
  assert.equal(isEnglishSpeechVoice({ name: 'Microsoft Stefanos', lang: 'en-US', default: false }), false);
  assert.equal(isEnglishSpeechVoice({ name: 'Greek Female', lang: '', default: false }), false);
  assert.equal(isEnglishSpeechVoice({ name: 'Google UK English Male', lang: '', default: false }), true);
  assert.equal(isEnglishSpeechVoice({ name: 'Deutsch', lang: 'de-DE', default: true }), false);
});

test('speakWithBrowserSynthesis refuses to call speechSynthesis.speak when only Greek voices exist', async () => {
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origUtterance = (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;
  const spoken: Array<{ voice: SpeechVoiceLike | null; lang: string; text: string }> = [];

  class FakeUtterance {
    text: string;
    lang = '';
    voice: SpeechVoiceLike | null = null;
    rate = 1;
    pitch = 1;
    volume = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const greekOnly = [{ name: 'Microsoft Stefanos - Greek (Greece)', lang: 'el-GR', default: true }];
  (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance;
  (globalThis as Record<string, unknown>).window = {
    speechSynthesis: {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => greekOnly,
      addEventListener: () => {},
      removeEventListener: () => {},
      resume: () => {},
      cancel: () => {},
      speak: (u: FakeUtterance) => {
        spoken.push({ voice: u.voice, lang: u.lang, text: u.text });
      },
    },
  };

  try {
    const ok = await speakWithBrowserSynthesis('Box this lap for fresh tires.', 'coaching', TEST_SETTINGS);
    assert.equal(ok, false);
    assert.equal(spoken.length, 0);
  } finally {
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = origUtterance;
  }
});

test('speakWithBrowserSynthesis waits for async English voiceschanged instead of using initial Greek voice', async () => {
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origUtterance = (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;
  const spoken: Array<{ voice: SpeechVoiceLike | null; lang: string; text: string }> = [];
  const listeners = new Set<() => void>();

  class FakeUtterance {
    text: string;
    lang = '';
    voice: SpeechVoiceLike | null = null;
    rate = 1;
    pitch = 1;
    volume = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  let currentVoices: SpeechVoiceLike[] = [
    { name: 'Microsoft Stefanos - Greek (Greece)', lang: 'el-GR', default: true },
  ];

  (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance;
  (globalThis as Record<string, unknown>).window = {
    speechSynthesis: {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => currentVoices,
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === 'voiceschanged') listeners.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        if (ev === 'voiceschanged') listeners.delete(fn);
      },
      resume: () => {},
      cancel: () => {},
      speak: (u: FakeUtterance) => {
        spoken.push({ voice: u.voice, lang: u.lang, text: u.text });
      },
    },
  };

  setTimeout(() => {
    currentVoices = [
      { name: 'Microsoft Stefanos - Greek (Greece)', lang: 'el-GR', default: true },
      { name: 'Google UK English Male', lang: 'en-GB', default: false },
    ];
    for (const fn of listeners) fn();
  }, 60);

  try {
    const ok = await speakWithBrowserSynthesis('Brake 10 meters earlier at Turn 1.', 'coaching', TEST_SETTINGS);
    assert.equal(ok, true);
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].voice?.name, 'Google UK English Male');
    assert.equal(spoken[0].lang, 'en-GB');
  } finally {
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = origUtterance;
  }
});
