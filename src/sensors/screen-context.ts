/**
 * `screen-context` sensor — Phase 5.5 stub shipped for real (plan §8.4).
 *
 * On each `sample()` tick the sensor:
 *   1. Asks the capturer for the most-recent frame (cheap — zero-arg reader).
 *   2. Skips silently if the frame is from a private app (defence in depth —
 *      the capturer's bundle-id skip is the first line, this human-readable-
 *      name check is the second).
 *   3. Decides whether to fire based on three mutually exclusive signals:
 *        a. active-app CHANGED since the last sample (max 1x per 60s per app)
 *        b. same app + same window title + no change for > 5 min → "stuck"
 *        c. composer-style window with an unsent draft age > 5 min →
 *           links to the existing `unsent-drafts` sensor's family
 *      …returning null when nothing is worth surfacing.
 *   4. Attaches the compact VisionBrief summary to the observation's
 *      `data.brief` so downstream consumers (pending-surface, agents) have
 *      a human-readable sketch without re-running the brief pipeline.
 *
 * Privacy: `privacyLevel = "local-only"` — this sensor *never* forwards the
 * frame to the LLM. If the caller later escalates to the `nchinda_see` MCP
 * tool, THAT path is where the optional LLM polish happens (and is still
 * blocked for private apps).
 */
import type { Sensor, SensorSample } from "./sensor.js";
import type { ScreenCapturer, ScreenFrame } from "../perception/screen-capture.js";
import { buildBrief, isPrivateApp, type VisionBrief } from "../perception/vision-brief.js";

// ─── Tunables (all overridable for tests) ────────────────────────────────────

export const APP_CHANGE_COOLDOWN_MS = 60_000;            // 60s per app
export const STUCK_WINDOW_THRESHOLD_MS = 5 * 60 * 1000;  // 5 min same window
export const DRAFT_STALE_THRESHOLD_MS = 5 * 60 * 1000;   // 5 min unsent draft
export const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;        // manager tick cadence

// ─── Dependency bundle ──────────────────────────────────────────────────────

export interface ScreenContextSensorDeps {
  capturer: ScreenCapturer;
  /** Test seam — real callers pass `buildBrief` from vision-brief.ts. */
  brief: typeof buildBrief;
  /**
   * Optional per-app last-fire map. Shared with other code if desired; a
   * fresh Map is created per sensor otherwise. Useful for tests that pre-seed
   * timestamps.
   */
  lastSeen?: Map<string, Date>;
  /** Wall-clock injector (tests advance it deterministically). */
  now?: () => Date;
  /** Optional structured logger for internal failures. */
  log?: (msg: string) => void;
}

// ─── Internal state ─────────────────────────────────────────────────────────

interface LastObserved {
  /** Composite "<app>|<title>" key last seen as the foreground window. */
  key: string;
  /** When we first noticed this (app, title) combination. */
  firstSeenAt: Date;
  /** When we last emitted a "stuck" observation for this key. */
  stuckFiredAt?: Date;
  /** When we first noticed this composer-style window (unsent-draft timer). */
  draftFirstSeenAt?: Date;
  /** When we last emitted an "unsent-draft" observation for this key. */
  draftFiredAt?: Date;
  /**
   * True when we entered this app but suppressed the app-change fire
   * because of the 60s-per-app cooldown. The sensor will re-attempt on
   * subsequent ticks until the cooldown elapses.
   */
  appChangePending?: boolean;
}

const COMPOSER_TITLE_PATTERN = /\b(draft|compose|reply|new message|new mail)\b/i;

// ─── Factory ────────────────────────────────────────────────────────────────

/** Build a real `screen-context` sensor. */
export function createScreenContextSensor(deps: ScreenContextSensorDeps): Sensor {
  const lastSeen = deps.lastSeen ?? new Map<string, Date>();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let observed: LastObserved | null = null;

  return {
    name: "screen-context",
    description:
      "Fires when the foreground app changes, when the user appears stuck on the same window > 5min, or when a composer window holds an unsent draft > 5min.",
    permissionsRequired: ["screen-recording"],
    privacyLevel: "local-only",
    interval: DEFAULT_SAMPLE_INTERVAL_MS,
    enabled: false, // opt-in per Phase 0 consent rules; the manager flips it.

    async sample(): Promise<SensorSample | null> {
      let frame: ScreenFrame | null = null;
      try {
        const recent = deps.capturer.getRecent(1);
        frame = recent[0] ?? null;
      } catch (err) {
        // getRecent() must NEVER throw by contract, but defend anyway.
        log(`screen-context: getRecent failed: ${errorMessage(err)}`);
        return null;
      }

      if (!frame) return null;

      // Defence-in-depth: re-check the private-app guard at the sensor layer.
      if (isPrivateApp(frame.active_app)) {
        return null;
      }

      const key = composeKey(frame);
      const nowAt = now();

      try {
        const signal = evaluateSignal(observed, frame, key, nowAt, lastSeen);
        observed = signal.nextObserved;

        if (!signal.fire) return null;

        // Only build the brief when we've decided to fire — keeps the hot path
        // cheap on most ticks.
        const brief = await safeBrief(deps.brief, frame, log);
        lastSeen.set(frame.active_app ?? "(unknown)", nowAt);

        return {
          sensorName: "screen-context",
          observation: signal.observationText(brief),
          urgency: signal.urgency,
          data: {
            reason: signal.reason,
            active_app: frame.active_app,
            window_title: frame.window_title,
            source_frame_id: frame.id,
            brief: brief
              ? {
                  summary: brief.summary,
                  sentiment: brief.sentiment,
                }
              : undefined,
          },
          sampledAt: nowAt,
        };
      } catch (err) {
        log(`screen-context: evaluate failed: ${errorMessage(err)}`);
        return null;
      }
    },
  };
}

// ─── Signal decision (pure) ────────────────────────────────────────────────

type SignalReason = "app-change" | "stuck" | "unsent-draft";

interface Signal {
  fire: boolean;
  reason: SignalReason;
  urgency: number;
  nextObserved: LastObserved;
  observationText(brief: VisionBrief | null): string;
}

/**
 * Decide whether this frame justifies an observation. Pure except for
 * lastSeen map reads — tests drive it by constructing fresh deps.
 */
function evaluateSignal(
  observed: LastObserved | null,
  frame: ScreenFrame,
  key: string,
  nowAt: Date,
  lastSeen: Map<string, Date>,
): Signal {
  const app = frame.active_app ?? "(unknown)";
  const title = frame.window_title ?? "";

  // Establish or refresh the observation we're building next.
  let next: LastObserved;

  // --- (a) app-change signal --------------------------------------------
  if (!observed || observed.key !== key) {
    // A new (app, title) pair. If the app itself has changed, consider
    // firing, subject to the 60s-per-app cooldown.
    const appChanged = !observed || appOf(observed.key) !== app;
    next = {
      key,
      firstSeenAt: nowAt,
      draftFirstSeenAt: isComposerTitle(title) ? nowAt : undefined,
    };

    if (appChanged) {
      const lastFire = lastSeen.get(app);
      if (!lastFire || nowAt.getTime() - lastFire.getTime() >= APP_CHANGE_COOLDOWN_MS) {
        return {
          fire: true,
          reason: "app-change",
          urgency: 0.2,
          nextObserved: next,
          observationText: (brief) =>
            brief
              ? `Active app changed to ${app} — ${brief.summary}`
              : `Active app changed to ${app}.`,
        };
      }
      // App changed but cooldown suppressed the fire — latch a pending
      // flag so we can fire once the cooldown drains on a later tick.
      next.appChangePending = true;
    }
    // App didn't change, just title — no app-change fire, but still update
    // observed so the stuck timer anchors on the new title.
    return noFire(next, "app-change");
  }

  // Same (app, title) as last tick. Carry forward timers but refresh draft
  // start if the window only NOW looks like a composer.
  next = {
    ...observed,
    key,
    draftFirstSeenAt:
      observed.draftFirstSeenAt ??
      (isComposerTitle(title) ? nowAt : undefined),
  };

  // Re-attempt a previously-suppressed app-change fire once the cooldown
  // elapses.
  if (observed.appChangePending) {
    const lastFire = lastSeen.get(app);
    if (!lastFire || nowAt.getTime() - lastFire.getTime() >= APP_CHANGE_COOLDOWN_MS) {
      next.appChangePending = false;
      return {
        fire: true,
        reason: "app-change",
        urgency: 0.2,
        nextObserved: next,
        observationText: (brief) =>
          brief
            ? `Active app changed to ${app} — ${brief.summary}`
            : `Active app changed to ${app}.`,
      };
    }
  }

  // --- (b) stuck signal -------------------------------------------------
  const dwell = nowAt.getTime() - observed.firstSeenAt.getTime();
  const stuckCooldownElapsed =
    !observed.stuckFiredAt ||
    nowAt.getTime() - observed.stuckFiredAt.getTime() >=
      STUCK_WINDOW_THRESHOLD_MS;

  if (dwell >= STUCK_WINDOW_THRESHOLD_MS && stuckCooldownElapsed) {
    next.stuckFiredAt = nowAt;
    return {
      fire: true,
      reason: "stuck",
      urgency: 0.4,
      nextObserved: next,
      observationText: (brief) =>
        brief
          ? `User has been on ${app} — "${title}" for ${Math.round(dwell / 60_000)} min (possible stuck). ${brief.summary}`
          : `User has been on ${app} — "${title}" for ${Math.round(dwell / 60_000)} min (possible stuck).`,
    };
  }

  // --- (c) unsent-draft signal ------------------------------------------
  if (
    isComposerTitle(title) &&
    next.draftFirstSeenAt !== undefined
  ) {
    const draftAge = nowAt.getTime() - next.draftFirstSeenAt.getTime();
    const draftCooldownElapsed =
      !observed.draftFiredAt ||
      nowAt.getTime() - observed.draftFiredAt.getTime() >=
        DRAFT_STALE_THRESHOLD_MS;

    if (draftAge >= DRAFT_STALE_THRESHOLD_MS && draftCooldownElapsed) {
      next.draftFiredAt = nowAt;
      return {
        fire: true,
        reason: "unsent-draft",
        urgency: 0.5,
        nextObserved: next,
        observationText: (brief) =>
          brief
            ? `Composer open in ${app} — "${title}" with an unsent draft for ${Math.round(draftAge / 60_000)} min. ${brief.summary}`
            : `Composer open in ${app} — "${title}" with an unsent draft for ${Math.round(draftAge / 60_000)} min.`,
      };
    }
  }

  return noFire(next, "app-change");
}

function noFire(next: LastObserved, reason: SignalReason): Signal {
  return {
    fire: false,
    reason,
    urgency: 0,
    nextObserved: next,
    observationText: () => "",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function composeKey(frame: ScreenFrame): string {
  return `${frame.active_app ?? "(unknown)"}|${frame.window_title ?? ""}`;
}

function appOf(key: string): string {
  const idx = key.indexOf("|");
  return idx === -1 ? key : key.slice(0, idx);
}

function isComposerTitle(title: string): boolean {
  return COMPOSER_TITLE_PATTERN.test(title);
}

async function safeBrief(
  build: typeof buildBrief,
  frame: ScreenFrame,
  log: (msg: string) => void,
): Promise<VisionBrief | null> {
  try {
    return await build(frame, {}, { mode: "local-only" });
  } catch (err) {
    log(`screen-context: buildBrief failed: ${errorMessage(err)}`);
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
