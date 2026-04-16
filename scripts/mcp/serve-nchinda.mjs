#!/usr/bin/env node
/**
 * Minimal MCP stdio server for Nchinda.
 *
 * Speaks JSON-RPC 2.0 framed as newline-delimited JSON on stdin/stdout.
 *
 * Tools exposed:
 *   nchinda_recall, nchinda_remember, nchinda_schedule, nchinda_research,
 *   nchinda_send, nchinda_broadcast, nchinda_status, nchinda_escalate,
 *   nchinda_ask_peer
 */

import { createInterface } from "node:readline";

let toolsInstance = null;

async function getTools() {
  if (toolsInstance) return toolsInstance;
  const [
    { NchindaTools },
    { ResearchTool },
    { NchindaCoordination },
    { VectorStore },
    { Embedder },
    { CronJobsDB },
    { EscalationsDB },
    { getAgentRegistry },
    { MessageBus },
  ] = await Promise.all([
    import("../../dist/mcp/nchinda-tools.js"),
    import("../../dist/mcp/research-tool.js"),
    import("../../dist/mcp/nchinda-coordination.js"),
    import("../../dist/memory/vector-store.js"),
    import("../../dist/memory/embedder.js"),
    import("../../dist/scheduler/cron-jobs-db.js"),
    import("../../dist/mcp/escalations-db.js"),
    import("../../dist/registry/agent-registry.js"),
    import("../../dist/communication/message-bus.js"),
  ]);
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error("DATABASE_URL env var is required");

  const store = new VectorStore(connStr);
  await store.initialize();
  const embedder = new Embedder();
  await embedder.initialize();
  const cronDb = new CronJobsDB();
  const escalationsDb = new EscalationsDB();
  const registry = getAgentRegistry();

  const nchindaTools = new NchindaTools({
    vectorStore: store,
    embedder,
    cronDb,
    resolveAgentRole: () => process.env.NCHINDA_AGENT_ROLE,
  });
  const researchTool = new ResearchTool();

  // Coordination tools: Orchestrator wires the live MessageBus / SlotManager
  // by assigning globalThis.NCHINDA_RUNTIME before spawning the server.
  // Absent that, we build a MessageBus with whatever handles are in env.
  const runtime = globalThis.NCHINDA_RUNTIME ?? {};
  const messageBus =
    runtime.messageBus ??
    new MessageBus(runtime.tmux, runtime.slotManager, store);
  const slotMap = runtime.slotMap ?? parseSlotMap(process.env.NCHINDA_SLOTS_JSON);
  const coordination = new NchindaCoordination({
    messageBus,
    registry,
    eventBus: runtime.eventBus,
    escalationsDb,
    resolvePeerSlot: (agent) => slotMap.get(agent.id),
  });

  toolsInstance = { nchindaTools, researchTool, coordination };
  return toolsInstance;
}

function parseSlotMap(raw) {
  const map = new Map();
  if (!raw) return map;
  try {
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number") map.set(k, v);
    }
  } catch {
    // malformed env var — silently ignore; callers get `no-peer` responses.
  }
  return map;
}

async function getToolSchemas() {
  const { NCHINDA_TOOL_SCHEMAS } = await import("../../dist/mcp/tool-schema.js");
  return NCHINDA_TOOL_SCHEMAS;
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: "2.0", id, error: err });
}

async function dispatch(name, args, tools) {
  switch (name) {
    case "nchinda_recall":     return await tools.nchindaTools.recall(args);
    case "nchinda_remember":   return await tools.nchindaTools.remember(args);
    case "nchinda_schedule":   return await tools.nchindaTools.schedule(args);
    case "nchinda_research":   return await tools.researchTool.research(args);
    case "nchinda_send":       return await tools.coordination.send(args);
    case "nchinda_broadcast":  return await tools.coordination.broadcast(args);
    case "nchinda_status":     return tools.coordination.status(args);
    case "nchinda_escalate":   return tools.coordination.escalate(args);
    case "nchinda_ask_peer":   return await tools.coordination.askPeer(args);
    case "nchinda_see": {
      const { nchindaSee } = await import("../../dist/mcp/nchinda-see.js");
      const { buildBrief } = await import("../../dist/perception/vision-brief.js");
      const { ScreenCapturer } = await import("../../dist/perception/screen-capture.js");
      // Runtime-shared capturer (wired by Orchestrator). Fallback: a fresh
      // instance that won't have called `.start()` yet — captureNow() still
      // works independently of the loop.
      const capturer = runtime.screenCapturer ?? new ScreenCapturer();
      return await nchindaSee(args ?? {}, { capturer, brief: buildBrief });
    }
    case "web_search": {
      const { webSearch } = await import("../../dist/tools/web-search.js");
      return await webSearch(args?.query ?? "", {
        limit: args?.limit,
        timeoutMs: args?.timeoutMs,
      });
    }
    case "tool_discovery": {
      const { toolDiscovery } = await import("../../dist/tools/tool-discovery.js");
      return await toolDiscovery(args?.need ?? "", {
        timeoutMs: args?.timeoutMs,
      });
    }
    case "skill_discover":
    case "skill_install":
    case "skill_use":
    case "skill_create": {
      const { getSkillTools } = await import("../../dist/mcp/skill-tools-wiring.js");
      const st = await getSkillTools();
      if (name === "skill_discover") return await st.discover(args);
      if (name === "skill_install") return await st.install(args);
      if (name === "skill_create") return await st.create(args);
      return await st.use(args);
    }
    case "social_send":
    case "social_post": {
      const { SocialTools } = await import("../../dist/mcp/social-tools.js");
      const { SocialDB } = await import("../../dist/social/social-db.js");
      const { createEventBus } = await import("../../dist/ipc/event-bus.js");
      const socialDb = new SocialDB();
      const eventBus = runtime.eventBus ?? createEventBus();
      const drivers = runtime.socialDrivers ?? new Map();
      const st = new SocialTools({ drivers, socialDb, eventBus });
      if (name === "social_send") return await st.send(args);
      return st.post(args);
    }
    default: {
      const err = new Error(`unknown tool: ${name}`);
      err.isUnknownTool = true;
      throw err;
    }
  }
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "nchinda", version: "0.1.0" },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      if (id !== undefined) reply(id, {});
      return;
    }
    if (method === "tools/list") {
      reply(id, { tools: await getToolSchemas() });
      return;
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      const tools = await getTools();
      let result;
      try {
        result = await dispatch(name, args, tools);
      } catch (err) {
        if (err && err.isUnknownTool) return replyError(id, -32601, err.message);
        throw err;
      }
      reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      return;
    }
    replyError(id, -32601, `method not found: ${method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    replyError(id, -32000, message);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg && msg.method) void handleRequest(msg);
});
rl.on("close", () => process.exit(0));
