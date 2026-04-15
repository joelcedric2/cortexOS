/**
 * SQLite-backed persistence for agent lifecycle events.
 *
 * DB file: ~/.cortexos/events.db (auto-created).
 * Owned by Agent A. Agent B owns a separate ~/.cortexos/registry.db.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

type BetterSqliteDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  close: () => void;
};

export interface AgentEventRow {
  id: number;
  kind: string;
  slot: number | null;
  session_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface InsertEventInput {
  kind: string;
  slot?: number;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  payload?: unknown;
}

export interface EventsDB {
  insert(input: InsertEventInput): number;
  recent(limit: number): AgentEventRow[];
  bySession(sessionId: string, limit: number): AgentEventRow[];
  byTask(taskId: string, limit: number): AgentEventRow[];
  count(): number;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  slot INTEGER,
  session_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  payload_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_task ON agent_events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON agent_events(session_id);
`;

export function defaultEventsDbPath(): string {
  return join(homedir(), ".cortexos", "events.db");
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function openEventsDB(dbPath?: string): Promise<EventsDB> {
  const resolvedPath = dbPath ?? defaultEventsDbPath();
  ensureDir(resolvedPath);

  // Dynamic import so tests on a machine without better-sqlite3 fail loudly.
  const mod = (await import("better-sqlite3")) as unknown as {
    default: new (path: string) => BetterSqliteDatabase;
  };
  const Database = mod.default;
  const db = new Database(resolvedPath);
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO agent_events (kind, slot, session_id, agent_id, task_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const recentStmt = db.prepare(
    `SELECT id, kind, slot, session_id, agent_id, task_id, payload_json, created_at
     FROM agent_events ORDER BY id DESC LIMIT ?`,
  );
  const bySessionStmt = db.prepare(
    `SELECT id, kind, slot, session_id, agent_id, task_id, payload_json, created_at
     FROM agent_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
  );
  const byTaskStmt = db.prepare(
    `SELECT id, kind, slot, session_id, agent_id, task_id, payload_json, created_at
     FROM agent_events WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM agent_events`);

  return {
    insert(input) {
      const result = insertStmt.run(
        input.kind,
        input.slot ?? null,
        input.session_id ?? null,
        input.agent_id ?? null,
        input.task_id ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
      );
      return Number(result.lastInsertRowid);
    },
    recent(limit) {
      return recentStmt.all(limit) as AgentEventRow[];
    },
    bySession(sessionId, limit) {
      return bySessionStmt.all(sessionId, limit) as AgentEventRow[];
    },
    byTask(taskId, limit) {
      return byTaskStmt.all(taskId, limit) as AgentEventRow[];
    },
    count() {
      const row = countStmt.get() as { n: number };
      return row.n;
    },
    close() {
      db.close();
    },
  };
}
