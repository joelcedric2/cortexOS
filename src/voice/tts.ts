/**
 * Text-to-speech — Edge TTS only.
 *
 * Uses Microsoft's free neural TTS via the `edge-tts` CLI. No API key,
 * no fallback chain, no complexity. One engine, one voice: Andrew
 * (warm, confident, authentic) — Nchinda's voice.
 *
 * Requires: `pip3 install edge-tts` (already installed).
 */

import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface TTSOptions {
  voice?: string;
  edgeTtsPath?: string;
  onSpeakStart?: () => void;
  onSpeakEnd?: () => void;
  onRmsUpdate?: (rms: number) => void;
}

/** Nchinda's default voice — deep, confident, slight British accent. */
export const DEFAULT_VOICE = "en-GB-RyanNeural";

function execFileAsync(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export class TextToSpeech {
  private readonly voice: string;
  private readonly edgeTtsPath: string;
  private readonly onSpeakStart?: () => void;
  private readonly onSpeakEnd?: () => void;
  private speaking = false;
  private abortController: AbortController | null = null;
  // Test hooks — same contract as before so existing tests compile.
  private _testPromise: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(opts: TTSOptions = {}) {
    this.voice = opts.voice ?? DEFAULT_VOICE;
    // edge-tts might not be on PATH if pip installed to a user dir
    this.edgeTtsPath = opts.edgeTtsPath
      ?? process.env.EDGE_TTS_PATH
      ?? "/Users/joelc/Library/Python/3.9/bin/edge-tts";
    this.onSpeakStart = opts.onSpeakStart;
    this.onSpeakEnd = opts.onSpeakEnd;
  }

  /** Test hook: prime the next speak() to await an in-process promise. */
  _armTestPromise(): void {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => { resolve = r; });
    this._testPromise = { promise, resolve };
  }

  /** Test hook: resolve the pending speak() call. */
  _resolveSpeak(): void {
    if (!this._testPromise) {
      this._armTestPromise();
    }
    this._testPromise?.resolve();
    this._testPromise = null;
  }

  async speak(text: string): Promise<void> {
    // If already speaking, wait for it to finish instead of crashing.
    // Multiple voice flows (ack, narration, reply) can overlap — queue
    // them instead of throwing.
    if (this.speaking) {
      await this.waitUntilDone();
    }
    if (!text.trim()) return;

    this.speaking = true;
    this.abortController = new AbortController();
    this.onSpeakStart?.();

    try {
      if (this._testPromise) {
        await this._testPromise.promise;
      } else {
        await this.speakEdge(text);
      }
    } finally {
      this.speaking = false;
      this.abortController = null;
      this.onSpeakEnd?.();
    }
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.speaking = false;
  }

  private waitUntilDone(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.speaking) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      // Safety: don't wait more than 30s
      setTimeout(() => { clearInterval(check); resolve(); }, 30_000);
    });
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private async speakEdge(text: string): Promise<void> {
    if (process.env.CORTEXOS_TEST) return;
    const tmpMp3 = join(tmpdir(), `nchinda-tts-${randomUUID()}.mp3`);

    try {
      // edge-tts --voice <voice> --text "<text>" --write-media <path>
      await execFileAsync(this.edgeTtsPath, [
        "--voice", this.voice,
        "--text", text,
        "--write-media", tmpMp3,
      ]);

      if (this.abortController?.signal.aborted) return;

      // Play the audio
      await execFileAsync("afplay", [tmpMp3]);
    } finally {
      await unlink(tmpMp3).catch(() => {});
    }
  }
}
