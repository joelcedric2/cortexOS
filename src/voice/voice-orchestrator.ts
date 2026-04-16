/**
 * Voice orchestrator — the glue tying wake-word, STT, TTS, and the audio
 * state machine to cortexOS's autonomy pipeline.
 *
 * Flow:
 *   wake-word / hotkey -> listening -> STT -> thinking -> onTask -> speaking -> TTS -> idle
 *
 * Supports interruption (wake during speak) and automatic error recovery.
 * Emits bus events for plan_emitted on VOICE_WAKE and VOICE_TASK phases.
 */

import type { AudioStateMachine } from "./audio-state.js";
import type { WakeWordDetector } from "./_a-stub.js";
import type { SpeechToText } from "./_a-stub.js";
import type { TextToSpeech } from "./_a-stub.js";
import type { GlobalHotkey } from "./hotkey.js";
import type { EventBus } from "../ipc/event-bus.js";

export interface VoiceOrchestratorOptions {
  wakeWord: WakeWordDetector;
  stt: SpeechToText;
  tts: TextToSpeech;
  stateMachine: AudioStateMachine;
  bus: EventBus;
  /** cortexOS processes the transcript and returns a reply string. */
  onTask: (transcript: string) => Promise<string>;
  hotkey?: GlobalHotkey;
  /** User name for personalized replies (e.g. "Cedric"). */
  userName?: string;
}

const ERROR_RECOVERY_MS = 2000;

export class VoiceOrchestrator {
  private readonly wakeWord: WakeWordDetector;
  private readonly stt: SpeechToText;
  private readonly tts: TextToSpeech;
  private readonly sm: AudioStateMachine;
  private readonly bus: EventBus;
  private readonly onTask: (transcript: string) => Promise<string>;
  private readonly hotkey: GlobalHotkey | undefined;
  /** User name for personalized greetings. Reserved for Phase 6 UI. */
  readonly userName: string | undefined;
  private running = false;

  /**
   * Generation counter for flow cancellation. Each new wake increments
   * the generation; stale flows check their generation before transitioning
   * and bail out if superseded.
   */
  private generation = 0;

  constructor(opts: VoiceOrchestratorOptions) {
    this.wakeWord = opts.wakeWord;
    this.stt = opts.stt;
    this.tts = opts.tts;
    this.sm = opts.stateMachine;
    this.bus = opts.bus;
    this.onTask = opts.onTask;
    this.hotkey = opts.hotkey;
    this.userName = opts.userName;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Wire wake-word trigger.
    this.wakeWord.onWake(() => this.handleWake());
    this.wakeWord.start();

    // Wire hotkey trigger if provided.
    if (this.hotkey) {
      this.hotkey.register();
    }
  }

  stop(): void {
    this.running = false;
    this.generation++; // cancel any in-flight flow
    this.wakeWord.stop();
    this.hotkey?.unregister();
  }

  /**
   * Handle activation from wake-word or hotkey.
   * If currently speaking, interrupt TTS first.
   */
  private handleWake(): void {
    if (!this.running) return;

    // Interruption: if speaking, stop TTS and go straight to listening.
    if (this.sm.getState() === "speaking") {
      this.tts.stop();
      // Transition directly from speaking to listening (valid per state machine).
      this.sm.transition("listening");
    }

    // Bump generation to cancel any stale flow.
    this.generation++;

    // Emit bus event for wake.
    this.bus.emit({
      kind: "plan_emitted",
      payload: { phase: "VOICE_WAKE" },
      ts: new Date(),
    });

    this.processVoiceInteraction(this.generation).catch((err) => {
      console.error("[VoiceOrchestrator] Unhandled error in voice pipeline:", err);
    });
  }

  /**
   * Check if this flow generation is still current. If not, the flow
   * should silently exit without further state transitions.
   */
  private isStale(gen: number): boolean {
    return gen !== this.generation;
  }

  private async processVoiceInteraction(gen: number): Promise<void> {
    try {
      // 1. Transition to listening (unless interruption already did it).
      if (this.sm.getState() !== "listening") {
        this.sm.transition("listening");
      }

      // 2. Start STT recording.
      this.stt.startRecording();

      // 3. Wait for STT to complete (silence detection handled by STT).
      const transcript = await this.stt.stopRecording();
      if (this.isStale(gen)) return;

      if (!transcript.trim()) {
        // Empty transcript — go back to idle.
        this.sm.transition("idle");
        return;
      }

      // 4. Transition to thinking.
      this.sm.transition("thinking");

      // 5. Emit bus event for task dispatch.
      this.bus.emit({
        kind: "plan_emitted",
        payload: { phase: "VOICE_TASK", transcript },
        ts: new Date(),
      });

      // 6. Process through cortexOS.
      const reply = await this.onTask(transcript);
      if (this.isStale(gen)) return;

      // 7. Transition to speaking.
      this.sm.transition("speaking");

      // 8. TTS speaks the reply.
      await this.tts.speak(reply);
      if (this.isStale(gen)) return;

      // 9. Back to idle.
      this.sm.transition("idle");
    } catch (err) {
      if (this.isStale(gen)) return;

      const message = err instanceof Error ? err.message : String(err);
      console.error("[VoiceOrchestrator] Pipeline error:", message);

      // Transition to error, then recover to idle after delay.
      try {
        this.sm.transition("error");
      } catch {
        // State machine may reject if already in error.
      }
      await this.delay(ERROR_RECOVERY_MS);
      if (this.isStale(gen)) return;
      try {
        this.sm.transition("idle");
      } catch {
        // Best-effort recovery.
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
