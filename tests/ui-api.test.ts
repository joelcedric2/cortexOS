/**
 * Phase 6 — Agent A
 * UI HTTP API (`src/ui/ui-api.ts`) tests on port 3103. Uses `port: 0` so
 * the kernel picks a free port per test; we then read `server.address()`
 * and issue requests against `http://127.0.0.1:<port>`.
 *
 * Covers: one test per route + a 400 on bad query + a 404 on unknown route.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { SkillRegistryDB } from "../src/skills/skill-registry-db.js";
import { CronJobsDB } from "../src/scheduler/cron-jobs-db.js";
import { AuditLog } from "../src/proactivity/audit.js";
import { UIApiServer } from "../src/ui/ui-api.js";
import type { BriefStore } from "../src/research/brief-store.js";

/** Minimal BriefStore stub — only `recall` is exercised by the API. */
function fakeBriefStore(): BriefStore {
  return {
    async recall() {
      return [
        {
          id: "brief-1",
          brief: {
            question: "How do we deploy to prod?",
            recommended_action: "Use blue/green with 10-minute soak",
            confidence: 0.82,
            evidence: ["prior deploy-success log"],
            open_questions: [],
            hypotheses: [],
          },
          similarity: 0.91,
          tags: ["research_brief", "task-42"],
          createdAt: new Date("2026-04-15T12:00:00.000Z"),
        },
      ];
    },
  } as unknown as BriefStore;
}

describe("UIApiServer", () => {
  let server: UIApiServer;
  let baseUrl: string;
  let tmpDir: string;
  let registry: AgentRegistry;
  let skillRegistry: SkillRegistryDB;
  let cronDb: CronJobsDB;
  let auditLog: AuditLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ui-api-test-"));
    registry = new AgentRegistry({ dbPath: ":memory:" });
    skillRegistry = new SkillRegistryDB({ dbPath: ":memory:" });
    cronDb = new CronJobsDB({ dbPath: ":memory:" });
    auditLog = new AuditLog(join(tmpDir, "audit.ndjson"));

    server = new UIApiServer({
      port: 0,
      registry,
      skillRegistry,
      cronDb,
      auditLog,
      briefStore: fakeBriefStore(),
      // Silence the default console.warn during tests.
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
    skillRegistry.close();
    cronDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET /ui/health returns ok + uptime + routes", async () => {
    const res = await fetch(`${baseUrl}/ui/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      uptime_s: number;
      routes: string[];
    };
    assert.equal(body.ok, true);
    assert.ok(typeof body.uptime_s === "number");
    assert.ok(Array.isArray(body.routes));
    assert.ok(body.routes.includes("GET /ui/agents"));
  });

  test("GET /ui/agents returns registry rows", async () => {
    registry.spawn({
      id: "agent-7",
      role: "coder",
      color: "#00ff88",
      tmux_session: "slot7_coder",
    });

    const res = await fetch(`${baseUrl}/ui/agents`);
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") ?? "",
      /application\/json/,
    );
    const rows = (await res.json()) as Array<{ id: string; role: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "agent-7");
    assert.equal(rows[0].role, "coder");
  });

  test("GET /ui/briefs?q=... returns mapped BriefRows", async () => {
    const res = await fetch(`${baseUrl}/ui/briefs?q=deploy&k=3`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{
      id: string;
      question: string;
      similarity: number;
      createdAt: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "brief-1");
    assert.equal(rows[0].question, "How do we deploy to prod?");
    assert.equal(rows[0].createdAt, "2026-04-15T12:00:00.000Z");
  });

  test("GET /ui/briefs with missing 'q' returns 400", async () => {
    const res = await fetch(`${baseUrl}/ui/briefs`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    // Zod message is "expected string, received undefined" on a missing field.
    assert.match(body.error, /expected string|missing/i);
  });

  test("GET /ui/skills returns skill rows", async () => {
    skillRegistry.insert({
      id: "skill-1",
      name: "github-pr-helper",
      trust_level: "user-trusted",
    });
    const res = await fetch(`${baseUrl}/ui/skills`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{ id: string; name: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "github-pr-helper");
  });

  test("GET /ui/crons returns cron rows", async () => {
    cronDb.create({
      id: "cron-daily",
      name: "Daily brief",
      cron_expr: "0 9 * * *",
      task: "run daily brief",
      created_by: "user",
      enabled: true,
    });
    const res = await fetch(`${baseUrl}/ui/crons`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{ id: string; name: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "cron-daily");
  });

  test("GET /ui/audit?date=YYYY-MM-DD returns a DailySummary", async () => {
    auditLog.append({
      action: "sensor_sample",
      detail: "hello",
      ts: new Date("2026-04-15T10:00:00.000Z"),
    });
    auditLog.append({
      action: "surface",
      detail: "showed to user",
      ts: new Date("2026-04-15T11:00:00.000Z"),
    });
    const res = await fetch(`${baseUrl}/ui/audit?date=2026-04-15`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      totalSamples: number;
      surfaced: number;
      actedOn: number;
    };
    assert.equal(body.totalSamples, 1);
    assert.equal(body.surfaced, 1);
    assert.equal(body.actedOn, 0);
  });

  test("GET /ui/audit with invalid date returns 400", async () => {
    const res = await fetch(`${baseUrl}/ui/audit?date=not-a-date`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /YYYY-MM-DD/);
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl}/ui/does-not-exist`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Not found/);
  });
});
