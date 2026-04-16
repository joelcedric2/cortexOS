/**
 * Phase 8.5 — perception-wide audit wiring smoke tests.
 *
 * Verifies:
 *   1. ScreenCapturer.captureNow() appends a `capture` line when audit wired
 *   2. A private-app tick appends `skip=private_app bundle=...`
 *   3. A bridge error during tick appends a redacted error label
 *   4. No audit is appended when no AuditLog is injected (silent path works)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ScreenCapturer,
  ephemeralStorageDir,
  type CaptureScheduler,
} from "../src/perception/screen-capture.js";
import { AuditLog } from "../src/proactivity/audit.js";
import type { VisionBridge } from "../src/perception/native-bridge.js";

function manualScheduler(): CaptureScheduler & { tick: () => Promise<void> } {
  let cb: (() => Promise<void> | void) | null = null;
  return {
    start(_intervalMs, tick) {
      cb = tick;
    },
    stop() {
      cb = null;
    },
    async tick() {
      if (cb) await cb();
    },
  };
}

function fakeBridge(overrides: Partial<VisionBridge> = {}): VisionBridge {
  return {
    async capture({ outPath }) {
      return {
        out_path: outPath,
        ts: Date.now(),
        active_app: "TestApp",
        active_bundle: "com.example.test",
        window_title: "t",
        width: 1,
        height: 1,
      };
    },
    async ocr() {
      return { text: "", blocks: [], duration_ms: 0 };
    },
    async probe() {
      return { ok: true };
    },
    ...overrides,
  };
}

function readLines(path: string): Array<{ action: string; detail: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { action: string; detail: string });
}

describe("ScreenCapturer audit wiring", () => {
  let tmpDir: string;
  let auditPath: string;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-cap-audit-"));
    auditPath = join(tmpDir, "audit.ndjson");
    audit = new AuditLog(auditPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captureNow() appends one capture line with active app", async () => {
    const cap = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler: manualScheduler(),
      storageDir: ephemeralStorageDir(),
      audit,
    });
    await cap.captureNow();

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "capture");
    assert.equal(lines[0].detail, "app=TestApp");
  });

  it("private-app tick appends skip=private_app", async () => {
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      bridge: fakeBridge({
        async capture({ outPath }) {
          return {
            out_path: outPath,
            ts: Date.now(),
            active_app: "1Password",
            active_bundle: "com.agilebits.onepassword7",
            window_title: "Vault",
            width: 1,
            height: 1,
          };
        },
      }),
      scheduler,
      storageDir: ephemeralStorageDir(),
      audit,
    });
    await cap.start();
    await scheduler.tick();

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "capture");
    assert.match(lines[0].detail, /skip=private_app/);
    assert.match(lines[0].detail, /bundle=com\.agilebits\.onepassword7/);
  });

  it("bridge error during tick appends redacted error label", async () => {
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      bridge: fakeBridge({
        async capture() {
          throw new Error("network ECONNREFUSED 127.0.0.1:443");
        },
      }),
      scheduler,
      storageDir: ephemeralStorageDir(),
      audit,
    });
    await cap.start();
    await scheduler.tick();

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "capture");
    // Raw error text (with IP + port) must be redacted to a label.
    assert.match(lines[0].detail, /error=/);
    assert.ok(!lines[0].detail.includes("127.0.0.1"));
  });

  it("no AuditLog injected → no append, capture still succeeds", async () => {
    const cap = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler: manualScheduler(),
      storageDir: ephemeralStorageDir(),
      // audit omitted
    });
    await cap.captureNow();
    // Nothing to assert beyond "did not throw".
    assert.ok(true);
  });
});
