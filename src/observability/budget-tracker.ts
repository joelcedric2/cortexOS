/**
 * BudgetTracker — Phase 7 §6 bullet 5.
 *
 * Tracks per-agent token spend + wall time + tool-call count + USD cost
 * and persists to a SQLite `budgets` table in the shared `~/.cortexos/
 * registry.db` (co-located with `agents`). Cost is computed from the
 * Anthropic list price per 1M tokens for Haiku/Sonnet/Opus.
 *
 * All DB writes go through prepared statements. Every `record` call is
 * an UPSERT keyed on `agent_id` — the tracker is the single writer for
 * its own table, so the pattern is safe without explicit transactions.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type BudgetModel = "sonnet" | "opus";

export interface AgentBudget {
  agentId: string;
  role: string;
  started_at: string;
  tokens_in: number;
  tokens_out: number;
  wall_time_ms: number;
  tool_calls: number;
  cost_usd?: number;
}

export interface BudgetRecordEvent {
  agentId: string;
  role: string;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms?: number;
  tool_call?: boolean;
  model?: BudgetModel;
}

export interface BudgetWindowTotals {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/**
 * Anthropic list price per 1M tokens, USD.
 * (Pinned 2025 schedule — revisit when pricing changes.)
 */
export const MODEL_PRICES_PER_1M: Record<BudgetModel, { in: number; out: number }> = {
  sonnet: { in: 3, out: 15 },
  opus: { in: 15, out: 75 },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budgets (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  wall_time_ms INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  last_model TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_budgets_role ON budgets(role);
CREATE INDEX IF NOT EXISTS idx_budgets_updated ON budgets(updated_at);
`;

/**
 * Minimal DB surface the tracker depends on. Lets callers inject an
 * in-memory `better-sqlite3` handle for tests or share one with other
 * subsystems in production.
 */
export interface BudgetDB {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(params?: Record<string, unknown> | unknown[]): unknown;
    get(params?: Record<string, unknown> | unknown[]): unknown;
    all(params?: Record<string, unknown> | unknown[]): unknown[];
  };
  close?(): void;
}

export interface BudgetTrackerOptions {
  db?: BudgetDB;
  /** DB path override (ignored if `db` is passed). Defaults to ~/.cortexos/registry.db. */
  dbPath?: string;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

interface BudgetRow {
  agent_id: string;
  role: string;
  started_at: string;
  tokens_in: number;
  tokens_out: number;
  wall_time_ms: number;
  tool_calls: number;
  cost_usd: number;
  last_model: string | null;
  updated_at: string;
}

const DEFAULT_DB_PATH = join(homedir(), ".cortexos", "registry.db");

export class BudgetTracker {
  private readonly db: BudgetDB;
  private readonly ownsDb: boolean;
  private readonly now: () => number;

  private readonly upsertStmt: ReturnType<BudgetDB["prepare"]>;
  private readonly updateStmt: ReturnType<BudgetDB["prepare"]>;
  private readonly selectStmt: ReturnType<BudgetDB["prepare"]>;
  private readonly listStmt: ReturnType<BudgetDB["prepare"]>;
  private readonly windowStmt: ReturnType<BudgetDB["prepare"]>;

  constructor(options: BudgetTrackerOptions = {}) {
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
      if (dbPath !== ":memory:") {
        mkdirSync(dirname(dbPath), { recursive: true });
      }
      const sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");
      this.db = sqlite as unknown as BudgetDB;
      this.ownsDb = true;
    }
    this.now = options.now ?? Date.now;

    this.db.exec(SCHEMA);

    this.upsertStmt = this.db.prepare(
      `INSERT INTO budgets (
         agent_id, role, started_at, tokens_in, tokens_out,
         wall_time_ms, tool_calls, cost_usd, last_model, updated_at
       ) VALUES (
         @agent_id, @role, @started_at, 0, 0, 0, 0, 0, NULL, @updated_at
       )
       ON CONFLICT(agent_id) DO NOTHING`,
    );

    this.updateStmt = this.db.prepare(
      `UPDATE budgets
         SET tokens_in    = tokens_in    + @d_tokens_in,
             tokens_out   = tokens_out   + @d_tokens_out,
             wall_time_ms = wall_time_ms + @d_duration_ms,
             tool_calls   = tool_calls   + @d_tool_calls,
             cost_usd     = cost_usd     + @d_cost_usd,
             last_model   = COALESCE(@last_model, last_model),
             updated_at   = @updated_at
       WHERE agent_id = @agent_id`,
    );

    this.selectStmt = this.db.prepare(
      `SELECT agent_id, role, started_at, tokens_in, tokens_out,
              wall_time_ms, tool_calls, cost_usd, last_model, updated_at
         FROM budgets
        WHERE agent_id = @agent_id`,
    );

    this.listStmt = this.db.prepare(
      `SELECT agent_id, role, started_at, tokens_in, tokens_out,
              wall_time_ms, tool_calls, cost_usd, last_model, updated_at
         FROM budgets
        ORDER BY updated_at DESC`,
    );

    this.windowStmt = this.db.prepare(
      `SELECT
          COALESCE(SUM(tokens_in), 0)  AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(cost_usd), 0)   AS cost_usd
         FROM budgets
        WHERE updated_at >= @cutoff`,
    );
  }

  /**
   * Fold a new event into the agent's rolling budget. Creates the row
   * on first call. Cost is computed from @model + token delta.
   */
  record(event: BudgetRecordEvent): void {
    if (!event.agentId || !event.role) {
      throw new Error("BudgetTracker.record: agentId and role are required");
    }
    const nowIso = new Date(this.now()).toISOString();
    this.upsertStmt.run({
      agent_id: event.agentId,
      role: event.role,
      started_at: nowIso,
      updated_at: nowIso,
    });

    // Per-event token cap (phase-7 REVIEW §P-2): prevents a poisoned caller
    // from inflating peer cost unboundedly. 1M in / 1M out per single event
    // is far above any legitimate Claude model response.
    const TOKEN_CAP = 1_000_000;
    const d_in = Math.min(TOKEN_CAP, Math.max(0, Math.floor(event.tokens_in ?? 0)));
    const d_out = Math.min(TOKEN_CAP, Math.max(0, Math.floor(event.tokens_out ?? 0)));
    const d_duration = Math.max(0, Math.floor(event.duration_ms ?? 0));
    const d_calls = event.tool_call ? 1 : 0;
    const d_cost = event.model
      ? costForDelta(d_in, d_out, event.model)
      : 0;

    this.updateStmt.run({
      agent_id: event.agentId,
      d_tokens_in: d_in,
      d_tokens_out: d_out,
      d_duration_ms: d_duration,
      d_tool_calls: d_calls,
      d_cost_usd: d_cost,
      last_model: event.model ?? null,
      updated_at: nowIso,
    });
  }

  /** Snapshot a single agent's current budget, or null if it has no record. */
  snapshot(agentId: string): AgentBudget | null {
    const row = this.selectStmt.get({ agent_id: agentId }) as
      | BudgetRow
      | undefined;
    if (!row) return null;
    return rowToBudget(row);
  }

  /** All known agent budgets, most-recently-updated first. */
  listActive(): AgentBudget[] {
    const rows = this.listStmt.all() as BudgetRow[];
    return rows.map(rowToBudget);
  }

  /**
   * Aggregate tokens + cost over the trailing `windowDays` (inclusive
   * of today). Rows that haven't been updated inside the window are
   * excluded — this gives a rolling operational view, not lifetime.
   */
  totalsInWindow(windowDays: number): BudgetWindowTotals {
    const days = Math.max(0, Math.floor(windowDays));
    const cutoffMs = this.now() - days * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    const row = this.windowStmt.get({ cutoff }) as
      | { tokens_in: number; tokens_out: number; cost_usd: number }
      | undefined;
    if (!row) return { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    return {
      tokens_in: Number(row.tokens_in),
      tokens_out: Number(row.tokens_out),
      cost_usd: round6(Number(row.cost_usd)),
    };
  }

  close(): void {
    if (this.ownsDb && typeof this.db.close === "function") {
      this.db.close();
    }
  }
}

function rowToBudget(row: BudgetRow): AgentBudget {
  return {
    agentId: row.agent_id,
    role: row.role,
    started_at: row.started_at,
    tokens_in: Number(row.tokens_in),
    tokens_out: Number(row.tokens_out),
    wall_time_ms: Number(row.wall_time_ms),
    tool_calls: Number(row.tool_calls),
    cost_usd: round6(Number(row.cost_usd)),
  };
}

/** Price a token delta against a given model. Result in USD. */
export function costForDelta(
  tokens_in: number,
  tokens_out: number,
  model: BudgetModel,
): number {
  const prices = MODEL_PRICES_PER_1M[model];
  const cost = (tokens_in / 1_000_000) * prices.in + (tokens_out / 1_000_000) * prices.out;
  return round6(cost);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
