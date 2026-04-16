/**
 * Tests for social platform drivers (ig, x, imessage).
 *
 * Each driver is tested with a mocked CDPPage or AppleScript execFile.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IgDriver, IG_SELECTORS } from "../src/social/drivers/ig-driver.js";
import { XDriver, X_SELECTORS } from "../src/social/drivers/x-driver.js";
import { IMessageDriver } from "../src/social/drivers/imessage-driver.js";
import { DriverNotImplemented } from "../src/social/driver.js";
import {
  linkedinStub,
  redditStub,
  tiktokStub,
  discordStub,
  telegramStub,
  whatsappStub,
} from "../src/social/drivers/stub-driver.js";
import type { CDPPage } from "../src/browser/_cdp-stub.js";

/* ------------------------------------------------------------------ */
/*  Mock CDPPage                                                       */
/* ------------------------------------------------------------------ */

interface PageCall {
  method: string;
  args: unknown[];
}

function makeMockPage(overrides?: Partial<CDPPage>): {
  page: CDPPage;
  calls: PageCall[];
} {
  const calls: PageCall[] = [];

  const page: CDPPage = {
    async navigate(url: string) { calls.push({ method: "navigate", args: [url] }); },
    async click(sel: string) { calls.push({ method: "click", args: [sel] }); },
    async type(sel: string, text: string, opts?: { delay?: number }) {
      calls.push({ method: "type", args: [sel, text, opts] });
    },
    async readText(sel?: string) {
      calls.push({ method: "readText", args: [sel] });
      return "";
    },
    async screenshot(opts?: { fullPage?: boolean }) {
      calls.push({ method: "screenshot", args: [opts] });
      return Buffer.from("fake-screenshot");
    },
    async waitFor(sel: string, timeout?: number) {
      calls.push({ method: "waitFor", args: [sel, timeout] });
    },
    async evaluate<T>(fn: string): Promise<T> {
      calls.push({ method: "evaluate", args: [fn] });
      return undefined as T;
    },
    async close() { calls.push({ method: "close", args: [] }); },
    ...overrides,
  };

  return { page, calls };
}

/* ------------------------------------------------------------------ */
/*  Instagram driver                                                   */
/* ------------------------------------------------------------------ */

describe("IgDriver", () => {
  test("platform and transport are correct", () => {
    const { page } = makeMockPage();
    const driver = new IgDriver({ page });
    assert.strictEqual(driver.platform, "ig");
    assert.strictEqual(driver.transport, "cdp");
  });

  test("loginCheck navigates to instagram.com", async () => {
    const { page, calls } = makeMockPage();
    const driver = new IgDriver({ page });

    const status = await driver.loginCheck();

    const navCall = calls.find(c => c.method === "navigate");
    assert.ok(navCall);
    assert.strictEqual(navCall.args[0], "https://www.instagram.com");
    assert.strictEqual(status, "logged-in");
  });

  test("loginCheck returns 'never' when login page detected", async () => {
    const { page } = makeMockPage({
      async readText() { return "username password"; },
    });
    const driver = new IgDriver({ page });
    const status = await driver.loginCheck();
    assert.strictEqual(status, "never");
  });

  test("resolveTarget navigates to user profile", async () => {
    const { page, calls } = makeMockPage({
      async readText() { return "Jobed"; },
    });
    const driver = new IgDriver({ page });

    const target = await driver.resolveTarget("@jobed");

    assert.strictEqual(target.id, "jobed");
    assert.strictEqual(target.display, "Jobed");
    const navCall = calls.find(c =>
      c.method === "navigate" &&
      (c.args[0] as string).includes("instagram.com/jobed"),
    );
    assert.ok(navCall, "should navigate to the profile page");
  });

  test("typeMessage types into DM input with delay", async () => {
    const { page, calls } = makeMockPage();
    const driver = new IgDriver({ page });

    await driver.typeMessage("hello there");

    const typeCall = calls.find(c => c.method === "type");
    assert.ok(typeCall);
    assert.strictEqual(typeCall.args[1], "hello there");
    const opts = typeCall.args[2] as { delay?: number } | undefined;
    assert.ok(opts?.delay, "should use a typing delay");
  });

  test("confirmAndSend returns ok:true (Phase 4 stub)", async () => {
    const { page } = makeMockPage();
    const driver = new IgDriver({ page });
    const result = await driver.confirmAndSend();
    assert.ok(result.ok);
  });
});

/* ------------------------------------------------------------------ */
/*  X/Twitter driver                                                   */
/* ------------------------------------------------------------------ */

describe("XDriver", () => {
  test("platform and transport are correct", () => {
    const { page } = makeMockPage();
    const driver = new XDriver({ page });
    assert.strictEqual(driver.platform, "x");
    assert.strictEqual(driver.transport, "cdp");
  });

  test("loginCheck navigates to x.com", async () => {
    const { page, calls } = makeMockPage();
    const driver = new XDriver({ page });

    await driver.loginCheck();

    const navCall = calls.find(c => c.method === "navigate");
    assert.ok(navCall);
    assert.strictEqual(navCall.args[0], "https://x.com");
  });

  test("resolveTarget navigates to x.com profile", async () => {
    const { page, calls } = makeMockPage({
      async readText() { return "Jobed"; },
    });
    const driver = new XDriver({ page });

    const target = await driver.resolveTarget("@jobed");

    assert.strictEqual(target.id, "jobed");
    const navCall = calls.find(c =>
      c.method === "navigate" &&
      (c.args[0] as string).includes("x.com/jobed"),
    );
    assert.ok(navCall, "should navigate to x.com profile");
  });

  test("typeMessage types into DM input", async () => {
    const { page, calls } = makeMockPage();
    const driver = new XDriver({ page });

    await driver.typeMessage("hey from x");

    const typeCall = calls.find(c => c.method === "type");
    assert.ok(typeCall);
    assert.strictEqual(typeCall.args[1], "hey from x");
  });

  test("confirmAndSend returns ok:true (Phase 4 stub)", async () => {
    const { page } = makeMockPage();
    const driver = new XDriver({ page });
    const result = await driver.confirmAndSend();
    assert.ok(result.ok);
  });
});

/* ------------------------------------------------------------------ */
/*  iMessage driver                                                    */
/* ------------------------------------------------------------------ */

describe("IMessageDriver", () => {
  test("platform and transport are correct", () => {
    const driver = new IMessageDriver();
    assert.strictEqual(driver.platform, "imessage");
    assert.strictEqual(driver.transport, "applescript");
  });

  test("loginCheck calls osascript", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const driver = new IMessageDriver({
      execFileFn: async (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args: [...args] });
        return { stdout: "Messages", stderr: "" };
      },
    });

    const status = await driver.loginCheck();

    assert.strictEqual(status, "logged-in");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, "osascript");
    assert.ok(calls[0].args.includes("-e"));
    assert.ok(calls[0].args.some(a => a.includes("Messages")));
  });

  test("loginCheck returns 'never' when osascript fails", async () => {
    const driver = new IMessageDriver({
      execFileFn: async () => { throw new Error("no Messages app"); },
    });

    const status = await driver.loginCheck();
    assert.strictEqual(status, "never");
  });

  test("resolveTarget returns handle as-is (strips @)", async () => {
    const driver = new IMessageDriver();
    const target = await driver.resolveTarget("@+15551234567");
    assert.strictEqual(target.id, "+15551234567");
    assert.strictEqual(target.display, "+15551234567");
  });

  test("full flow: open → type → confirm buffers and returns ok", async () => {
    const driver = new IMessageDriver({
      execFileFn: async () => ({ stdout: "", stderr: "" }),
    });

    await driver.openConversation("+15551234567");
    await driver.typeMessage("test message");
    const result = await driver.confirmAndSend();

    assert.ok(result.ok);
  });

  test("confirmAndSend without open/type returns ok:false", async () => {
    const driver = new IMessageDriver();
    const result = await driver.confirmAndSend();
    assert.strictEqual(result.ok, false);
  });
});

/* ------------------------------------------------------------------ */
/*  Stub drivers                                                       */
/* ------------------------------------------------------------------ */

describe("stub drivers", () => {
  const stubs = [
    { name: "linkedin", driver: linkedinStub },
    { name: "reddit", driver: redditStub },
    { name: "tiktok", driver: tiktokStub },
    { name: "discord", driver: discordStub },
    { name: "telegram", driver: telegramStub },
    { name: "whatsapp", driver: whatsappStub },
  ];

  for (const { name, driver } of stubs) {
    test(`${name} stub throws DriverNotImplemented`, () => {
      assert.throws(
        () => driver.loginCheck(),
        (err: Error) =>
          err instanceof DriverNotImplemented &&
          err.message.includes(name),
      );
    });
  }
});
