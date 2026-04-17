/**
 * Speech-to-text via Groq cloud API (whisper-large-v3-turbo).
 *
 * Records audio to a temp WAV via sox, then sends to Groq's API
 * for transcription. Requires GROQ_API_KEY env var.
 * Partial callback fires every 2s with latest chunk.
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

export class SpeechToText {
  private readonly language: string;
  private readonly onPartial?: (text: string) => void;
  private readonly onFinal?: (text: string) => void;
  

  private recording = false;
  private soxProcess: ChildProcess | null = null;
  private tmpWav: string | null = null;
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private recordingStartedAt = 0;

  // Test hook: when set, startRecording/stopRecording skip sox/Groq and
  // resolve stopRecording with this transcript instead.
  private _testTranscript: string | null = null;

  constructor(opts: STTOptions) {
    this.language = opts.language ?? 'en';
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
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

    // Record up to 60s — sox runs with silence detection that ONLY stops
    // after the user finishes a long instruction (3s of silence after speech).
    // Groq's whisper-large-v3 handles the transcription accuracy; sox just
    // needs to capture cleanly and stop when the user is done talking.
    //
    // The `silence` effect here works because Groq (not local whisper) does
    // the transcription — we don't need the audio to be clean, just captured.
    // 1 0.5 1% = start recording after 0.5s of sound above 1%
    // 1 3.0 1% = stop after 3 seconds of silence below 1%
    const maxSec = 60;
    console.log("[stt] Listening... (speak now, 3s silence to finish)");
    this.soxProcess = execFile('sox', [
      '-d',
      '-r', '16000',
      '-c', '1',
      '-b', '16',
      this.tmpWav,
      'silence', '1', '0.5', '1%',   // wait for speech to start
      '1', '3.0', '1%',              // stop after 3s of silence (long pause = done)
      'trim', '0', String(maxSec),   // hard cap at 60s
    ]);

    this.soxProcess.on('error', (err) => {
      console.error('[stt] sox recording error:', err.message);
      this.recording = false;
    });

    // Safety timeout at 65s
    const timeout = setTimeout(() => {
      if (this.recording) {
        console.log('[stt] recording timeout (60s) — stopping');
        this.recording = false;
      }
    }, 65_000);

    // When sox exits (silence detected or max duration), mark done.
    this.soxProcess.on('exit', () => {
      clearTimeout(timeout);
      console.log("[stt] sox finished recording (silence detected or max reached)");
      this.recording = false;
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

    // recording=false means sox already exited (via exit handler) — that's
    // normal for fixed-duration recording. We still need to transcribe.
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

    if (!this.tmpWav) {
      console.log("[stt] no wav file — returning empty");
      return "";
    }

    console.log(`[stt] transcribing ${this.tmpWav}...`);
    const transcript = await this.transcribe(this.tmpWav);
    console.log(`[stt] groq result: "${transcript}"`);

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
    try {
      const { transcribeWithGroq, GROQ_MODEL_ACCURATE } = await import("./groq-stt.js");
      const result = await transcribeWithGroq(wavPath, {
        language: this.language,
        timeoutMs: 15_000, model: GROQ_MODEL_ACCURATE,
      });
      return result.text || "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[stt] Groq transcription failed:", message);
      return "[transcription failed]";
    }
  }
}
