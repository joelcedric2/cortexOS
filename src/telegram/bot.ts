import { Bot } from "grammy";
import type { CortexController } from "../controller/cortex.js";
import type { AgentRole } from "../agents/roles.js";
import { isValidRole } from "../agents/roles.js";
import type { AgentProvider } from "../agents/agent.js";

export interface TelegramBotConfig {
  token: string;
  allowedUserIds?: number[];
}

/**
 * Telegram bot interface for CortexOS.
 * Allows remote control of agents, memory queries, and status checks.
 */
export class CortexTelegramBot {
  private readonly bot: Bot;
  private readonly allowedUsers: Set<number>;

  constructor(
    config: TelegramBotConfig,
    private readonly controller: CortexController,
  ) {
    this.bot = new Bot(config.token);
    this.allowedUsers = new Set(config.allowedUserIds ?? []);
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      if (this.allowedUsers.size > 0 && ctx.from) {
        if (!this.allowedUsers.has(ctx.from.id)) {
          await ctx.reply("Unauthorized.");
          return;
        }
      }
      await next();
    });

    this.bot.command("status", async (ctx) => {
      try {
        const status = this.controller.getStatus();
        const lines = status.slots.map((s) => {
          const state = s.occupied
            ? `${s.provider}/${s.agentRole}`
            : "empty";
          const label = s.slotIndex === 0 ? "PERM" : "ROT ";
          return `Slot ${s.slotIndex} [${label}]: ${state}`;
        });
        await ctx.reply(lines.join("\n"));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${message}`);
      }
    });

    this.bot.command("spawn", async (ctx) => {
      try {
        const args = ctx.message?.text?.split(" ").slice(1) ?? [];
        const role = args[0];
        const provider = args[1] as AgentProvider | undefined;
        if (!role || !isValidRole(role)) {
          await ctx.reply("Usage: /spawn <role> [provider]");
          return;
        }
        const slot = await this.controller.spawnAgent(role as AgentRole, provider);
        await ctx.reply(`Spawned ${role} in slot ${slot}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${message}`);
      }
    });

    this.bot.command("kill", async (ctx) => {
      try {
        const slotStr = ctx.message?.text?.split(" ")[1];
        if (!slotStr) {
          await ctx.reply("Usage: /kill <slot>");
          return;
        }
        await this.controller.killAgent(parseInt(slotStr, 10));
        await ctx.reply(`Killed agent in slot ${slotStr}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${message}`);
      }
    });

    this.bot.command("send", async (ctx) => {
      try {
        const parts = ctx.message?.text?.split(" ").slice(1) ?? [];
        const slot = parseInt(parts[0], 10);
        const message = parts.slice(1).join(" ");
        if (isNaN(slot) || !message) {
          await ctx.reply("Usage: /send <slot> <message>");
          return;
        }
        await this.controller.sendMessage(slot, message);
        await ctx.reply(`Sent to slot ${slot}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${message}`);
      }
    });

    this.bot.command("recall", async (ctx) => {
      try {
        const query = ctx.message?.text?.split(" ").slice(1).join(" ");
        if (!query) {
          await ctx.reply("Usage: /recall <query>");
          return;
        }
        const results = await this.controller.queryMemory(query, 5);
        if (results.length === 0) {
          await ctx.reply("No matching memories.");
          return;
        }
        const lines = results.map((r) => {
          const pct = Math.round(r.similarity * 100);
          return `[${r.outcome.toUpperCase()}] ${pct}% | ${r.agentRole}: ${r.content.slice(0, 80)}`;
        });
        await ctx.reply(lines.join("\n\n"));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${message}`);
      }
    });

    this.bot.command("broadcast", async (ctx) => {
      try {
        const message = ctx.message?.text?.split(" ").slice(1).join(" ");
        if (!message) {
          await ctx.reply("Usage: /broadcast <message>");
          return;
        }
        await this.controller.sendMessage(0, `[BROADCAST] ${message}`);
        await ctx.reply("Broadcast sent to System Designer");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${message}`);
      }
    });
  }

  async start(): Promise<void> {
    console.log("[CortexOS] Telegram bot starting...");
    this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
