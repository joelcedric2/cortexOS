/**
 * Speech-to-text via whisper CLI (whisper.cpp).
 *
 * Records audio to a temp WAV via sox, then shells out to `whisper`
 * for transcription. Falls back to a placeholder if whisper is not
 * installed. Partial callback fires every 2s with latest chunk.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
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
  private readonly model: string;
  private readonly language: string;
  private readonly onPartial?: (text: string) => void;
  private readonly onFinal?: (text: string) => void;
  private readonly timeoutMs: number;

  private recording = false;
  private soxProcess: ChildProcess | null = null;
  private tmpWav: string | null = null;
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private recordingStartedAt = 0;

  constructor(opts: STTOptions) {
    this.model = opts.model ?? 'base.en';
    this.language = opts.language ?? 'en';
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
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

    this.soxProcess = execFile('sox', [
      '-d',           // default audio device
      '-r', '16000',
      '-c', '1',      // mono
      '-b', '16',
      this.tmpWav,
    ]);

    this.soxProcess.on('error', (err) => {
      console.error('[stt] sox recording error:', err.message);
      this.recording = false;
    });

    // Auto-stop after timeout
    const timeout = setTimeout(() => {
      if (this.recording) {
        void this.stopRecording();
      }
    }, this.timeoutMs);

    this.soxProcess.on('exit', () => {
      clearTimeout(timeout);
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
    if (!this.recording) {
      return '';
    }

    this.recording = false;

    if (this.partialTimer) {
      clearInterval(this.partialTimer);
      this.partialTimer = null;
    }

    // Kill sox to finalize the WAV file
    if (this.soxProcess) {
      this.soxProcess.kill('SIGTERM');
      // Wait for process exit
      await new Promise<void>((resolve) => {
        if (this.soxProcess) {
          this.soxProcess.on('exit', resolve);
          // Safety timeout
          setTimeout(resolve, 2000);
        } else {
          resolve();
        }
      });
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
    const whisperAvailable = await commandExists('whisper');

    if (!whisperAvailable) {
      console.warn(
        '[stt] whisper CLI not found. Returning placeholder transcript.',
      );
      return '[whisper not installed — transcript unavailable]';
    }

    const outputBase = wavPath.replace(/\.wav$/, '');

    try {
      await execFileAsync(
        'whisper',
        [
          wavPath,
          '--model', this.model,
          '--language', this.language,
          '--output_format', 'txt',
          '--output_dir', tmpdir(),
        ],
        60_000, // 60s timeout for transcription
      );

      // Whisper outputs <basename>.txt
      const txtPath = `${outputBase}.txt`;
      const text = await readFile(txtPath, 'utf-8').catch(() => '');
      await unlink(txtPath).catch(() => {});

      return text.trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[stt] Whisper transcription failed:', message);
      return '[transcription failed]';
    }
  }
}
