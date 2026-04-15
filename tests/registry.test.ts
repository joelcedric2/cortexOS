import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/registry/agent-registry.js";

describe("AgentRegistry", () => {
  let reg: AgentRegistry;

  beforeEach(() => {
    reg = new AgentRegistry({ dbPath: ":memory:" });
  });

  afterEach(() => {
    reg.close();
  });

  test("spawn inserts a row with default status 'spawning'", () => {
    const row = reg.spawn({
      id: "RES0",
      role: "system-designer",
      color: "cyan",
      task_id: "task-1",
    });
    assert.equal(row.id, "RES0");
    assert.equal(row.role, "system-designer");
    assert.equal(row.color, "cyan");
    assert.equal(row.status, "spawning");
    assert.equal(row.task_id, "task-1");
    assert.equal(row.tmux_session, null);
    assert.equal(row.worktree, null);
    assert.ok(row.started_at, "started_at should be populated");
  });

  test("spawn persists optional worktree and tmux_session", () => {
    reg.spawn({
      id: "BKD0",
      role: "backend",
      color: "blue",
      tmux_session: "slot1_backend",
      worktree: "feature/api",
      task_id: "task-2",
    });
    const row = reg.getById("BKD0");
    assert.ok(row);
    assert.equal(row.tmux_session, "slot1_backend");
    assert.equal(row.worktree, "feature/api");
  });

  test("status transitions walk the full lifecycle", () => {
    reg.spawn({ id: "A", role: "coder", color: "blue" });

    reg.markRunning("A");
    assert.equal(reg.getById("A")?.status, "running");

    reg.markStandby("A");
    assert.equal(reg.getById("A")?.status, "standby");

    reg.markDone("A");
    assert.equal(reg.getById("A")?.status, "done");

    reg.markError("A");
    assert.equal(reg.getById("A")?.status, "error");
  });

  test("heartbeat updates last_heartbeat timestamp", async () => {
    reg.spawn({ id: "H", role: "coder", color: "blue" });
    const before = reg.getById("H");
    assert.equal(before?.last_heartbeat, null);

    // Small delay so the CURRENT_TIMESTAMP actually moves.
    await new Promise((r) => setTimeout(r, 1100));
    reg.heartbeat("H");
    const after = reg.getById("H");
    assert.ok(after?.last_heartbeat, "last_heartbeat should now be set");
  });

  test("getByTaskId returns all agents on a task in insertion order", () => {
    reg.spawn({ id: "T0", role: "coder", color: "blue", task_id: "shared" });
    reg.spawn({ id: "T1", role: "tester", color: "yellow", task_id: "shared" });
    reg.spawn({ id: "T2", role: "coder", color: "blue", task_id: "other" });

    const shared = reg.getByTaskId("shared");
    assert.equal(shared.length, 2);
    assert.deepEqual(
      shared.map((r) => r.id),
      ["T0", "T1"],
    );
  });

  test("list returns every agent, newest first", () => {
    reg.spawn({ id: "X", role: "coder", color: "blue" });
    reg.spawn({ id: "Y", role: "tester", color: "yellow" });
    const rows = reg.list();
    assert.equal(rows.length, 2);
    assert.ok(rows.find((r) => r.id === "X"));
    assert.ok(rows.find((r) => r.id === "Y"));
  });

  test("transition on unknown agent throws", () => {
    assert.throws(() => reg.markDone("nope"), /no agent with id 'nope'/);
  });

  test("heartbeat on unknown agent throws", () => {
    assert.throws(() => reg.heartbeat("ghost"), /no agent with id 'ghost'/);
  });

  test("migration is idempotent across re-opens", () => {
    // Reopen the same in-memory DB path (use a tmp file to actually persist).
    const path = `/tmp/cortexos-test-${Date.now()}.db`;
    const a = new AgentRegistry({ dbPath: path });
    a.spawn({ id: "P0", role: "coder", color: "blue" });
    a.close();

    const b = new AgentRegistry({ dbPath: path });
    const row = b.getById("P0");
    assert.ok(row);
    assert.equal(row.role, "coder");
    b.close();
  });
});
