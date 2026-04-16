/**
 * Tests for MCP social tools (src/mcp/social-tools.ts).
 *
 * Covers: social_send round-trip, social_post throws, input validation.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SocialTools } from "../src/mcp/social-tools.js";
import type {
  SocialDriver,
  SocialPlatform,
  ResolvedTarget,
  SendOutcome,
} from "../src/social/driver.js";
import type { SocialDB } from "../src/social/social-db.js";
import type { EventBus, AgentEvent, EventFilter } from "../src/ipc/event-bus.js";
import type { SocialDispatchDeps } from "../src/social/dispatch.js";

/* ------------------------------------------------------------------ */
/*  Fakes                                                              */
/* ------------------------------------------------------------------ */

function makeFakeDriver(): SocialDriver {
  return {
    platform: "ig",
    transport: "cdp",
    async loginCheck() { return "logged-in"; },
    async resolveTarget(h: string): Promise<ResolvedTarget> {
      return { id: h, display: h };
    },
    async openConversation() {},
    async typeMessage() {},
    async confirmAndSend(): Promise<SendOutcome> { return { ok: true }; },
  };
}

function makeFakeSocialDB(): SocialDB {
  return {
    isKnownContact() { return false; },
    recordContact() {},
    logAction() {},
    countRecentActions() { return 0; },
    close() {},
  } as unknown as SocialDB;
}

function makeFakeEventBus(): EventBus {
  return {
    emit(_e: AgentEvent) {},
    subscribe(_f: EventFilter, _h: (e: AgentEvent) => void) { return () => {}; },
    once() { return Promise.reject(new Error("not implemented")); },
  };
}

function makeSocialTools(): SocialTools {
  const driver = makeFakeDriver();
  const drivers = new Map<SocialPlatform, SocialDriver>([["ig", driver]]);
  const deps: SocialDispatchDeps = {
    drivers,
    socialDb: makeFakeSocialDB(),
    eventBus: makeFakeEventBus(),
  };
  return new SocialTools(deps);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("SocialTools MCP handlers", () => {
  test("social_send dispatches and returns SocialSendResult", async () => {
    const tools = makeSocialTools();

    const result = await tools.send({
      platform: "ig",
      target: "@jobed",
      message: "hey from MCP",
    });

    assert.ok(result.ok);
    assert.strictEqual(result.platform, "ig");
    assert.strictEqual(result.target, "@jobed");
    assert.strictEqual(result.confirmationRequired, true);
  });

  test("social_send validates input — missing platform throws", async () => {
    const tools = makeSocialTools();

    await assert.rejects(
      () => tools.send({ target: "@jobed", message: "hey" }),
      (err: Error) => err.name === "ZodError" || err.message.includes("Required"),
    );
  });

  test("social_send validates input — empty message throws", async () => {
    const tools = makeSocialTools();

    await assert.rejects(
      () => tools.send({ platform: "ig", target: "@jobed", message: "" }),
    );
  });

  test("social_send validates input — invalid platform throws", async () => {
    const tools = makeSocialTools();

    await assert.rejects(
      () => tools.send({ platform: "fakebook", target: "@x", message: "hi" }),
    );
  });

  test("social_post always throws 'not yet implemented'", () => {
    const tools = makeSocialTools();

    assert.throws(
      () => tools.post({ platform: "ig", content: "hello world" }),
      (err: Error) => err.message.includes("not yet implemented"),
    );
  });

  test("social_post validates input before throwing", () => {
    const tools = makeSocialTools();

    // Invalid input should throw validation error, not "not yet implemented"
    assert.throws(
      () => tools.post({ platform: "ig", content: "" }),
    );
  });

  test("social_send returns no-driver for unregistered platform", async () => {
    const tools = makeSocialTools();

    const result = await tools.send({
      platform: "tiktok",
      target: "@someone",
      message: "hello",
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "no-driver");
  });
});
