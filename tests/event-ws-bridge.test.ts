/**
 * Phase 6 — Agent A
 * Event WebSocket bridge (`src/ui/ws-bridge.ts`) tests. Exercises:
 *   - snapshot frame on connect
 *   - live event forwarding
 *   - query round-trip (agents, pending, escalations)
 *   - resolve-escalation round-trip
 *   - graceful shutdown
 *
 * Picks a free port per test to keep things parallel-safe.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { once } from "node:events";
import { createEventBus, type EventBus } from "../src/ipc/event-bus.js";
import { EscalationsDB } from "../src/mcp/escalations-db.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { EventWSBridge } from "../src/ui/ws-bridge.js";
import type { PendingItem, ServerFrame } from "../src/ui/types.js";

// Helper: fetch a free TCP port by letting the kernel pick one.
async function pickPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("Could not pick a port"));
      });
    });
    srv.on("error", reject);
  });
}

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(ws, "open");
  return ws;
}

async function nextFrame(ws: WebSocket): Promise<ServerFrame> {
  const [raw] = (await once(ws, "message")) as [Buffer];
  return JSON.parse(raw.toString()) as ServerFrame;
}

async function nextFrameOfType<T extends ServerFrame["type"]>(
  ws: WebSocket,
  type: T,
  timeoutMs = 1000,
): Promise<Extract<ServerFrame, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for frame type=${type}`);
    }
    const f = await nextFrame(ws);
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
}

describe("EventWSBridge", () => {
  let bus: EventBus;
  let bridge: EventWSBridge;
  let port: number;
  let escalationsDb: EscalationsDB;
  let registry: AgentRegistry;

  beforeEach(async () => {
    console.log("[beforeEach] pickPort");
    port = await pickPort();
    console.log("[beforeEach] port=", port);
    bus = createEventBus();
    escalationsDb = new EscalationsDB({ dbPath: ":memory:" });
    registry = new AgentRegistry({ dbPath: ":memory:" });
    console.log("[beforeEach] dbs opened");
    console.log("[beforeEach] constructing bridge...");

    // Seed a pending surface stub.
    const pending: PendingItem[] = [
      {
        id: 1,
        sensorName: "unsent-drafts",
        observation: "2 draft emails pending",
        urgency: 0.7,
        suggestedAction: "[Reply]",
        sampledAt: new Date().toISOString(),
      },
    ];

    bridge = new EventWSBridge({
      port,
      bus,
      registry,
      escalationsDb,
      pending: { list: () => pending },
    });
    console.log("[beforeEach] starting bridge");
    await bridge.start();
    console.log("[beforeEach] bridge started");
  });

  afterEach(async () => {
    await bridge.stop();
    escalationsDb.close();
    registry.close();
  });

  test("sends initial snapshot on connect", async () => {
    console.log("[t1] connecting");
    const ws = await connect(port);
    console.log("[t1] connected");
    try {
      const frame = await nextFrameOfType(ws, "snapshot");
      console.log("[t1] got snapshot");
      assert.equal(frame.type, "snapshot");
      assert.ok(Array.isArray(frame.agents));
      assert.ok(Array.isArray(frame.pending));
      assert.ok(Array.isArray(frame.recentEvents));
      assert.equal(frame.pending.length, 1);
      assert.equal(frame.pending[0].sensorName, "unsent-drafts");
    } finally {
      ws.close();
    }
  });

  test("forwards 5 live events from the bus", async () => {
    const ws = await connect(port);
    try {
      await nextFrameOfType(ws, "snapshot");

      const received: string[] = [];
      const collector = new Promise<void>((resolve) => {
        ws.on("message", (raw) => {
          const f = JSON.parse(raw.toString()) as ServerFrame;
          if (f.type === "event") {
            received.push(f.event.kind);
            if (received.length === 5) resolve();
          }
        });
      });

      for (let i = 0; i < 5; i++) {
        bus.emit({ kind: "heartbeat", ts: new Date(), payload: { i } });
      }

      await collector;
      assert.equal(received.length, 5);
      assert.ok(received.every((k) => k === "heartbeat"));
    } finally {
      ws.close();
    }
  });

  test("query round-trip: agents", async () => {
    registry.spawn({
      id: "agent-1",
      role: "coder",
      color: "#00ff88",
      tmux_session: "slot1_coder",
    });

    const ws = await connect(port);
    try {
      await nextFrameOfType(ws, "snapshot");
      ws.send(
        JSON.stringify({ type: "query", query: "agents", requestId: "r1" }),
      );
      const result = await nextFrameOfType(ws, "query-result");
      assert.equal(result.query, "agents");
      assert.equal(result.requestId, "r1");
      assert.ok(Array.isArray(result.data));
      const rows = result.data as Array<{ id: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "agent-1");
    } finally {
      ws.close();
    }
  });

  test("query round-trip: escalations (pending only)", async () => {
    escalationsDb.create({ question: "Deploy to prod?", level: "blocker" });
    escalationsDb.create({ question: "Answered", level: "info" });
    const all = escalationsDb.list();
    escalationsDb.resolve(all[0].id, { resolution: "yes", resolved_by: "me" });

    const ws = await connect(port);
    try {
      await nextFrameOfType(ws, "snapshot");
      ws.send(JSON.stringify({ type: "query", query: "escalations" }));
      const result = await nextFrameOfType(ws, "query-result");
      const rows = result.data as Array<{ resolved: boolean }>;
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.resolved === false));
    } finally {
      ws.close();
    }
  });

  test("resolve-escalation round-trip marks row resolved", async () => {
    const row = escalationsDb.create({ question: "Ship it?" });

    const ws = await connect(port);
    try {
      await nextFrameOfType(ws, "snapshot");
      ws.send(
        JSON.stringify({
          type: "resolve-escalation",
          id: row.id,
          resolution: "yes",
          resolved_by: "joel",
          requestId: "r2",
        }),
      );
      const ack = await nextFrameOfType(ws, "resolve-escalation-ack");
      assert.equal(ack.ok, true);
      assert.equal(ack.id, row.id);
      assert.equal(ack.requestId, "r2");

      const after = escalationsDb.getById(row.id);
      assert.ok(after);
      assert.equal(after!.resolved, true);
      assert.equal(after!.resolution, "yes");
      assert.equal(after!.resolved_by, "joel");
    } finally {
      ws.close();
    }
  });

  test("resolve-escalation rejects unknown id with ok=false", async () => {
    const ws = await connect(port);
    try {
      await nextFrameOfType(ws, "snapshot");
      ws.send(
        JSON.stringify({
          type: "resolve-escalation",
          id: "esc_nope",
          resolution: "x",
        }),
      );
      const ack = await nextFrameOfType(ws, "resolve-escalation-ack");
      assert.equal(ack.ok, false);
      assert.ok(ack.error);
    } finally {
      ws.close();
    }
  });

  test("invalid JSON frame emits error response", async () => {
    const ws = await connect(port);
    try {
      await nextFrameOfType(ws, "snapshot");
      ws.send("{not-json");
      const err = await nextFrameOfType(ws, "error");
      assert.match(err.message, /Invalid JSON/);
    } finally {
      ws.close();
    }
  });

  test("clientCount tracks open connections", async () => {
    assert.equal(bridge.clientCount(), 0);
    const a = await connect(port);
    const b = await connect(port);
    // Give the server a tick to register.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.clientCount(), 2);
    a.close();
    b.close();
  });
});
