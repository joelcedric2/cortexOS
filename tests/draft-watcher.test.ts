/**
 * Unit tests for DraftWatcher — the TypeScript side of Phase 13 (writing
 * coach). The Swift bridge is stubbed via {@link FakeBridge}, which records
 * spawn calls and lets tests push NDJSON lines or simulate an exit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DraftWatcher,
  type DraftSample,
  type NativeBridge,
  type NativeBridgeHandle,
} from "../src/coach/draft-watcher.js";

interface FakeHandle extends NativeBridgeHandle {
  bundleId: string;
  pushLine(line: string): void;
  fireExit(code: number | null): void;
  killed: boolean;
}

class FakeBridge implements NativeBridge {
  public handles: FakeHandle[] = [];
  public throwNext = false;

  spawn(bundleId: string): NativeBridgeHandle {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("binary missing");
    }
    let lineFn: ((line: string) => void) | null = null;
    let exitFn: ((c: number | null) => void) | null = null;
    const h: FakeHandle = {
      bundleId,
      killed: false,
      kill() { this.killed = true; },
      onLine(fn) { lineFn = fn; },
      onExit(fn) { exitFn = fn; },
      pushLine(line: string) { lineFn?.(line); },
      fireExit(code: number | null) { exitFn?.(code); },
    };
    this.handles.push(h);
    return h;
  }
  latest(): FakeHandle {
    return this.handles[this.handles.length - 1]!;
  }
}

function sampleLine(overrides: Partial<DraftSample> = {}): string {
  return JSON.stringify({
    app: "com.apple.mail",
    role: "AXTextArea",
    label: "Body",
    value: "Hi Mark, sorry to bother",
    ts: "2026-04-15T10:00:00.000Z",
    ...overrides,
  });
}

describe("DraftWatcher", () => {
  it("stays idle when the allow-list is empty (default OFF)", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({ bridge, appsAllowList: [] });
    await watcher.start();

    assert.equal(bridge.handles.length, 0);
    assert.equal(watcher.isRunning(), false);
  });

  it("spawns one child per allow-listed app and delivers samples", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({
      bridge,
      appsAllowList: ["com.apple.mail", "com.tinyspeck.slackmacgap"],
      throttleMs: 10,
    });

    const received: DraftSample[] = [];
    watcher.onSample((s) => received.push(s));
    await watcher.start();

    assert.equal(bridge.handles.length, 2);
    assert.equal(bridge.handles[0]?.bundleId, "com.apple.mail");
    assert.equal(bridge.handles[1]?.bundleId, "com.tinyspeck.slackmacgap");

    bridge.handles[0]?.pushLine(sampleLine());
    assert.equal(received.length, 1);
    assert.equal(received[0]?.app, "com.apple.mail");
    assert.equal(received[0]?.value, "Hi Mark, sorry to bother");

    watcher.stop();
  });

  it("enforces a per-key throttle even if the bridge floods samples", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({
      bridge,
      appsAllowList: ["com.apple.mail"],
      throttleMs: 60_000,
    });
    const received: DraftSample[] = [];
    watcher.onSample((s) => received.push(s));
    await watcher.start();

    // Same key → only first passes.
    bridge.latest().pushLine(sampleLine({ value: "A" }));
    bridge.latest().pushLine(sampleLine({ value: "A" }));
    bridge.latest().pushLine(sampleLine({ value: "A" }));
    assert.equal(received.length, 1);

    // Different value → passes.
    bridge.latest().pushLine(sampleLine({ value: "B" }));
    assert.equal(received.length, 2);

    watcher.stop();
  });

  it("gracefully drops malformed NDJSON", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({
      bridge,
      appsAllowList: ["com.apple.mail"],
      throttleMs: 10,
    });
    const received: DraftSample[] = [];
    watcher.onSample((s) => received.push(s));
    await watcher.start();

    bridge.latest().pushLine("not json");
    bridge.latest().pushLine(JSON.stringify({ app: "x" })); // missing fields
    bridge.latest().pushLine(sampleLine());

    assert.equal(received.length, 1);
    watcher.stop();
  });

  it("reconnects with exponential backoff on Swift child crash", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({
      bridge,
      appsAllowList: ["com.apple.mail"],
      throttleMs: 10,
      initialBackoffMs: 5,
      maxBackoffMs: 40,
    });
    await watcher.start();
    assert.equal(bridge.handles.length, 1);

    // Simulate crash.
    bridge.latest().fireExit(137);

    // Wait slightly longer than the initial backoff.
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bridge.handles.length >= 2, `expected reconnect (got ${bridge.handles.length})`);

    watcher.stop();
  });

  it("does not reconnect after stop()", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({
      bridge,
      appsAllowList: ["com.apple.mail"],
      throttleMs: 10,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
    });
    await watcher.start();
    const initial = bridge.handles.length;
    watcher.stop();
    bridge.latest().fireExit(0);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(bridge.handles.length, initial);
  });

  it("app allowlist gating: only spawns for listed bundles", async () => {
    const bridge = new FakeBridge();
    const watcher = new DraftWatcher({
      bridge,
      appsAllowList: ["com.apple.MobileSMS"],
      throttleMs: 10,
    });
    await watcher.start();
    assert.equal(bridge.handles.length, 1);
    assert.equal(bridge.handles[0]?.bundleId, "com.apple.MobileSMS");
    watcher.stop();
  });
});
