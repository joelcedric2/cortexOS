/**
 * Text-to-speech engine with multi-backend support.
 * Engines: macos-say (default), piper, elevenlabs.
 * Auto-selects best available engine.
 */

import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import https from 'node:https';

export interface TTSOptions {
  engine?: 'macos-say' | 'piper' | 'elevenlabs';
  voice?: string;
  apiKey?: string;
  onSpeakStart?: () => void;
  onSpeakEnd?: () => void;
  onRmsUpdate?: (rms: number) => void;
}

type TTSEngine = 'macos-say' | 'piper' | 'elevenlabs';

/** Check if a binary exists on PATH */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
  });
}

/** Run execFile as a promise */
function execFileAsync(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/** POST to ElevenLabs TTS API, save to file */
function elevenLabsRequest(
  voiceId: string,
  text: string,
  apiKey: string,
  outPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
    });

    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          Accept: 'audio/mpeg',
        },
        timeout: 10_000,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`ElevenLabs API returned ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          writeFile(outPath, Buffer.concat(chunks))
            .then(() => resolve())
            .catch(reject);
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('ElevenLabs request timed out after 10s'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function detectEngine(opts: TTSOptions): Promise<TTSEngine> {
  if (opts.engine) return opts.engine;

  const apiKey = opts.apiKey ?? process.env['ELEVENLABS_API_KEY'];
  if (apiKey) return 'elevenlabs';

  if (await commandExists('piper')) return 'piper';

  return 'macos-say';
}

export class TextToSpeech {
  private readonly opts: TTSOptions;
  private speaking = false;
  private abortController: AbortController | null = null;
  // Test hook: when set, speak() awaits this promise instead of shelling
  // out to say/piper/elevenlabs. _resolveSpeak() settles it.
  private _testPromise: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(opts: TTSOptions) {
    this.opts = opts;
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
      // If not armed, arm then immediately resolve so the next speak() is instant.
      this._armTestPromise();
    }
    this._testPromise?.resolve();
    this._testPromise = null;
  }

  async speak(text: string): Promise<void> {
    if (this.speaking) {
      throw new Error('Already speaking. Call stop() first.');
    }
    if (!text.trim()) return;

    this.speaking = true;
    this.abortController = new AbortController();
    this.opts.onSpeakStart?.();

    try {
      // Test path: if _armTestPromise was called, await its resolution instead.
      if (this._testPromise) {
        await this._testPromise.promise;
      } else {
        const engine = await detectEngine(this.opts);

        switch (engine) {
          case 'macos-say':
            await this.speakMacos(text);
            break;
          case 'piper':
            await this.speakPiper(text);
            break;
          case 'elevenlabs':
            await this.speakElevenLabs(text);
            break;
        }
      }
    } finally {
      this.speaking = false;
      this.abortController = null;
      this.opts.onSpeakEnd?.();
    }
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private async speakMacos(text: string): Promise<void> {
    // Never call the real `say` binary during tests — it triggers Siri
    // and plays audio simultaneously from parallel test runners.
    if (process.env.CORTEXOS_TEST) return;
    const voice = this.opts.voice ?? 'Samantha';
    await execFileAsync('say', ['-v', voice, text]);
  }

  private async speakPiper(text: string): Promise<void> {
    const tmpWav = join(tmpdir(), `cortex-tts-${randomUUID()}.wav`);
    const model = this.opts.voice ?? 'en_US-lessac-medium';

    try {
      // Pipe text to piper via echo | piper
      await new Promise<void>((resolve, reject) => {
        const piper = execFile(
          'piper',
          ['--model', model, '--output_file', tmpWav],
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
        piper.stdin?.write(text);
        piper.stdin?.end();
      });

      if (this.abortController?.signal.aborted) return;
      await execFileAsync('afplay', [tmpWav]);
    } finally {
      await unlink(tmpWav).catch(() => {});
    }
  }

  private async speakElevenLabs(text: string): Promise<void> {
    const apiKey = this.opts.apiKey ?? process.env['ELEVENLABS_API_KEY'];
    if (!apiKey) {
      throw new Error('ElevenLabs API key not set');
    }

    const voiceId = this.opts.voice ?? '21m00Tcm4TlvDq8ikWAM'; // default Rachel
    const tmpMp3 = join(tmpdir(), `cortex-tts-${randomUUID()}.mp3`);

    try {
      await elevenLabsRequest(voiceId, text, apiKey, tmpMp3);
      if (this.abortController?.signal.aborted) return;
      await execFileAsync('afplay', [tmpMp3]);
    } finally {
      await unlink(tmpMp3).catch(() => {});
    }
  }
}
