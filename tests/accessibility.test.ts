/**
 * Tests for src/computer-use/accessibility.ts — mocked NativeBridge.
 *
 * Covers:
 *   - findElement(): success, not-found (→ null), malformed JSON
 *   - findAll(): success, empty, malformed
 *   - correct CLI arg shape for role / label / app
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  findElement,
  findAll,
  AccessibilityError,
  type AXElement,
} from "../src/computer-use/accessibility.js";
import type { NativeBridge } from "../src/computer-use/actuator.js";

class FakeBridge implements NativeBridge {
  public calls: string[][] = [];
  public responses: string[] = [];
  async run(args: string[]): Promise<string> {
    this.calls.push(args.slice());
    return this.responses.shift() ?? "";
  }
}

const MOCK_ELEMENT: AXElement = {
  role: "AXButton",
  label: "Send",
  bbox: { x: 100, y: 200, w: 80, h: 30 },
  pid: 42,
};

// ───────────────── findElement ──────────────────────────────────────────

describe("findElement", () => {
  test("shells `ax find --role <role> --label <str> --app <bundle>`", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify(MOCK_ELEMENT));
    const out = await findElement(
      { role: "AXButton", label: "Send", app: "com.apple.Mail" },
      { bridge },
    );
    assert.deepEqual(out, MOCK_ELEMENT);
    assert.deepEqual(bridge.calls, [
      [
        "ax",
        "find",
        "--role",
        "AXButton",
        "--label",
        "Send",
        "--app",
        "com.apple.Mail",
      ],
    ]);
  });

  test("omits --label and --app when not provided", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify(MOCK_ELEMENT));
    await findElement({ role: "AXButton" }, { bridge });
    assert.deepEqual(bridge.calls[0], ["ax", "find", "--role", "AXButton"]);
  });

  test("returns null when helper reports `{match: 'none'}`", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify({ match: "none" }));
    const out = await findElement({ role: "AXButton" }, { bridge });
    assert.equal(out, null);
  });

  test("rejects when JSON is malformed", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push("not-json");
    await assert.rejects(
      () => findElement({ role: "AXButton" }, { bridge }),
      AccessibilityError,
    );
  });

  test("rejects when element shape is wrong", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify({ role: "AXButton" })); // missing label/bbox/pid
    await assert.rejects(
      () => findElement({ role: "AXButton" }, { bridge }),
      AccessibilityError,
    );
  });

  test("rejects empty role", async () => {
    const bridge = new FakeBridge();
    await assert.rejects(
      () => findElement({ role: "" }, { bridge }),
      AccessibilityError,
    );
    assert.equal(bridge.calls.length, 0);
  });
});

// ───────────────── findAll ──────────────────────────────────────────────

describe("findAll", () => {
  test("shells `ax findAll --role <role>` and returns matches array", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(
      JSON.stringify({ matches: [MOCK_ELEMENT, { ...MOCK_ELEMENT, pid: 43 }] }),
    );
    const out = await findAll({ role: "AXButton" }, { bridge });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.pid, 42);
    assert.equal(out[1]!.pid, 43);
    assert.deepEqual(bridge.calls[0], ["ax", "findAll", "--role", "AXButton"]);
  });

  test("returns [] on empty matches", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify({ matches: [] }));
    const out = await findAll({ role: "AXButton" }, { bridge });
    assert.deepEqual(out, []);
  });

  test("passes --app when provided", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify({ matches: [] }));
    await findAll({ role: "AXButton", app: "com.apple.Safari" }, { bridge });
    assert.deepEqual(bridge.calls[0]!.slice(-2), ["--app", "com.apple.Safari"]);
  });

  test("rejects when `matches` is not an array", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify({ matches: "oops" }));
    await assert.rejects(
      () => findAll({ role: "AXButton" }, { bridge }),
      AccessibilityError,
    );
  });

  test("rejects when a match is malformed", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(JSON.stringify({ matches: [{ role: "AXButton" }] }));
    await assert.rejects(
      () => findAll({ role: "AXButton" }, { bridge }),
      AccessibilityError,
    );
  });
});
