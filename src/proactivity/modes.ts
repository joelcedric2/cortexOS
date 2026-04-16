/**
 * Proactivity mode engine (plan section 5.7.2).
 *
 * Controls how aggressively cortexOS surfaces observations to the user.
 * Four graduated modes from passive to fully autonomous.
 */

export type ProactivityMode =
  | "silent"
  | "volunteer"
  | "anticipatory"
  | "autonomous";

export interface ModeConfig {
  mode: ProactivityMode;
  /** Whether the assistant may speak proactively. */
  speakAllowed: boolean;
  /** Whether the assistant may take (reversible) actions autonomously. */
  actionAllowed: boolean;
  /** Maximum observations surfaced per hour. */
  maxSurfacePerHour: number;
  /** If set, suppress all proactive behaviour until this time. */
  quietUntil?: Date;
}

/**
 * Default configuration per mode.
 *
 * - silent: never speaks, never acts
 * - volunteer: max 2 surfaces/hr, speaks as questions only, no action
 * - anticipatory: max 2 surfaces/hr, pre-drafts reversible actions
 * - autonomous: max 10 surfaces/hr, takes reversible actions, speaks for irreversible
 */
export const MODE_DEFAULTS: Record<ProactivityMode, ModeConfig> = {
  silent: {
    mode: "silent",
    speakAllowed: false,
    actionAllowed: false,
    maxSurfacePerHour: 0,
  },
  volunteer: {
    mode: "volunteer",
    speakAllowed: true,
    actionAllowed: false,
    maxSurfacePerHour: 2,
  },
  anticipatory: {
    mode: "anticipatory",
    speakAllowed: true,
    actionAllowed: true,
    maxSurfacePerHour: 2,
  },
  autonomous: {
    mode: "autonomous",
    speakAllowed: true,
    actionAllowed: true,
    maxSurfacePerHour: 10,
  },
};

/**
 * Manages the current proactivity mode and quiet timer.
 *
 * Thread-safe for single-process use. The quiet timer is a simple Date
 * comparison — no background timer needed.
 */
export class ProactivityModeManager {
  private currentMode: ProactivityMode;
  private quietUntilDate: Date | undefined;

  constructor(initial: ProactivityMode = "volunteer") {
    this.currentMode = initial;
  }

  setMode(mode: ProactivityMode): void {
    this.currentMode = mode;
  }

  getMode(): ProactivityMode {
    return this.currentMode;
  }

  getConfig(): ModeConfig {
    const base = { ...MODE_DEFAULTS[this.currentMode] };
    if (this.quietUntilDate) {
      base.quietUntil = this.quietUntilDate;
    }
    return base;
  }

  /**
   * Suppress all proactive behaviour for the given duration.
   * @param durationMs Milliseconds of quiet time.
   */
  goQuiet(durationMs: number): void {
    if (durationMs <= 0) return;
    this.quietUntilDate = new Date(Date.now() + durationMs);
  }

  /**
   * Returns true if the quiet timer is still active.
   */
  isQuiet(): boolean {
    if (!this.quietUntilDate) return false;
    if (this.quietUntilDate <= new Date()) {
      // Timer expired — clear it
      this.quietUntilDate = undefined;
      return false;
    }
    return true;
  }
}
