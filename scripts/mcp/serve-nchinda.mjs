#!/usr/bin/env node
/**
 * Minimal MCP stdio server that exposes nchinda_recall and nchinda_remember.
 *
 * Speaks JSON-RPC 2.0 framed as newline-delimited JSON on stdin/stdout. Just
 * enough of the MCP protocol to register with Claude Code CLI:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - notifications/initialized (ignored)
 *
 * Configure in your .mcp.json:
 *   "nchinda": {
 *     "command": "node",
 *     "args": ["scripts/mcp/serve-nchinda.mjs"],
 *     "env": { "DATABASE_URL": "postgres://..." }
 *   }
 *
 * On startup this lazily boots the Embedder + VectorStore. Both are heavy
 * (hf transformers + pg pool) — do not import at module load time; tests
 * and dry-runs should be able to source this file without side effects.
 */

import { createInterface } from "node:readline";

// Lazy-loaded so that --dry-run can introspect the tool list without
// paying the embedder boot cost.
let toolsInstance = null;

async function getTools() {
  if (toolsInstance) return toolsInstance;
  const [{ NchindaTools }, { VectorStore }, { Embedder }, { CronJobsDB }] = await Promise.all([
    import("../../dist/mcp/nchinda-tools.js"),
    import("../../dist/memory/vector-store.js"),
    import("../../dist/memory/embedder.js"),
    import("../../dist/scheduler/cron-jobs-db.js"),
  ]);
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    throw new Error("DATABASE_URL env var is required");
  }
  const store = new VectorStore(connStr);
  await store.initialize();
  const embedder = new Embedder();
  await embedder.initialize();
  const cronDb = new CronJobsDB();
  toolsInstance = new NchindaTools({
    vectorStore: store,
    embedder,
    cronDb,
    resolveAgentRole: () => process.env.NCHINDA_AGENT_ROLE,
  });
  return toolsInstance;
}

async function getToolSchemas() {
  const { NCHINDA_TOOL_SCHEMAS } = await import(
    "../../dist/mcp/tool-schema.js"
  );
  return NCHINDA_TOOL_SCHEMAS;
}

// --------------------------- JSON-RPC plumbing -----------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: "2.0", id, error: err });
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
      // No response required for notifications; tolerate both spellings.
      if (id !== undefined) reply(id, {});
      return;
    }

    if (method === "tools/list") {
      const schemas = await getToolSchemas();
      reply(id, { tools: schemas });
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      const tools = await getTools();
      let result;
      if (name === "nchinda_recall") {
        result = await tools.recall(args);
      } else if (name === "nchinda_remember") {
        result = await tools.remember(args);
      } else if (name === "nchinda_schedule") {
        result = await tools.schedule(args);
      } else {
        return replyError(id, -32601, `unknown tool: ${name}`);
      }
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
      return;
    }

    replyError(id, -32601, `method not found: ${method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    replyError(id, -32000, message);
  }
}

// --------------------------- Main loop -------------------------------------

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Protocol requires us to ignore malformed frames silently (not hang).
    return;
  }
  if (msg && msg.method) {
    void handleRequest(msg);
  }
});

rl.on("close", () => process.exit(0));
