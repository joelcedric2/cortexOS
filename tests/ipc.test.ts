/**
 * Phase 1 — Agent A
 *
 * Tests for the event bus, events SQLite persistence, and the HTTP hooks server.
 *
 * Uses Node 20's built-in test runner (`node:test`) + `node:assert`. Run via:
 *     npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";
import { openEventsDB } from "../src/ipc/events-db.js";
import { startHooksServer } from "../src/ipc/server.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cortexos-events-"));
  return join(dir, "events.db");
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getJson(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("EventBus: subscribe + emit", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  const unsub = bus.subscribe({ kind: "done" }, (e) => seen.push(e));

  bus.emit({ kind: "done", session_id: "s1", ts: new Date() });
  bus.emit({ kind: "heartbeat", session_id: "s1", ts: new Date() }); // filtered out
  bus.emit({ kind: "done", session_id: "s2", ts: new Date() });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].session_id, "s1");
  assert.equal(seen[1].session_id, "s2");

  unsub();
  bus.emit({ kind: "done", session_id: "s3", ts: new Date() });
  assert.equal(seen.length, 2, "unsubscribe must stop delivery");
});

test("EventBus: subscribe filters on multiple fields (AND)", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe({ kind: "done", slot: 2 }, (e) => seen.push(e));

  bus.emit({ kind: "done", slot: 1, ts: new Date() });
  bus.emit({ kind: "done", slot: 2, ts: new Date() });
  bus.emit({ kind: "heartbeat", slot: 2, ts: new Date() });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].slot, 2);
});

test("EventBus: once resolves on match", async () => {
  const bus = createEventBus();
  const p = bus.once({ kind: "compact", session_id: "x" }, 1000);
  bus.emit({ kind: "compact", session_id: "y", ts: new Date() });
  bus.emit({ kind: "compact", session_id: "x", ts: new Date() });
  const e = await p;
  assert.equal(e.session_id, "x");
});

test("EventBus: once rejects on timeout", async () => {
  const bus = createEventBus();
  await assert.rejects(
    () => bus.once({ kind: "done" }, 50),
    /timed out after 50ms/,
  );
});

test("eventsDB: insert + retrieve", async () => {
  const db = await openEventsDB(tmpDbPath());
  try {
    const id = db.insert({
      kind: "done",
      session_id: "sess-1",
      agent_id: "ag-1",
      slot: 3,
      payload: { hello: "world" },
    });
    assert.ok(id > 0);

    const rows = db.bySession("sess-1", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "done");
    assert.equal(rows[0].slot, 3);
    assert.equal(rows[0].agent_id, "ag-1");
    assert.deepEqual(JSON.parse(rows[0].payload_json!), { hello: "world" });
    assert.equal(db.count(), 1);
  } finally {
    db.close();
  }
});

test("hooks server: GET /health responds with uptime and events_seen", async () => {
  const bus = createEventBus();
  const db = await openEventsDB(tmpDbPath());
  const handle = await startHooksServer({ bus, db, port: 0 });
  try {
    const { status, body } = await getJson(handle.port, "/health");
    assert.equal(status, 200);
    const b = body as { ok: boolean; uptime_s: number; events_seen: number };
    assert.equal(b.ok, true);
    assert.equal(typeof b.uptime_s, "number");
    assert.equal(b.events_seen, 0);
  } finally {
    await handle.close();
    db.close();
  }
});

test("hooks server: POST /hooks/stop inserts row, fires 'done' event, bumps events_seen", async () => {
  const bus = createEventBus();
  const db = await openEventsDB(tmpDbPath());
  const handle = await startHooksServer({ bus, db, port: 0 });

  try {
    const onDone = bus.once({ kind: "done", session_id: "hooked" }, 2000);

    const { status, body } = await postJson(handle.port, "/hooks/stop", {
      session_id: "hooked",
      agent_id: "coder-a",
      slot: 1,
      transcript_tail: "last line",
      exit_reason: "stop",
      ts: new Date().toISOString(),
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });

    const evt = await onDone;
    assert.equal(evt.kind, "done");
    assert.equal(evt.session_id, "hooked");
    assert.equal(evt.slot, 1);

    const rows = db.bySession("hooked", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "done");
    assert.equal(rows[0].agent_id, "coder-a");

    const health = await getJson(handle.port, "/health");
    assert.equal((health.body as { events_seen: number }).events_seen, 1);
  } finally {
    await handle.close();
    db.close();
  }
});

test("hooks server: POST /hooks/pre-compact returns 202 and fires 'compact' event", async () => {
  const bus = createEventBus();
  const db = await openEventsDB(tmpDbPath());
  const handle = await startHooksServer({ bus, db, port: 0 });

  try {
    const onCompact = bus.once(
      { kind: "compact", session_id: "compact-1" },
      2000,
    );
    const { status, body } = await postJson(handle.port, "/hooks/pre-compact", {
      session_id: "compact-1",
      transcript_path: "/does/not/exist.jsonl",
      task_id: "t-9",
    });
    assert.equal(status, 202);
    assert.equal((body as { ok: boolean }).ok, true);

    const evt = await onCompact;
    assert.equal(evt.session_id, "compact-1");
    assert.equal(evt.task_id, "t-9");

    const rows = db.bySession("compact-1", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "compact");
  } finally {
    await handle.close();
    db.close();
  }
});

test("hooks server: POST with invalid JSON returns 400", async () => {
  const bus = createEventBus();
  const db = await openEventsDB(tmpDbPath());
  const handle = await startHooksServer({ bus, db, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/hooks/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{this is not json",
    });
    assert.equal(res.status, 400);
  } finally {
    await handle.close();
    db.close();
  }
});

test("hooks server: unknown routes return 404", async () => {
  const bus = createEventBus();
  const db = await openEventsDB(tmpDbPath());
  const handle = await startHooksServer({ bus, db, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await handle.close();
    db.close();
  }
});
