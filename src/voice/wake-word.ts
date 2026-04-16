/**
 * Wake-word detector using energy-based Voice Onset Detection.
 *
 * Option A (recommended): Captures mic audio via sox, computes RMS on
 * 50ms chunks. Sustained RMS above threshold for 300ms+ triggers wake.
 * Actual keyword matching ("nchinda") deferred to Phase 7 (Porcupine).
 *
 * DECISION: Using energy-based VOD to avoid commercial SDK dependency.
 */

import { execFile, type ChildProcess } from 'node:child_process';

export interface WakeWordOptions {
  keyword?: string;           // default "nchinda" (reserved for Phase 7)
  sensitivity?: number;       // 0..1, default 0.5
  sampleRate?: number;        // default 16000
  onWake: () => void;
  onRmsUpdate?: (rms: number) => void;
}

/** Duration in ms that RMS must stay above threshold to trigger wake */
const SUSTAINED_MS = 300;

/** Chunk size in ms for RMS computation */
const CHUNK_MS = 50;

/** Map sensitivity (0..1) to an RMS threshold. Higher sensitivity = lower threshold. */
function sensitivityToThreshold(sensitivity: number): number {
  // sensitivity 0 -> threshold 0.1, sensitivity 1 -> threshold 0.005
  const clamped = Math.max(0, Math.min(1, sensitivity));
  return 0.1 - clamped * 0.095;
}

/** Compute RMS from a buffer of 16-bit signed PCM samples */
export function computeRms(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

export class WakeWordDetector {
  readonly keyword: string;
  private readonly sensitivity: number;
  private readonly sampleRate: number;
  private onWake: () => void;
  private readonly onRmsUpdate?: (rms: number) => void;
  private readonly threshold: number;

  private listening = false;
  private soxProcess: ChildProcess | null = null;
  private sustainedStart: number | null = null;
  private wakeFired = false;

  constructor(opts: WakeWordOptions) {
    this.keyword = opts.keyword ?? 'nchinda';
    this.sensitivity = opts.sensitivity ?? 0.5;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.onWake = opts.onWake;
    this.onRmsUpdate = opts.onRmsUpdate;
    this.threshold = sensitivityToThreshold(this.sensitivity);
  }

  /**
   * Replace the wake callback after construction. Used by VoiceOrchestrator,
   * which holds the detector but wires the handler later when it knows what
   * to do with a wake event.
   */
  setOnWake(fn: () => void): void {
    this.onWake = fn;
  }

  /**
   * Test hook: synchronously fire the wake callback without running sox.
   * Use only from tests.
   */
  _simulateWake(): void {
    this.onWake();
  }

  async start(): Promise<void> {
    if (this.listening) return;

    // Verify sox is available
    const soxExists = await new Promise<boolean>((resolve) => {
      execFile('which', ['sox'], (err) => resolve(!err));
    });

    if (!soxExists) {
      console.warn(
        '[wake-word] sox not found on PATH. Voice wake detection disabled.',
      );
      return;
    }

    this.listening = true;
    this.wakeFired = false;
    this.sustainedStart = null;

    // Calculate bytes per chunk: sampleRate * 2 bytes * chunkMs / 1000
    const bytesPerChunk = Math.floor(
      (this.sampleRate * 2 * CHUNK_MS) / 1000,
    );

    this.soxProcess = execFile('sox', [
      '-d',           // default audio device
      '-t', 'raw',    // raw PCM output
      '-r', String(this.sampleRate),
      '-c', '1',      // mono
      '-e', 'signed',
      '-b', '16',     // 16-bit
      '-',            // stdout
    ]);

    let buffer = Buffer.alloc(0);

    this.soxProcess.stdout?.on('data', (chunk: Buffer) => {
      if (!this.listening) return;

      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= bytesPerChunk) {
        const pcmChunk = buffer.subarray(0, bytesPerChunk);
        buffer = buffer.subarray(bytesPerChunk);

        const rms = computeRms(pcmChunk);
        this.onRmsUpdate?.(rms);
        this.processRms(rms);
      }
    });

    this.soxProcess.on('error', (err) => {
      console.error('[wake-word] sox process error:', err.message);
      this.listening = false;
    });

    this.soxProcess.on('exit', () => {
      this.listening = false;
      this.soxProcess = null;
    });
  }

  stop(): void {
    this.listening = false;
    this.sustainedStart = null;

    if (this.soxProcess) {
      this.soxProcess.kill('SIGTERM');
      this.soxProcess = null;
    }
  }

  isListening(): boolean {
    return this.listening;
  }

  /** @internal — exposed for testing */
  processRms(rms: number): void {
    if (this.wakeFired) return;

    if (rms >= this.threshold) {
      if (this.sustainedStart === null) {
        this.sustainedStart = Date.now();
      } else if (Date.now() - this.sustainedStart >= SUSTAINED_MS) {
        this.wakeFired = true;
        this.onWake();
      }
    } else {
      // Reset sustained counter on silence
      this.sustainedStart = null;
    }
  }

  /** Reset wake state so detector can trigger again */
  resetWake(): void {
    this.wakeFired = false;
    this.sustainedStart = null;
  }
}
