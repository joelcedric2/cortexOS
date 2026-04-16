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
import type { WakeWordDetector } from "./wake-word.js";
import type { SpeechToText } from "./stt.js";
import type { TextToSpeech } from "./tts.js";
import type { GlobalHotkey } from "./hotkey.js";
import type { EventBus } from "../ipc/event-bus.js";
import { extractIntent } from "./intent-extractor.js";
import type { PerceptionKillSwitch } from "../perception/kill-switch.js";
import type { AuditLog } from "../proactivity/audit.js";
import type {
  NchindaLookInput,
  NchindaLookResult,
} from "../mcp/nchinda-look.js";

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
  /**
   * Phase 8.5 — if supplied, each transcript is first classified by
   * {@link extractIntent}. When the intent is `kill`, the perception
   * kill-switch fires, any in-flight TTS is stopped, and the transcript is
   * NOT forwarded to `onTask`.
   */
  killSwitch?: PerceptionKillSwitch;
  /** Optional audit log for intent routing decisions. */
  audit?: AuditLog;
  /**
   * Phase 9 — when supplied, `camera-query` transcripts ("what am I
   * looking at", "is that a bird?") bypass `onTask` and instead call
   * this function. The returned description is spoken via TTS. When
   * absent, camera-query intents fall through to `onTask` unchanged so
   * existing deployments keep working.
   */
  onCameraQuery?: (input: NchindaLookInput) => Promise<NchindaLookResult>;
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
  private readonly killSwitch: PerceptionKillSwitch | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly onCameraQuery:
    | ((input: NchindaLookInput) => Promise<NchindaLookResult>)
    | undefined;
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
    this.killSwitch = opts.killSwitch;
    this.audit = opts.audit;
    this.onCameraQuery = opts.onCameraQuery;
    this.userName = opts.userName;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Wire wake-word trigger.
    this.wakeWord.setOnWake(() => this.handleWake());
    await this.wakeWord.start();

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

      // 3.5. Phase 8.5 — classify the transcript. Orchestrator-level intents
      // (kill / pause / resume / config) short-circuit the normal task
      // pipeline. Kill is the only one wired here; the others fall through
      // to onTask as-if they were normal tasks until Phase 9+ handles them.
      const intent = extractIntent(transcript);
      if (intent.kind === "kill") {
        // Stop any in-flight TTS immediately.
        this.tts.stop();
        // Fire the kill-switch (never rejects — trigger() is best-effort
        // internally and idempotent).
        if (this.killSwitch) {
          await this.killSwitch.trigger("voice");
        }
        // One audit line documenting the routing decision.
        this.audit?.append({
          action: "voice_intent",
          detail: `intent=kill transcript=${intent.payload?.transcript ?? ""}`,
          ts: new Date(),
        });
        // Skip onTask; go back to idle so the mic does not immediately
        // re-engage.
        try {
          this.sm.transition("idle");
        } catch {
          // State machine may reject if already idle — safe to ignore.
        }
        return;
      }

      // Phase 9 — camera-query. Only engages when a nchindaLook handler
      // has been supplied; otherwise the transcript falls through to the
      // normal task pipeline below (preserves backward compatibility).
      if (intent.kind === "camera-query" && this.onCameraQuery) {
        this.sm.transition("thinking");
        this.bus.emit({
          kind: "plan_emitted",
          payload: { phase: "VOICE_CAMERA", transcript },
          ts: new Date(),
        });
        let reply: string;
        try {
          const result = await this.onCameraQuery({
            question: intent.payload?.question ?? transcript,
          });
          reply = result.description;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[VoiceOrchestrator] camera-query failed: ${msg}`);
          reply =
            "I couldn't see through the camera just now. " +
            "Check camera permissions and try again.";
        }
        this.audit?.append({
          action: "voice_intent",
          detail: `intent=camera-query transcript=${intent.payload?.transcript ?? ""}`,
          ts: new Date(),
        });
        if (this.isStale(gen)) return;
        this.sm.transition("speaking");
        await this.tts.speak(reply);
        if (this.isStale(gen)) return;
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
