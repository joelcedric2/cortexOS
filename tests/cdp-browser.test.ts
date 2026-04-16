/**
 * Tests for src/browser/cdp.ts — Chrome DevTools Protocol wrapper.
 *
 * All Chrome interaction is mocked via CDPBrowserInternals injection.
 * No real browser is spawned. Tests are fast and deterministic.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createCDPBrowser,
  type CDPBrowserOptions,
  type CDPBrowserInternals,
} from "../src/browser/cdp.js";

// ────────────────────────── Fake Chrome process ────────────────────────

class FakeChromeProcess extends EventEmitter {
  public killed = false;
  public readonly pid = 12345;
  // ChildProcess has these — we only need the subset CDPBrowserImpl uses
  unref(): void { /* no-op */ }
  kill(signal?: string): boolean {
    this.killed = true;
    this.emit("exit", 0, signal ?? null);
    return true;
  }
}

// ────────────────────────── Fake CDP Session ───────────────────────────

/** Records CDP send() calls and returns canned responses. */
class FakeCDPSession {
  public connected = false;
  public disconnected = false;
  public sentCommands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  public cannedResponses = new Map<string, Record<string, unknown>>();

  get closed(): boolean {
    return this.disconnected;
  }

  async connect(_wsUrl: string): Promise<void> {
    this.connected = true;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disconnected) throw new Error("CDP session disconnected");
    this.sentCommands.push({ method, params });
    const canned = this.cannedResponses.get(method);
    if (canned) return canned;
    // Default responses per method
    return this.defaultResponse(method, params);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  private defaultResponse(method: string, params?: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "Page.enable":
      case "DOM.enable":
      case "Runtime.enable":
        return {};
      case "Page.navigate":
        return { frameId: "frame-1", loaderId: "loader-1" };
      case "Runtime.evaluate":
        return { result: { type: "string", value: "Hello World" } };
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelector":
        return { nodeId: 42 };
      case "DOM.getBoxModel":
        return { model: { content: [10, 10, 110, 10, 110, 50, 10, 50] } };
      case "Input.dispatchMouseEvent":
        return {};
      case "Input.dispatchKeyEvent":
        return {};
      case "Page.captureScreenshot":
        return { data: Buffer.from("fake-png-data").toString("base64") };
      case "Target.closeTarget":
        return { success: true };
      default:
        return {};
    }
  }
}

// ────────────────────────── Test helpers ────────────────────────────────

const FAKE_TARGET = {
  id: "target-1",
  type: "page",
  title: "New Tab",
  url: "about:blank",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
};

function createTestInternals(opts?: {
  fakeProcess?: FakeChromeProcess;
  fakeSession?: FakeCDPSession;
  targets?: typeof FAKE_TARGET[];
}): { internals: CDPBrowserInternals; process: FakeChromeProcess; session: FakeCDPSession; spawnArgs: string[][] } {
  const proc = opts?.fakeProcess ?? new FakeChromeProcess();
  const session = opts?.fakeSession ?? new FakeCDPSession();
  const targets = opts?.targets ?? [FAKE_TARGET];
  const spawnArgs: string[][] = [];

  const internals: CDPBrowserInternals = {
    spawnChrome: (_path: string, args: string[]) => {
      spawnArgs.push(args);
      return proc as unknown as import("node:child_process").ChildProcess;
    },
    fetchTargets: async (_port: number) => targets,
    createNewTarget: async (_port: number) => targets[0],
    createSession: () => session as unknown as ReturnType<NonNullable<CDPBrowserInternals["createSession"]>>,
  };

  return { internals, process: proc, session, spawnArgs };
}

// ────────────────────────── Tests ──────────────────────────────────────

describe("CDPBrowser.launch", () => {
  test("spawns Chrome with correct args", async () => {
    const { internals, spawnArgs } = createTestInternals();
    const browser = createCDPBrowser({ debugPort: 9333 }, internals);

    await browser.launch();

    assert.equal(spawnArgs.length, 1);
    const args = spawnArgs[0];
    assert.ok(args.includes("--remote-debugging-port=9333"), "should set debug port");
    assert.ok(args.some((a) => a.startsWith("--user-data-dir=")), "should set user data dir");
    assert.ok(args.includes("--no-first-run"), "should set no-first-run");
    assert.ok(args.includes("--no-default-browser-check"), "should set no-default-browser-check");
  });

  test("spawns Chrome with headless flag when headless=true", async () => {
    const { internals, spawnArgs } = createTestInternals();
    const browser = createCDPBrowser({ headless: true }, internals);

    await browser.launch();

    assert.ok(spawnArgs[0].includes("--headless=new"), "should include headless flag");
  });

  test("does not include headless flag by default", async () => {
    const { internals, spawnArgs } = createTestInternals();
    const browser = createCDPBrowser({}, internals);

    await browser.launch();

    assert.ok(!spawnArgs[0].some((a) => a.includes("headless")), "should not include headless");
  });

  test("uses custom chrome path", async () => {
    let capturedPath = "";
    const proc = new FakeChromeProcess();
    const internals: CDPBrowserInternals = {
      spawnChrome: (path: string, _args: string[]) => {
        capturedPath = path;
        return proc as unknown as import("node:child_process").ChildProcess;
      },
      fetchTargets: async () => [FAKE_TARGET],
    };
    const browser = createCDPBrowser({ chromePath: "/usr/bin/chromium" }, internals);

    await browser.launch();

    assert.equal(capturedPath, "/usr/bin/chromium");
  });

  test("is idempotent — second call is a no-op", async () => {
    const { internals, spawnArgs } = createTestInternals();
    const browser = createCDPBrowser({}, internals);

    await browser.launch();
    await browser.launch();

    assert.equal(spawnArgs.length, 1, "Chrome should only be spawned once");
  });

  test("uses custom userDataDir", async () => {
    const { internals, spawnArgs } = createTestInternals();
    const browser = createCDPBrowser({ userDataDir: "/tmp/test-chrome-profile" }, internals);

    await browser.launch();

    assert.ok(
      spawnArgs[0].includes("--user-data-dir=/tmp/test-chrome-profile"),
      "should use custom profile dir",
    );
  });
});

describe("CDPBrowser.isConnected", () => {
  test("returns false before launch", () => {
    const { internals } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    assert.equal(browser.isConnected(), false);
  });

  test("returns true after launch", async () => {
    const { internals } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    assert.equal(browser.isConnected(), true);
  });

  test("returns false after Chrome process exits", async () => {
    const { internals, process: proc } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    assert.equal(browser.isConnected(), true);

    // Simulate Chrome crash
    proc.emit("exit", 1, null);

    assert.equal(browser.isConnected(), false);
  });

  test("returns false after close()", async () => {
    const { internals } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    await browser.close();
    assert.equal(browser.isConnected(), false);
  });
});

describe("CDPBrowser.close", () => {
  test("kills Chrome process", async () => {
    const { internals, process: proc } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();

    await browser.close();

    assert.equal(proc.killed, true);
  });

  test("disconnects active sessions", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    await browser.newPage();

    assert.equal(session.connected, true);

    await browser.close();

    assert.equal(session.disconnected, true);
  });
});

describe("CDPBrowser re-launch after crash", () => {
  test("can re-launch after Chrome process exits", async () => {
    const { internals, process: proc, spawnArgs } = createTestInternals();
    const browser = createCDPBrowser({}, internals);

    await browser.launch();
    assert.equal(browser.isConnected(), true);

    // Simulate crash
    proc.emit("exit", 1, null);
    assert.equal(browser.isConnected(), false);

    // Re-launch
    await browser.launch();
    assert.equal(browser.isConnected(), true);
    assert.equal(spawnArgs.length, 2, "should spawn Chrome a second time");
  });
});

describe("CDPPage.navigate", () => {
  test("sends Page.navigate CDP command", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.navigate("https://example.com");

    const navCmd = session.sentCommands.find((c) => c.method === "Page.navigate");
    assert.ok(navCmd, "should have sent Page.navigate");
    assert.deepEqual(navCmd.params, { url: "https://example.com" });
  });
});

describe("CDPPage.click", () => {
  test("resolves selector and dispatches mouse events", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.click("#submit-btn");

    const querySelector = session.sentCommands.find((c) => c.method === "DOM.querySelector");
    assert.ok(querySelector, "should query selector");
    assert.equal(querySelector.params?.["selector"], "#submit-btn");

    const mousePressed = session.sentCommands.find(
      (c) => c.method === "Input.dispatchMouseEvent" && c.params?.["type"] === "mousePressed",
    );
    assert.ok(mousePressed, "should dispatch mousePressed");

    const mouseReleased = session.sentCommands.find(
      (c) => c.method === "Input.dispatchMouseEvent" && c.params?.["type"] === "mouseReleased",
    );
    assert.ok(mouseReleased, "should dispatch mouseReleased");
  });
});

describe("CDPPage.type", () => {
  test("dispatches key events for each character", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.type("#input", "Hi");

    const keyDowns = session.sentCommands.filter(
      (c) => c.method === "Input.dispatchKeyEvent" && c.params?.["type"] === "keyDown",
    );
    assert.equal(keyDowns.length, 2, "should have 2 keyDown events");
    assert.equal(keyDowns[0].params?.["text"], "H");
    assert.equal(keyDowns[1].params?.["text"], "i");
  });
});

describe("CDPPage.readText", () => {
  test("evaluates innerText via Runtime.evaluate", async () => {
    const { internals, session } = createTestInternals();
    session.cannedResponses.set("Runtime.evaluate", {
      result: { type: "string", value: "Page content here" },
    });
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    const text = await page.readText();

    assert.equal(text, "Page content here");
  });

  test("uses selector when provided", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.readText(".main-content");

    // Find the Runtime.evaluate call after the page setup calls
    const evalCalls = session.sentCommands.filter((c) => c.method === "Runtime.evaluate");
    const lastEval = evalCalls[evalCalls.length - 1];
    assert.ok(lastEval, "should call Runtime.evaluate");
    const expr = lastEval.params?.["expression"] as string;
    assert.ok(expr.includes(".main-content"), "expression should reference the selector");
  });

  test("defaults to document.body when no selector", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.readText();

    const evalCalls = session.sentCommands.filter((c) => c.method === "Runtime.evaluate");
    const lastEval = evalCalls[evalCalls.length - 1];
    const expr = lastEval.params?.["expression"] as string;
    assert.ok(expr.includes("document.body"), "should default to document.body");
  });
});

describe("CDPPage.screenshot", () => {
  test("returns Buffer from base64 CDP response", async () => {
    const { internals } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    const buf = await page.screenshot();

    assert.ok(Buffer.isBuffer(buf), "should return a Buffer");
    assert.equal(buf.toString(), "fake-png-data");
  });

  test("passes fullPage option", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.screenshot({ fullPage: true });

    const screenshotCmd = session.sentCommands.find(
      (c) => c.method === "Page.captureScreenshot",
    );
    assert.ok(screenshotCmd, "should call Page.captureScreenshot");
    assert.equal(screenshotCmd.params?.["captureBeyondViewport"], true);
  });
});

describe("CDPPage.evaluate", () => {
  test("evaluates JS expression and returns result", async () => {
    const { internals, session } = createTestInternals();
    session.cannedResponses.set("Runtime.evaluate", {
      result: { type: "number", value: 42 },
    });
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    const result = await page.evaluate<number>("1 + 41");

    assert.equal(result, 42);
  });
});

describe("CDPPage.close", () => {
  test("sends Target.closeTarget and disconnects session", async () => {
    const { internals, session } = createTestInternals();
    const browser = createCDPBrowser({}, internals);
    await browser.launch();
    const page = await browser.newPage();

    await page.close();

    const closeCmd = session.sentCommands.find((c) => c.method === "Target.closeTarget");
    assert.ok(closeCmd, "should send Target.closeTarget");
    assert.equal(closeCmd.params?.["targetId"], "target-1");
    assert.equal(session.disconnected, true);
  });
});

describe("CDPBrowser.newPage throws when not connected", () => {
  test("throws if browser not launched", async () => {
    const { internals } = createTestInternals();
    const browser = createCDPBrowser({}, internals);

    await assert.rejects(() => browser.newPage(), {
      message: /not connected/,
    });
  });
});

describe("CDPBrowser.pages", () => {
  test("returns page objects for each target", async () => {
    const targets = [
      { ...FAKE_TARGET, id: "t1" },
      { ...FAKE_TARGET, id: "t2" },
    ];
    const { internals } = createTestInternals({ targets });
    const browser = createCDPBrowser({}, internals);
    await browser.launch();

    const pages = await browser.pages();

    assert.equal(pages.length, 2);
  });
});
