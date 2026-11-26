import type { RadioProtocol, SimSessionType } from '../types/telemetry';
import { extractAndPublishAiStatus, publishAiStatus, type AiStatusState } from './aiStatus';
import {
  AdaptiveSpeechGate,
  base64ToFloat32,
  downsampleFloat32,
  float32ToInt16Base64,
} from './liveAudioUtils';

export type LiveVoiceStatus = 'disconnected' | 'connecting' | 'listening' | 'speaking' | 'error';

export type LiveVoiceTurnPhase = 'idle' | 'user_speaking' | 'thinking' | 'ai_speaking';

export interface LiveVoiceCallbacks {
  onStatusChange: (status: LiveVoiceStatus, detail?: string) => void;
  onTurnPhaseChange?: (phase: LiveVoiceTurnPhase) => void;
  onInputTranscript?: (text: string) => void;
  onOutputTranscript?: (text: string) => void;
}

export interface LiveSessionConfig {
  simName: string;
  trackName: string;
  carName: string;
  carClass?: string;
  voiceName: string;
  radioProtocol?: RadioProtocol;
  sessionPhase?: SimSessionType;
  virtualEnergyPct?: number;
  language: 'en';
  isNewToGame: boolean;
  autonomyMode?: 'advise' | 'hands_on';
  sessionState?: string;
  speedKmh?: number;
  currentCorner?: string;
}

const MIC_WORKLET_PROCESSOR_NAME = 'apex-live-mic-processor';

const MIC_WORKLET_SOURCE = `
class ApexLiveMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    let readIdx = 0;
    while (readIdx < ch.length) {
      const space = this._buffer.length - this._offset;
      const toCopy = Math.min(space, ch.length - readIdx);
      this._buffer.set(ch.subarray(readIdx, readIdx + toCopy), this._offset);
      this._offset += toCopy;
      readIdx += toCopy;
      if (this._offset >= this._buffer.length) {
        const out = new Float32Array(this._buffer);
        this.port.postMessage(out, [out.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('${MIC_WORKLET_PROCESSOR_NAME}', ApexLiveMicProcessor);
`;

export class LiveCoachVoiceClient {
  private ws: WebSocket | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletBlobUrl: string | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silentSinkNode: GainNode | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private callbacks: LiveVoiceCallbacks;
  private outputTranscriptBuffer = '';
  private inputTranscriptBuffer = '';
  private hadError = false;
  private micStarted = false;
  private disconnectedManually = false;
  private activeConfig: LiveSessionConfig | null = null;
  private captureMode: 'worklet' | 'script_processor' | 'none' = 'none';

  private speechGate = new AdaptiveSpeechGate();
  private preRollBase64: string | null = null;
  private userSpeaking = false;
  private awaitingModelReply = false;
  private lastUserSpeechAtMs = 0;
  private pendingTelemetryState: string | null = null;
  private pendingTelemetryCue: string | null = null;
  private telemetryFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private connectEpoch = 0;

  constructor(callbacks: LiveVoiceCallbacks) {
    this.callbacks = callbacks;
  }

  getAudioCaptureMode(): 'worklet' | 'script_processor' | 'none' {
    return this.captureMode;
  }

  async reconnectWithConfig(patch: Partial<LiveSessionConfig>): Promise<void> {
    if (!this.activeConfig) return;
    const merged: LiveSessionConfig = { ...this.activeConfig, ...patch };
    await this.connect(merged, true);
  }

  async connect(config: LiveSessionConfig, suppressDisconnectedOnReset = false): Promise<void> {
    this.teardownConnection(!suppressDisconnectedOnReset);
    this.activeConfig = { ...config };
    this.disconnectedManually = false;
    this.hadError = false;
    this.micStarted = false;
    this.captureMode = 'none';
    this.outputTranscriptBuffer = '';
    this.inputTranscriptBuffer = '';
    this.preRollBase64 = null;
    this.userSpeaking = false;
    this.awaitingModelReply = false;
    this.lastUserSpeechAtMs = 0;
    this.pendingTelemetryState = null;
    this.pendingTelemetryCue = null;
    this.speechGate = new AdaptiveSpeechGate({
      silenceHangoverMs: config.radioProtocol === 'pro_terse' ? 520 : 680,
    });
    const myEpoch = ++this.connectEpoch;
    this.callbacks.onStatusChange('connecting');
    this.callbacks.onTurnPhaseChange?.('idle');

    try {
      // Create & unlock AudioContexts synchronously inside the click gesture
      // BEFORE awaiting getUserMedia so post-prompt playback is never suspended.
      const AudioCtxCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const inputCtx = new AudioCtxCtor({ sampleRate: 16000 });
      const outputCtx = new AudioCtxCtor({ sampleRate: 24000 });
      this.inputCtx = inputCtx;
      this.outputCtx = outputCtx;

      if (inputCtx.state === 'suspended') {
        void inputCtx.resume().catch(() => {});
      }
      if (outputCtx.state === 'suspended') {
        void outputCtx.resume().catch(() => {});
      }
      try {
        const silentBuf = outputCtx.createBuffer(1, 1, 24000);
        const silentSrc = outputCtx.createBufferSource();
        silentSrc.buffer = silentBuf;
        silentSrc.connect(outputCtx.destination);
        silentSrc.start(0);
      } catch {
        // ignore audio unlock edge cases
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      if (this.disconnectedManually || myEpoch !== this.connectEpoch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mediaStream = stream;

      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({
        simName: config.simName,
        trackName: config.trackName,
        carName: config.carName,
        carClass: config.carClass ?? 'Hypercar',
        voiceName: config.voiceName,
        radioProtocol: config.radioProtocol ?? 'pro_terse',
        sessionPhase: config.sessionPhase ?? 'unknown',
        ...(typeof config.virtualEnergyPct === 'number' && Number.isFinite(config.virtualEnergyPct)
          ? { virtualEnergyPct: String(Math.round(config.virtualEnergyPct)) }
          : {}),
        language: 'en',
        isNewToGame: String(config.isNewToGame),
        autonomyMode: config.autonomyMode ?? 'advise',
        sessionState: config.sessionState ?? 'standby_offline',
        speedKmh: String(Math.round(config.speedKmh ?? 0)),
        currentCorner: config.currentCorner ?? 'Standby',
      });
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live-coach?${params.toString()}`);
      this.ws = ws;

      const processCapturedSamples = (rawSamples: Float32Array, actualInputRate: number) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const samples16k = downsampleFloat32(rawSamples, actualInputRate, 16000);
        const now = Date.now();
        const decision = this.speechGate.processFrame(samples16k, now);

        if (decision.startedSpeech) {
          this.userSpeaking = true;
          this.awaitingModelReply = true;
          this.lastUserSpeechAtMs = now;
          this.clearOutputQueue();
          this.callbacks.onTurnPhaseChange?.('user_speaking');
          this.ws.send(JSON.stringify({ activityStart: true }));
          if (this.preRollBase64) {
            this.ws.send(JSON.stringify({ audio: this.preRollBase64, speaking: true }));
            this.preRollBase64 = null;
          }
        }

        if (decision.shouldTransmitAudio) {
          this.lastUserSpeechAtMs = now;
          const audioBase64 = float32ToInt16Base64(samples16k);
          this.ws.send(JSON.stringify({ audio: audioBase64, speaking: true }));
          this.preRollBase64 = null;
        } else {
          this.preRollBase64 = float32ToInt16Base64(samples16k);
          if (decision.endedSpeech) {
            this.userSpeaking = false;
            this.awaitingModelReply = true;
            this.lastUserSpeechAtMs = now;
            this.callbacks.onTurnPhaseChange?.('thinking');
            this.ws.send(JSON.stringify({ activityEnd: true }));
            this.scheduleTelemetryFlush(4500);
          }
        }
      };

      const startScriptProcessorFallback = (
        ctx: AudioContext,
        source: MediaStreamAudioSourceNode,
        silentSink: GainNode
      ) => {
        const actualInputRate = ctx.sampleRate || 16000;
        const processor = ctx.createScriptProcessor(2048, 1, 1);
        this.processor = processor;
        this.captureMode = 'script_processor';
        processor.onaudioprocess = (event) => {
          processCapturedSamples(event.inputBuffer.getChannelData(0), actualInputRate);
        };
        source.connect(processor);
        processor.connect(silentSink);
        silentSink.connect(ctx.destination);
      };

      const startMicCapture = async () => {
        if (
          this.micStarted ||
          !this.mediaStream ||
          !this.inputCtx ||
          !this.ws ||
          this.ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        this.micStarted = true;
        const ctx = this.inputCtx;
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
        const source = ctx.createMediaStreamSource(this.mediaStream);
        const silentSink = ctx.createGain();
        silentSink.gain.value = 0;

        this.sourceNode = source;
        this.silentSinkNode = silentSink;
        const actualInputRate = ctx.sampleRate || 16000;

        const canUseWorklet =
          typeof AudioWorkletNode !== 'undefined' &&
          Boolean(ctx.audioWorklet) &&
          typeof Blob !== 'undefined' &&
          typeof URL?.createObjectURL === 'function';

        if (canUseWorklet) {
          try {
            const blob = new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            this.workletBlobUrl = blobUrl;
            await ctx.audioWorklet.addModule(blobUrl);

            if (this.disconnectedManually || myEpoch !== this.connectEpoch || this.inputCtx !== ctx) {
              return;
            }

            const worklet = new AudioWorkletNode(ctx, MIC_WORKLET_PROCESSOR_NAME, {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              channelCount: 1,
            });
            this.workletNode = worklet;
            this.captureMode = 'worklet';
            worklet.port.onmessage = (event) => {
              if (event.data instanceof Float32Array) {
                processCapturedSamples(event.data, actualInputRate);
              } else if (ArrayBuffer.isView(event.data)) {
                const view = event.data as ArrayBufferView;
                processCapturedSamples(
                  new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4)),
                  actualInputRate
                );
              }
            };
            source.connect(worklet);
            worklet.connect(silentSink);
            silentSink.connect(ctx.destination);
            return;
          } catch {
            // Fall back smoothly if AudioWorklet is blocked or unsupported
            if (this.workletBlobUrl) {
              URL.revokeObjectURL(this.workletBlobUrl);
              this.workletBlobUrl = null;
            }
          }
        }

        startScriptProcessorFallback(ctx, source, silentSink);
      };

      ws.onopen = () => {
        // Wait for server { ready: true } once Gemini Live session is established
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.aiStatus && typeof msg.aiStatus === 'object') {
            publishAiStatus(msg.aiStatus as AiStatusState);
          }
          if (msg.error) {
            this.hadError = true;
            extractAndPublishAiStatus(msg.code === 'RATE_LIMIT' ? 429 : 500, msg);
            this.callbacks.onStatusChange('error', msg.error);
            this.callbacks.onTurnPhaseChange?.('idle');
            return;
          }
          if (msg.ready) {
            void startMicCapture();
            this.callbacks.onStatusChange('listening');
            this.callbacks.onTurnPhaseChange?.('idle');
            return;
          }
          if (msg.interrupted) {
            this.clearOutputQueue();
            // Discard interrupted partial AI text so it does not flush on the interrupted turnComplete
            this.outputTranscriptBuffer = '';
            this.awaitingModelReply = true;
            this.lastUserSpeechAtMs = Date.now();
            this.callbacks.onStatusChange('listening');
            this.callbacks.onTurnPhaseChange?.(this.userSpeaking ? 'user_speaking' : 'thinking');
            return;
          }
          if (msg.inputTranscript) {
            this.inputTranscriptBuffer += msg.inputTranscript;
            this.lastUserSpeechAtMs = Date.now();
          }
          if (msg.audio || msg.outputTranscript) {
            if (this.userSpeaking) {
              // Ignore trailing pre-interruption chunks while driver is actively speaking
              return;
            }
            if (this.inputTranscriptBuffer.trim()) {
              this.callbacks.onInputTranscript?.(this.inputTranscriptBuffer.trim());
              this.inputTranscriptBuffer = '';
            }
            this.awaitingModelReply = false;
          }
          if (msg.audio) {
            if (!this.micStarted) void startMicCapture();
            this.scheduleOutputAudio(msg.audio);
            this.callbacks.onStatusChange('speaking');
            this.callbacks.onTurnPhaseChange?.('ai_speaking');
          }
          if (msg.outputTranscript) {
            this.outputTranscriptBuffer += msg.outputTranscript;
          }
          if (msg.turnComplete) {
            if (this.inputTranscriptBuffer.trim()) {
              this.callbacks.onInputTranscript?.(this.inputTranscriptBuffer.trim());
              this.inputTranscriptBuffer = '';
            }
            if (this.outputTranscriptBuffer.trim()) {
              this.callbacks.onOutputTranscript?.(this.outputTranscriptBuffer.trim());
              this.outputTranscriptBuffer = '';
            }
            if (this.activeSources.size === 0) {
              this.callbacks.onStatusChange('listening');
              this.callbacks.onTurnPhaseChange?.(
                this.userSpeaking ? 'user_speaking' : this.awaitingModelReply ? 'thinking' : 'idle'
              );
            }
            this.scheduleTelemetryFlush(700);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        this.hadError = true;
        this.callbacks.onStatusChange('error', 'Live voice connection failed.');
        this.callbacks.onTurnPhaseChange?.('idle');
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.cleanupAudioOnly();
        if (!this.hadError && !this.disconnectedManually) {
          this.callbacks.onStatusChange('disconnected');
          this.callbacks.onTurnPhaseChange?.('idle');
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied.';
      this.disconnect();
      this.callbacks.onStatusChange('error', msg);
    }
  }

  private isConversationBusy(): boolean {
    const now = Date.now();
    return (
      this.userSpeaking ||
      this.awaitingModelReply ||
      this.activeSources.size > 0 ||
      now - this.lastUserSpeechAtMs < 4200
    );
  }

  private scheduleTelemetryFlush(delayMs = 900): void {
    if (this.telemetryFlushTimer) {
      clearTimeout(this.telemetryFlushTimer);
      this.telemetryFlushTimer = null;
    }
    if (!this.pendingTelemetryState && !this.pendingTelemetryCue) return;
    this.telemetryFlushTimer = setTimeout(() => {
      this.telemetryFlushTimer = null;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.isConversationBusy()) {
        // Do not overwrite user's voice turn; retry shortly or expire old transient cues
        if (Date.now() - this.lastUserSpeechAtMs > 12000) {
          this.awaitingModelReply = false;
        } else {
          this.scheduleTelemetryFlush(1000);
          return;
        }
      }
      if (this.pendingTelemetryState) {
        const state = this.pendingTelemetryState;
        this.pendingTelemetryState = null;
        this.ws.send(JSON.stringify({ telemetryState: state }));
      }
      if (this.pendingTelemetryCue) {
        const cue = this.pendingTelemetryCue;
        this.pendingTelemetryCue = null;
        this.ws.send(JSON.stringify({ telemetryCue: cue }));
      }
    }, delayMs);
  }

  sendTelemetryEvent(message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.isConversationBusy()) {
      // Never inject telemetry text mid-speech; keep only latest urgent context for when channel settles
      this.pendingTelemetryCue = message;
      this.scheduleTelemetryFlush(1500);
      return;
    }
    this.ws.send(JSON.stringify({ telemetryCue: message }));
  }

  sendTelemetryState(stateSummary: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.isConversationBusy()) {
      this.pendingTelemetryState = stateSummary;
      this.scheduleTelemetryFlush(1500);
      return;
    }
    this.ws.send(JSON.stringify({ telemetryState: stateSummary }));
  }

  private scheduleOutputAudio(base64Pcm: string): void {
    if (!this.outputCtx) return;
    if (this.outputCtx.state === 'suspended') {
      void this.outputCtx.resume().catch(() => {});
    }
    const float32 = base64ToFloat32(base64Pcm);
    if (float32.length === 0) return;

    const buffer = this.outputCtx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);

    const now = this.outputCtx.currentTime;
    const startAt = Math.max(now + 0.02, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.callbacks.onStatusChange('listening');
        this.callbacks.onTurnPhaseChange?.(this.userSpeaking ? 'user_speaking' : 'idle');
      }
    };
  }

  private clearOutputQueue(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    if (this.outputCtx) {
      this.nextStartTime = this.outputCtx.currentTime;
    }
  }

  private cleanupAudioOnly(): void {
    this.clearOutputQueue();
    this.captureMode = 'none';
    if (this.telemetryFlushTimer) {
      clearTimeout(this.telemetryFlushTimer);
      this.telemetryFlushTimer = null;
    }
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.silentSinkNode) {
      this.silentSinkNode.disconnect();
      this.silentSinkNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.inputCtx) {
      this.inputCtx.close().catch(() => {});
      this.inputCtx = null;
    }
    if (this.outputCtx) {
      this.outputCtx.close().catch(() => {});
      this.outputCtx = null;
    }
  }

  private teardownConnection(emitDisconnected: boolean): void {
    this.disconnectedManually = true;
    this.connectEpoch += 1;
    const oldWs = this.ws;
    this.ws = null;
    if (oldWs) {
      try {
        if (this.userSpeaking && oldWs.readyState === WebSocket.OPEN) {
          oldWs.send(JSON.stringify({ activityEnd: true }));
        }
        oldWs.close();
      } catch {
        // ignore
      }
    }
    this.userSpeaking = false;
    this.cleanupAudioOnly();
    if (emitDisconnected) {
      this.callbacks.onStatusChange('disconnected');
      this.callbacks.onTurnPhaseChange?.('idle');
    }
  }

  disconnect(): void {
    this.teardownConnection(true);
  }
}
