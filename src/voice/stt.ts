/**
 * Speech-to-text via whisper CLI (whisper.cpp).
 *
 * Records audio to a temp WAV via sox, then shells out to `whisper`
 * for transcription. Falls back to a placeholder if whisper is not
 * installed. Partial callback fires every 2s with latest chunk.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface STTOptions {
  model?: string;             // default "base.en"
  language?: string;          // default "en"
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  timeoutMs?: number;         // max recording time, default 30000
}

/** Check if a binary exists on PATH */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
  });
}

/** Run execFile as a promise with optional timeout */
function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      },
    );
  });
}

export class SpeechToText {
  private readonly language: string;
  private readonly onPartial?: (text: string) => void;
  private readonly onFinal?: (text: string) => void;
  private readonly timeoutMs: number;

  private recording = false;
  private soxProcess: ChildProcess | null = null;
  private tmpWav: string | null = null;
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private recordingStartedAt = 0;

  // Test hook: when set, startRecording/stopRecording skip sox/whisper and
  // resolve stopRecording with this transcript instead.
  private _testTranscript: string | null = null;

  constructor(opts: STTOptions) {
    this.language = opts.language ?? 'en';
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  /** Test hook: resolve the next stopRecording() with `transcript` synchronously. */
  _resolveWith(transcript: string): void {
    this._testTranscript = transcript;
    this.recording = false;
    this.onFinal?.(transcript);
  }

  async startRecording(): Promise<void> {
    if (this.recording) {
      throw new Error('Already recording. Call stopRecording() first.');
    }

    const soxAvailable = await commandExists('sox');
    if (!soxAvailable) {
      console.warn('[stt] sox not found. Recording disabled.');
      return;
    }

    this.tmpWav = join(tmpdir(), `cortex-stt-${randomUUID()}.wav`);
    this.recording = true;
    this.recordingStartedAt = Date.now();

    // Record for a fixed duration. Silence detection via sox's `silence`
    // effect was too unreliable on laptop mics (ambient noise triggered
    // false starts, or sox exited immediately). Instead: record for a
    // fixed window (default 8s) then transcribe whatever was captured.
    // The user gets a clear "speak now" prompt and a defined window.
    const recordSec = Math.min(Math.floor(this.timeoutMs / 1000), 15);
    console.log(`[stt] Recording for ${recordSec}s — speak now`);
    this.soxProcess = execFile('sox', [
      '-d',           // default audio device
      '-r', '16000',
      '-c', '1',      // mono
      '-b', '16',
      this.tmpWav,
      'gain', '40',                     // +40dB boost for quiet laptop mics
      'trim', '0', String(recordSec),   // fixed duration recording
    ]);

    this.soxProcess.on('error', (err) => {
      console.error('[stt] sox recording error:', err.message);
      this.recording = false;
    });

    // Safety timeout — in case silence detection never triggers
    const timeout = setTimeout(() => {
      if (this.recording) {
        console.log('[stt] recording timeout — stopping');
        void this.stopRecording();
      }
    }, this.timeoutMs);

    // When sox exits naturally (silence detected), auto-trigger stopRecording
    this.soxProcess.on('exit', () => {
      clearTimeout(timeout);
      if (this.recording) {
        console.log('[stt] sox exited (silence detected) — transcribing');
        void this.stopRecording();
      }
    });

    // Partial transcription every 2s (fire partial with elapsed info)
    if (this.onPartial) {
      this.partialTimer = setInterval(() => {
        if (!this.recording) return;
        const elapsed = Math.round((Date.now() - this.recordingStartedAt) / 1000);
        this.onPartial?.(`[recording ${elapsed}s...]`);
      }, 2000);
    }
  }

  async stopRecording(): Promise<string> {
    // Test hook: if _resolveWith was called, short-circuit with the transcript.
    if (this._testTranscript !== null) {
      const t = this._testTranscript;
      this._testTranscript = null;
      this.recording = false;
      return t;
    }

    if (!this.recording) {
      return '';
    }

    this.recording = false;

    if (this.partialTimer) {
      clearInterval(this.partialTimer);
      this.partialTimer = null;
    }

    // Finalize the WAV file — sox may have already exited (silence detection)
    // or may still be recording (manual stop / timeout). Kill only if alive.
    if (this.soxProcess) {
      if (!this.soxProcess.killed && this.soxProcess.exitCode === null) {
        this.soxProcess.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          if (this.soxProcess) {
            this.soxProcess.on('exit', resolve);
            setTimeout(resolve, 2000);
          } else {
            resolve();
          }
        });
      }
      this.soxProcess = null;
    }

    if (!this.tmpWav) return '';

    const transcript = await this.transcribe(this.tmpWav);

    // Clean up
    await unlink(this.tmpWav).catch(() => {});
    this.tmpWav = null;

    this.onFinal?.(transcript);
    return transcript;
  }

  isRecording(): boolean {
    return this.recording;
  }

  private async transcribe(wavPath: string): Promise<string> {
    // whisper.cpp installs as `whisper-cli` via brew, not `whisper`
    const whisperBin = process.env.WHISPER_CLI_PATH ?? "whisper-cli";
    const modelPath = process.env.WHISPER_MODEL_PATH
      ?? `${process.env.HOME}/.cortexos/models/ggml-base.en.bin`;

    const whisperAvailable = await commandExists(whisperBin);

    if (!whisperAvailable) {
      console.warn(
        `[stt] ${whisperBin} not found. Install: brew install whisper-cpp`,
      );
      return "[whisper not installed — transcript unavailable]";
    }

    try {
      // whisper-cli outputs to stdout with --output-txt --no-timestamps
      const { stdout } = await execFileAsync(
        whisperBin,
        [
          "--model", modelPath,
          "--language", this.language,
          "--no-timestamps",
          "--file", wavPath,
        ],
        60_000,
      );

      // whisper-cli prints the transcript to stdout directly
      const text = stdout
        .split("\n")
        .filter((line) => !line.startsWith("[") && line.trim())
        .join(" ")
        .trim();

      return text || "[empty transcript]";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[stt] Whisper transcription failed:", message);
      return "[transcription failed]";
    }
  }
}
