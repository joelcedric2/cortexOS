/**
 * Stub types for Agent A's voice primitives.
 * Agent A ships: wake-word.ts, stt.ts, tts.ts
 * Delete this file once Agent A's implementations land.
 */

export class WakeWordDetector {
  private running = false;
  private handler: (() => void) | null = null;

  /** Register the callback that fires when the wake-word is detected. */
  onWake(fn: () => void): void {
    this.handler = fn;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isListening(): boolean {
    return this.running;
  }

  /** Test helper: simulate wake-word detection. */
  _simulateWake(): void {
    this.handler?.();
  }
}

export class SpeechToText {
  private recording = false;
  private resolveRecording: ((text: string) => void) | null = null;

  startRecording(): void {
    this.recording = true;
  }

  stopRecording(): Promise<string> {
    this.recording = false;
    return new Promise<string>((resolve) => {
      this.resolveRecording = resolve;
    });
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Test helper: resolve the pending stopRecording() promise. */
  _resolveWith(text: string): void {
    this.resolveRecording?.(text);
    this.resolveRecording = null;
  }
}

export class TextToSpeech {
  private speaking = false;
  private resolveSpeak: (() => void) | null = null;

  speak(_text: string): Promise<void> {
    this.speaking = true;
    return new Promise<void>((resolve) => {
      this.resolveSpeak = resolve;
    });
  }

  stop(): void {
    this.speaking = false;
    this.resolveSpeak?.();
    this.resolveSpeak = null;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Test helper: resolve the pending speak() promise. */
  _resolveSpeak(): void {
    this.speaking = false;
    this.resolveSpeak?.();
    this.resolveSpeak = null;
  }
}
