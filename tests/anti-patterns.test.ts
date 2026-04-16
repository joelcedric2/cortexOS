/**
 * Phase 7 — Anti-pattern clustering tests.
 *
 * Scripted fixture rows drive LoopAttemptLog + SkillUsageLedger on in-memory
 * SQLite, then we assert the cluster shape, memory-sink writes, and
 * signature normalization. No real pgvector required — we pass a stub sink.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LoopAttemptLog } from "../src/loop/loop-attempts-db.js";
import { SkillUsageLedger } from "../src/skills/usage-ledger.js";
import {
  detectAntiPatterns,
  parseErrorClass,
  canonicalSignature,
  type AntiPatternMemorySink,
  type AntiPatternEmbedder,
} from "../src/analytics/anti-patterns.js";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

interface CapturedWrite {
  agentRole: string;
  taskType: string;
  content: string;
  tags: string[];
}

function stubSink(): { sink: AntiPatternMemorySink; writes: CapturedWrite[] } {
  const writes: CapturedWrite[] = [];
  const sink: AntiPatternMemorySink = {
    async storeMemory(record) {
      writes.push({
        agentRole: record.agentRole,
        taskType: record.taskType,
        content: record.content,
        tags: record.tags,
      });
      return `mem-${writes.length}`;
    },
  };
  return { sink, writes };
}

const fakeEmbedder: AntiPatternEmbedder = {
  async embed() {
    // 384-dim zero vector. Content is irrelevant because the stub sink is
    // not actually doing nearest-neighbour; it just records the write.
    return new Array(384).fill(0);
  },
};

function iso(offsetMinutes: number): string {
  return new Date(Date.now() - offsetMinutes * 60_000).toISOString();
}

function seedLoopFailures(
  log: LoopAttemptLog,
  opts: { taskId: string; count: number; error: string; strategy: string; minutesAgo?: number },
): void {
  const baseMinutes = opts.minutesAgo ?? 5;
  for (let i = 0; i < opts.count; i++) {
    const t = new Date(Date.now() - (baseMinutes + i) * 60_000);
    log.record({
      taskId: opts.taskId,
      attempt: i + 1,
      state: "ATTEMPT",
      strategy: opts.strategy,
      error: opts.error,
      startedAt: t,
      endedAt: t,
    });
  }
}

describe("parseErrorClass", () => {
  test("extracts known classes in regex-order (first-match wins)", () => {
    assert.equal(parseErrorClass("TIMEOUT talking to github.com"), "TIMEOUT");
    assert.equal(parseErrorClass("NETWORK unreachable"), "NETWORK");
    assert.equal(parseErrorClass("AUTH failed"), "AUTH");
    assert.equal(parseErrorClass("PARSE error in JSON"), "PARSE");
    assert.equal(parseErrorClass("HTTP 503 upstream"), "503");
    assert.equal(parseErrorClass("HTTP 404 not reachable"), "404");
    assert.equal(parseErrorClass(""), "UNKNOWN");
    assert.equal(parseErrorClass(null), "UNKNOWN");
    assert.equal(parseErrorClass("something weird"), "UNKNOWN");
    // First match wins — the numeric status beats the word in this ordering.
    assert.equal(parseErrorClass("401 AUTH failed"), "401");
  });

  test("is case-insensitive but normalizes to uppercase", () => {
    assert.equal(parseErrorClass("network unreachable"), "NETWORK");
    assert.equal(parseErrorClass("Timeout hit"), "TIMEOUT");
  });
});

describe("canonicalSignature", () => {
  test("formats as <source>:<class>:<discriminator>", () => {
    const sig = canonicalSignature({
      source: "loop_attempts",
      errorClass: "NETWORK",
      discriminator: "retry_same",
      errorMsg: "ETIMEDOUT",
      timestamp: "2026-04-15T10:00:00.000Z",
    });
    assert.equal(sig, "loop_attempts:NETWORK:retry_same");
  });

  test("falls back to 'unknown' when discriminator is empty", () => {
    const sig = canonicalSignature({
      source: "skill_runs",
      errorClass: "TIMEOUT",
      discriminator: "",
      errorMsg: "",
      timestamp: "2026-04-15T10:00:00.000Z",
    });
    assert.equal(sig, "skill_runs:TIMEOUT:unknown");
  });
});

describe("detectAntiPatterns", () => {
  let tmpDir: string;
  let attemptsLog: LoopAttemptLog;
  let ledger: SkillUsageLedger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "anti-patterns-"));
    // Two separate in-memory DBs — shape-compatible with production where
    // both tables live in ~/.cortexos/registry.db.
    attemptsLog = new LoopAttemptLog({ dbPath: join(tmpDir, "loop.db") });
    ledger = new SkillUsageLedger({ dbPath: join(tmpDir, "skill.db") });
  });

  afterEach(() => {
    attemptsLog.close();
    ledger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("clusters 3 network timeouts into a single auto-flagged cluster", async () => {
    seedLoopFailures(attemptsLog, {
      taskId: "task-net",
      count: 3,
      error: "TIMEOUT fetching github.com",
      strategy: "retry_same",
    });

    const { sink, writes } = stubSink();
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      { windowDays: 7, flagThreshold: 3 },
    );

    assert.equal(report.totalFailures, 3);
    assert.equal(report.clusters.length, 1);
    const [c] = report.clusters;
    assert.equal(c.hitCount, 3);
    assert.equal(c.signature, "loop_attempts:TIMEOUT:retry_same");
    assert.equal(c.autoFlagged, true);
    assert.deepEqual(c.sources, ["loop_attempts"]);
    assert.equal(c.samples.length, 3);
    assert.equal(report.newClustersSinceLastRun, 1);

    // Memory write went through with the required tag.
    assert.equal(writes.length, 1);
    assert.ok(writes[0].tags.includes("anti-pattern:avoid"));
    assert.ok(writes[0].tags.includes("loop_attempts:TIMEOUT:retry_same"));
    assert.equal(writes[0].taskType, "anti_pattern");
  });

  test("does not auto-flag a cluster below threshold", async () => {
    seedLoopFailures(attemptsLog, {
      taskId: "task-small",
      count: 2,
      error: "PARSE error bad JSON",
      strategy: "reduce_scope",
    });

    const { sink, writes } = stubSink();
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      { flagThreshold: 3 },
    );

    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].autoFlagged, false);
    assert.equal(report.newClustersSinceLastRun, 0);
    assert.equal(writes.length, 0);
  });

  test("merges failures across loop_attempts and skill_runs into separate clusters", async () => {
    seedLoopFailures(attemptsLog, {
      taskId: "task-auth",
      count: 3,
      error: "AUTH rejected for github token",
      strategy: "retry_same",
    });
    for (let i = 0; i < 4; i++) {
      ledger.record({
        skill_name: "docs-fetch",
        input_hash: `hash-${i}`,
        outcome: "fail",
        latency_ms: 100,
        error_msg: "HTTP 503 upstream",
      });
    }

    const { sink, writes } = stubSink();
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      { flagThreshold: 3 },
    );

    // 2 signatures: one per source.
    assert.equal(report.clusters.length, 2);
    const sigs = report.clusters.map((c) => c.signature).sort();
    assert.deepEqual(sigs, [
      "loop_attempts:AUTH:retry_same",
      "skill_runs:503:docs-fetch",
    ]);
    // Most hits first.
    assert.equal(report.clusters[0].signature, "skill_runs:503:docs-fetch");
    assert.equal(report.clusters[0].hitCount, 4);
    // Both auto-flagged → 2 memory writes.
    assert.equal(writes.length, 2);
  });

  test("respects knownSignatures to suppress double-writes", async () => {
    seedLoopFailures(attemptsLog, {
      taskId: "task-net",
      count: 3,
      error: "NETWORK unreachable",
      strategy: "retry_same",
    });

    const { sink, writes } = stubSink();
    const known = new Set<string>(["loop_attempts:NETWORK:retry_same"]);
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      { flagThreshold: 3, knownSignatures: known },
    );

    assert.equal(report.clusters[0].autoFlagged, true);
    assert.equal(report.newClustersSinceLastRun, 0);
    assert.equal(writes.length, 0);
  });

  test("prefers explicit error_class on skill_runs over regex extraction", async () => {
    for (let i = 0; i < 3; i++) {
      ledger.record({
        skill_name: "summarize",
        input_hash: `h-${i}`,
        outcome: "fail",
        latency_ms: 10,
        error_msg: "something went sideways", // regex would return UNKNOWN
        error_class: "PROVIDER_DOWN",
      });
    }

    const { sink } = stubSink();
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      { flagThreshold: 3 },
    );

    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].signature, "skill_runs:PROVIDER_DOWN:summarize");
  });

  test("returns zero clusters when there are no failures", async () => {
    const { sink, writes } = stubSink();
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      {},
    );
    assert.equal(report.totalFailures, 0);
    assert.equal(report.clusters.length, 0);
    assert.equal(report.newClustersSinceLastRun, 0);
    assert.equal(writes.length, 0);
  });

  test("windowDays filters out ancient failures", async () => {
    // Record a failure whose ended_at is deliberately older than the window.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    attemptsLog.record({
      taskId: "task-old",
      attempt: 1,
      state: "ATTEMPT",
      strategy: "retry_same",
      error: "NETWORK timeout",
      startedAt: old,
      endedAt: old,
    });
    // And a recent one that should be counted.
    seedLoopFailures(attemptsLog, {
      taskId: "task-recent",
      count: 1,
      error: "NETWORK timeout",
      strategy: "retry_same",
    });

    const { sink } = stubSink();
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger, vectorStore: sink, embedder: fakeEmbedder },
      { windowDays: 7 },
    );
    assert.equal(report.totalFailures, 1);
  });

  test("runs without a vector store and still returns the report", async () => {
    // Silent-catch regression guard: the report MUST come back even if
    // persistence is unavailable — the dashboard can't render otherwise.
    seedLoopFailures(attemptsLog, {
      taskId: "task-net",
      count: 3,
      error: "NETWORK unreachable",
      strategy: "retry_same",
    });
    const report = await detectAntiPatterns(
      { attemptsLog, skillUsageLedger: ledger },
      { flagThreshold: 3 },
    );
    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].autoFlagged, true);
    assert.equal(report.newClustersSinceLastRun, 1);
  });
});
