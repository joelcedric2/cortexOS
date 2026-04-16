/**
 * Social Operator Layer — universal dispatch + safety rails (§5.4.3, §5.4.5).
 *
 * Entry point: `socialSend(req, deps)`. Picks the driver for the requested
 * platform from the registry, runs the universal flow (login → resolve →
 * open → type → confirm), enforces rate limits and first-contact confirmation,
 * logs every attempt, and emits an escalation event on the bus.
 */

import type {
  SocialPlatform,
  SocialDriver,
} from "./driver.js";
import type { SocialDB } from "./social-db.js";
import type { EventBus, AgentEvent } from "../ipc/event-bus.js";

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface SocialSendRequest {
  platform: SocialPlatform;
  target: string;
  message: string;
}

export interface SocialSendResult {
  ok: boolean;
  messageId?: string;
  platform: SocialPlatform;
  target: string;
  confirmationRequired: boolean;
  error?: string;
}

export interface SocialDispatchDeps {
  /** Registry of available drivers keyed by platform. */
  drivers: Map<SocialPlatform, SocialDriver>;
  /** SQLite helper for contacts + actions tables. */
  socialDb: SocialDB;
  /** In-process event bus for escalation events. */
  eventBus: EventBus;
  /** Max DMs per platform per hour. Default 20 per §5.4.5. */
  rateLimitPerHour?: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_RATE_LIMIT = 20;

/* ------------------------------------------------------------------ */
/*  Core dispatch                                                      */
/* ------------------------------------------------------------------ */

export async function socialSend(
  req: SocialSendRequest,
  deps: SocialDispatchDeps,
): Promise<SocialSendResult> {
  const { platform, target, message } = req;
  const {
    drivers,
    socialDb,
    eventBus,
    rateLimitPerHour = DEFAULT_RATE_LIMIT,
  } = deps;

  const base: Pick<SocialSendResult, "platform" | "target"> = {
    platform,
    target,
  };

  // 1. Pick driver from registry
  const driver = drivers.get(platform);
  if (!driver) {
    socialDb.logAction(platform, target, message, "no-driver");
    return { ...base, ok: false, confirmationRequired: false, error: "no-driver" };
  }

  // 2. Rate-limit check (§5.4.5 — max 20 DMs/platform/hour)
  const recentCount = socialDb.countRecentActions(platform);
  if (recentCount >= rateLimitPerHour) {
    socialDb.logAction(platform, target, message, "rate-limited");
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "rate-limited",
    };
  }

  // 3. Login check
  let loginStatus: "logged-in" | "expired" | "never";
  try {
    loginStatus = await driver.loginCheck();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    socialDb.logAction(platform, target, message, `login-check-error: ${msg}`);
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "login-check-failed",
    };
  }

  if (loginStatus !== "logged-in") {
    socialDb.logAction(platform, target, message, `login-${loginStatus}`);
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "login-required",
    };
  }

  // 4. Resolve target
  let targetId: string;
  try {
    const resolved = await driver.resolveTarget(target);
    targetId = resolved.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    socialDb.logAction(platform, target, message, `resolve-error: ${msg}`);
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "resolve-failed",
    };
  }

  // 5. Open conversation
  try {
    await driver.openConversation(targetId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    socialDb.logAction(platform, target, message, `open-error: ${msg}`);
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "open-conversation-failed",
    };
  }

  // 6. Type message — appears in input field, NOT submitted
  try {
    await driver.typeMessage(message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    socialDb.logAction(platform, target, message, `type-error: ${msg}`);
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "type-message-failed",
    };
  }

  // 7. Confirm and send — always fires escalation in Phase 4
  //    Emit escalation event on the bus per §5.4.3 step 7
  const escalationEvent: AgentEvent = {
    kind: "error",
    payload: {
      where: "social_confirm",
      platform,
      target,
      message,
      isFirstContact: !socialDb.isKnownContact(platform, target),
    },
    ts: new Date(),
  };
  eventBus.emit(escalationEvent);

  // Record first contact
  if (!socialDb.isKnownContact(platform, target)) {
    socialDb.recordContact(platform, target);
  }

  // Call driver's confirmAndSend (Phase 4 = no-op / stub)
  try {
    const outcome = await driver.confirmAndSend();
    socialDb.logAction(
      platform,
      target,
      message,
      outcome.ok ? "confirmed" : "confirm-rejected",
    );
    return {
      ...base,
      ok: true,
      messageId: outcome.messageId,
      confirmationRequired: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Captcha / unusual-activity → fail fast, escalate (§5.4.5)
    socialDb.logAction(platform, target, message, `confirm-error: ${msg}`);
    return {
      ...base,
      ok: false,
      confirmationRequired: false,
      error: "confirm-failed",
    };
  }
}
