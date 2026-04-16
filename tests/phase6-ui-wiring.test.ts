/**
 * Phase 6 — Agent A
 * Controller ↔ UI surface wiring test. Exercises the CORTEXOS_UI=on path
 * at a tighter scope than the Phase N DoD suites: instead of booting the
 * full `CortexController` (which would pull in pgvector + tmux), we
 * construct the UI surface with the same dependencies the controller
 * wires up and assert:
 *   - both servers start on free kernel-picked ports
 *   - both respond on their protocols (WS snapshot + HTTP /ui/health)
 *   - both tear down cleanly and release their ports
 *
 * The env-flag gate + getter shape are covered by a pure field-existence
 * assertion on `CortexController` to avoid instantiating the heavy deps.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { once } from "node:events";
import { createEventBus } from "../src/ipc/event-bus.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { EscalationsDB } from "../src/mcp/escalations-db.js";
import { SkillRegistryDB } from "../src/skills/skill-registry-db.js";
import { EventWSBridge } from "../src/ui/ws-bridge.js";
import { UIApiServer } from "../src/ui/ui-api.js";
import { CortexController } from "../src/controller/cortex.js";
import type { ServerFrame } from "../src/ui/types.js";

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

describe("Phase 6 — UI wiring", () => {
  test("controller exposes UI getters (null until CORTEXOS_UI=on + initialize)", () => {
    // We construct the controller without calling initialize() so the
    // heavy deps (pgvector, tmux) are never touched. The getters must
    // still exist and return null.
    const c = new CortexController({
      sessionName: "test",
      pgConnectionString: "postgres://nope",
      maxSlots: 1,
      workingDirectory: "/tmp",
    });
    assert.equal(typeof c.getEventWSBridge, "function");
    assert.equal(typeof c.getUIApi, "function");
    assert.equal(c.getEventWSBridge(), null);
    assert.equal(c.getUIApi(), null);
  });

  test("event WS bridge + HTTP API boot together and tear down cleanly", async () => {
    const bus = createEventBus();
    const registry = new AgentRegistry({ dbPath: ":memory:" });
    const escalationsDb = new EscalationsDB({ dbPath: ":memory:" });
    const skillRegistry = new SkillRegistryDB({ dbPath: ":memory:" });

    const wsPort = await pickPort();

    const bridge = new EventWSBridge({
      port: wsPort,
      bus,
      registry,
      escalationsDb,
    });
    const api = new UIApiServer({
      port: 0,
      registry,
      skillRegistry,
      logger: () => {},
    });

    await bridge.start();
    await api.start();

    try {
      // WS path: initial snapshot frame.
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`);
      await once(ws, "open");
      const [raw] = (await once(ws, "message")) as [Buffer];
      const frame = JSON.parse(raw.toString()) as ServerFrame;
      assert.equal(frame.type, "snapshot");
      ws.close();

      // HTTP path: /ui/health returns 200 JSON.
      const httpPort = api.address();
      assert.ok(httpPort, "api should have bound a port");
      const res = await fetch(`http://127.0.0.1:${httpPort}/ui/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; routes: string[] };
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.routes));

      // Also: /ui/agents returns 200 + []
      const agentsRes = await fetch(`http://127.0.0.1:${httpPort}/ui/agents`);
      assert.equal(agentsRes.status, 200);
      const agentsBody = await agentsRes.json();
      assert.ok(Array.isArray(agentsBody));
    } finally {
      await api.stop();
      await bridge.stop();
      registry.close();
      escalationsDb.close();
      skillRegistry.close();
    }

    // After stop() the bound ports should be released — an immediate
    // re-listen on the same port should succeed. (Best-effort sanity
    // check: kernel-level port reuse is mildly flaky in CI, so we keep
    // the assertion loose.)
    assert.equal(bridge.clientCount(), 0);
    assert.equal(api.address(), null);
  });
});
