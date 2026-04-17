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
import type { RewindResult } from "../rewind/rewind-query.js";
import type { ConvIntent } from "../intent/conversation-intent.js";

/**
 * Result-surface sink for rewind hits. Wired by the Orchestrator to the
 * Pending Surface so the user can click-through to open the WebP. No-op
 * when unwired — the top-1 result is still spoken via TTS.
 */
export interface RewindSurface {
  present(results: RewindResult[]): void;
}

/**
 * Handler for Phase 15 rewind queries.
 */
export interface RewindHandler {
  query(transcript: string): Promise<RewindResult[]>;
}

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
   * this function.
   */
  onCameraQuery?: (input: NchindaLookInput) => Promise<NchindaLookResult>;
  /**
   * Phase 15 — if supplied, transcripts classified as `rewind` intents are
   * routed through this handler instead of the generic task pipeline.
   */
  rewindHandler?: RewindHandler;
  /** Optional Pending-Surface sink for the full top-5 rewind result set. */
  rewindSurface?: RewindSurface;
  /**
   * Phase 14 — conversation-intent side-channel. Runs in parallel with
   * onTask; never auto-executes.
   */
  conversationIntent?: {
    classify: (transcript: string) => Promise<ConvIntent>;
    route: (intent: ConvIntent) => Promise<unknown>;
  };
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
  private readonly rewindHandler: RewindHandler | undefined;
  private readonly rewindSurface: RewindSurface | undefined;
  private readonly conversationIntent:
    | VoiceOrchestratorOptions["conversationIntent"]
    | undefined;
  private lastConvIntentTask: Promise<void> | undefined;
  /** User name for personalized greetings. */
  readonly userName: string | undefined;
  private running = false;
  /** Tracks whether we've greeted the user this session. */
  private greeted = false;

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
    this.rewindHandler = opts.rewindHandler;
    this.rewindSurface = opts.rewindSurface;
    this.userName = opts.userName;
    this.conversationIntent = opts.conversationIntent;
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

    // First activation this session: greet the user before listening.
    if (!this.greeted) {
      this.greeted = true;
      const name = this.userName ?? "Sir";
      const greeting = `Welcome ${name}. Nchinda is online and ready. What can I do for you?`;
      this.sm.transition("speaking");
      this.tts.speak(greeting).then(() => {
        if (this.isStale(this.generation)) return;
        this.processVoiceInteraction(this.generation).catch((err) => {
          console.error("[VoiceOrchestrator] Unhandled error in voice pipeline:", err);
        });
      }).catch(() => {
        this.processVoiceInteraction(this.generation).catch((err) => {
          console.error("[VoiceOrchestrator] Unhandled error in voice pipeline:", err);
        });
      });
      return;
    }

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

      // 2. PAUSE the wake-word detector so it releases the mic. Two sox
      //    processes can't share the mic on macOS.
      this.wakeWord.stop();

      // 3. Start STT recording — sox runs with silence detection and exits
      //    on its own when the user stops speaking (~1.5s of silence).
      console.log("[VoiceOrchestrator] Listening — speak now...");
      await this.stt.startRecording();

      // 4. Wait for sox to finish (silence detected) → auto-calls stopRecording
      //    which transcribes via Groq. We poll until recording is done.
      const transcript = await this.waitForTranscript();

      if (this.isStale(gen)) return;

      if (!transcript.trim() || transcript.includes("[") || transcript.length < 3) {
        // Empty or placeholder transcript — go back to idle.
        // Wait 2s cooldown before re-enabling wake to prevent rapid cycling.
        console.log("[VoiceOrchestrator] No speech detected — idle");
        this.sm.transition("idle"); await this.rearmWakeWord();
        return;
      }

      console.log(`[VoiceOrchestrator] Transcript: "${transcript}"`);

      // Wake-word stays OFF until after TTS reply finishes — prevents
      // Nchinda from hearing its own voice through the speakers.

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
          this.sm.transition("idle"); await this.rearmWakeWord();
        } catch {
          // State machine may reject if already idle — safe to ignore.
        }
        return;
      }

      // Phase 9 — camera-query. Only engages when a nchindaLook handler
      // has been supplied; otherwise the transcript falls through.
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
        this.sm.transition("idle"); await this.rearmWakeWord();
        return;
      }

      // Phase 15 — rewind queries short-circuit the task pipeline when a
      // handler is wired. Rewind is a control intent, so we do NOT also
      // fire the conv-intent side-channel.
      if (intent.kind === "rewind" && this.rewindHandler) {
        this.sm.transition("thinking");
        let results: RewindResult[] = [];
        try {
          results = await this.rewindHandler.query(
            intent.payload?.transcript ?? transcript,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[VoiceOrchestrator] rewind failed:", msg);
        }
        if (this.isStale(gen)) return;
        this.rewindSurface?.present(results);
        this.audit?.append({
          action: "voice_intent",
          detail: `intent=rewind hits=${results.length}`,
          ts: new Date(),
        });
        const reply = buildRewindReply(results);
        this.sm.transition("speaking");
        await this.tts.speak(reply);
        if (this.isStale(gen)) return;
        this.sm.transition("idle"); await this.rearmWakeWord();
        return;
      }

      // 3.6. Phase 14 — fire-and-forget conversation-intent classification.
      this.dispatchConversationIntent(transcript);

      // 4. Transition to thinking.
      this.sm.transition("thinking");

      // 5. Emit bus event for task dispatch.
      this.bus.emit({
        kind: "plan_emitted",
        payload: { phase: "VOICE_TASK", transcript },
        ts: new Date(),
      });

      // 6. Acknowledge immediately — don't leave the user in silence
      //    while Claude processes. Speak a random filler, then think.
      const acks = [
        "Got it. Working on that.",
        "On it. Give me a moment.",
        "Let me look into this.",
        "Understood. One second.",
        "Right away.",
        "Sure thing. Processing.",
        "Got it. Just a moment.",
      ];
      const ack = acks[Math.floor(Math.random() * acks.length)];
      this.sm.transition("speaking");
      await this.tts.speak(ack);
      if (this.isStale(gen)) return;

      // 7. Transition to THINKING — waveform shows particles/pulse,
      //    user knows work is happening. Wake-word stays active for interrupts.
      this.sm.transition("thinking");
      await this.rearmWakeWord();

      // 8. Process through cortexOS (Claude Code CLI).
      const reply = await this.onTask(transcript);
      if (this.isStale(gen)) return;

      // 9. Transition to speaking — deliver the reply.
      this.sm.transition("speaking");

      // 10. TTS speaks the reply. If the user interrupts (handleWake fires),
      //     the generation bumps and isStale returns true after speak resolves.
      await this.tts.speak(reply);
      if (this.isStale(gen)) return;

      // 11. Back to idle.
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
        this.sm.transition("idle"); await this.rearmWakeWord();
      } catch {
        // Best-effort recovery.
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Re-arm the wake-word detector. No echo delay — the user should be
   * able to interrupt Nchinda at any time by saying "Nchinda" or "stop".
   * Echo is handled by Groq's large-v3 model which is smart enough to
   * distinguish real wake words from TTS playback artifacts.
   */
  private async rearmWakeWord(): Promise<void> {
    this.wakeWord.setOnWake(() => this.handleWake());
    await this.wakeWord.start().catch(() => {});
    console.log("[VoiceOrchestrator] Ready — say 'Nchinda'");
  }

  /**
   * Wait for the STT to finish recording (sox exits on silence detection)
   * then return the transcript. Polls isRecording() every 200ms.
   * Falls back to stopRecording after 30s safety timeout.
   */
  private async waitForTranscript(): Promise<string> {
    const maxWait = 30_000;
    const start = Date.now();

    // Wait for sox to exit on its own (silence detected)
    while (this.stt.isRecording() && Date.now() - start < maxWait) {
      await this.delay(200);
    }

    // If still recording after timeout, force stop
    if (this.stt.isRecording()) {
      return this.stt.stopRecording();
    }

    // Sox already exited — stopRecording will just transcribe the file
    return this.stt.stopRecording();
  }

  /**
   * Fire-and-forget Phase 14 side-channel. The returned promise is stored on
   * `this.lastConvIntentTask` solely so tests can await completion; it is
   * never awaited by the voice pipeline.
   */
  private dispatchConversationIntent(transcript: string): void {
    const conv = this.conversationIntent;
    if (!conv) return;
    this.lastConvIntentTask = (async () => {
      try {
        const intent = await conv.classify(transcript);
        await conv.route(intent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Isolate failures — this path must never break voice.
        console.error("[VoiceOrchestrator] conv-intent dispatch failed:", msg);
      }
    })();
  }

  /** Test-only: await the most recent fire-and-forget conv-intent task. */
  async _flushConversationIntentForTests(): Promise<void> {
    await this.lastConvIntentTask;
  }
}

/**
 * Compose a short spoken reply for a rewind query. We voice only the
 * top-1 hit's label (plus captured_at context); the full list lives in
 * the Pending Surface so the user can click through to the WebP.
 */
function buildRewindReply(results: RewindResult[]): string {
  if (results.length === 0) {
    return "I couldn't find anything matching that.";
  }
  const top = results[0]!;
  const label = top.label && top.label.trim() ? top.label : "that memory";
  const when = friendlyWhen(top.captured_at);
  const hits =
    results.length > 1 ? ` I found ${results.length} possible matches.` : "";
  return `${label}, from ${when}.${hits}`;
}

function friendlyWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "earlier";
  const delta = Date.now() - t;
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
