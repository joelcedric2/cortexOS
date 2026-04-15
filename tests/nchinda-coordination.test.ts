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
import type { EventBus } from "../src/ipc/event-bus.js";
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
  list(): AgentRecord[] { return [...this.rows]; }
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

interface Harness {
  bus: FakeMessageBus;
  registry: FakeRegistry;
  eventBus: EventBus;
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
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.db.close(); });

  test("forwards to MessageBus.send with body + slots", async () => {
    const result = await h.coordination.send({
      to_slot: 2, body: "hello", from_slot: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.to_slot, 2);
    assert.equal(result.from_slot, 1);
    assert.deepEqual(h.bus.sent, [{ fromSlot: 1, toSlot: 2, content: "hello" }]);
  });

  test("defaults from_slot to -1 (system)", async () => {
    const result = await h.coordination.send({ to_slot: 0, body: "ping" });
    assert.equal(result.from_slot, -1);
    assert.equal(h.bus.sent[0].fromSlot, -1);
  });

  test("rejects empty body (zod)", async () => {
    await assert.rejects(() => h.coordination.send({ to_slot: 1, body: "" }));
  });

  test("rejects negative slot (zod)", async () => {
    await assert.rejects(() => h.coordination.send({ to_slot: -2, body: "x" }));
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
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.db.close(); });

  test("forwards to MessageBus.broadcast with default from_slot=-1", async () => {
    const result = await h.coordination.broadcast({ body: "heads-up" });
    assert.equal(result.ok, true);
    assert.equal(result.from_slot, -1);
    assert.deepEqual(h.bus.broadcasts, [{ fromSlot: -1, content: "heads-up" }]);
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

// --------------------------- status --------------------------------------

describe("NchindaCoordination.status", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.db.close(); });

  test("projects registry rows and counts running vs standby", () => {
    h.registry.rows = [
      makeAgent({ id: "A1", role: "coder", status: "running", task_id: "t1" }),
      makeAgent({ id: "A2", role: "tester", status: "running" }),
      makeAgent({ id: "A3", role: "researcher", status: "standby" }),
      makeAgent({ id: "A4", role: "planner", status: "spawning" }),
      makeAgent({ id: "A5", role: "coder", status: "error" }),
    ];
    const result = h.coordination.status();
    assert.equal(result.agents.length, 5);
    assert.equal(result.active_count, 2);
    assert.equal(result.standby_count, 1);
    assert.equal(result.agents[0].id, "A1");
    assert.equal(result.agents[0].role, "coder");
    assert.equal(result.agents[0].task_id, "t1");
    assert.ok(result.agents[0].uptime_s >= 0);
  });

  test("uptime_s is floored seconds since started_at", () => {
    const frozenNow = new Date("2026-04-15T12:00:05.700Z");
    const started = new Date("2026-04-15T12:00:00.000Z");
    const reg = new FakeRegistry();
    reg.rows = [makeAgent({ id: "A1", started_at: started.toISOString() })];
    const coord = new NchindaCoordination({
      messageBus: new FakeMessageBus(),
      registry: reg,
      eventBus: createEventBus(),
      escalationsDb: new EscalationsDB({ dbPath: ":memory:" }),
      resolvePeerSlot: () => undefined,
      now: () => frozenNow,
    });
    assert.equal(coord.status().agents[0].uptime_s, 5);
  });

  test("empty registry yields zero counts", () => {
    assert.deepEqual(
      h.coordination.status(),
      { agents: [], active_count: 0, standby_count: 0 },
    );
  });

  test("tolerates an invalid started_at (uptime_s=0)", () => {
    h.registry.rows = [makeAgent({ id: "A1", started_at: "not-a-date" })];
    assert.equal(h.coordination.status().agents[0].uptime_s, 0);
  });

  test("rejects unexpected input keys (strict zod)", () => {
    assert.throws(() => h.coordination.status({ mystery: 1 }));
  });
});

// --------------------------- escalate ------------------------------------

describe("NchindaCoordination.escalate", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.db.close(); });

  test("persists a row in escalations and emits an error event", () => {
    const events: unknown[] = [];
    h.eventBus.subscribe({ kind: "error" }, (e) => events.push(e));
    const result = h.coordination.escalate({
      question: "Commit or stash?",
      task_id: "t-7",
      agent_id: "DEV0",
    });
    assert.ok(result.escalation_id.startsWith("esc_"));
    const row = h.db.getById(result.escalation_id);
    assert.ok(row);
    assert.equal(row!.question, "Commit or stash?");
    assert.equal(row!.level, "question");
    assert.equal(row!.task_id, "t-7");
    assert.equal(row!.agent_id, "DEV0");

    assert.equal(events.length, 1);
    const e = events[0] as {
      kind: string;
      task_id?: string;
      agent_id?: string;
      payload: { where: string; question: string; level: string; escalation_id: string };
    };
    assert.equal(e.kind, "error");
    assert.equal(e.task_id, "t-7");
    assert.equal(e.agent_id, "DEV0");
    assert.equal(e.payload.where, "escalation");
    assert.equal(e.payload.question, "Commit or stash?");
    assert.equal(e.payload.level, "ask");
    assert.equal(e.payload.escalation_id, result.escalation_id);
  });

  test("level 'blocker' is persisted verbatim", () => {
    const r = h.coordination.escalate({ question: "Prod DB down", level: "blocker" });
    assert.equal(h.db.getById(r.escalation_id)!.level, "blocker");
  });

  test("level 'info' is persisted verbatim", () => {
    const r = h.coordination.escalate({ question: "FYI", level: "info" });
    assert.equal(h.db.getById(r.escalation_id)!.level, "info");
  });

  test("rejects empty question", () => {
    assert.throws(() => h.coordination.escalate({ question: "" }));
  });

  test("rejects unknown level", () => {
    assert.throws(() =>
      h.coordination.escalate({ question: "q", level: "urgent" as never }),
    );
  });
});

// --------------------------- ask_peer ------------------------------------

describe("NchindaCoordination.askPeer", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.db.close(); });

  test("returns {ok:false,reason:'no-peer'} when no matching role is running", async () => {
    h.registry.rows = [
      makeAgent({ id: "A1", role: "researcher", status: "running" }),
      makeAgent({ id: "A2", role: "coder", status: "standby" }),
    ];
    const result = await h.coordination.askPeer({
      role: "coder", question: "what?", timeout_s: 1,
    });
    assert.deepEqual(result, { ok: false, reason: "no-peer" });
    assert.equal(h.bus.sent.length, 0);
  });

  test("returns 'no-peer' when resolver cannot map agent to a slot", async () => {
    h.registry.rows = [makeAgent({ id: "A1", role: "coder", status: "running" })];
    const result = await h.coordination.askPeer({
      role: "coder", question: "ping", timeout_s: 1,
    });
    assert.deepEqual(result, { ok: false, reason: "no-peer" });
  });

  test("round-trips a reply when peer emits matching task_id", async () => {
    h.registry.rows = [makeAgent({ id: "A1", role: "coder", status: "running" })];
    h.slots.set("A1", 2);

    const askPromise = h.coordination.askPeer({
      role: "coder", question: "unit?", timeout_s: 2,
    });

    await new Promise((r) => setImmediate(r));
    assert.equal(h.bus.sent.length, 1);
    const env = h.bus.sent[0].content;
    const match = /^\[ASK ([0-9a-f-]+)\]: unit\?$/.exec(env);
    assert.ok(match, `envelope shape: ${env}`);
    const correlationId = match![1];
    assert.equal(h.bus.sent[0].fromSlot, -1);
    assert.equal(h.bus.sent[0].toSlot, 2);

    h.eventBus.emit({
      kind: "done",
      task_id: correlationId,
      payload: { body: "tests are green" },
      ts: new Date(),
    });

    const result = await askPromise;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.answer, "tests are green");
      assert.equal(result.correlation_id, correlationId);
    }
  });

  test("returns {ok:false,reason:'timeout'} when peer never replies", async () => {
    h.registry.rows = [makeAgent({ id: "A1", role: "coder", status: "running" })];
    h.slots.set("A1", 2);
    const result = await h.coordination.askPeer({
      role: "coder", question: "hang?", timeout_s: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "timeout");
      assert.ok(result.correlation_id);
    }
  });

  test("two concurrent asks are isolated by correlation id", async () => {
    h.registry.rows = [
      makeAgent({ id: "A1", role: "coder", status: "running" }),
      makeAgent({ id: "A2", role: "tester", status: "running" }),
    ];
    h.slots.set("A1", 2);
    h.slots.set("A2", 3);

    const p1 = h.coordination.askPeer({ role: "coder", question: "Q1", timeout_s: 2 });
    const p2 = h.coordination.askPeer({ role: "tester", question: "Q2", timeout_s: 2 });

    await new Promise((r) => setImmediate(r));
    assert.equal(h.bus.sent.length, 2);
    const id1 = /^\[ASK ([0-9a-f-]+)\]/.exec(h.bus.sent[0].content)![1];
    const id2 = /^\[ASK ([0-9a-f-]+)\]/.exec(h.bus.sent[1].content)![1];
    assert.notEqual(id1, id2);

    h.eventBus.emit({
      kind: "done", task_id: id2,
      payload: { body: "A2 says hi" }, ts: new Date(),
    });
    const r2 = await p2;
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.answer, "A2 says hi");

    h.eventBus.emit({
      kind: "done", task_id: id1,
      payload: { body: "A1 says hi" }, ts: new Date(),
    });
    const r1 = await p1;
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.answer, "A1 says hi");
  });

  test("rejects bad input (zod)", async () => {
    await assert.rejects(() => h.coordination.askPeer({ role: "", question: "q" }));
    await assert.rejects(() => h.coordination.askPeer({ role: "coder", question: "" }));
    await assert.rejects(() =>
      h.coordination.askPeer({ role: "coder", question: "q", timeout_s: 0 }),
    );
  });
});
