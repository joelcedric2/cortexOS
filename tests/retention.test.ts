/**
 * Tests for the Phase 8.5 retention downgrader.
 *
 * Uses in-memory SQLite + tmp-dir WebP stand-ins so the harness is fully
 * hermetic. Clock is injected via `opts.now`.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";
import {
  runRetention,
  DEFAULT_RETENTION_DAYS,
} from "../src/perception/retention.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date(Date.parse("2026-04-15T00:00:00Z"));
const NOW = () => BASE;

function int8Vec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-128, Math.min(127, Math.trunc(values[i]!)));
    buf[i] = v < 0 ? v + 256 : v;
  }
  return buf;
}

function makeInput(overrides: Partial<ScreenMemoryInput> = {}): ScreenMemoryInput {
  const defaults: ScreenMemoryInput = {
    id: "sm-x",
    captured_at: BASE,
    webp_path: null,
    phash: 0n,
    active_app: null,
    window_title: null,
    ocr_text_zstd: null,
    label: null,
    embedding: int8Vec([1, 0, 0]),
    task_id: null,
    session_id: null,
    bytes: 0,
  };
  return { ...defaults, ...overrides };
}

async function touch(path: string, contents = "webp"): Promise<void> {
  await writeFile(path, contents);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("runRetention", () => {
  let db: ScreenMemoriesDB;
  let tmp: string;

  beforeEach(async () => {
    db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    tmp = await mkdtemp(join(tmpdir(), "retention-"));
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  test("downgrades only rows older than retentionDays with a webp_path", async () => {
    // 5 older than 7 days (should downgrade), 5 newer (untouched).
    const older: string[] = [];
    const newer: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(tmp, `old-${i}.webp`);
      await touch(p, "x".repeat(10));
      older.push(p);
      db.insert(
        makeInput({
          id: `old-${i}`,
          captured_at: new Date(BASE.getTime() - (10 + i) * DAY),
          webp_path: p,
          bytes: 100 + i, // 100+101+102+103+104 = 510
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      const p = join(tmp, `new-${i}.webp`);
      await touch(p, "y".repeat(20));
      newer.push(p);
      db.insert(
        makeInput({
          id: `new-${i}`,
          captured_at: new Date(BASE.getTime() - i * DAY),
          webp_path: p,
          bytes: 200 + i,
        }),
      );
    }

    const report = await runRetention({ db }, { now: NOW });

    assert.equal(report.scanned, 5);
    assert.equal(report.downgraded, 5);
    assert.equal(report.bytesReclaimed, 100 + 101 + 102 + 103 + 104);
    assert.deepEqual(report.errors, []);
    assert.equal(report.ts, BASE.toISOString());
    assert.ok(report.duration_ms >= 0);

    // Older rows: webp_path NULL, file gone, bytes 0.
    for (let i = 0; i < 5; i++) {
      const row = db.get(`old-${i}`);
      assert.ok(row);
      assert.equal(row!.webp_path, null);
      assert.equal(row!.bytes, 0);
      assert.equal(await pathExists(older[i]!), false);
    }
    // Newer rows: untouched.
    for (let i = 0; i < 5; i++) {
      const row = db.get(`new-${i}`);
      assert.ok(row);
      assert.equal(row!.webp_path, newer[i]);
      assert.equal(row!.bytes, 200 + i);
      assert.equal(await pathExists(newer[i]!), true);
    }
  });

  test("idempotent — second run reports 0 downgraded", async () => {
    for (let i = 0; i < 3; i++) {
      const p = join(tmp, `idem-${i}.webp`);
      await touch(p);
      db.insert(
        makeInput({
          id: `idem-${i}`,
          captured_at: new Date(BASE.getTime() - 10 * DAY),
          webp_path: p,
          bytes: 50,
        }),
      );
    }
    const first = await runRetention({ db }, { now: NOW });
    assert.equal(first.downgraded, 3);
    assert.equal(first.bytesReclaimed, 150);

    const second = await runRetention({ db }, { now: NOW });
    assert.equal(second.scanned, 0);
    assert.equal(second.downgraded, 0);
    assert.equal(second.bytesReclaimed, 0);
    assert.deepEqual(second.errors, []);
  });

  test("ENOENT on file is not an error — row still downgraded", async () => {
    // webp_path references a file that never existed on disk.
    const ghostPath = join(tmp, "ghost.webp");
    db.insert(
      makeInput({
        id: "ghost",
        captured_at: new Date(BASE.getTime() - 10 * DAY),
        webp_path: ghostPath,
        bytes: 77,
      }),
    );
    const report = await runRetention({ db }, { now: NOW });
    assert.equal(report.downgraded, 1);
    assert.equal(report.bytesReclaimed, 77);
    assert.deepEqual(report.errors, []);
    const row = db.get("ghost");
    assert.equal(row!.webp_path, null);
  });

  test("per-row error is captured and loop continues", async () => {
    // Row A: real file — should downgrade fine.
    const ok = join(tmp, "ok.webp");
    await touch(ok);
    db.insert(
      makeInput({
        id: "ok",
        captured_at: new Date(BASE.getTime() - 10 * DAY),
        webp_path: ok,
        bytes: 10,
      }),
    );
    // Row B: webp_path is a DIRECTORY — unlink will throw EPERM/EISDIR
    // on most platforms. Captured as an error; row NOT downgraded.
    const dirPath = join(tmp, "not-a-file");
    await (await import("node:fs/promises")).mkdir(dirPath);
    db.insert(
      makeInput({
        id: "dir",
        captured_at: new Date(BASE.getTime() - 10 * DAY),
        webp_path: dirPath,
        bytes: 99,
      }),
    );
    // Row C: another real file — should also downgrade.
    const ok2 = join(tmp, "ok2.webp");
    await touch(ok2);
    db.insert(
      makeInput({
        id: "ok2",
        captured_at: new Date(BASE.getTime() - 10 * DAY),
        webp_path: ok2,
        bytes: 20,
      }),
    );

    const report = await runRetention({ db }, { now: NOW });
    assert.equal(report.scanned, 3);
    assert.equal(report.downgraded, 2);
    assert.equal(report.bytesReclaimed, 30);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]!.id, "dir");
    assert.ok(report.errors[0]!.error.length > 0);
    // The dir row still has its webp_path — retention didn't claim it.
    assert.equal(db.get("dir")!.webp_path, dirPath);
    // The ok rows were downgraded.
    assert.equal(db.get("ok")!.webp_path, null);
    assert.equal(db.get("ok2")!.webp_path, null);
  });

  test("dryRun leaves files + DB untouched but still scans + reports", async () => {
    const p = join(tmp, "dry.webp");
    await touch(p);
    db.insert(
      makeInput({
        id: "dry",
        captured_at: new Date(BASE.getTime() - 10 * DAY),
        webp_path: p,
        bytes: 42,
      }),
    );
    const report = await runRetention({ db }, { now: NOW, dryRun: true });
    assert.equal(report.scanned, 1);
    assert.equal(report.downgraded, 1);
    assert.equal(report.bytesReclaimed, 42);
    // File still on disk, row still has its path.
    assert.equal(await pathExists(p), true);
    assert.equal(db.get("dry")!.webp_path, p);
  });

  test("retentionDays override supersedes the 7-day default", async () => {
    const p = join(tmp, "three.webp");
    await touch(p);
    db.insert(
      makeInput({
        id: "three",
        captured_at: new Date(BASE.getTime() - 4 * DAY),
        webp_path: p,
        bytes: 7,
      }),
    );
    // Default (7) would NOT downgrade a 4-day-old row.
    const skipped = await runRetention({ db }, { now: NOW });
    assert.equal(skipped.downgraded, 0);
    assert.equal(await pathExists(p), true);

    // Override to 3 days — now it should downgrade.
    const caught = await runRetention({ db }, { now: NOW, retentionDays: 3 });
    assert.equal(caught.downgraded, 1);
    assert.equal(caught.bytesReclaimed, 7);
    assert.equal(await pathExists(p), false);
  });

  test("DoD: seed 10 rows at day 0, advance to day 8, runRetention downgrades 10", async () => {
    const day0 = new Date(Date.parse("2026-04-01T00:00:00Z"));
    const day8 = new Date(day0.getTime() + 8 * DAY);
    const paths: string[] = [];
    let totalBytes = 0;
    for (let i = 0; i < 10; i++) {
      const p = join(tmp, `dod-${i}.webp`);
      await touch(p, "z".repeat(8));
      paths.push(p);
      const b = 1024 * (i + 1);
      totalBytes += b;
      db.insert(
        makeInput({
          id: `dod-${i}`,
          captured_at: day0,
          webp_path: p,
          bytes: b,
        }),
      );
    }
    const report = await runRetention({ db }, { now: () => day8 });
    assert.equal(report.scanned, 10);
    assert.equal(report.downgraded, 10);
    assert.equal(report.bytesReclaimed, totalBytes);
    for (const p of paths) assert.equal(await pathExists(p), false);
  });

  test("rejects negative retentionDays", async () => {
    await assert.rejects(
      () => runRetention({ db }, { retentionDays: -1 }),
      /retentionDays must be a non-negative finite number/,
    );
  });

  test("DEFAULT_RETENTION_DAYS exports 7 (policy default, not a magic number)", () => {
    assert.equal(DEFAULT_RETENTION_DAYS, 7);
  });
});
