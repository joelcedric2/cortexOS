/**
 * Phase 3 — Agent A
 *
 * Unit tests for `NchindaCoordination` (send / broadcast / status /
 * escalate / ask_peer). Everything runs against in-memory fakes — no tmux,
 * no SQLite file, no real EventBus timing edge cases (except the explicit
 * timeout test which uses short timers).
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NchindaCoordination } from "../src/mcp/nchinda-coordination.js";
import type {
  MessageBusLike,
  AgentRegistryLike,
  PeerSlotResolver,
} from "../src/mcp/nchinda-coordination.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { EscalationsDB } from "../src/mcp/escalations-db.js";
import type { AgentRecord } from "../src/registry/agent-registry.js";

// --------------------------- Fakes ---------------------------------------

class FakeMessageBus implements MessageBusLike {
  public sent: Array<{ fromSlot: number; toSlot: number; content: string }> = [];
  public broadcasts: Array<{ fromSlot: number; content: string }> = [];
  public shouldFail = false;

  async send(fromSlot: number, toSlot: number, content: string): Promise<void> {
    if (this.shouldFail) throw new Error("send failed");
    this.sent.push({ fromSlot, toSlot, content });
  }

  async broadcast(fromSlot: number, content: string): Promise<void> {
    if (this.shouldFail) throw new Error("broadcast failed");
    this.broadcasts.push({ fromSlot, content });
  }
}

class FakeRegistry implements AgentRegistryLike {
  public rows: AgentRecord[] = [];
  list(): AgentRecord[] {
    return [...this.rows];
  }
}

function makeAgent(partial: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    id: partial.id,
    role: partial.role ?? "coder",
    color: partial.color ?? "blue",
    tmux_session: partial.tmux_session ?? `sess-${partial.id}`,
    worktree: partial.worktree ?? null,
    status: partial.status ?? "running",
    task_id: partial.task_id ?? null,
    started_at: partial.started_at ?? new Date().toISOString(),
    last_heartbeat: partial.last_heartbeat ?? null,
  };
}

// --------------------------- Shared harness ------------------------------

interface Harness {
  bus: FakeMessageBus;
  registry: FakeRegistry;
  eventBus: ReturnType<typeof createEventBus>;
  db: EscalationsDB;
  slots: Map<string, number>;
  coordination: NchindaCoordination;
}

function buildHarness(): Harness {
  const bus = new FakeMessageBus();
  const registry = new FakeRegistry();
  const eventBus = createEventBus();
  const db = new EscalationsDB({ dbPath: ":memory:" });
  const slots = new Map<string, number>();
  const resolvePeerSlot: PeerSlotResolver = (a) => slots.get(a.id);
  const coordination = new NchindaCoordination({
    messageBus: bus,
    registry,
    eventBus,
    escalationsDb: db,
    resolvePeerSlot,
  });
  return { bus, registry, eventBus, db, slots, coordination };
}

// --------------------------- send ----------------------------------------

describe("NchindaCoordination.send", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("forwards to MessageBus.send with body + slots", async () => {
    const result = await h.coordination.send({
      to_slot: 2,
      body: "hello",
      from_slot: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.to_slot, 2);
    assert.equal(result.from_slot, 1);
    assert.deepEqual(h.bus.sent, [
      { fromSlot: 1, toSlot: 2, content: "hello" },
    ]);
  });

  test("defaults from_slot to -1 (system)", async () => {
    const result = await h.coordination.send({ to_slot: 0, body: "ping" });
    assert.equal(result.from_slot, -1);
    assert.equal(h.bus.sent[0].fromSlot, -1);
  });

  test("rejects empty body (zod)", async () => {
    await assert.rejects(
      () => h.coordination.send({ to_slot: 1, body: "" }),
      /body/i,
    );
  });

  test("rejects negative slot (zod)", async () => {
    await assert.rejects(
      () => h.coordination.send({ to_slot: -2, body: "x" }),
    );
  });

  test("propagates MessageBus errors (no silent catch)", async () => {
    h.bus.shouldFail = true;
    await assert.rejects(
      () => h.coordination.send({ to_slot: 1, body: "x" }),
      /send failed/,
    );
  });
});

// --------------------------- broadcast -----------------------------------

describe("NchindaCoordination.broadcast", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("forwards to MessageBus.broadcast with default from_slot=-1", async () => {
    const result = await h.coordination.broadcast({ body: "heads-up" });
    assert.equal(result.ok, true);
    assert.equal(result.from_slot, -1);
    assert.deepEqual(h.bus.broadcasts, [
      { fromSlot: -1, content: "heads-up" },
    ]);
  });

  test("honors explicit from_slot", async () => {
    await h.coordination.broadcast({ body: "hi", from_slot: 3 });
    assert.equal(h.bus.broadcasts[0].fromSlot, 3);
  });

  test("rejects body longer than 10k chars", async () => {
    await assert.rejects(
      () => h.coordination.broadcast({ body: "x".repeat(10_001) }),
    );
  });
});
