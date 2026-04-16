/**
 * Phase 7 — UI API extensions tests.
 *
 * Exercises GET /ui/anti-patterns and GET /ui/success-rate over a real
 * UIApiServer + LoopAttemptLog + SkillUsageLedger + AgentRegistry stack,
 * and asserts the 60s in-memory cache (two back-to-back requests hit the
 * stores exactly once).
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { LoopAttemptLog } from "../src/loop/loop-attempts-db.js";
import { SkillUsageLedger } from "../src/skills/usage-ledger.js";
import { UIApiServer } from "../src/ui/ui-api.js";
import type {
  AntiPatternMemorySink,
  AntiPatternEmbedder,
  AntiPatternReport,
} from "../src/analytics/anti-patterns.js";
import type { SuccessRateReport } from "../src/analytics/success-rate.js";

const fakeEmbedder: AntiPatternEmbedder = {
  async embed() {
    return new Array(384).fill(0);
  },
};

describe("UIApiServer — Phase 7 analytics routes", () => {
  let server: UIApiServer;
  let baseUrl: string;
  let tmpDir: string;
  let registry: AgentRegistry;
  let attemptsLog: LoopAttemptLog;
  let skillUsageLedger: SkillUsageLedger;
  let sinkWrites: number;
  let sink: AntiPatternMemorySink;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ui-api-phase7-"));
    registry = new AgentRegistry({ dbPath: join(tmpDir, "registry.db") });
    attemptsLog = new LoopAttemptLog({ dbPath: join(tmpDir, "loop.db") });
    skillUsageLedger = new SkillUsageLedger({ dbPath: join(tmpDir, "skill.db") });
    sinkWrites = 0;
    sink = {
      async storeMemory() {
        sinkWrites += 1;
        return `mem-${sinkWrites}`;
      },
    };
    server = new UIApiServer({
      port: 0,
      registry,
      attemptsLog,
      skillUsageLedger,
      antiPatternSink: sink,
      antiPatternEmbedder: fakeEmbedder,
      logger: () => {},
    });
    await server.start();
    const port = server.address();
    if (!port) throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    registry.close();
    attemptsLog.close();
    skillUsageLedger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET /ui/anti-patterns returns a well-formed report", async () => {
    for (let i = 0; i < 3; i++) {
      const t = new Date();
      attemptsLog.record({
        taskId: "task-net",
        attempt: i + 1,
        state: "ATTEMPT",
        strategy: "retry_same",
        error: "TIMEOUT talking to github.com",
        startedAt: t,
        endedAt: t,
      });
    }
    const res = await fetch(`${baseUrl}/ui/anti-patterns?days=7`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as AntiPatternReport;
    assert.equal(body.windowDays, 7);
    assert.equal(body.totalFailures, 3);
    assert.equal(body.clusters.length, 1);
    assert.equal(body.clusters[0].autoFlagged, true);
    assert.equal(body.clusters[0].signature, "loop_attempts:TIMEOUT:retry_same");
    assert.equal(sinkWrites, 1);
  });

  test("GET /ui/anti-patterns is cached — second call does not re-run detection", async () => {
    for (let i = 0; i < 3; i++) {
      const t = new Date();
      attemptsLog.record({
        taskId: "task-net",
        attempt: i + 1,
        state: "ATTEMPT",
        strategy: "retry_same",
        error: "TIMEOUT",
        startedAt: t,
        endedAt: t,
      });
    }
    const r1 = await fetch(`${baseUrl}/ui/anti-patterns?days=7`);
    assert.equal(r1.status, 200);
    assert.equal(sinkWrites, 1);
    for (let i = 0; i < 3; i++) {
      const t = new Date();
      attemptsLog.record({
        taskId: "task-net2",
        attempt: i + 1,
        state: "ATTEMPT",
        strategy: "retry_same",
        error: "TIMEOUT",
        startedAt: t,
        endedAt: t,
      });
    }
    const r2 = await fetch(`${baseUrl}/ui/anti-patterns?days=7`);
    assert.equal(r2.status, 200);
    const body = (await r2.json()) as AntiPatternReport;
    assert.equal(body.totalFailures, 3, "cache hit should return the original report");
    assert.equal(sinkWrites, 1, "sink must not be re-written on a cache hit");
  });

  test("GET /ui/success-rate returns per-role stats for the window", async () => {
    registry.spawn({ id: "a1", role: "coder", color: "#000", task_id: "t-1" });
    const t = new Date();
    attemptsLog.record({
      taskId: "t-1",
      attempt: 1,
      state: "DONE",
      startedAt: t,
      endedAt: new Date(t.getTime() + 250),
    });
    const res = await fetch(`${baseUrl}/ui/success-rate?days=7`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SuccessRateReport;
    assert.equal(body.windowDays, 7);
    assert.equal(body.byRole.length, 1);
    assert.equal(body.byRole[0].role, "coder");
    assert.equal(body.byRole[0].successRate, 1);
    assert.equal(body.byRole[0].autonomyRate, 1);
    assert.equal(body.byOverall.totalAttempts, 1);
    assert.equal(body.trend.length, 7);
  });

  test("GET /ui/success-rate is cached — identical query does not re-read DB", async () => {
    registry.spawn({ id: "a1", role: "coder", color: "#000", task_id: "t-1" });
    const t = new Date();
    attemptsLog.record({
      taskId: "t-1",
      attempt: 1,
      state: "DONE",
      startedAt: t,
      endedAt: t,
    });
    const r1 = await fetch(`${baseUrl}/ui/success-rate?days=7`);
    assert.equal(r1.status, 200);
    const body1 = (await r1.json()) as SuccessRateReport;
    assert.equal(body1.byOverall.totalAttempts, 1);
    registry.spawn({ id: "a2", role: "coder", color: "#000", task_id: "t-2" });
    attemptsLog.record({
      taskId: "t-2",
      attempt: 1,
      state: "DONE",
      startedAt: t,
      endedAt: t,
    });
    const r2 = await fetch(`${baseUrl}/ui/success-rate?days=7`);
    assert.equal(r2.status, 200);
    const body2 = (await r2.json()) as SuccessRateReport;
    assert.equal(body2.byOverall.totalAttempts, 1, "cache hit must return stale count");
  });

  test("GET /ui/anti-patterns with days=foo returns 400", async () => {
    const res = await fetch(`${baseUrl}/ui/anti-patterns?days=foo`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /positive integer/);
  });

  test("GET /ui/success-rate with days=0 returns 400", async () => {
    const res = await fetch(`${baseUrl}/ui/success-rate?days=0`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /positive integer/);
  });

  test("analytics routes return empty reports when deps are missing", async () => {
    const s = new UIApiServer({ port: 0, logger: () => {} });
    await s.start();
    try {
      const port = s.address()!;
      const url = `http://127.0.0.1:${port}`;
      const ap = await fetch(`${url}/ui/anti-patterns?days=7`);
      assert.equal(ap.status, 200);
      const apBody = (await ap.json()) as AntiPatternReport;
      assert.equal(apBody.totalFailures, 0);
      assert.equal(apBody.clusters.length, 0);
      const sr = await fetch(`${url}/ui/success-rate?days=7`);
      assert.equal(sr.status, 200);
      const srBody = (await sr.json()) as SuccessRateReport;
      assert.equal(srBody.byRole.length, 0);
      assert.equal(srBody.byOverall.totalAttempts, 0);
    } finally {
      await s.stop();
    }
  });

  test("clearAnalyticsCache forces re-computation", async () => {
    for (let i = 0; i < 3; i++) {
      const t = new Date();
      attemptsLog.record({
        taskId: "task-net",
        attempt: i + 1,
        state: "ATTEMPT",
        strategy: "retry_same",
        error: "TIMEOUT",
        startedAt: t,
        endedAt: t,
      });
    }
    await fetch(`${baseUrl}/ui/anti-patterns?days=7`);
    assert.equal(sinkWrites, 1);
    await fetch(`${baseUrl}/ui/anti-patterns?days=7`);
    assert.equal(sinkWrites, 1);
    server.clearAnalyticsCache();
    await fetch(`${baseUrl}/ui/anti-patterns?days=7`);
    assert.equal(sinkWrites, 2);
  });

  test("/ui/health lists the new routes", async () => {
    const res = await fetch(`${baseUrl}/ui/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { routes: string[] };
    assert.ok(body.routes.includes("GET /ui/anti-patterns"));
    assert.ok(body.routes.includes("GET /ui/success-rate"));
  });
});
