#!/usr/bin/env node

import { Command } from "commander";
import { CortexController } from "./controller/cortex.js";
import { ipcCall, isControllerRunning } from "./ipc/client.js";
import { isValidRole } from "./agents/roles.js";
import type { AgentRole } from "./agents/roles.js";
import type { AgentProvider } from "./agents/agent.js";

const DEFAULT_PG = "postgresql://localhost:5432/cortexos";
const DEFAULT_SESSION = "cortexos";

function createController(opts: { pg?: string; slots?: string }): CortexController {
  return new CortexController({
    sessionName: DEFAULT_SESSION,
    pgConnectionString: opts.pg ?? process.env.CORTEXOS_PG ?? DEFAULT_PG,
    maxSlots: parseInt(opts.slots ?? "3", 10),
    workingDirectory: process.cwd(),
  });
}

const program = new Command();

program
  .name("cortex")
  .description("CortexOS — Multi-AI CLI orchestrator with shared persistent memory")
  .version("0.1.0");

program
  .command("start")
  .description("Initialize CortexOS and spawn the System Designer in slot 0")
  .option("-s, --slots <number>", "Number of rotating slots", "3")
  .option("--pg <url>", "PostgreSQL connection string")
  .option("--no-designer", "Skip spawning System Designer in slot 0")
  .action(async (opts) => {
    const cortex = createController(opts);
    await cortex.initialize();

    if (opts.designer !== false) {
      await cortex.spawnAgent("system-designer", "claude", 0);
      console.log("[CortexOS] System Designer running in slot 0 (permanent)");
    }

    console.log("[CortexOS] Ready. Use 'cortex spawn' to add agents.");

    // Keep process alive
    process.on("SIGINT", async () => {
      await cortex.shutdown();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await cortex.shutdown();
      process.exit(0);
    });

    process.on('uncaughtException', async (err) => {
      console.error('[CortexOS] Fatal error:', err.message);
      await cortex.shutdown();
      process.exit(1);
    });
    process.on('unhandledRejection', async (err) => {
      console.error('[CortexOS] Unhandled rejection:', err);
      await cortex.shutdown();
      process.exit(1);
    });

    // Wire Telegram bot if token is set
    const telegramToken = process.env.CORTEXOS_TELEGRAM_TOKEN;
    if (telegramToken) {
      const { CortexTelegramBot } = await import('./telegram/bot.js');
      const bot = new CortexTelegramBot(
        { token: telegramToken, allowedUserIds: process.env.CORTEXOS_TELEGRAM_USERS?.split(',').map(Number) },
        cortex
      );
      await bot.start();
      console.log('[CortexOS] Telegram bot started');
    }

    // Block forever
    await new Promise(() => {});
  });

program
  .command("run <task...>")
  .description("Give CortexOS a task — it plans, spawns agents, opens terminals, and executes")
  .option("-s, --slots <number>", "Number of rotating slots", "3")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (taskParts: string[], opts) => {
    const task = taskParts.join(" ");
    const cortex = createController(opts);
    await cortex.initialize();

    const { Orchestrator } = await import("./orchestrator/orchestrator.js");
    const { TmuxManager } = await import("./tmux/tmux-manager.js");
    const orchestrator = new Orchestrator(cortex, new TmuxManager());

    await orchestrator.execute(task);

    // Keep alive so terminals stay open
    process.on("SIGINT", async () => {
      await cortex.shutdown();
      process.exit(0);
    });
    await new Promise(() => {});
  });

program
  .command("spawn")
  .description("Spawn an agent in a rotating slot")
  .requiredOption("-r, --role <role>", "Agent role (backend, frontend, security, etc.)")
  .option("-p, --provider <provider>", "AI provider (claude, gemini, codex)")
  .option("-s, --slot <number>", "Target slot number")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (opts) => {
    if (!isValidRole(opts.role)) {
      console.error(`Invalid role: ${opts.role}`);
      process.exit(1);
    }
    if (isControllerRunning()) {
      const result = (await ipcCall("spawn", {
        role: opts.role,
        provider: opts.provider,
        slot: opts.slot ? parseInt(opts.slot, 10) : undefined,
      })) as { slot: number };
      console.log(`Agent spawned in slot ${result.slot}`);
    } else {
      const cortex = createController(opts);
      await cortex.initialize();
      const slot = await cortex.spawnAgent(
        opts.role as AgentRole,
        opts.provider as AgentProvider | undefined,
        opts.slot ? parseInt(opts.slot, 10) : undefined,
      );
      console.log(`Agent spawned in slot ${slot}`);
    }
  });

program
  .command("kill")
  .description("Kill an agent in a slot")
  .requiredOption("-s, --slot <number>", "Slot number to kill")
  .option("-l, --learning <text>", "Learning to persist before killing")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (opts) => {
    if (isControllerRunning()) {
      await ipcCall("kill", {
        slot: parseInt(opts.slot, 10),
        learning: opts.learning,
      });
      console.log(`Killed agent in slot ${opts.slot}`);
    } else {
      const cortex = createController(opts);
      await cortex.initialize();
      await cortex.killAgent(parseInt(opts.slot, 10), opts.learning);
    }
  });

program
  .command("send")
  .description("Send a message/task to an agent")
  .requiredOption("-s, --slot <number>", "Target slot number")
  .requiredOption("-m, --message <message>", "Message content")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (opts) => {
    if (isControllerRunning()) {
      await ipcCall("send", {
        slot: parseInt(opts.slot, 10),
        message: opts.message,
      });
      console.log(`Message sent to slot ${opts.slot}`);
    } else {
      const cortex = createController(opts);
      await cortex.sendMessage(parseInt(opts.slot, 10), opts.message);
      console.log(`Message sent to slot ${opts.slot}`);
    }
  });

program
  .command("status")
  .description("Show status of all slots and agents")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (_opts) => {
    if (isControllerRunning()) {
      const status = (await ipcCall("status", {})) as {
        slots: Array<{
          slotIndex: number;
          occupied: boolean;
          provider?: string;
          agentRole?: string;
          startedAt?: string;
        }>;
        sessions: string[];
      };
      console.log("\n=== CortexOS Status ===\n");
      for (const slot of status.slots) {
        const state = slot.occupied
          ? `${slot.provider}/${slot.agentRole} (since ${slot.startedAt ? new Date(slot.startedAt).toLocaleTimeString() : "unknown"})`
          : "empty";
        const label = slot.slotIndex === 0 ? "[PERMANENT]" : "[ROTATING] ";
        console.log(`  Slot ${slot.slotIndex} ${label}: ${state}`);
      }
      if (status.sessions.length > 0) {
        console.log("\n  Active sessions:");
        for (const s of status.sessions) {
          console.log(`    ${s}`);
        }
      }
      console.log();
    } else {
      console.log("\n=== CortexOS Status ===\n");
      console.log("  CortexOS is not running. Start it with: cortex start\n");
    }
  });

program
  .command("recall")
  .description("Query vector memory for relevant learnings")
  .requiredOption("-q, --query <query>", "Search query")
  .option("-k, --top-k <number>", "Number of results", "5")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (opts) => {
    if (isControllerRunning()) {
      const results = (await ipcCall("recall", {
        query: opts.query,
        topK: parseInt(opts.topK, 10),
      })) as Array<{
        similarity: number;
        outcome: string;
        agentRole: string;
        taskType: string;
        content: string;
      }>;
      if (results.length === 0) {
        console.log("No matching memories found.");
        return;
      }
      console.log(`\n=== Top ${results.length} Memories ===\n`);
      for (const r of results) {
        const pct = Math.round(r.similarity * 100);
        const tag = r.outcome === "success" ? "SUCCESS" : "FAIL";
        console.log(`  [${tag}] ${pct}% match | ${r.agentRole} | ${r.taskType}`);
        console.log(`    ${r.content.slice(0, 120)}`);
        console.log();
      }
    } else {
      const cortex = createController(opts);
      const results = await cortex.queryMemory(opts.query, parseInt(opts.topK, 10));
      if (results.length === 0) {
        console.log("No matching memories found.");
        return;
      }
      console.log(`\n=== Top ${results.length} Memories ===\n`);
      for (const r of results) {
        const pct = Math.round(r.similarity * 100);
        const tag = r.outcome === "success" ? "SUCCESS" : "FAIL";
        console.log(`  [${tag}] ${pct}% match | ${r.agentRole} | ${r.taskType}`);
        console.log(`    ${r.content.slice(0, 120)}`);
        console.log();
      }
    }
  });

program
  .command("learn")
  .description("Manually store a learning in vector memory")
  .requiredOption("-r, --role <role>", "Agent role that learned this")
  .requiredOption("-c, --content <content>", "What was learned")
  .option("-t, --task-type <type>", "Task type", "manual")
  .option("-o, --outcome <outcome>", "Outcome (success/fail)", "success")
  .option("--tags <tags>", "Comma-separated tags")
  .option("--pg <url>", "PostgreSQL connection string")
  .action(async (opts) => {
    const cortex = createController(opts);
    await cortex.initialize();
    await cortex.queryMemory(opts.content, 0); // warm up embedder
    console.log("Storing learning...");
    // Use the learning loop directly via controller internals isn't ideal,
    // so we go through queryMemory to ensure embedder is initialized, then store
    const { Embedder } = await import("./memory/embedder.js");
    const { VectorStore } = await import("./memory/vector-store.js");
    const embedder = new Embedder();
    const vs = new VectorStore(opts.pg ?? process.env.CORTEXOS_PG ?? DEFAULT_PG);
    await vs.initialize();
    const emb = await embedder.embed(opts.content);
    const id = await vs.storeMemory({
      agentRole: opts.role,
      taskType: opts.taskType,
      content: opts.content,
      embedding: emb,
      outcome: opts.outcome as "success" | "fail",
      tags: opts.tags ? opts.tags.split(",") : [opts.role],
    });
    await vs.close();
    console.log(`Learning stored: ${id}`);
  });

program.parse();
