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
  type ScreenFrame,
} from "../src/perception/screen-capture.js";
import { AuditLog } from "../src/proactivity/audit.js";
import type { VisionBridge } from "../src/perception/native-bridge.js";
import { ocrImageAudited } from "../src/perception/ocr-audit.js";
import { buildBrief } from "../src/perception/vision-brief.js";
import { writeFileSync } from "node:fs";

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

describe("ocrImageAudited wrapper", () => {
  let tmpDir: string;
  let auditPath: string;
  let audit: AuditLog;
  let pngPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-ocr-audit-"));
    auditPath = join(tmpDir, "audit.ndjson");
    audit = new AuditLog(auditPath);
    pngPath = join(tmpDir, "dummy.png");
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // png magic
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends an ocr line on success", async () => {
    const fakeBridge = {
      async capture() {
        throw new Error("not used");
      },
      async ocr() {
        return {
          text: "hello world",
          blocks: [],
          duration_ms: 12,
        };
      },
      async probe() {
        return { ok: true };
      },
    };
    const r = await ocrImageAudited(pngPath, {
      bridge: fakeBridge,
      audit,
      source: "unit-test",
    });
    assert.equal(r.text, "hello world");

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "ocr");
    assert.match(lines[0].detail, /bytes=4/);
    assert.match(lines[0].detail, /outcome=ok/);
    assert.match(lines[0].detail, /source=unit-test/);
    assert.match(lines[0].detail, /duration_ms=12/);
  });

  it("appends an ocr error line on failure and re-throws", async () => {
    const fakeBridge = {
      async capture() {
        throw new Error("not used");
      },
      async ocr() {
        throw new Error("ocr boom");
      },
      async probe() {
        return { ok: true };
      },
    };

    await assert.rejects(
      () => ocrImageAudited(pngPath, { bridge: fakeBridge, audit }),
      /ocr boom/,
    );

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "ocr");
    assert.match(lines[0].detail, /outcome=error/);
  });

  it("does not append when audit is not provided", async () => {
    const fakeBridge = {
      async capture() {
        throw new Error("not used");
      },
      async ocr() {
        return { text: "", blocks: [], duration_ms: 0 };
      },
      async probe() {
        return { ok: true };
      },
    };
    await ocrImageAudited(pngPath, { bridge: fakeBridge });
    // no audit log was constructed — nothing to check beyond "didn't throw"
    assert.ok(true);
  });
});

describe("vision-brief audit plumbing", () => {
  let tmpDir: string;
  let auditPath: string;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-vbrief-"));
    auditPath = join(tmpDir, "audit.ndjson");
    audit = new AuditLog(auditPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function frame(): ScreenFrame {
    return {
      id: "frame-1",
      ts: new Date("2026-04-15T10:00:00Z"),
      png_path: "/tmp/does-not-matter.png",
      active_app: "Safari",
      window_title: "Example",
      ocr_text: "hello world",
      width: 1,
      height: 1,
    };
  }

  it("appends vision_llm line when LLM path fires successfully", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "User is browsing example.com.",
                sentiment: "consuming",
              }),
            },
          ],
        }),
        { status: 200 },
      );

    const brief = await buildBrief(
      frame(),
      { ocr: async () => ({ text: "hello", blocks: [], duration_ms: 0 }) },
      {
        mode: "llm",
        apiKey: "test-key",
        fetchImpl: fakeFetch,
        audit,
      },
    );
    assert.equal(brief.sentiment, "consuming");

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "vision_llm");
    assert.match(lines[0].detail, /model=sonnet/);
    assert.match(lines[0].detail, /outcome=ok/);
  });

  it("appends vision_llm error line on LLM failure", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("boom", { status: 500 });

    await buildBrief(
      frame(),
      { ocr: async () => ({ text: "hello", blocks: [], duration_ms: 0 }) },
      {
        mode: "llm",
        apiKey: "test-key",
        fetchImpl: fakeFetch,
        audit,
      },
    );

    const lines = readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "vision_llm");
    assert.match(lines[0].detail, /outcome=error/);
    assert.match(lines[0].detail, /reason=server-error/);
  });

  it("no audit append in local-only mode", async () => {
    await buildBrief(frame(), {}, { mode: "local-only", audit });
    const lines = readLines(auditPath);
    assert.equal(lines.length, 0);
  });
});
