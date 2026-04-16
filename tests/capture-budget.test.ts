/**
 * Phase 8.5 tests — daily disk-byte budget gate on ScreenCapturer.
 *
 * We inject a stub `ScreenMemoriesStore` whose `bytesInWindow` reports more
 * than the configured budget. The next capture must:
 *   1. Not insert into the DB.
 *   2. Emit an `error` event on the bus with `where: 'capture.budget'`.
 *   3. Surface a Pending Surface observation.
 *   4. Return `{ok:false, reason:'budget-exceeded'}`.
 *
 * And — crucially — the prior frame must go through normally when the store
 * is below budget. Never a silent drop.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPTURE_DEFAULTS,
  ScreenCapturer,
  type PendingSurface,
} from "../src/perception/screen-capture.js";
import type { EventBus, AgentEvent } from "../src/ipc/event-bus.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type {
  ScreenMemoryInput,
  ScreenMemoryRow,
  ScreenMemoriesStore,
} from "../src/perception/screen-memories-db.js";
import type {
  NativeCaptureResult,
  NativeOcrResult,
  VisionBridge,
} from "../src/perception/native-bridge.js";
import type { PhashDecoder } from "../src/perception/phash.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeBridge(): VisionBridge {
  return {
    async isAvailable() { return true; },
    async capture(opts) {
      if (opts?.outPath) await writeFile(opts.outPath, "PNG-STUB");
      return {
        width: 1920,
        height: 1080,
        active_app: "Ghostty",
        active_bundle: "com.mitchellh.ghostty",
        window_title: "~/Documents/Github/cortexOS",
        png_path: opts?.outPath ?? "",
        ts: Date.now(),
      } satisfies NativeCaptureResult;
    },
    async ocr(): Promise<NativeOcrResult> {
      return { blocks: [], text: "", duration_ms: 0 };
    },
  };
}

function uniqDecoder(): PhashDecoder {
  let seed = 1;
  return {
    async decodeGray8x8() {
      const b = new Uint8Array(64);
      for (let i = 0; i < 64; i++) b[i] = (i * 17 + seed * 53) % 256;
      seed += 1;
      return b;
    },
  };
}

interface FakeStoreState {
  bytes: number;
  inserts: ScreenMemoryInput[];
}

function fakeStore(state: FakeStoreState): ScreenMemoriesStore {
  return {
    bytesInWindow() {
      return state.bytes;
    },
    insert(row) {
      state.inserts.push(row);
      const stored: ScreenMemoryRow = {
        id: row.id,
        captured_at: row.captured_at.toISOString(),
        webp_path: row.webp_path,
        phash: typeof row.phash === "bigint" ? row.phash : BigInt(row.phash),
        active_app: row.active_app,
        window_title: row.window_title,
        ocr_text_zstd: row.ocr_text_zstd,
        label: row.label,
        embedding: row.embedding,
        task_id: row.task_id,
        session_id: row.session_id,
        bytes: row.bytes ?? 0,
      };
      return stored;
    },
  };
}

function collectingSurface(): PendingSurface & { items: unknown[] } {
  const items: unknown[] = [];
  return {
    items,
    add(obs) {
      items.push(obs);
    },
  };
}

function collectingBus(): {
  bus: EventBus;
  events: AgentEvent[];
  unsubscribe(): void;
} {
  const bus = createEventBus();
  const events: AgentEvent[] = [];
  const unsubscribe = bus.subscribe({}, (e) => events.push(e));
  return { bus, events, unsubscribe };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ScreenCapturer — daily byte-budget gate", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "cortexos-budget-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  test("refuses capture when bytesInWindow >= budget; emits error + pending", async () => {
    const state: FakeStoreState = { bytes: 401_000_000, inserts: [] };
    const { bus, events, unsubscribe } = collectingBus();
    const surface = collectingSurface();

    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      phashDecoder: uniqDecoder(),
      db: fakeStore(state),
      bus,
      pendingSurface: surface,
      // Use the default 400 MB budget — 401 MB should trip it.
    });

    const result = await cap.captureNow();
    unsubscribe();

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "budget-exceeded");
      if (result.reason === "budget-exceeded") {
        assert.equal(result.bytesInWindow, 401_000_000);
        assert.equal(result.budget, CAPTURE_DEFAULTS.CAPTURE_BUDGET_DAILY_BYTES);
      }
    }

    // Did NOT insert into the store.
    assert.equal(state.inserts.length, 0);

    // Exactly one error event with the expected shape.
    const budgetEvents = events.filter(
      (e) =>
        e.kind === "error" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        (e.payload as { where?: unknown }).where === "capture.budget",
    );
    assert.equal(budgetEvents.length, 1, "one budget-error event expected");
    const payload = budgetEvents[0]!.payload as {
      bytes_in_window: number;
      budget: number;
    };
    assert.equal(payload.bytes_in_window, 401_000_000);
    assert.equal(payload.budget, CAPTURE_DEFAULTS.CAPTURE_BUDGET_DAILY_BYTES);

    // Pending Surface was notified.
    assert.equal(surface.items.length, 1);
  });

  test("allows capture when store is under budget", async () => {
    const state: FakeStoreState = { bytes: 10_000_000, inserts: [] };
    const { bus, unsubscribe } = collectingBus();
    const surface = collectingSurface();

    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      phashDecoder: uniqDecoder(),
      db: fakeStore(state),
      bus,
      pendingSurface: surface,
    });

    const result = await cap.captureNow();
    unsubscribe();

    assert.equal(result.ok, true);
    assert.equal(state.inserts.length, 1, "under-budget capture must insert");
    assert.equal(surface.items.length, 0, "no pending surface under budget");
  });

  test("custom budget takes precedence over the default", async () => {
    const state: FakeStoreState = { bytes: 50_000_000, inserts: [] };
    const { bus, events, unsubscribe } = collectingBus();

    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      phashDecoder: uniqDecoder(),
      db: fakeStore(state),
      bus,
      captureBudgetDailyBytes: 40_000_000, // 40 MB — 50 MB already used
    });

    const result = await cap.captureNow();
    unsubscribe();

    assert.equal(result.ok, false);
    if (!result.ok && result.reason === "budget-exceeded") {
      assert.equal(result.budget, 40_000_000);
    }
    const budgetEvents = events.filter(
      (e) =>
        e.kind === "error" &&
        (e.payload as { where?: unknown } | null)?.where === "capture.budget",
    );
    assert.equal(budgetEvents.length, 1);
  });

  test("budget gate works without pendingSurface (graceful no-op)", async () => {
    const state: FakeStoreState = { bytes: 999_000_000, inserts: [] };
    const { bus, events, unsubscribe } = collectingBus();

    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      phashDecoder: uniqDecoder(),
      db: fakeStore(state),
      bus,
      // no pendingSurface
    });

    const result = await cap.captureNow();
    unsubscribe();

    assert.equal(result.ok, false);
    const budgetEvents = events.filter(
      (e) =>
        e.kind === "error" &&
        (e.payload as { where?: unknown } | null)?.where === "capture.budget",
    );
    assert.equal(budgetEvents.length, 1, "bus event still fires without surface");
  });

  test("no db → no budget check (back-compat path)", async () => {
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      phashDecoder: uniqDecoder(),
    });
    const result = await cap.captureNow();
    assert.equal(result.ok, true);
  });
});
