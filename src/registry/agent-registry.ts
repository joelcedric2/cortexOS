import Database, { type Database as DB } from "better-sqlite3";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Authoritative inline schema. Kept in sync with `schema.sql` (the SQL file is
 * the human-readable spec; this string is the runtime fallback so that a build
 * artifact missing the sidecar file still initializes correctly).
 */
const INLINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  tmux_session TEXT,
  worktree TEXT,
  status TEXT NOT NULL DEFAULT 'spawning',
  task_id TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agents_task ON agents(task_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
`;

/**
 * Registry-level status for a spawned agent.
 *
 * spawning → agent row inserted, tmux/claude not yet confirmed ready
 * running  → agent is actively executing a task
 * standby  → task finished but session kept warm for follow-up work
 * done     → terminal success state; session may or may not still exist
 * error    → terminal failure state; see last heartbeat payload
 */
export type AgentStatus = "spawning" | "running" | "standby" | "done" | "error";

export interface AgentRecord {
  id: string;
  role: string;
  color: string;
  tmux_session: string | null;
  worktree: string | null;
  status: AgentStatus;
  task_id: string | null;
  started_at: string;
  last_heartbeat: string | null;
}

export interface SpawnInput {
  id: string;
  role: string;
  color: string;
  tmux_session?: string | null;
  worktree?: string | null;
  task_id?: string | null;
}

export interface AgentRegistryOptions {
  /** Override DB path (primarily for tests). Defaults to ~/.cortexos/registry.db. */
  dbPath?: string;
}

const DEFAULT_DB_DIR = join(homedir(), ".cortexos");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "registry.db");

function loadSchema(): string {
  // Prefer an adjacent schema.sql (useful during development + diffing).
  // Fall back to the inline string if the file isn't shipped (e.g. in dist/).
  const candidates = [
    join(__dirname, "schema.sql"),
    join(__dirname, "..", "..", "src", "registry", "schema.sql"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  }
  return INLINE_SCHEMA;
}

/**
 * SQLite-backed registry of every live/recent agent.
 *
 * This is the single source of truth the orchestrator consults when it needs
 * to know "who is up, doing what, on which task." It replaces the fragile
 * in-memory Map<slot, agentId> that the old orchestrator carried.
 */
export class AgentRegistry {
  private readonly db: DB;

  constructor(options: AgentRegistryOptions = {}) {
    const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Run the schema migration. Idempotent — safe to call on every init. */
  private migrate(): void {
    this.db.exec(loadSchema());
  }

  /**
   * Insert a new agent row. Status defaults to 'spawning' — caller transitions
   * to 'running' once the process is confirmed alive (typically via a first
   * heartbeat or a successful `sendKeys`).
   */
  spawn(input: SpawnInput): AgentRecord {
    const stmt = this.db.prepare(
      `INSERT INTO agents (id, role, color, tmux_session, worktree, status, task_id)
       VALUES (@id, @role, @color, @tmux_session, @worktree, 'spawning', @task_id)`
    );
    stmt.run({
      id: input.id,
      role: input.role,
      color: input.color,
      tmux_session: input.tmux_session ?? null,
      worktree: input.worktree ?? null,
      task_id: input.task_id ?? null,
    });
    const row = this.getById(input.id);
    if (!row) {
      throw new Error(`AgentRegistry.spawn: insert failed for agent ${input.id}`);
    }
    return row;
  }

  markRunning(id: string): void {
    this.transition(id, "running");
  }

  markStandby(id: string): void {
    this.transition(id, "standby");
  }

  markDone(id: string): void {
    this.transition(id, "done");
  }

  markError(id: string): void {
    this.transition(id, "error");
  }

  /**
   * Bump `last_heartbeat` to now. Called by the Stop/heartbeat IPC path and
   * used by the policy engine to distinguish "alive but quiet" from "crashed."
   */
  heartbeat(id: string): void {
    const stmt = this.db.prepare(
      `UPDATE agents SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?`
    );
    const info = stmt.run(id);
    if (info.changes === 0) {
      throw new Error(`AgentRegistry.heartbeat: no agent with id '${id}'`);
    }
  }

  list(): AgentRecord[] {
    return this.db
      .prepare(`SELECT * FROM agents ORDER BY started_at DESC`)
      .all() as AgentRecord[];
  }

  getById(id: string): AgentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get(id) as AgentRecord | undefined;
    return row;
  }

  getByTaskId(taskId: string): AgentRecord[] {
    return this.db
      .prepare(`SELECT * FROM agents WHERE task_id = ? ORDER BY started_at ASC`)
      .all(taskId) as AgentRecord[];
  }

  /** Close the underlying DB. Tests call this in teardown. */
  close(): void {
    this.db.close();
  }

  private transition(id: string, status: AgentStatus): void {
    const stmt = this.db.prepare(
      `UPDATE agents SET status = ?, last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?`
    );
    const info = stmt.run(status, id);
    if (info.changes === 0) {
      throw new Error(
        `AgentRegistry.transition: no agent with id '${id}' (wanted status='${status}')`
      );
    }
  }
}

/** Lazily-initialized process-wide registry. */
let sharedRegistry: AgentRegistry | null = null;

/**
 * Returns the shared process-wide registry, creating it on first call.
 * Tests should construct their own `AgentRegistry({ dbPath: ":memory:" })`
 * instead of using this.
 */
export function getAgentRegistry(): AgentRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new AgentRegistry();
  }
  return sharedRegistry;
}
