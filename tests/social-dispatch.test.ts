/**
 * Tests for the social dispatch layer (src/social/dispatch.ts).
 *
 * Covers: full flow, login-expired path, rate-limit rejection,
 * escalation event emission, first-contact tracking.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { socialSend, type SocialDispatchDeps } from "../src/social/dispatch.js";
import type {
  SocialDriver,
  SocialPlatform,
  ResolvedTarget,
  SendOutcome,
} from "../src/social/driver.js";
import type { SocialDB } from "../src/social/social-db.js";
import type { EventBus, AgentEvent, EventFilter } from "../src/ipc/event-bus.js";

/* ------------------------------------------------------------------ */
/*  Fakes                                                              */
/* ------------------------------------------------------------------ */

function makeFakeDriver(overrides?: Partial<SocialDriver>): SocialDriver {
  return {
    platform: "ig",
    transport: "cdp",
    async loginCheck() { return "logged-in"; },
    async resolveTarget(handle: string): Promise<ResolvedTarget> {
      return { id: handle, display: handle };
    },
    async openConversation() {},
    async typeMessage() {},
    async confirmAndSend(): Promise<SendOutcome> { return { ok: true }; },
    ...overrides,
  };
}

class FakeSocialDB {
  public contacts = new Set<string>();
  public actions: Array<{
    platform: string;
    target: string;
    message: string;
    outcome: string;
  }> = [];
  public recentCount = 0;

  isKnownContact(platform: string, target: string): boolean {
    return this.contacts.has(`${platform}:${target}`);
  }
  recordContact(platform: string, target: string): void {
    this.contacts.add(`${platform}:${target}`);
  }
  logAction(
    platform: string,
    target: string,
    message: string,
    outcome: string,
  ): void {
    this.actions.push({ platform, target, message, outcome });
  }
  countRecentActions(): number {
    return this.recentCount;
  }
  close(): void {}
}

class FakeEventBus implements EventBus {
  public emitted: AgentEvent[] = [];
  emit(event: AgentEvent): void { this.emitted.push(event); }
  subscribe(_f: EventFilter, _h: (e: AgentEvent) => void): () => void {
    return () => {};
  }
  once(_f: EventFilter, _t?: number): Promise<AgentEvent> {
    return Promise.reject(new Error("not implemented in fake"));
  }
}

function makeDeps(overrides?: {
  driver?: SocialDriver;
  socialDb?: FakeSocialDB;
  eventBus?: FakeEventBus;
  rateLimitPerHour?: number;
}): { deps: SocialDispatchDeps; db: FakeSocialDB; bus: FakeEventBus } {
  const db = overrides?.socialDb ?? new FakeSocialDB();
  const bus = overrides?.eventBus ?? new FakeEventBus();
  const driver = overrides?.driver ?? makeFakeDriver();
  const drivers = new Map<SocialPlatform, SocialDriver>([[driver.platform, driver]]);
  return {
    deps: {
      drivers,
      socialDb: db as unknown as SocialDB,
      eventBus: bus,
      rateLimitPerHour: overrides?.rateLimitPerHour,
    },
    db,
    bus,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("socialSend", () => {
  test("full flow: login → resolve → open → type → confirm → escalation", async () => {
    const calls: string[] = [];
    const driver = makeFakeDriver({
      async loginCheck() { calls.push("loginCheck"); return "logged-in"; },
      async resolveTarget(h) { calls.push("resolveTarget"); return { id: h, display: h }; },
      async openConversation() { calls.push("openConversation"); },
      async typeMessage() { calls.push("typeMessage"); },
      async confirmAndSend() { calls.push("confirmAndSend"); return { ok: true }; },
    });
    const { deps, bus, db } = makeDeps({ driver });

    const result = await socialSend(
      { platform: "ig", target: "@jobed", message: "hey" },
      deps,
    );

    assert.ok(result.ok);
    assert.strictEqual(result.confirmationRequired, true);
    assert.strictEqual(result.platform, "ig");
    assert.strictEqual(result.target, "@jobed");

    // Universal flow order
    assert.deepStrictEqual(calls, [
      "loginCheck",
      "resolveTarget",
      "openConversation",
      "typeMessage",
      "confirmAndSend",
    ]);

    // Escalation event was emitted on bus
    assert.strictEqual(bus.emitted.length, 1);
    const evt = bus.emitted[0];
    assert.strictEqual(evt.kind, "error");
    const payload = evt.payload as Record<string, unknown>;
    assert.strictEqual(payload.where, "social_confirm");
    assert.strictEqual(payload.platform, "ig");
    assert.strictEqual(payload.target, "@jobed");
    assert.strictEqual(payload.message, "hey");

    // Action was logged
    assert.ok(db.actions.length > 0);
    assert.strictEqual(db.actions[db.actions.length - 1].outcome, "confirmed");
  });

  test("login expired → returns error without proceeding", async () => {
    const driver = makeFakeDriver({
      async loginCheck() { return "expired"; },
    });
    const { deps, bus } = makeDeps({ driver });

    const result = await socialSend(
      { platform: "ig", target: "@jobed", message: "hey" },
      deps,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "login-required");
    assert.strictEqual(result.confirmationRequired, false);
    // No escalation event — login-required is a soft failure
    assert.strictEqual(bus.emitted.length, 0);
  });

  test("login 'never' → returns login-required error", async () => {
    const driver = makeFakeDriver({
      async loginCheck() { return "never"; },
    });
    const { deps } = makeDeps({ driver });

    const result = await socialSend(
      { platform: "ig", target: "@test", message: "hello" },
      deps,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "login-required");
  });

  test("rate limit: rejects when at max", async () => {
    const db = new FakeSocialDB();
    db.recentCount = 20;
    const { deps, bus } = makeDeps({ socialDb: db, rateLimitPerHour: 20 });

    const result = await socialSend(
      { platform: "ig", target: "@jobed", message: "hey" },
      deps,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "rate-limited");
    assert.strictEqual(result.confirmationRequired, false);
    assert.strictEqual(bus.emitted.length, 0);
    // Rate limit logged
    assert.ok(db.actions.some(a => a.outcome === "rate-limited"));
  });

  test("no driver for platform → no-driver error", async () => {
    const { deps, db } = makeDeps();

    const result = await socialSend(
      { platform: "tiktok", target: "@someone", message: "hi" },
      deps,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "no-driver");
    assert.ok(db.actions.some(a => a.outcome === "no-driver"));
  });

  test("first-contact is tracked and included in escalation payload", async () => {
    const { deps, bus, db } = makeDeps();

    // First send — should be marked as first contact
    const result1 = await socialSend(
      { platform: "ig", target: "@newuser", message: "hey" },
      deps,
    );
    assert.ok(result1.ok);
    const payload1 = bus.emitted[0].payload as Record<string, unknown>;
    assert.strictEqual(payload1.isFirstContact, true);

    // Second send — no longer first contact
    const result2 = await socialSend(
      { platform: "ig", target: "@newuser", message: "follow up" },
      deps,
    );
    assert.ok(result2.ok);
    const payload2 = bus.emitted[1].payload as Record<string, unknown>;
    assert.strictEqual(payload2.isFirstContact, false);

    // Contact was recorded
    assert.ok(db.contacts.has("ig:@newuser"));
  });

  test("resolve failure → resolve-failed error", async () => {
    const driver = makeFakeDriver({
      async resolveTarget() { throw new Error("user not found"); },
    });
    const { deps } = makeDeps({ driver });

    const result = await socialSend(
      { platform: "ig", target: "@ghost", message: "hey" },
      deps,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "resolve-failed");
  });

  test("confirmAndSend throws → confirm-failed (captcha/unusual activity)", async () => {
    const driver = makeFakeDriver({
      async confirmAndSend() { throw new Error("unusual activity detected"); },
    });
    const { deps, db } = makeDeps({ driver });

    const result = await socialSend(
      { platform: "ig", target: "@test", message: "hey" },
      deps,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "confirm-failed");
    assert.ok(db.actions.some(a => a.outcome.includes("confirm-error")));
  });
});
