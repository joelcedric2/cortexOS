-- CortexOS Agent Registry (Phase 1, Nchinda plan §3.2, §6 Phase 1 step 6)
-- Owned by the orchestrator. One row per spawned agent process.

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  tmux_session TEXT,
  worktree TEXT,
  status TEXT NOT NULL DEFAULT 'spawning',   -- spawning|running|standby|done|error
  task_id TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_task ON agents(task_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
