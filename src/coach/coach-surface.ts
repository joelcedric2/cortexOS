/**
 * Phase 13 — Real-time Writing Coach: surfacing layer.
 *
 * Glues together the draft-watcher, suggestion-engine, proactivity mode,
 * TTS, and the pending surface / audit log. Each {@link DraftSample} can
 * optionally trigger a Haiku suggestion; resulting suggestions are
 * routed as follows:
 *
 *   mode=anticipatory|autonomous  → insert into pending surface (urgency=0.4)
 *   severity=important AND user idle → TTS whisper (interrupt-safe)
 *   otherwise                       → audit-only
 *
 * Dedup: the same `draft_value` is suppressed for 10 minutes.
 */
import type { DraftSample } from "./draft-watcher.js";
import type { CoachSuggestion } from "./suggestion-engine.js";
import type { ProactivityModeManager } from "../proactivity/modes.js";
import type { AuditLog } from "../proactivity/audit.js";
import type { SensorSample } from "../sensors/sensor.js";

// ────────────────────────── Collaborators ──────────────────────────────────

/** Minimal surface-store contract — matches ObservationStore.insert(). */
export interface CoachSurfaceStore {
  insert(sample: SensorSample): number;
}

/** Minimal TTS contract. */
export interface CoachTTS {
  speak(text: string): Promise<void>;
  isSpeaking?(): boolean;
}

/** Minimal voice-orchestrator read-only state. */
export interface VoiceIdleSource {
  /** True when the user is not actively speaking to Nchinda. */
  isIdle(): boolean;
}

export interface CoachSurfaceOptions {
  modeManager: Pick<ProactivityModeManager, "getMode" | "isQuiet">;
  store?: CoachSurfaceStore;
  tts?: CoachTTS;
  voiceIdle?: VoiceIdleSource;
  audit?: AuditLog;
  /** Dedup window for identical `draft_value`. Default 10 min. */
  dedupWindowMs?: number;
  /** Wall clock — injectable for tests. */
  now?: () => number;
}

// ────────────────────────── Constants ──────────────────────────────────────

const DEFAULT_DEDUP_MS = 10 * 60 * 1000;
const COACH_URGENCY = 0.4;
const COACH_SENSOR_NAME = "writing-coach";

// ────────────────────────── Implementation ─────────────────────────────────

export class CoachSurface {
  private readonly modes: Pick<ProactivityModeManager, "getMode" | "isQuiet">;
  private readonly store: CoachSurfaceStore | undefined;
  private readonly tts: CoachTTS | undefined;
  private readonly voiceIdle: VoiceIdleSource | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly dedupWindowMs: number;
  private readonly now: () => number;

  /** key = draft_value → last surfaced at (ms). */
  private readonly lastRouted: Map<string, number> = new Map();

  constructor(opts: CoachSurfaceOptions) {
    this.modes = opts.modeManager;
    this.store = opts.store;
    this.tts = opts.tts;
    this.voiceIdle = opts.voiceIdle;
    this.audit = opts.audit;
    this.dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Route a suggestion for the given draft sample. Returns one of:
   *   "surfaced"  — inserted into the pending surface
   *   "whispered" — spoken via TTS (important + user idle)
   *   "audited"   — logged only, no user-facing surface
   *   "deduped"   — within the 10-min window for this draft value
   *   "quiet"     — proactivity mode is currently quiet/silent
   */
  async route(
    sample: DraftSample,
    suggestion: CoachSuggestion,
  ): Promise<"surfaced" | "whispered" | "audited" | "deduped" | "quiet"> {
    // Dedup first — same suggestion text for the same draft within window.
    const dedupKey = suggestion.draft_value;
    const last = this.lastRouted.get(dedupKey);
    const now = this.now();
    if (last !== undefined && now - last < this.dedupWindowMs) {
      return "deduped";
    }

    const mode = this.modes.getMode();
    if (mode === "silent" || this.modes.isQuiet?.()) {
      return "quiet";
    }

    const aggressive = mode === "anticipatory" || mode === "autonomous";
    const isImportant = suggestion.severity === "important";
    const userIdle = this.voiceIdle ? this.voiceIdle.isIdle() : true;

    // Record dedup marker eagerly: if we decide to route in any meaningful
    // way, we must suppress immediate re-routes of the same draft text.
    this.lastRouted.set(dedupKey, now);

    // Whisper path: important severity + user idle + TTS available.
    if (isImportant && userIdle && this.tts) {
      try {
        await this.tts.speak(buildWhisper(suggestion));
        this.auditLine("surface", `coach-whisper app=${sample.app} severity=important`);
        return "whispered";
      } catch {
        // TTS failure is non-fatal — fall through to pending-surface.
      }
    }

    // Pending-surface path (anticipatory / autonomous).
    if (aggressive && this.store) {
      this.store.insert({
        sensorName: COACH_SENSOR_NAME,
        observation: buildObservation(sample, suggestion),
        urgency: COACH_URGENCY,
        data: {
          app: sample.app,
          severity: suggestion.severity,
          reason: suggestion.reason,
        },
        sampledAt: new Date(now),
      });
      this.auditLine(
        "surface",
        `coach-surface app=${sample.app} severity=${suggestion.severity}`,
      );
      return "surfaced";
    }

    // Otherwise audit-only.
    this.auditLine(
      "sensor_sample",
      `coach-audit app=${sample.app} severity=${suggestion.severity}`,
    );
    return "audited";
  }

  private auditLine(
    action: "sensor_sample" | "surface",
    detail: string,
  ): void {
    if (!this.audit) return;
    try {
      this.audit.append({
        action,
        sensorName: COACH_SENSOR_NAME,
        detail,
        ts: new Date(this.now()),
      });
    } catch {
      // Audit failures must never break the coach.
    }
  }
}

// ────────────────────────── Helpers ────────────────────────────────────────

function buildObservation(
  sample: DraftSample,
  suggestion: CoachSuggestion,
): string {
  return `✎ ${appShort(sample.app)}: ${suggestion.suggestion}`;
}

function buildWhisper(suggestion: CoachSuggestion): string {
  return suggestion.suggestion;
}

function appShort(bundle: string): string {
  const map: Record<string, string> = {
    "com.apple.mail": "Mail",
    "com.apple.MobileSMS": "Messages",
    "com.apple.Notes": "Notes",
    "com.tinyspeck.slackmacgap": "Slack",
  };
  return map[bundle] ?? bundle;
}
