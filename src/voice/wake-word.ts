/**
 * Wake-word detector — always listening, only fires on "Nchinda".
 *
 * Records rolling 3-second audio chunks via sox, transcribes each with
 * whisper-cli, and checks the transcript for the keyword. When the
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

export interface WakeWordOptions {
  keyword?: string;
  chunkSec?: number;          // recording chunk duration, default 3
  whisperBin?: string;
  modelPath?: string;
  onWake: () => void;
  onRmsUpdate?: (rms: number) => void;
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
  private readonly whisperBin: string;
  private readonly modelPath: string;
  private onWake: () => void;
  private readonly onRmsUpdate?: (rms: number) => void;

  private listening = false;
  private soxProcess: ChildProcess | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WakeWordOptions) {
    this.keyword = (opts.keyword ?? "nchinda").toLowerCase();
    this.chunkSec = opts.chunkSec ?? 3;
    this.onWake = opts.onWake;
    this.onRmsUpdate = opts.onRmsUpdate;
    this.whisperBin = opts.whisperBin
      ?? process.env.WHISPER_CLI_PATH
      ?? "whisper-cli";
    this.modelPath = opts.modelPath
      ?? process.env.WHISPER_MODEL_PATH
      ?? `${process.env.HOME}/.cortexos/models/ggml-base.en.bin`;
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
    const whisperOk = await commandExists(this.whisperBin);

    if (!soxOk) {
      console.warn("[wake-word] sox not found — wake detection disabled");
      return;
    }
    if (!whisperOk) {
      console.warn(`[wake-word] ${this.whisperBin} not found — wake detection disabled`);
      return;
    }

    this.listening = true;
    console.log(`[wake-word] Listening for "${this.keyword}"...`);
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
          console.log(`[wake-word] "${this.keyword}" detected — waking`);
          this.onWake();
          // After wake, pause briefly — the orchestrator will stop us
          // when it takes over the mic for STT recording.
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        // Sox or whisper error — wait 1s then retry
        const msg = err instanceof Error ? err.message : String(err);
        if (this.listening) {
          console.warn(`[wake-word] error: ${msg} — retrying in 1s`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  private async captureAndCheck(): Promise<boolean> {
    const tmpWav = join(tmpdir(), `wake-${randomUUID()}.wav`);

    try {
      // Record a short chunk
      await execFileAsync("sox", [
        "-d",
        "-r", "16000",
        "-c", "1",
        "-b", "16",
        tmpWav,
        "trim", "0", String(this.chunkSec),
      ], (this.chunkSec + 5) * 1000);

      if (!this.listening) return false;

      // Transcribe with whisper
      const { stdout } = await execFileAsync(this.whisperBin, [
        "--model", this.modelPath,
        "--language", "en",
        "--no-timestamps",
        "--file", tmpWav,
      ], 15_000);

      // Check for keyword in transcript — fuzzy match because whisper
      // may transcribe "Nchinda" as "Enchinda", "N'Chinda", "in Chinda", etc.
      const transcript = stdout
        .split("\n")
        .filter((l) => !l.startsWith("[") && l.trim())
        .join(" ")
        .toLowerCase()
        .trim();

      if (transcript && transcript !== "[blank_audio]" && !transcript.startsWith("[music")) {
        console.log(`[wake-word] heard: "${transcript}"`);
      }

      const hasKeyword =
        transcript.includes("nchinda") ||
        transcript.includes("enchinda") ||
        transcript.includes("chinda") ||
        transcript.includes("n'chinda") ||
        transcript.includes("in chinda") ||
        transcript.includes("and chinda") ||
        transcript.includes("hey chinda");

      this.onRmsUpdate?.(hasKeyword ? 0.8 : 0.05);

      return hasKeyword;
    } finally {
      await unlink(tmpWav).catch(() => {});
    }
  }
}
