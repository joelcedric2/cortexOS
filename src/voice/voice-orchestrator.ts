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
import type { EchoGate } from "./echo-gate.js";
import { extractIntent } from "./intent-extractor.js";
import type { PerceptionKillSwitch } from "../perception/kill-switch.js";
import type { AuditLog } from "../proactivity/audit.js";
import type {
  NchindaLookInput,
  NchindaLookResult,
} from "../mcp/nchinda-look.js";
import type { RewindResult } from "../rewind/rewind-query.js";
import type { ConvIntent } from "../intent/conversation-intent.js";
import type { VoiceMemory } from "./voice-memory.js";
import type { DeepgramVoiceStream } from "./deepgram-stream.js";

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
  /** When supplied, replaces wakeWord + stt with a single Deepgram stream. */
  deepgram?: DeepgramVoiceStream;
  stateMachine: AudioStateMachine;
  bus: EventBus;
  /** cortexOS processes the transcript and returns a reply string.
   *  `narrate` lets the handler speak progress updates mid-task. */
  onTask: (transcript: string, narrate: (update: string) => Promise<void>) => Promise<string>;
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
  /** Voice memory persistence — stores interactions in pgvector. */
  voiceMemory?: VoiceMemory;
  /**
   * Echo suppression gate — mutes mic transcription during TTS playback
   * to prevent Nchinda from hearing its own voice as a false wake.
   */
  echoGate?: EchoGate;
}

const ERROR_RECOVERY_MS = 2000;

export class VoiceOrchestrator {
  private readonly wakeWord: WakeWordDetector;
  private readonly stt: SpeechToText;
  private readonly tts: TextToSpeech;
  private readonly sm: AudioStateMachine;
  private readonly bus: EventBus;
  private readonly onTask: (transcript: string, narrate: (update: string) => Promise<void>) => Promise<string>;
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
  private readonly voiceMemory: VoiceMemory | undefined;
  private readonly echoGate: EchoGate | undefined;
  private readonly deepgram: DeepgramVoiceStream | undefined;
  /** Resolves when Deepgram delivers a command transcript. */
  private dgTranscriptResolve: ((text: string) => void) | null = null;
  private lastConvIntentTask: Promise<void> | undefined;
  /** Tracks the memory ID of the current in-flight interaction for markFailed. */
  private lastMemoryId: string | undefined;
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
  /** Timer for pulsing RMS values to the waveform during active states. */
  private rmsPulseTimer: ReturnType<typeof setInterval> | null = null;

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
    this.voiceMemory = opts.voiceMemory;
    this.echoGate = opts.echoGate;
    this.deepgram = opts.deepgram;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.deepgram) {
      // Deepgram streaming mode — single stream handles wake + STT.
      await this.deepgram.start();
      console.log("[Nchinda] Deepgram streaming active");
    } else {
      // Legacy file-based mode — separate wake-word + STT via Groq.
      this.wakeWord.setOnWake(() => this.handleWake());
      await this.wakeWord.start();
    }

    if (this.hotkey) {
      this.hotkey.register();
    }
  }

  stop(): void {
    this.running = false;
    this.generation++; // cancel any in-flight flow
    this.stopRmsPulse();
    if (this.deepgram) {
      this.deepgram.stop();
    } else {
      this.wakeWord.stop();
    }
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
      this.sm.transition("listening");
    }

    // IMMEDIATELY stop wake-word / mute Deepgram to prevent echo
    // pickup during greeting/acknowledgment TTS.
    if (this.deepgram) {
      this.deepgram.setMode("interrupt");
    } else {
      this.wakeWord.stop();
    }

    // Bump generation to cancel any stale flow.
    this.generation++;

    // Emit bus event for wake.
    this.bus.emit({
      kind: "plan_emitted",
      payload: { phase: "VOICE_WAKE" },
      ts: new Date(),
    });

    // First activation this session: greet then listen.
    if (!this.greeted) {
      this.greeted = true;
      const greeting = `Welcome Sir. I'm online.`;
      this.sm.transition("speaking");
      this.speakWithEchoGate(greeting).then(() => {
        if (this.isStale(this.generation)) return;
        this.processVoiceInteraction(this.generation).catch((err) => {
          console.error("[Nchinda] Unhandled error in voice pipeline:", err);
        });
      }).catch(() => {
        this.processVoiceInteraction(this.generation).catch((err) => {
          console.error("[Nchinda] Unhandled error in voice pipeline:", err);
        });
      });
      return;
    }

    this.processVoiceInteraction(this.generation).catch((err) => {
      console.error("[Nchinda] Unhandled error in voice pipeline:", err);
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
    const interactionStart = Date.now();
    try {
      // 1. Transition to listening (unless interruption already did it).
      if (this.sm.getState() !== "listening") {
        this.sm.transition("listening");
      }

      // 2. Capture the command transcript.
      console.log("[Nchinda] Listening — speak now...");
      this.startRmsPulse(0.4, 0.2);
      let transcript: string;

      if (this.deepgram) {
        // Text-based echo rejection handles TTS bleed — no delay needed.
        this.deepgram.setMode("command");
        transcript = await new Promise<string>((resolve) => {
          this.dgTranscriptResolve = resolve;
          // Safety timeout
          setTimeout(() => {
            if (this.dgTranscriptResolve === resolve) {
              this.dgTranscriptResolve = null;
              resolve("");
            }
          }, 30_000);
        });
      } else {
        // Legacy file-based — sox records, Groq transcribes.
        await this.stt.startRecording();
        transcript = await this.waitForTranscript();
      }

      if (this.isStale(gen)) return;

      if (!transcript.trim() || transcript.includes("[") || transcript.length < 3) {
        // Empty or placeholder transcript — go back to idle.
        // Wait 2s cooldown before re-enabling wake to prevent rapid cycling.
        console.log("[Nchinda] No speech detected — idle");
        this.sm.transition("idle"); await this.rearmWakeWord();
        return;
      }

      console.log(`[Cedric] "${transcript}"`);

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
        // Mark the previous interaction as failed if we have a memory ID.
        if (this.voiceMemory && this.lastMemoryId) {
          try {
            await this.voiceMemory.markFailed(this.lastMemoryId);
          } catch {
            // Best-effort — never break the kill path.
          }
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
        await this.speakWithEchoGate(reply);
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
        await this.speakWithEchoGate(reply);
        if (this.isStale(gen)) return;
        this.sm.transition("idle"); await this.rearmWakeWord();
        return;
      }

      // 3.6. Phase 14 — fire-and-forget conversation-intent classification.
      this.dispatchConversationIntent(transcript);

      // 4. Transition to thinking.
      this.stopRmsPulse();
      this.sm.transition("thinking");
      this.startRmsPulse(0.15, 0.1); // subtle pulse during thinking

      // 5. Emit bus event for task dispatch.
      this.bus.emit({
        kind: "plan_emitted",
        payload: { phase: "VOICE_TASK", transcript },
        ts: new Date(),
      });

      // 6. Acknowledge immediately with contextual ack.
      const ack = buildAck(transcript);
      this.sm.transition("speaking");
      await this.speakWithEchoGate(ack);
      if (this.isStale(gen)) return;

      // 7. Transition to THINKING — waveform shows particles/pulse.
      this.sm.transition("thinking");
      this.startRmsPulse(0.15, 0.1);
      await this.rearmWakeWord();

      // 8. Subscribe to bus events during task execution so Nchinda can
      //    narrate real progress: "The coder just finished. Waiting on tests."
      const unsubProgress = this.bus.subscribe({ kind: "done" }, async (event) => {
        if (this.isStale(gen)) return;
        const role = event.agent_id ?? "an agent";
        const update = `${role} just finished its work.`;
        try {
          this.sm.transition("speaking");
          await this.speakWithEchoGate(update);
          if (!this.isStale(gen)) this.sm.transition("thinking");
        } catch {}
      });

      // 9. Process through cortexOS (Claude Code CLI).
      //    Pass `narrate` so the handler can speak progress updates
      //    mid-task: timer-based "still working" + event-based agent completions.
      const narrate = async (update: string): Promise<void> => {
        if (this.isStale(gen)) return;
        try {
          this.sm.transition("speaking");
          await this.speakWithEchoGate(update);
          if (!this.isStale(gen)) {
            this.sm.transition("thinking");
          }
        } catch {
          // TTS failure during narration is non-fatal — task continues
        }
      };
      const reply = await this.onTask(transcript, narrate);
      unsubProgress(); // stop narrating progress
      if (this.isStale(gen)) return;

      // 10. Transition to speaking — deliver the reply.
      this.sm.transition("speaking");

      // 10. TTS speaks the reply. If the user interrupts (handleWake fires),
      //     the generation bumps and isStale returns true after speak resolves.
      await this.speakWithEchoGate(reply);
      if (this.isStale(gen)) return;

      // 10.5. Persist voice interaction to pgvector for future recall.
      if (this.voiceMemory) {
        try {
          this.lastMemoryId = await this.voiceMemory.storeInteraction({
            transcript,
            reply,
            outcome: "success",
            durationMs: Date.now() - interactionStart,
          });
        } catch (err) {
          // Memory persistence is best-effort — never break the voice flow.
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[VoiceOrchestrator] voice memory store failed:", msg);
        }
      }

      // 11. Back to idle.
      this.stopRmsPulse();
      this.sm.transition("idle");
    } catch (err) {
      if (this.isStale(gen)) return;

      const message = err instanceof Error ? err.message : String(err);
      console.error("[Nchinda] Error:", message);

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

  /** Trigger wake programmatically (used by Deepgram stream). */
  triggerWake(): void {
    this.handleWake();
  }

  /**
   * Called by DeepgramVoiceStream when a command transcript is ready.
   * Resolves the pending promise in processVoiceInteraction.
   */
  deliverTranscript(text: string): void {
    if (this.dgTranscriptResolve) {
      this.dgTranscriptResolve(text);
      this.dgTranscriptResolve = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start pulsing RMS values to the state machine so the waveform
   * animates during active states. Pulses at ~20Hz with a sine wave
   * pattern that varies by state.
   */
  private startRmsPulse(baseRms: number, variance: number): void {
    this.stopRmsPulse();
    let tick = 0;
    this.rmsPulseTimer = setInterval(() => {
      tick++;
      const rms = baseRms + variance * Math.sin(tick * 0.3);
      this.sm.transition(this.sm.getState(), Math.max(0, rms));
    }, 50);
  }

  private stopRmsPulse(): void {
    if (this.rmsPulseTimer) {
      clearInterval(this.rmsPulseTimer);
      this.rmsPulseTimer = null;
    }
  }

  /**
   * Speak text through TTS with echo suppression. Mutes the echo gate
   * before speaking and unmutes (with decay) after TTS finishes so the
   * wake-word detector doesn't pick up Nchinda's own output.
   */
  private async speakWithEchoGate(text: string): Promise<void> {
    this.echoGate?.mute();
    this.deepgram?.setMode("interrupt");
    this.deepgram?.setEchoText(text);
    this.deepgram?.markTtsStarted();
    this.startRmsPulse(0.5, 0.3);
    try {
      await this.tts.speak(text);
    } finally {
      this.stopRmsPulse();
      this.deepgram?.markTtsEnded();
      this.echoGate?.unmute();
    }
  }

  /**
   * Re-arm the wake-word detector. No echo delay — the user should be
   * able to interrupt Nchinda at any time by saying "Nchinda" or "stop".
   * Echo is handled by Groq's large-v3 model which is smart enough to
   * distinguish real wake words from TTS playback artifacts.
   */
  private async rearmWakeWord(): Promise<void> {
    if (this.deepgram) {
      this.deepgram.setMode("wake");
      console.log("[Nchinda] Ready — say 'Cortex'");
    } else {
      this.wakeWord.setOnWake(() => this.handleWake());
      await this.wakeWord.start().catch(() => {});
      console.log("[Nchinda] Ready — say 'Cortex'");
    }
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

/**
 * Build a dynamic acknowledgment — extracts the topic from the transcript
 * and describes what action Nchinda will take.
 */
function buildAck(transcript: string): string {
  const topic = extractTopic(transcript);
  const t = transcript.toLowerCase();

  if (t.includes("happening") || t.includes("going on") || t.includes("news") || t.includes("update"))
    return `I'll search the web for the latest on ${topic}. One moment.`;
  if (t.includes("time") || t.includes("date") || t.includes("day"))
    return `Let me check the time for you.`;
  if (t.includes("weather"))
    return `I'll pull up the weather for ${topic}. One moment.`;
  if (t.includes("send") || t.includes("email") || t.includes("message"))
    return `I'll draft that for you now. Give me a moment.`;
  if (t.includes("open") || t.includes("launch") || t.includes("start"))
    return `Opening ${topic} for you now.`;
  if (t.includes("search") || t.includes("find") || t.includes("look"))
    return `I'll search for ${topic}. One moment.`;
  if (t.includes("create") || t.includes("build") || t.includes("make") || t.includes("write"))
    return `I'll start working on ${topic} for you now.`;
  if (t.includes("?") || t.includes("what") || t.includes("how") || t.includes("why"))
    return `Good question. Let me look into ${topic} for you.`;
  return `Understood. I'll work on ${topic} for you now.`;
}

/** Extract the meaningful topic from a transcript, stripping filler words. */
function extractTopic(transcript: string): string {
  let topic = transcript
    .replace(/[?.!,]+$/g, "")
    .replace(/^(what's|what is|whats|tell me about|give me|show me|can you|could you|please|hey|cortex)\s+/gi, "")
    .replace(/^(the latest|an update|updates|the current|the)\s+/gi, "")
    .replace(/^(on|about|for|in|at|with)\s+/gi, "")
    .trim();
  // If stripping left nothing meaningful, use "that"
  if (!topic || topic.length < 3) return "that";
  // Lowercase first letter for natural flow in a sentence
  return topic.charAt(0).toLowerCase() + topic.slice(1);
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
