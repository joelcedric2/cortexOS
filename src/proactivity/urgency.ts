/**
 * Urgency scoring and decision logic (plan section 5.7.3).
 *
 * Given a sensor sample and the current proactivity context, decides
 * whether to surface the observation immediately, bundle it for the
 * next session prompt, or just log it.
 */
import type { SensorSample } from "../sensors/sensor.js";
import type { ProactivityMode } from "./modes.js";

export interface UrgencyInput {
  sample: SensorSample;
  mode: ProactivityMode;
  quietUntil?: Date;
  /** 0..1 learned weight from past accept/reject patterns. */
  userHistoryWeight?: number;
  /** Timestamps of recent surfaces for rate-limit checking. */
  recentSurfaceTimes?: Date[];
  /** Max surfaces per hour for current mode. */
  maxSurfacePerHour?: number;
}

export type UrgencyDecision = "speak-now" | "bundle-for-session" | "log-only";

/** Threshold above which an observation is considered critical. */
const CRITICAL_THRESHOLD = 0.8;
/** Threshold above which an observation qualifies for bundling. */
const BUNDLE_THRESHOLD = 0.5;
/** One hour in milliseconds. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Count how many surfaces occurred in the last hour.
 */
function countRecentSurfaces(times: Date[], now: Date): number {
  const cutoff = new Date(now.getTime() - ONE_HOUR_MS);
  return times.filter((t) => t >= cutoff).length;
}

/**
 * Compute the urgency decision for a sensor sample.
 *
 * Decision logic (in priority order):
 * 1. silent mode OR quiet period → log-only
 * 2. urgency >= 0.8 AND not silent AND not quiet → speak-now
 *    (but downgrade to bundle-for-session if rate-limited)
 * 3. urgency >= 0.5 AND mode in [volunteer, anticipatory, autonomous] → bundle-for-session
 * 4. Otherwise → log-only
 */
export function computeUrgencyDecision(input: UrgencyInput): UrgencyDecision {
  const { sample, mode, quietUntil, recentSurfaceTimes, maxSurfacePerHour } =
    input;
  const now = new Date();

  // Rule 1: silent mode always logs only
  if (mode === "silent") return "log-only";

  // Rule 1b: quiet period active → log only
  if (quietUntil && quietUntil > now) return "log-only";

  // Check rate limit
  const isRateLimited =
    recentSurfaceTimes !== undefined &&
    maxSurfacePerHour !== undefined &&
    maxSurfacePerHour > 0 &&
    countRecentSurfaces(recentSurfaceTimes, now) >= maxSurfacePerHour;

  // Rule 2: critical urgency
  if (sample.urgency >= CRITICAL_THRESHOLD) {
    if (isRateLimited) return "bundle-for-session";
    return "speak-now";
  }

  // Rule 3: moderate urgency
  if (sample.urgency >= BUNDLE_THRESHOLD) {
    return "bundle-for-session";
  }

  // Rule 4: low urgency
  return "log-only";
}
