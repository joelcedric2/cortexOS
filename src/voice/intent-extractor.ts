/**
 * Voice intent extractor — classifies a raw STT transcript into one of a
 * small, fixed set of orchestrator-level intents BEFORE the transcript is
 * handed to the task pipeline.
 *
 * The primary motivator is the Phase 8.5 kill-switch voice path: a user
 * should be able to say "stop" (or any natural variant) and have the
 * perception capturer turned off immediately, bypassing the normal task
 * dispatch. We keep the classifier rule-based + deterministic so:
 *
 *   1. The kill path never depends on network / LLM availability.
 *   2. Tests can enumerate phrases and assert a stable mapping.
 *   3. There is zero ambiguity about what triggers a global shutdown.
 *
 * Precedence is top-down: kill > pause/resume > config-wake > task. A
 * regex match returns confidence 1.0; the fallback `task` route returns 0.5
 * so callers can surface low-confidence UX affordances later if desired.
 */

/** Discrete intents the orchestrator knows how to handle. */
export type VoiceIntentKind =
  | "task"
  | "kill"
  | "pause"
  | "resume"
  | "config"
  | "chat";

export interface VoiceIntent {
  kind: VoiceIntentKind;
  /**
   * Optional structured payload. For `task` + `chat`, the original trimmed
   * transcript is included so downstream code can dispatch it. For control
   * intents (kill/pause/resume/config) the original phrase is included so
   * audit entries can record what the user actually said.
   */
  payload?: { transcript: string };
  /** 1.0 for a direct match, 0.5 for the `task` fallback. */
  confidence: number;
}

// Kill — tight set. Single-word "stop" and common escalations.
const KILL_REGEX = /^(stop|kill|cancel|abort|shut\s*up|quiet|halt|enough)$/i;

// Pause — "hold on" et al.
const PAUSE_REGEX = /^(pause|hold|hold\s*on|wait|wait\s*a\s*sec|one\s*sec)$/i;

// Resume.
const RESUME_REGEX = /^(continue|resume|go\s*on|keep\s*going|carry\s*on)$/i;

// Config — anything addressed to the assistant for preference changes.
// Matches "nchinda, set …" / "nchinda change …" / "nchinda config …"
// (optional comma, any trailing payload).
const CONFIG_REGEX = /^nchinda,?\s+(set|config(?:ure)?|change|update)\b/i;

/**
 * Extract a VoiceIntent from a raw transcript.
 *
 * Input rules:
 *   - `transcript` is trimmed and common trailing punctuation stripped before
 *     matching. "Stop." / "stop!" / "  stop  " all route to `kill`.
 *   - Empty / whitespace-only input → `task` with confidence 0 and empty
 *     payload (caller should no-op rather than dispatch).
 *
 * Determinism: given the same input string, always returns the same output.
 */
export function extractIntent(transcript: string): VoiceIntent {
  if (typeof transcript !== "string") {
    throw new TypeError("extractIntent: transcript must be a string");
  }

  const normalized = normalize(transcript);

  if (normalized.length === 0) {
    return { kind: "task", payload: { transcript: "" }, confidence: 0 };
  }

  if (KILL_REGEX.test(normalized)) {
    return { kind: "kill", payload: { transcript: normalized }, confidence: 1 };
  }
  if (PAUSE_REGEX.test(normalized)) {
    return { kind: "pause", payload: { transcript: normalized }, confidence: 1 };
  }
  if (RESUME_REGEX.test(normalized)) {
    return { kind: "resume", payload: { transcript: normalized }, confidence: 1 };
  }
  if (CONFIG_REGEX.test(normalized)) {
    return {
      kind: "config",
      payload: { transcript: normalized },
      confidence: 1,
    };
  }

  // Soft match: the kill regex is anchored to exact phrase; handle a few
  // natural "please stop" / "stop please" shapes as well.
  if (/^(please\s+stop|stop\s+please|stop\s+now|stop\s+it)$/i.test(normalized)) {
    return { kind: "kill", payload: { transcript: normalized }, confidence: 1 };
  }

  // Fallback: treat as a task with the original (normalized) transcript.
  return {
    kind: "task",
    payload: { transcript: normalized },
    confidence: 0.5,
  };
}

/** Strip leading/trailing whitespace + common sentence punctuation. */
function normalize(s: string): string {
  return s.trim().replace(/[.!?,;:]+$/u, "").trim();
}
