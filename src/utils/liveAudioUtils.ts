/**
 * Pure audio DSP, PCM conversion, and adaptive voice-activity helpers
 * for bidirectional 16kHz-in / 24kHz-out Gemini Live voice coaching.
 */

export function downsampleFloat32(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = 16000
): Float32Array {
  if (
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    Math.abs(sourceSampleRate - targetSampleRate) <= 1 ||
    samples.length === 0
  ) {
    return samples;
  }

  if (sourceSampleRate < targetSampleRate) {
    // Linear upsample fallback (rare, e.g. 8kHz Bluetooth HFP headset)
    const ratio = sourceSampleRate / targetSampleRate;
    const outLength = Math.max(1, Math.round(samples.length / ratio));
    const result = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = samples[Math.min(idx, samples.length - 1)];
      const b = samples[Math.min(idx + 1, samples.length - 1)];
      result[i] = a + (b - a) * frac;
    }
    return result;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const result = new Float32Array(outLength);

  let offsetBuffer = 0;
  for (let i = 0; i < outLength; i++) {
    const nextOffsetBuffer = Math.min(samples.length, Math.round((i + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let j = offsetBuffer; j < nextOffsetBuffer; j++) {
      accum += samples[j];
      count++;
    }
    result[i] = count > 0 ? accum / count : samples[Math.min(offsetBuffer, samples.length - 1)];
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function computeRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const usableLength = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(usableLength);
  for (let i = 0; i < usableLength; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, usableLength / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export interface SpeechGateConfig {
  /** Minimum RMS threshold even in a dead-silent room. */
  minSpeechRms?: number;
  /** Multiplier above adaptive background floor to trigger speech onset. */
  onsetMultiplier?: number;
  /** Multiplier above adaptive background floor to sustain speech. */
  sustainMultiplier?: number;
  /** Trailing silence duration before signaling audioStreamEnd. */
  silenceHangoverMs?: number;
  /** Minimum spoken duration before emitting audioStreamEnd (filters tiny clicks/pops). */
  minUtteranceMs?: number;
}

export interface SpeechFrameDecision {
  rms: number;
  isSpeechFrame: boolean;
  speechActive: boolean;
  startedSpeech: boolean;
  endedSpeech: boolean;
  shouldSendPreRoll: boolean;
  shouldTransmitAudio: boolean;
}

/**
 * Adaptive client-side speech/silence detector with 1-frame pre-roll support.
 * Ensures steady room/fan/sim-rig noise does not keep Gemini Live VAD stuck
 * waiting indefinitely for end-of-speech, and triggers clean `audioStreamEnd`
 * once a spoken phrase finishes.
 */
export class AdaptiveSpeechGate {
  private noiseFloor = 0.0025;
  private speechActive = false;
  private accumulatedLoudMs = 0;
  private lastLoudAtMs = 0;
  private readonly minSpeechRms: number;
  private readonly onsetMultiplier: number;
  private readonly sustainMultiplier: number;
  private readonly silenceHangoverMs: number;
  private readonly minUtteranceMs: number;
  private readonly sampleRate: number;

  constructor(config: SpeechGateConfig & { sampleRate?: number } = {}) {
    this.minSpeechRms = config.minSpeechRms ?? 0.0055;
    this.onsetMultiplier = config.onsetMultiplier ?? 2.2;
    this.sustainMultiplier = config.sustainMultiplier ?? 1.55;
    this.silenceHangoverMs = config.silenceHangoverMs ?? 780;
    this.minUtteranceMs = config.minUtteranceMs ?? 75;
    this.sampleRate = config.sampleRate ?? 16000;
  }

  get isSpeechActive(): boolean {
    return this.speechActive;
  }

  get currentNoiseFloor(): number {
    return this.noiseFloor;
  }

  reset(): void {
    this.noiseFloor = 0.0025;
    this.speechActive = false;
    this.accumulatedLoudMs = 0;
    this.lastLoudAtMs = 0;
  }

  processFrame(samples: Float32Array, nowMs: number): SpeechFrameDecision {
    const rms = computeRmsLevel(samples);
    const frameDurationMs = (samples.length / Math.max(1, this.sampleRate)) * 1000;
    const onsetThreshold = Math.max(this.minSpeechRms, this.noiseFloor * this.onsetMultiplier);
    const sustainThreshold = Math.max(this.minSpeechRms * 0.72, this.noiseFloor * this.sustainMultiplier);

    const activeThreshold = this.speechActive ? sustainThreshold : onsetThreshold;
    const isLoud = rms >= activeThreshold;

    let startedSpeech = false;
    let endedSpeech = false;

    if (isLoud) {
      if (!this.speechActive) {
        this.speechActive = true;
        this.accumulatedLoudMs = 0;
        startedSpeech = true;
      }
      this.accumulatedLoudMs += frameDurationMs;
      this.lastLoudAtMs = nowMs;
    } else {
      // Adapt noise floor gently during non-speech frames, clamped so loud hum never blinds onset
      const cappedSample = Math.min(rms, 0.035);
      this.noiseFloor = Math.max(
        0.0025,
        Math.min(0.03, this.noiseFloor * 0.94 + cappedSample * 0.06)
      );

      if (this.speechActive && nowMs - this.lastLoudAtMs >= this.silenceHangoverMs) {
        this.speechActive = false;
        this.accumulatedLoudMs = 0;
        endedSpeech = true;
      }
    }

    return {
      rms,
      isSpeechFrame: isLoud,
      speechActive: this.speechActive,
      startedSpeech,
      endedSpeech,
      shouldSendPreRoll: startedSpeech,
      shouldTransmitAudio: this.speechActive,
    };
  }
}
