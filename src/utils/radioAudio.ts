import type { CalloutSeverity, CoachSettings } from '../types/telemetry';
import { extractAndPublishAiStatus } from './aiStatus';

let audioCtx: AudioContext | null = null;
let currentAudioEl: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;
let lastSpokenAt = 0;
let lastSpeechCancelAt = 0;
const activeUtterances = new Set<SpeechSynthesisUtterance>();

// Warm browser speech voices early so async Google/Microsoft English voices populate before first callout.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      try {
        window.speechSynthesis.getVoices();
      } catch {
        // Ignore browser voice enumeration errors
      }
    });
  } catch {
    // Ignore initialization errors
  }
}

function ensureAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Call synchronously inside click/tap handlers so AudioContext & speechSynthesis
 * keep user-gesture activation across async /api/coach/tts fetches and iframes.
 */
export function unlockAudioPlayback(): void {
  try {
    const ctx = ensureAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      // Play a 1-sample silent buffer to unlock audio output in strict browsers/iframes
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      // Trigger voice list population early
      window.speechSynthesis.getVoices();
    }
  } catch {
    // Ignore unlock errors on unsupported browsers
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').trim();
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stopGeminiAudioOnly(): void {
  if (currentBufferSource) {
    try {
      currentBufferSource.onended = null;
      currentBufferSource.stop();
      currentBufferSource.disconnect();
    } catch {
      // already stopped
    }
    currentBufferSource = null;
  }
  if (currentAudioEl) {
    try {
      currentAudioEl.onended = null;
      currentAudioEl.onerror = null;
      currentAudioEl.pause();
    } catch {
      // ignore
    }
    currentAudioEl = null;
  }
  if (currentObjectUrl) {
    try {
      URL.revokeObjectURL(currentObjectUrl);
    } catch {
      // ignore
    }
    currentObjectUrl = null;
  }
}

/**
 * Plays base64 WAV/audio via Web Audio API (immune to post-fetch HTMLAudio autoplay blocking
 * once AudioContext is unlocked) with Blob HTMLAudioElement fallback.
 * Returns true only if playback actually started and finished (or was aborted mid-play);
 * returns false if decoding/autoplay failed so caller can fall back to browser speech.
 */
async function playEncodedAudioBase64(
  base64: string,
  mimeType: string,
  options: {
    volume: number;
    playbackRate: number;
    signal?: AbortSignal;
    onEnded?: () => void;
  }
): Promise<'played' | 'aborted' | 'failed'> {
  if (options.signal?.aborted) return 'aborted';

  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8Array(base64);
    if (bytes.byteLength < 64) return 'failed';
  } catch {
    return 'failed';
  }

  // 1) Try Web Audio API decodeAudioData first
  try {
    const ctx = ensureAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      if (options.signal?.aborted) return 'aborted';

      if (ctx.state === 'running') {
        const audioCopy = new Uint8Array(bytes.byteLength);
        audioCopy.set(bytes);
        const audioBuffer = await ctx.decodeAudioData(audioCopy.buffer);
        if (options.signal?.aborted) return 'aborted';

        stopGeminiAudioOnly();
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = audioBuffer;
        source.playbackRate.value = options.playbackRate;
        gain.gain.value = options.volume;
        source.connect(gain);
        gain.connect(ctx.destination);
        currentBufferSource = source;

        return await new Promise<'played' | 'aborted'>((resolve) => {
          let settled = false;
          const finish = (outcome: 'played' | 'aborted') => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener('abort', onAbort);
            if (currentBufferSource === source) currentBufferSource = null;
            if (outcome === 'played') options.onEnded?.();
            resolve(outcome);
          };
          const onAbort = () => {
            try {
              source.stop();
            } catch {
              // ignore
            }
            finish('aborted');
          };
          options.signal?.addEventListener('abort', onAbort, { once: true });
          source.onended = () => finish('played');
          source.start(0);
        });
      }
    }
  } catch {
    // Fall through to Blob HTMLAudioElement fallback
  }

  if (options.signal?.aborted) return 'aborted';

  // 2) Fallback: Blob URL HTMLAudioElement
  try {
    stopGeminiAudioOnly();
    const blob = new Blob([bytes.buffer.slice(0) as ArrayBuffer], { type: mimeType || 'audio/wav' });
    const objUrl = URL.createObjectURL(blob);
    currentObjectUrl = objUrl;
    const audio = new Audio(objUrl);
    audio.volume = options.volume;
    audio.playbackRate = options.playbackRate;
    currentAudioEl = audio;

    return await new Promise<'played' | 'aborted' | 'failed'>((resolve) => {
      let settled = false;
      const finish = (outcome: 'played' | 'aborted' | 'failed') => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        if (currentAudioEl === audio) {
          stopGeminiAudioOnly();
        } else {
          try {
            URL.revokeObjectURL(objUrl);
          } catch {
            // ignore
          }
        }
        if (outcome === 'played') options.onEnded?.();
        resolve(outcome);
      };
      const onAbort = () => finish('aborted');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      audio.onended = () => finish('played');
      audio.onerror = () => finish('failed');
      audio.play().catch(() => finish('failed'));
    });
  } catch {
    return 'failed';
  }
}

/**
 * Plays a crisp motorsport pit-radio squelch/beep before or after speech.
 */
export function playRadioSquelch(kind: 'open' | 'close' | 'urgent'): void {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (kind === 'urgent') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(1180, now);
      osc.frequency.setValueAtTime(1520, now + 0.06);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
      return;
    }

    osc.type = 'sine';
    osc.frequency.setValueAtTime(kind === 'open' ? 1320 : 880, now);
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  } catch {
    // Audio playback may be blocked prior to user gesture; ignore gracefully.
  }
}

export type SpeechVoiceLike = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'default'>;

const BANNED_NON_ENGLISH_VOICE_NAME_RE = /greek|stefanos|athina|nestoras|\u03b5\u03bb\u03bb\u03b7\u03bd/i;
const BANNED_GREEK_LANG_RE = /^(el|ell|gre)([-_]|$)/i;

export function isEnglishSpeechVoice(voice: SpeechVoiceLike): boolean {
  const normLang = (voice.lang || '').trim().toLowerCase().replace(/_/g, '-');
  const name = (voice.name || '').trim();

  if (BANNED_GREEK_LANG_RE.test(normLang) || BANNED_NON_ENGLISH_VOICE_NAME_RE.test(name)) {
    return false;
  }
  if (/^en([-]|$)/.test(normLang)) {
    return true;
  }
  if (!normLang && /\benglish\b/i.test(name)) {
    return true;
  }
  return false;
}

function scoreEnglishVoice(voice: SpeechVoiceLike): number {
  const normLang = (voice.lang || '').trim().toLowerCase().replace(/_/g, '-');
  const name = (voice.name || '').trim().toLowerCase();
  let score = 0;

  if (normLang === 'en-gb') score += 100;
  else if (normLang === 'en-us') score += 80;
  else if (normLang.startsWith('en-')) score += 50;
  else score += 20;

  if (/google uk english male|microsoft ryan|microsoft george|microsoft guy/.test(name)) {
    score += 200;
  } else if (
    /google us english|google uk english female|microsoft libby|microsoft aria|microsoft jenny|microsoft sonia/.test(
      name
    )
  ) {
    score += 160;
  } else if (/natural|online|neural/.test(name)) {
    score += 120;
  } else if (/google|daniel|arthur|oliver|samantha|matthew|stephen|brian/.test(name)) {
    score += 90;
  }

  if (voice.default) score += 10;
  return score;
}

export function pickEnglishVoice<T extends SpeechVoiceLike>(
  voices: readonly T[]
): { voice: T | null; hasLanguageVoice: boolean } {
  const englishVoices = voices.filter(isEnglishSpeechVoice);
  if (englishVoices.length === 0) {
    // Never fall back to OS default / first voice (e.g. el-GR Microsoft Stefanos on Greek Windows).
    return { voice: null, hasLanguageVoice: false };
  }

  const ranked = englishVoices
    .map((voice, index) => ({ voice, index, score: scoreEnglishVoice(voice) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return { voice: ranked[0].voice, hasLanguageVoice: true };
}

async function waitForEnglishSpeechVoices(maxWaitMs = 750): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  const immediate = window.speechSynthesis.getVoices();
  if (pickEnglishVoice(immediate).hasLanguageVoice) {
    return immediate;
  }

  return await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      window.speechSynthesis.removeEventListener('voiceschanged', onVoices);
      resolve(window.speechSynthesis.getVoices());
    };
    const onVoices = () => {
      const latest = window.speechSynthesis.getVoices();
      if (pickEnglishVoice(latest).hasLanguageVoice) {
        finish();
      }
    };
    const pollTimer = setInterval(onVoices, 150);
    const timer = setTimeout(finish, maxWaitMs);
    window.speechSynthesis.addEventListener('voiceschanged', onVoices);
  });
}

function splitSpeechIntoChunks(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const rawSentences = cleaned.split(/(?<=[.!;?])\s+/);
  const chunks: string[] = [];
  let buf = '';
  for (const s of rawSentences) {
    if (!s) continue;
    if ((buf + ' ' + s).trim().length <= 165) {
      buf = (buf ? buf + ' ' : '') + s;
    } else {
      if (buf) chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length > 0 ? chunks : [cleaned];
}

export async function speakWithBrowserSynthesis(
  text: string,
  severity: CalloutSeverity,
  settings: CoachSettings
): Promise<boolean> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  try {
    const voices = await waitForEnglishSpeechVoices(750);
    const { voice, hasLanguageVoice } = pickEnglishVoice(voices);
    // Strict guard: never call speechSynthesis.speak with voice=null or a non-English voice.
    if (!hasLanguageVoice || !voice) {
      return false;
    }

    if (severity === 'urgent' && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
      window.speechSynthesis.cancel();
      lastSpeechCancelAt = Date.now();
      await new Promise((r) => setTimeout(r, 55));
    }
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang || 'en-GB';
    utterance.rate =
      severity === 'urgent' ? Math.min(1.3, settings.speechRate + 0.06) : settings.speechRate;
    utterance.pitch = severity === 'urgent' ? 1.03 : 0.96;
    utterance.volume = Math.max(0.1, Math.min(1, settings.voiceVolume ?? 0.95));

    activeUtterances.add(utterance);
    utterance.onend = () => {
      activeUtterances.delete(utterance);
      if (settings.radioSquelchFx) {
        playRadioSquelch('close');
      }
    };
    utterance.onerror = () => {
      activeUtterances.delete(utterance);
    };
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export async function speakCoachCallout(
  text: string,
  severity: CalloutSeverity,
  settings: CoachSettings,
  preferGemini = true
): Promise<'gemini-tts' | 'browser-speech' | 'muted'> {
  if (!settings.voiceEnabled) return 'muted';

  const isDirectMode = settings.radioProtocol === 'pro_terse';
  const now = Date.now();
  const minAudioGapMs = isDirectMode
    ? Math.max(900, (settings.minSpeakIntervalSec ?? 4) * 450)
    : Math.max(1500, (settings.minSpeakIntervalSec ?? 4) * 650);
  const canInterrupt = severity === 'urgent' && (settings.urgentInterruptsRadio ?? true);
  if (!canInterrupt && now - lastSpokenAt < minAudioGapMs) {
    return 'muted';
  }
  lastSpokenAt = now;

  if (settings.radioSquelchFx) {
    playRadioSquelch(severity === 'urgent' ? 'urgent' : 'open');
  }

  // Prefer natural Gemini TTS voice when enabled by the user.
  if (settings.useGeminiTts && preferGemini) {
    try {
      const resp = await fetch('/api/coach/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voiceName: settings.geminiVoiceName,
          urgent: severity === 'urgent',
          radioProtocol: settings.radioProtocol ?? 'coaching_detail',
          language: 'en',
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        extractAndPublishAiStatus(resp.status, data);
        if (data.audioBase64) {
          const baseRate = Math.max(0.8, Math.min(1.3, settings.speechRate ?? 1.05));
          const outcome = await playEncodedAudioBase64(data.audioBase64, data.mimeType || 'audio/wav', {
            volume: Math.max(0.1, Math.min(1, settings.voiceVolume ?? 0.95)),
            playbackRate: isDirectMode ? Math.min(1.3, baseRate + 0.04) : baseRate,
            onEnded: () => {
              if (settings.radioSquelchFx) playRadioSquelch('close');
            },
          });
          if (outcome === 'played') return 'gemini-tts';
        }
      } else {
        const errData = await resp.json().catch(() => null);
        extractAndPublishAiStatus(resp.status, errData);
      }
    } catch {
      // Fall back to strict language-matched browser speech
    }
  }

  const spoke = await speakWithBrowserSynthesis(text, severity, settings);
  return spoke ? 'browser-speech' : 'muted';
}

export function stopAllRadioSpeech(): void {
  stopGeminiAudioOnly();
  activeUtterances.clear();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
      lastSpeechCancelAt = Date.now();
    }
  }
}

export interface PresentationSpeechOptions {
  language?: 'en';
  voiceEnabled: boolean;
  useGeminiTts: boolean;
  geminiVoiceName: CoachSettings['geminiVoiceName'];
  speechRate?: number;
  voiceVolume?: number;
  signal?: AbortSignal;
}

export interface PresentationSpeechResult {
  mode: 'gemini-tts' | 'browser-speech' | 'muted' | 'unavailable';
  reason?: string;
}

/**
 * Speaks a single presentation slide narration segment and resolves once playback completes.
 * Tries Gemini TTS first (via unlocked Web Audio decodeAudioData + Blob Audio fallback),
 * then falls back cleanly to sentence-chunked browser SpeechSynthesis without silent drops.
 */
export async function speakPresentationSegment(
  text: string,
  options: PresentationSpeechOptions
): Promise<PresentationSpeechResult> {
  if (!options.voiceEnabled || options.signal?.aborted || !text.trim()) {
    return { mode: 'muted' };
  }

  stopAllRadioSpeech();

  let geminiFailureReason: string | undefined;

  if (options.useGeminiTts) {
    try {
      const resp = await fetch('/api/coach/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal,
        body: JSON.stringify({
          text,
          voiceName: options.geminiVoiceName,
          urgent: false,
          language: 'en',
        }),
      });
      if (options.signal?.aborted) return { mode: 'muted' };

      if (resp.ok) {
        const data = await resp.json();
        extractAndPublishAiStatus(resp.status, data);
        if (data.audioBase64 && !options.signal?.aborted) {
          const outcome = await playEncodedAudioBase64(
            data.audioBase64,
            data.mimeType || 'audio/wav',
            {
              volume: Math.max(0.1, Math.min(1, options.voiceVolume ?? 0.95)),
              playbackRate: Math.max(0.85, Math.min(1.3, options.speechRate ?? 1.05)),
              signal: options.signal,
            }
          );
          if (outcome === 'aborted') return { mode: 'muted' };
          if (outcome === 'played') return { mode: 'gemini-tts' };
          geminiFailureReason = 'browser-audio-blocked';
        } else if (data.rateLimited) {
          geminiFailureReason = 'gemini-quota';
        } else if (data.fallback) {
          geminiFailureReason = 'gemini-unavailable';
        }
      } else {
        const errData = await resp.json().catch(() => null);
        extractAndPublishAiStatus(resp.status, errData);
        geminiFailureReason = resp.status === 429 ? 'gemini-quota' : 'gemini-unavailable';
      }
    } catch {
      if (options.signal?.aborted) return { mode: 'muted' };
      geminiFailureReason = 'gemini-network';
    }
  }

  // Fallback to browser SpeechSynthesis (sentence-chunked so Chromium never stalls on long text)
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return { mode: 'unavailable', reason: geminiFailureReason || 'no-speech-api' };
  }

  const voices = await waitForEnglishSpeechVoices(750);
  if (options.signal?.aborted) return { mode: 'muted' };

  const { voice, hasLanguageVoice } = pickEnglishVoice(voices);
  if (!hasLanguageVoice || !voice) {
    return {
      mode: 'unavailable',
      reason: geminiFailureReason || 'no-english-voice',
    };
  }

  // Wait briefly after any recent speechSynthesis.cancel() to avoid Chromium's silent drop bug
  const sinceCancel = Date.now() - lastSpeechCancelAt;
  if (sinceCancel < 55) {
    await new Promise((r) => setTimeout(r, 55 - sinceCancel));
    if (options.signal?.aborted) return { mode: 'muted' };
  }

  const chunks = splitSpeechIntoChunks(text);
  let playedAnyChunk = false;
  let lastErrorCode: string | undefined;

  for (const chunk of chunks) {
    if (options.signal?.aborted) return { mode: 'muted' };

    const chunkOutcome = await new Promise<'ok' | 'aborted' | 'error'>((resolve) => {
      let settled = false;
      let started = false;
      let startWatchdog: ReturnType<typeof setTimeout>;
      const finish = (outcome: 'ok' | 'aborted' | 'error') => {
        if (settled) return;
        settled = true;
        clearTimeout(startWatchdog);
        clearTimeout(safetyTimer);
        clearInterval(resumeHeartbeat);
        options.signal?.removeEventListener('abort', onAbort);
        activeUtterances.delete(utterance);
        resolve(outcome);
      };

      const onAbort = () => {
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.cancel();
          lastSpeechCancelAt = Date.now();
        }
        finish('aborted');
      };

      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.voice = voice;
      utterance.lang = voice.lang || 'en-GB';
      utterance.rate = Math.max(0.85, Math.min(1.3, options.speechRate ?? 1.05));
      utterance.pitch = 0.96;
      utterance.volume = Math.max(0.1, Math.min(1, options.voiceVolume ?? 0.95));

      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = () => finish('ok');
      utterance.onerror = (ev) => {
        lastErrorCode = ev?.error || 'synthesis-error';
        finish(ev?.error === 'canceled' || ev?.error === 'interrupted' ? 'aborted' : 'error');
      };

      // Chrome pauses long utterances unless resumed periodically; also abort if speech never even starts within 2.8s
      startWatchdog = setTimeout(() => {
        if (!started && !settled && !window.speechSynthesis.speaking) {
          lastErrorCode = 'not-allowed-or-silent';
          finish('error');
        }
      }, 2800);

      const safetyTimer = setTimeout(() => {
        finish(started ? 'ok' : 'error');
      }, 15000);

      const resumeHeartbeat = setInterval(() => {
        if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      }, 2500);

      options.signal?.addEventListener('abort', onAbort, { once: true });
      activeUtterances.add(utterance);

      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
        window.speechSynthesis.speak(utterance);
      } catch {
        clearTimeout(startWatchdog);
        finish('error');
      }
    });

    if (chunkOutcome === 'aborted') return { mode: 'muted' };
    if (chunkOutcome === 'ok') {
      playedAnyChunk = true;
    } else {
      break;
    }
  }

  if (playedAnyChunk) {
    return { mode: 'browser-speech' };
  }
  return {
    mode: 'unavailable',
    reason: lastErrorCode || geminiFailureReason || 'speech-blocked',
  };
}

