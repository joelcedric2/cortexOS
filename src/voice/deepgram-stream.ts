/**
 * Deepgram streaming STT — replaces file-based Groq pipeline.
 *
 * A single sox process streams raw 16-bit PCM to a Deepgram WebSocket
 * in real time. Three modes: wake (listen for wake word), command
 * (collect utterance), muted (echo suppression during TTS playback).
 *
 * No temp files, no uploads — sub-200ms latency end-to-end.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VPIO_PATH = join(__dirname, "..", "..", "helpers", "cortexos-mic");

type Mode = "wake" | "command" | "interrupt";

interface DeepgramResult {
  type: string;
  channel?: { alternatives?: Array<{ transcript?: string }> };
  speech_final?: boolean;
  is_final?: boolean;
  /** Seconds since the Deepgram stream opened (sent on every Results message). */
  start?: number;
  /** Audio segment length in seconds (sent on every Results message). */
  duration?: number;
}

export interface DeepgramVoiceStreamOpts {
  apiKey?: string;
  wakeWords?: string[];
  onWake: () => void;
  onTranscript: (text: string) => void;
  onPartial?: (text: string) => void;
}

const DG_URL =
  "wss://api.deepgram.com/v1/listen?" +
  "model=nova-2&language=en&smart_format=true&endpointing=2000" +
  "&interim_results=true&vad_events=true&encoding=linear16" +
  "&sample_rate=16000&channels=1";

const RECONNECT_DELAY_MS = 1_000;
const CHUNK_SIZE = 4096;

export class DeepgramVoiceStream {
  private readonly apiKey: string;
  private readonly wakeWords: string[];
  private readonly onWake: () => void;
  private readonly onTranscript: (text: string) => void;
  private readonly onPartial?: (text: string) => void;

  private mode: Mode = "wake";
  private running = false;
  private mic: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private wakeFired = false;
  private commandBuffer: string[] = [];
  private lastPartial = "";
  private commandSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private modeChangedAt = 0;
  private gotFirstResult = false;
  /** Recent TTS text for echo rejection — if a transcript matches this, drop it. */
  private echoBuffer = "";
  /** Timestamp when TTS stopped — reject echo for 3s after. */
  private ttsEndedAt = 0;
  /** Wall-clock ms when the Deepgram WebSocket opened. */
  private streamEpochMs = 0;
  /** Wall-clock ms when TTS playback started. 0 = not playing. */
  private ttsStartedAtMs = 0;
  /** Wall-clock ms when TTS playback ended. */
  private ttsEndedAtMs = 0;

  constructor(opts: DeepgramVoiceStreamOpts) {
    this.apiKey = opts.apiKey ?? process.env.DEEPGRAM_API_KEY ?? "";
    this.wakeWords = (opts.wakeWords ?? ["cortex", "nchinda"]).map((w) =>
      w.toLowerCase(),
    );
    this.onWake = opts.onWake;
    this.onTranscript = opts.onTranscript;
    this.onPartial = opts.onPartial;
  }

  // ── Public API ──────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.apiKey) throw new Error("DEEPGRAM_API_KEY not set");

    this.running = true;
    this.startMic();
    this.connectWebSocket();
  }

  stop(): void {
    this.running = false;
    this.killMic();
    this.closeWebSocket();
  }

  /**
   * Tell the stream what text Nchinda just spoke via TTS.
   * Transcripts matching this text will be rejected as echo.
   */
  setEchoText(text: string): void {
    this.echoBuffer = text.toLowerCase().replace(/[^\w\s]/g, "");
    this.ttsEndedAt = Date.now();
  }

  /** Signal that TTS playback is about to start. */
  markTtsStarted(): void {
    this.ttsStartedAtMs = Date.now();
  }

  /** Signal that TTS playback has ended. Also updates ttsEndedAt for text-overlap compat. */
  markTtsEnded(): void {
    this.ttsEndedAtMs = Date.now();
    this.ttsEndedAt = Date.now();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.modeChangedAt = Date.now();
    if (mode === "wake") this.wakeFired = false;
    if (mode === "command") {
      this.commandBuffer = [];
      this.lastPartial = "";
      if (this.commandSilenceTimer) clearTimeout(this.commandSilenceTimer);
      this.commandSilenceTimer = null;
    }
  }

  getMode(): string {
    return this.mode;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Mic capture ─────────────────────────────────────────────────

  private startMic(): void {
    if (existsSync(VPIO_PATH)) {
      console.log("[deepgram-stream] Using VPIO mic (hardware AEC)");
      this.mic = spawn(VPIO_PATH, []);
    } else {
      console.log("[deepgram-stream] Using sox mic (no hardware AEC)");
      this.mic = spawn("sox", [
        "-d", "-r", "16000", "-c", "1", "-b", "16",
        "-e", "signed-integer", "-t", "raw", "-",
      ]);
    }

    this.mic.stderr?.on("data", () => {});

    this.mic.on("error", (err) => {
      console.error("[deepgram-stream] mic error:", err.message);
    });

    this.mic.on("exit", () => {
      if (this.running) {
        console.warn("[deepgram-stream] mic exited unexpectedly — restarting");
        this.startMic();
      }
    });

    this.mic.stdout?.on("data", (chunk: Buffer) => {
      this.sendAudio(chunk);
    });
  }

  private killMic(): void {
    if (this.mic && !this.mic.killed) {
      this.mic.kill("SIGTERM");
    }
    this.mic = null;
  }

  // ── WebSocket ───────────────────────────────────────────────────

  private connectWebSocket(): void {
    if (!this.running) return;

    this.ws = new WebSocket(DG_URL, {
      headers: { Authorization: `Token ${this.apiKey}` },
    } as never);

    this.ws.onopen = () => {
      console.log("[deepgram-stream] WebSocket connected");
      this.reconnecting = false;
      this.streamEpochMs = Date.now();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onerror = (event: Event) => {
      const err = event as Event & { message?: string };
      console.error("[deepgram-stream] WebSocket error:", err.message ?? "unknown");
    };

    this.ws.onclose = () => {
      if (this.running && !this.reconnecting) {
        this.reconnecting = true;
        console.warn("[deepgram-stream] WebSocket closed — reconnecting");
        setTimeout(() => this.connectWebSocket(), RECONNECT_DELAY_MS);
      }
    };
  }

  private closeWebSocket(): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      // already closed
    }
    this.ws.onclose = null;
    this.ws.close();
    this.ws = null;
  }

  private audioBytesSent = 0;
  private sendAudio(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Log first audio send to confirm data is flowing
    if (this.audioBytesSent === 0) {
      console.log(`[deepgram-stream] First audio chunk: ${chunk.length} bytes`);
    }
    this.audioBytesSent += chunk.length;

    for (let off = 0; off < chunk.length; off += CHUNK_SIZE) {
      const slice = chunk.subarray(off, off + CHUNK_SIZE);
      try {
        this.ws.send(slice);
      } catch {
        break;
      }
    }
  }

  // ── Message handling ────────────────────────────────────────────

  private handleMessage(event: MessageEvent): void {
    let msg: DeepgramResult;
    try {
      msg = JSON.parse(String(event.data)) as DeepgramResult;
    } catch {
      return;
    }

    // Log first message to confirm Deepgram is responding
    if (msg.type === "Results" && !this.gotFirstResult) {
      this.gotFirstResult = true;
      console.log("[deepgram-stream] First Deepgram result received");
    }
    if (msg.type !== "Results") return;

    const transcript = (
      msg.channel?.alternatives?.[0]?.transcript ?? ""
    ).trim();
    if (!transcript) return;

    // Timestamp-based echo rejection — first line of defense.
    if (this.isTimestampEcho(msg)) return;

    // Text-level echo rejection (fallback): if the transcript matches what
    // Nchinda just said via TTS, drop it. Uses token overlap — if >50% of
    // the transcript tokens appear in the TTS text, it's echo, not the user.
    if (this.echoBuffer && Date.now() - this.ttsEndedAt < 4000) {
      if (this.isEcho(transcript)) return;
    }

    // Minimal debounce in wake mode — timestamp echo handles the heavy lifting.
    if (this.mode === "wake" && Date.now() - this.modeChangedAt < 200) return;

    if (this.mode === "wake" || this.mode === "interrupt") {
      // Both modes check for wake words only. Interrupt mode is active
      // during TTS — lets the user say "cortex" or "stop" to interrupt.
      this.handleWakeMode(transcript);
      return;
    }

    // command mode
    this.handleCommandMode(transcript, msg);
  }

  /**
   * Timestamp-based echo rejection — deterministic alternative to text overlap.
   * Checks whether the audio segment that produced this transcript overlaps
   * the wall-clock window during which TTS was playing.
   */
  private isTimestampEcho(msg: DeepgramResult): boolean {
    if (!msg.start || !this.streamEpochMs || !this.ttsStartedAtMs) return false;
    const audioStartMs = this.streamEpochMs + msg.start * 1000;
    const audioEndMs = audioStartMs + (msg.duration ?? 0) * 1000;
    const ttsWindowEnd = (this.ttsEndedAtMs || Date.now()) + 200;
    // Overlap: [audioStart, audioEnd] ∩ [ttsStarted, ttsEnded+200ms]
    const overlaps = audioStartMs < ttsWindowEnd && this.ttsStartedAtMs < audioEndMs;
    if (overlaps) {
      console.log(`[deepgram-stream] Timestamp echo rejected: audio overlaps TTS window`);
    }
    return overlaps;
  }

  /**
   * Check if a transcript is echo of recent TTS output.
   * Uses token overlap — if >50% of transcript tokens appear in the
   * echo buffer, it's Nchinda hearing itself, not the user.
   */
  private isEcho(transcript: string): boolean {
    const incoming = transcript.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
    if (incoming.length === 0) return false;
    const echoTokens = new Set(this.echoBuffer.split(/\s+/).filter(Boolean));
    const overlap = incoming.filter((t) => echoTokens.has(t)).length;
    const ratio = overlap / incoming.length;
    if (ratio > 0.5) {
      console.log(`[deepgram-stream] Echo rejected (${Math.round(ratio * 100)}% match): "${transcript}"`);
      return true;
    }
    return false;
  }

  private handleWakeMode(transcript: string): void {
    if (this.wakeFired) return;

    const lower = transcript.toLowerCase();
    // In interrupt mode, only listen for words Nchinda would never say
    // about itself. "nchinda" is excluded because TTS saying "I'm Nchinda"
    // would trigger a false interrupt.
    const words = this.mode === "interrupt"
      ? ["cortex", "stop", "cancel", "never mind", "nevermind"]
      : this.wakeWords;
    const matched = words.some((w) => lower.includes(w));
    if (matched) {
      this.wakeFired = true;
      this.onWake();
    }
  }

  private handleCommandMode(transcript: string, msg: DeepgramResult): void {
    // Track everything — both final and partial results.
    if (msg.is_final) {
      this.commandBuffer.push(transcript);
    }
    this.lastPartial = transcript;
    this.onPartial?.(transcript);

    // Fire on speech_final (endpointing detected by Deepgram).
    if (msg.speech_final) {
      this.fireCommand();
      return;
    }

    // Fallback: if Deepgram's endpointing doesn't fire, use our own
    // 3s silence timer. Reset on every transcript.
    if (this.commandSilenceTimer) clearTimeout(this.commandSilenceTimer);
    this.commandSilenceTimer = setTimeout(() => {
      if (this.mode === "command") this.fireCommand();
    }, 3000);
  }

  private fireCommand(): void {
    if (this.commandSilenceTimer) {
      clearTimeout(this.commandSilenceTimer);
      this.commandSilenceTimer = null;
    }
    // Prefer accumulated finals; fall back to last partial.
    const fromBuffer = this.commandBuffer.join(" ").trim();
    const result = fromBuffer || this.lastPartial.trim();
    this.commandBuffer = [];
    this.lastPartial = "";
    if (result) this.onTranscript(result);
  }
}
