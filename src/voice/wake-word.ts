/**
 * Wake-word detector — always listening, only fires on "Nchinda".
 *
 * Records rolling 3-second audio chunks via sox, transcribes each with
 * Groq cloud STT, and checks the transcript for the keyword. When the
 * keyword is detected, fires the onWake callback.
 *
 * This runs continuously whenever cortexOS is up. The mic is always on.
 * Only the keyword triggers action — ambient noise is ignored.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcribeWithGroq } from "./groq-stt.js";
import type { EchoGate } from "./echo-gate.js";
export interface WakeWordOptions {
  keyword?: string;
  chunkSec?: number;          // recording chunk duration, default 3
  onWake: () => void;
  onRmsUpdate?: (rms: number) => void;
  /** When supplied, captureAndCheck skips Groq transcription while muted. */
  echoGate?: EchoGate;
}
function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [cmd], (err) => resolve(!err));
  });
}
export class WakeWordDetector {
  readonly keyword: string;
  private readonly chunkSec: number;
  private onWake: () => void;
  private readonly onRmsUpdate?: (rms: number) => void;
  private readonly echoGate?: EchoGate;
  private listening = false;
  private soxProcess: ChildProcess | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(opts: WakeWordOptions) {
    this.keyword = (opts.keyword ?? "nchinda").toLowerCase();
    this.chunkSec = opts.chunkSec ?? 3;
    this.onWake = opts.onWake;
    this.onRmsUpdate = opts.onRmsUpdate;
    this.echoGate = opts.echoGate;
  }
  setOnWake(fn: () => void): void {
    this.onWake = fn;
  }
  _simulateWake(): void {
    this.onWake();
  }
  async start(): Promise<void> {
    if (this.listening) return;
    const soxOk = await commandExists("sox");
    if (!soxOk) {
      console.warn("[Nchinda] sox not found — wake detection disabled");
      return;
    }
    if (!process.env.GROQ_API_KEY) {
      console.warn("[Nchinda] GROQ_API_KEY not set — wake detection disabled");
      return;
    }
    this.listening = true;
    console.log(`[Nchinda] Listening for "${this.keyword}"...`);
    this.listenLoop();
  }
  stop(): void {
    this.listening = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.soxProcess) {
      try { this.soxProcess.kill("SIGTERM"); } catch {}
      this.soxProcess = null;
    }
  }
  isListening(): boolean {
    return this.listening;
  }
  private async listenLoop(): Promise<void> {
    while (this.listening) {
      try {
        const detected = await this.captureAndCheck();
        if (detected && this.listening) {
          console.log(`[Nchinda] Wake word detected`);
          this.onWake();
          // After wake, pause briefly — the orchestrator will stop us
          // when it takes over the mic for STT recording.
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        // Sox or Groq error — wait 1s then retry
        const msg = err instanceof Error ? err.message : String(err);
        if (this.listening) {
          console.warn(`[Nchinda] error: ${msg} — retrying in 1s`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }
  private async captureAndCheck(): Promise<boolean> {
    const tmpWav = join(tmpdir(), `wake-${randomUUID()}.wav`);
    try {
      // Record a short chunk for keyword detection
      // 
      await execFileAsync("sox", [
        "-d",
        "-r", "16000",
        "-c", "1",
        "-b", "16",
        tmpWav,
        "trim", "0", String(this.chunkSec),
      ], (this.chunkSec + 5) * 1000);
      if (!this.listening) return false;
      // Echo gate: if TTS is playing (or echo is decaying), skip
      // transcription entirely — just discard the recorded audio.
      // This prevents Nchinda's own voice from triggering false wakes.
      if (this.echoGate?.isMuted()) {
        return false;
      }
      // Transcribe with Groq (whisper-large-v3-turbo, free, ~0.3s)
      const result = await transcribeWithGroq(tmpWav, { timeoutMs: 8_000 });
      const transcript = result.text.toLowerCase().trim();
      if (transcript) {
        console.log(`[Cedric] "${transcript}"`);
      }
      // Match real variants Groq produces — but NOT loose substrings
      // like "chinda" alone (catches "chindang", keyboard noise artifacts).
      const hasKeyword =
        transcript.includes("nchinda") ||
        transcript.includes("enchinda") ||
        transcript.includes("n'chinda") ||
        transcript.includes("in chinda") ||
        transcript.includes("and chinda") ||
        transcript.includes("hey chinda") ||
        transcript.includes("and jinda") ||
        /\benchinda\b/.test(transcript);
      this.onRmsUpdate?.(hasKeyword ? 0.8 : 0.05);
      return hasKeyword;
    } finally {
      await unlink(tmpWav).catch(() => {});
    }
  }
}
