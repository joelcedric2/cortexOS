/**
 * Phase 7 — Coder 3
 * UI Budget API routes: /ui/budgets and /ui/budgets/totals?days=<n>.
 *
 * Runs UIApiServer on an ephemeral port (port: 0), wires an in-memory
 * BudgetTracker, and exercises both the list + window-totals routes,
 * plus: empty-tracker fallback, missing-tracker fallback, bad-query 400.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { UIApiServer } from "../src/ui/ui-api.js";
import {
  BudgetTracker,
  type BudgetDB,
} from "../src/observability/budget-tracker.js";

function mkDb(): BudgetDB {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = MEMORY");
  return sqlite as unknown as BudgetDB;
}

async function getJson(
  url: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

describe("UI /ui/budgets routes", () => {
  let server: UIApiServer;
  let baseUrl: string;
  let tracker: BudgetTracker;
  let db: BudgetDB;
  let clock: number;

  beforeEach(async () => {
    db = mkDb();
    clock = Date.parse("2026-04-15T12:00:00.000Z");
    tracker = new BudgetTracker({ db, now: () => clock });

    server = new UIApiServer({
      port: 0,
      budgetTracker: tracker,
      logger: () => {},
    });
    await server.start();
    const port = server.address();
    if (!port) throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    tracker.close();
  });

  test("GET /ui/budgets returns [] when no agents recorded", async () => {
    const { status, body } = await getJson(`${baseUrl}/ui/budgets`);
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  test("GET /ui/budgets returns recorded agent budgets", async () => {
    tracker.record({
      agentId: "A1",
      role: "coder",
      tokens_in: 1000,
      tokens_out: 500,
      duration_ms: 1500,
      tool_call: true,
      model: "sonnet",
    });
    const { status, body } = await getJson(`${baseUrl}/ui/budgets`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    const rows = body as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agentId, "A1");
    assert.equal(rows[0].role, "coder");
    assert.equal(rows[0].tokens_in, 1000);
    assert.equal(rows[0].tokens_out, 500);
    assert.equal(rows[0].tool_calls, 1);
    assert.equal(rows[0].wall_time_ms, 1500);
    // 1000 in @ $3/1M + 500 out @ $15/1M = 0.003 + 0.0075 = 0.0105
    assert.equal(rows[0].cost_usd, 0.0105);
  });

  test("GET /ui/budgets/totals?days=30 returns window totals", async () => {
    tracker.record({ agentId: "A", role: "coder", tokens_in: 2000, tokens_out: 1000, model: "sonnet" });
    const { status, body } = await getJson(`${baseUrl}/ui/budgets/totals?days=30`);
    assert.equal(status, 200);
    const totals = body as { tokens_in: number; tokens_out: number; cost_usd: number };
    assert.equal(totals.tokens_in, 2000);
    assert.equal(totals.tokens_out, 1000);
    // 2000 in @ $3/1M + 1000 out @ $15/1M = 0.006 + 0.015 = 0.021
    assert.equal(totals.cost_usd, 0.021);
  });

  test("GET /ui/budgets/totals defaults to 1 day when days omitted", async () => {
    const { status, body } = await getJson(`${baseUrl}/ui/budgets/totals`);
    assert.equal(status, 200);
    const totals = body as { tokens_in: number; tokens_out: number; cost_usd: number };
    assert.equal(totals.tokens_in, 0);
    assert.equal(totals.tokens_out, 0);
    assert.equal(totals.cost_usd, 0);
  });

  test("GET /ui/budgets/totals rejects invalid days with 400", async () => {
    const res = await fetch(`${baseUrl}/ui/budgets/totals?days=0`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /days/);
  });

  test("GET /ui/budgets/totals rejects non-integer days with 400", async () => {
    const res = await fetch(`${baseUrl}/ui/budgets/totals?days=abc`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /days/);
  });

  test("routes tolerate a missing tracker (server constructed without one)", async () => {
    await server.stop();
    const bare = new UIApiServer({ port: 0, logger: () => {} });
    await bare.start();
    try {
      const port = bare.address();
      const base = `http://127.0.0.1:${port}`;

      const list = await getJson(`${base}/ui/budgets`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body, []);

      const totals = await getJson(`${base}/ui/budgets/totals?days=7`);
      assert.equal(totals.status, 200);
      assert.deepEqual(totals.body, { tokens_in: 0, tokens_out: 0, cost_usd: 0 });
    } finally {
      await bare.stop();
    }
  });

  test("GET /ui/health lists the two new budget routes", async () => {
    const { status, body } = await getJson(`${baseUrl}/ui/health`);
    assert.equal(status, 200);
    const h = body as { routes: string[] };
    assert.ok(h.routes.includes("GET /ui/budgets"));
    assert.ok(h.routes.includes("GET /ui/budgets/totals"));
  });
});
