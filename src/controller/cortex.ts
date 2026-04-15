import { SlotManager } from "./slot-manager.js";
import { TmuxManager } from "../tmux/tmux-manager.js";
import { checkBinaryExists } from "../agents/binary-check.js";
import { VectorStore } from "../memory/vector-store.js";
import { Embedder } from "../memory/embedder.js";
import { LearningLoop } from "../memory/learning-loop.js";
import { MessageBus } from "../communication/message-bus.js";
import { MessageRouter } from "../communication/router.js";
import { ClaudeAgent } from "../agents/claude-agent.js";
import { GeminiAgent } from "../agents/gemini-agent.js";
import { CodexAgent } from "../agents/codex-agent.js";
import { buildAgentClaudeMd, colorForRole } from "../config/roles.js";
import { isValidRole, getRoleDefinition } from "../agents/roles.js";
import type { AgentRole } from "../agents/roles.js";
import type { Agent, AgentProvider, AgentHandle } from "../agents/agent.js";
import type { MemorySearchResult } from "../memory/vector-store.js";
import { IpcServer, startHooksServer, makeDefaultPersistCompact } from "../ipc/server.js";
import { BriefStore } from "../research/brief-store.js";
import type { IpcRequest, IpcResponse, HooksServerHandle } from "../ipc/server.js";
import { createEventBus, type EventBus } from "../ipc/event-bus.js";
import { openEventsDB, type EventsDB } from "../ipc/events-db.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface CortexConfig {
  sessionName: string;
  pgConnectionString: string;
  maxSlots: number;
  workingDirectory: string;
  telegramToken?: string;
}

export class CortexController {
  private readonly slotManager: SlotManager;
  private readonly tmux: TmuxManager;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly learningLoop: LearningLoop;
  private readonly messageBus: MessageBus;
  private readonly router: MessageRouter;
  private readonly agents: Map<AgentProvider, Agent>;
  private readonly handles: Map<number, AgentHandle> = new Map();
  private readonly bus: EventBus;
  private ipcServer: IpcServer | null = null;
  private hooksServer: HooksServerHandle | null = null;
  private eventsDb: EventsDB | null = null;
  private briefStore: BriefStore | null = null;
  private initialized = false;

  constructor(private readonly config: CortexConfig) {
    this.tmux = new TmuxManager();
    this.slotManager = new SlotManager(config.maxSlots);
    this.vectorStore = new VectorStore(config.pgConnectionString);
    this.embedder = new Embedder();
    this.learningLoop = new LearningLoop(this.vectorStore, this.embedder);
    this.messageBus = new MessageBus(this.tmux, this.slotManager, this.vectorStore);
    this.router = new MessageRouter(this.messageBus, this.slotManager);
    // Single process-wide EventBus — shared between hooks server and orchestrator.
    this.bus = createEventBus();

    this.agents = new Map<AgentProvider, Agent>([
      ["claude", new ClaudeAgent(this.tmux)],
      ["gemini", new GeminiAgent(this.tmux)],
      ["codex", new CodexAgent(this.tmux)],
    ]);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure tmux is installed
    if (!(await checkBinaryExists("tmux"))) {
      throw new Error("tmux is not installed. Install it with: brew install tmux");
    }

    // Initialize vector store and embedder in parallel
    await Promise.all([
      this.vectorStore.initialize(),
      this.embedder.initialize(),
    ]);

    // BriefStore depends on both being ready — instantiate now so the
    // Orchestrator can recall prior research into the Designer's prompt.
    this.briefStore = new BriefStore({
      vectorStore: this.vectorStore,
      embedder: this.embedder,
    });

    // Clean up orphaned sessions from previous crashes
    const orphans = await this.tmux.listSessions();
    for (const name of orphans) {
      console.log(`[CortexOS] Cleaning up orphaned session: ${name}`);
      await this.tmux.destroySession(name);
    }

    // Start IPC server so CLI subcommands can reach this process
    this.ipcServer = new IpcServer(this.handleIpcRequest.bind(this));
    this.ipcServer.start();

    // Start HTTP hooks server so Claude Code CLI instances can POST Stop/PreCompact events.
    // Uses the same EventBus instance the orchestrator consumes, so hook emits fan out
    // to any .once() / .subscribe() callers in the same process.
    try {
      this.eventsDb = await openEventsDB();
      this.hooksServer = await startHooksServer({
        bus: this.bus,
        db: this.eventsDb,
        persistCompact: makeDefaultPersistCompact({
          embedder: this.embedder,
          vectorStore: this.vectorStore,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CortexOS] Hooks server failed to start: ${message}`);
    }

    this.initialized = true;
    console.log("[CortexOS] Initialized — pgvector connected, embedder loaded");
  }

  /** Process-wide event bus. Inject into Orchestrator so it sees hook events. */
  getBus(): EventBus {
    return this.bus;
  }

  /**
   * BriefStore — persistence + semantic recall for research Briefs. Valid
   * only after `initialize()` has completed (vectorStore + embedder ready).
   */
  getBriefStore(): BriefStore {
    if (!this.briefStore) {
      throw new Error(
        "BriefStore not initialized — call controller.initialize() first",
      );
    }
    return this.briefStore;
  }

  async handleIpcRequest(req: IpcRequest): Promise<IpcResponse> {
    try {
      switch (req.command) {
        case "spawn": {
          const slot = await this.spawnAgent(
            req.args.role as AgentRole,
            req.args.provider as AgentProvider | undefined,
            req.args.slot as number | undefined,
          );
          return { ok: true, data: { slot } };
        }
        case "kill": {
          await this.killAgent(
            req.args.slot as number,
            req.args.learning as string | undefined,
          );
          return { ok: true, data: { killed: req.args.slot } };
        }
        case "send": {
          await this.sendMessage(req.args.slot as number, req.args.message as string);
          return { ok: true, data: { sent: true } };
        }
        case "status": {
          return { ok: true, data: this.getStatus() };
        }
        case "recall": {
          const results = await this.queryMemory(
            req.args.query as string,
            (req.args.topK as number) ?? 5,
          );
          return { ok: true, data: results };
        }
        default:
          return { ok: false, error: `Unknown command: ${req.command}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async spawnAgent(
    role: AgentRole,
    provider?: AgentProvider,
    slot?: number,
  ): Promise<number> {
    if (!this.initialized) await this.initialize();
    if (!isValidRole(role)) throw new Error(`Invalid role: ${role}`);

    const resolvedProvider = provider ?? getRoleDefinition(role).defaultProvider;
    const agent = this.agents.get(resolvedProvider);
    if (!agent) throw new Error(`Unknown provider: ${resolvedProvider}`);

    // Allocate a slot (may evict the oldest agent)
    const allocation = this.slotManager.allocateSlot(role, resolvedProvider, slot);

    // If an agent was evicted, persist its learnings and kill its tmux session
    if (allocation.evicted) {
      console.log(
        `[CortexOS] Evicting ${allocation.evictedRole} from slot ${allocation.slotIndex} to make room for ${role}`,
      );
      try {
        await this.killAgent(allocation.slotIndex);
      } catch {
        // Slot already reset by allocateSlot; best-effort cleanup of handle/tmux
      }
    }

    const slotIndex = allocation.slotIndex;
    const sessionName = `slot${slotIndex}_${role}`;

    // Build CLAUDE.md with past learnings injected
    const pastLearnings = await this.learningLoop.onTaskStart({
      role,
      taskDescription: `Starting ${role} agent`,
    });
    const learningsContext = this.learningLoop.formatLearningsForContext(pastLearnings);
    const claudeMd = await buildAgentClaudeMd(role, learningsContext || undefined);

    // Create per-agent working directory with role instructions
    const agentWorkDir = join(this.config.workingDirectory, ".cortexos-agents", sessionName);
    await mkdir(agentWorkDir, { recursive: true });
    const claudeMdPath = join(agentWorkDir, "CLAUDE.md");
    await writeFile(claudeMdPath, claudeMd, "utf-8");

    // Create tmux session rooted in the agent's own directory
    await this.tmux.createSession(sessionName, agentWorkDir);

    // Color the pane border by role (Nchinda plan §5.3) — purely cosmetic.
    try {
      await this.tmux.setPaneBorderColor(sessionName, colorForRole(role));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CortexOS] Could not set pane border color: ${message}`);
    }

    const handle = await agent.spawn(
      {
        role,
        provider: resolvedProvider,
        workingDirectory: agentWorkDir,
        claudeMdPath,
      },
      sessionName,
    );
    handle.slot = slotIndex;

    // Track the handle and update slot state
    this.handles.set(slotIndex, handle);
    const slotState = this.slotManager.getSlot(slotIndex);
    if (slotState) slotState.sessionName = sessionName;

    console.log(
      `[CortexOS] Spawned ${resolvedProvider}/${role} in slot ${slotIndex} (session: ${sessionName})`,
    );
    return slotIndex;
  }

  async killAgent(slot: number, learning?: string): Promise<void> {
    const handle = this.handles.get(slot);
    if (!handle) throw new Error(`No agent in slot ${slot}`);

    // Persist learnings before kill
    if (learning) {
      await this.learningLoop.onTaskComplete({
        agentRole: handle.role,
        taskType: "general",
        content: learning,
        outcome: "success",
        tags: [handle.role, handle.provider],
      });
    }

    // Stop agent and destroy tmux session
    const agent = this.agents.get(handle.provider);
    if (agent) await agent.stop(handle);

    try {
      await this.tmux.destroySession(handle.sessionName);
    } catch {
      // Session may already be gone
    }

    this.handles.delete(slot);
    if (slot !== 0) {
      this.slotManager.releaseSlot(slot);
    }
    console.log(`[CortexOS] Killed agent in slot ${slot}`);
  }

  async sendMessage(toSlot: number, message: string): Promise<void> {
    const handle = this.handles.get(toSlot);
    if (!handle) throw new Error(`No agent in slot ${toSlot}`);

    const agent = this.agents.get(handle.provider);
    if (agent) await agent.sendTask(handle, message);
  }

  async routeMessage(fromSlot: number, content: string): Promise<void> {
    await this.router.autoRoute(fromSlot, content);
  }

  async queryMemory(query: string, topK = 5): Promise<MemorySearchResult[]> {
    if (!this.initialized) await this.initialize();
    const embedding = await this.embedder.embed(query);
    return this.vectorStore.searchMemories(embedding, topK);
  }

  getStatus(): { slots: ReturnType<SlotManager["getAllSlots"]>; sessions: string[] } {
    return {
      slots: this.slotManager.getAllSlots(),
      sessions: Array.from(this.handles.entries()).map(
        ([slot, h]) => `slot${slot}: ${h.provider}/${h.role} (${h.sessionName})`,
      ),
    };
  }

  async shutdown(): Promise<void> {
    console.log("[CortexOS] Shutting down...");

    // Stop hooks server first (before the bus gets stale references)
    if (this.hooksServer) {
      try {
        await this.hooksServer.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[CortexOS] Hooks server close error: ${message}`);
      }
      this.hooksServer = null;
    }
    if (this.eventsDb) {
      try {
        this.eventsDb.close();
      } catch {
        // best-effort
      }
      this.eventsDb = null;
    }

    // Stop IPC server
    this.ipcServer?.stop();
    this.ipcServer = null;

    // Kill all agents (except slot 0 goes last)
    const slots = [...this.handles.keys()].sort((a, b) => b - a);
    for (const slot of slots) {
      try {
        await this.killAgent(slot);
      } catch {
        // Best effort cleanup
      }
    }

    await this.vectorStore.close();
    console.log("[CortexOS] Shutdown complete");
  }
}
