import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveSpeechGate,
  base64ToFloat32,
  computeRmsLevel,
  downsampleFloat32,
  float32ToInt16Base64,
} from './liveAudioUtils.ts';

describe('liveAudioUtils', () => {
  it('passes through 16kHz audio unchanged and downsamples 48kHz / 44.1kHz cleanly to 16kHz', () => {
    const src16 = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    assert.equal(downsampleFloat32(src16, 16000, 16000), src16);

    // 48kHz -> 16kHz (3:1 exact ratio)
    const src48 = new Float32Array(4800);
    for (let i = 0; i < src48.length; i++) {
      src48[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const down48 = downsampleFloat32(src48, 48000, 16000);
    assert.equal(down48.length, 1600);
    assert.ok(computeRmsLevel(down48) > 0.15);

    // 44.1kHz -> 16kHz
    const src44 = new Float32Array(4410);
    src44.fill(0.2);
    const down44 = downsampleFloat32(src44, 44100, 16000);
    assert.equal(down44.length, 1600);
    assert.ok(Math.abs(down44[0] - 0.2) < 1e-4);
  });

  it('encodes Float32 to Int16 base64 and decodes safely even with odd-length chunks', () => {
    const original = new Float32Array([0, 0.5, -0.5, 0.99, -0.99]);
    const b64 = float32ToInt16Base64(original);
    const decoded = base64ToFloat32(b64);
    assert.equal(decoded.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(decoded[i] - original[i]) < 0.001);
    }

    // Odd trailing byte should not throw RangeError
    const oddBytes = btoa('ABC');
    const safeOdd = base64ToFloat32(oddBytes);
    assert.equal(safeOdd.length, 1);
  });

  it('detects speech amidst steady room noise and emits endedSpeech for short & normal turns', () => {
    const gate = new AdaptiveSpeechGate({ silenceHangoverMs: 750 });

    const makeFrame = (amp: number, len = 2048) => {
      const f = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        f[i] = amp * Math.sin(i * 0.2);
      }
      return f;
    };

    // 1. Ambient room floor (~0.004 amplitude) stays idle
    let t = 1000;
    for (let i = 0; i < 6; i++) {
      const d = gate.processFrame(makeFrame(0.004), t);
      assert.equal(d.speechActive, false);
      assert.equal(d.endedSpeech, false);
      t += 128;
    }

    // 2. Short 1-frame spoken word ("Box!") ~0.04 amplitude triggers onset
    const startDec = gate.processFrame(makeFrame(0.04), t);
    assert.equal(startDec.startedSpeech, true);
    assert.equal(startDec.shouldTransmitAudio, true);
    assert.equal(startDec.shouldSendPreRoll, true);
    t += 128;

    // 3. Silence hangover for ~800ms ends turn cleanly with endedSpeech = true
    let emittedEnd = false;
    for (let i = 0; i < 8; i++) {
      const d = gate.processFrame(makeFrame(0.002), t);
      if (d.endedSpeech) emittedEnd = true;
      t += 128;
    }
    assert.equal(emittedEnd, true);
    assert.equal(gate.isSpeechActive, false);

    // 4. Second spoken turn starts and ends cleanly too
    const turn2Start = gate.processFrame(makeFrame(0.05), t);
    assert.equal(turn2Start.startedSpeech, true);
    t += 128;
    gate.processFrame(makeFrame(0.05), t);
    t += 900;
    const turn2End = gate.processFrame(makeFrame(0.002), t);
    assert.equal(turn2End.endedSpeech, true);
  });

  it('LiveCoachVoiceClient starts with captureMode none and ignores reconnectWithConfig before connect', async () => {
    const { LiveCoachVoiceClient } = await import('./liveVoiceClient.ts');
    const statuses: string[] = [];
    const client = new LiveCoachVoiceClient({
      onStatusChange: (s) => statuses.push(s),
    });
    assert.equal(client.getAudioCaptureMode(), 'none');
    await client.reconnectWithConfig({ radioProtocol: 'coaching_detail' });
    assert.equal(statuses.length, 0);
    client.disconnect();
    assert.equal(client.getAudioCaptureMode(), 'none');
    assert.deepEqual(statuses, ['disconnected']);
  });

  it('always pairs startedSpeech and endedSpeech 1-to-1 even for brief 42ms AudioWorklet bursts', () => {
    const gate = new AdaptiveSpeechGate({ silenceHangoverMs: 520, minUtteranceMs: 75 });
    const shortBurst = new Float32Array(682).fill(0.05); // ~42.6ms at 16kHz
    const silence = new Float32Array(682).fill(0.0005);

    const s = gate.processFrame(shortBurst, 1000);
    assert.equal(s.startedSpeech, true);
    assert.equal(gate.isSpeechActive, true);

    const e = gate.processFrame(silence, 1600);
    assert.equal(e.endedSpeech, true);
    assert.equal(gate.isSpeechActive, false);
  });
});

