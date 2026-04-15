import { freemem as osFreemem, totalmem as osTotalmem } from "node:os";
import type { AgentRegistry, AgentRecord } from "./agent-registry.js";
import type {
  AgentEvent,
  EventBus,
} from "../ipc/event-bus.js";

export interface PolicyDeps {
  registry: AgentRegistry;
  bus: EventBus;
  /** DI override for {@link os.freemem}. Bytes free, as a number. */
  freemem?: () => number;
  /** DI override for {@link os.totalmem}. Total bytes installed. */
  totalmem?: () => number;
  /**
   * Callback invoked when the engine decides an agent must be evicted
   * (e.g. killed from tmux, session destroyed). The registry is transitioned
   * to `error` AFTER this completes so callers have a terminal signal.
   */
  onEvict?: (agentId: string) => Promise<void>;
  /** Ratio of free memory below which we start LRU-evicting. Default 0.15. */
  memoryPressureThreshold?: number;
  /** Standby agents older than this (by last_heartbeat) get evicted. Default 10m. */
  idleStandbyMs?: number;
  /** How often the periodic tick fires. Default 60s. */
  tickIntervalMs?: number;
  /** DI override for Date.now — lets tests freeze "now". */
  now?: () => number;
}

/**
 * Anchor point for the two Nchinda §6 Phase 3 policy rules:
 *
 *   "Idle agents keep their session but sleep"
 *     → on `done` event we call registry.markStandby(agentId). The session
 *        stays warm until either (a) the user queues follow-up work or
 *        (b) the idle threshold expires.
 *
 *   "Memory pressure triggers LRU kill"
 *     → every periodic tick (default 60s) we check free/total memory; if we
 *        cross the pressure threshold we evict the oldest-heartbeat standby
 *        agent via `onEvict` (typically a tmux destroySession call), then
 *        mark it `error` in the registry.
 *
 * The engine is pure orchestration — it does not own the tmux sessions, only
 * the decisions about which agent is next to kill. Injecting `onEvict`
 * keeps the policy testable in isolation from the controller's spawn stack.
 */
export class PolicyEngine {
  private readonly registry: AgentRegistry;
  private readonly bus: EventBus;
  private readonly freemem: () => number;
  private readonly totalmem: () => number;
  private readonly onEvict: (agentId: string) => Promise<void>;
  private readonly memoryPressureThreshold: number;
  private readonly idleStandbyMs: number;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;

  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: PolicyDeps) {
    this.registry = deps.registry;
    this.bus = deps.bus;
    this.freemem = deps.freemem ?? osFreemem;
    this.totalmem = deps.totalmem ?? osTotalmem;
    this.onEvict = deps.onEvict ?? (async () => {});
    this.memoryPressureThreshold = deps.memoryPressureThreshold ?? 0.15;
    this.idleStandbyMs = deps.idleStandbyMs ?? 10 * 60 * 1000;
    this.tickIntervalMs = deps.tickIntervalMs ?? 60_000;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Wire up the `done`-event subscription and start the periodic tick.
   * Safe to call once; repeated `start()` without `stop()` is a no-op.
   */
  start(): void {
    if (this.unsubscribe === null) {
      this.unsubscribe = this.bus.subscribe({ kind: "done" }, (event) => {
        // Fire-and-forget: the bus is sync; we can't await handlers.
        // Errors are logged so a single bad event doesn't kill the subscription.
        this.onDoneEvent(event).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[PolicyEngine] onDoneEvent failed: ${message}`);
        });
      });
    }
    if (this.timer === null) {
      this.timer = setInterval(() => {
        this.periodicTick().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[PolicyEngine] periodicTick failed: ${message}`);
        });
      }, this.tickIntervalMs);
      // Don't hold the event loop open for the tick alone.
      this.timer.unref?.();
    }
  }

  /** Stop the subscription + timer. Idempotent. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Transition a done-event's agent to `standby` per the idle-agents policy.
   * Public so tests (and future callers) can invoke directly without a bus.
   */
  async onDoneEvent(event: AgentEvent): Promise<void> {
    const agentId = event.agent_id;
    if (!agentId) return;
    const record = this.registry.getById(agentId);
    if (!record) return;
    // Only transition `running` → `standby`. Respect terminal states so we
    // don't resurrect a manually-killed or errored agent.
    if (record.status !== "running") return;
    this.registry.markStandby(agentId);
  }

  /**
   * Single tick of the LRU + idle-sweep policy. Public for tests; production
   * callers should use `start()` and let the interval drive this.
   *
   * Order of operations matters:
   *   1. Idle sweep (may free memory, so it goes first).
   *   2. Memory-pressure LRU (only if we're still below the threshold).
   */
  async periodicTick(): Promise<void> {
    await this.sweepIdle();
    await this.sweepMemoryPressure();
  }

  private async sweepIdle(): Promise<void> {
    const agents = this.registry.list();
    const nowMs = this.now();
    const cutoff = nowMs - this.idleStandbyMs;
    for (const agent of agents) {
      if (agent.status !== "standby") continue;
      const hbMs = heartbeatMs(agent);
      if (hbMs !== null && hbMs < cutoff) {
        await this.evict(agent.id);
      }
    }
  }

  private async sweepMemoryPressure(): Promise<void> {
    const total = this.totalmem();
    const free = this.freemem();
    if (total <= 0) return;
    const ratio = free / total;
    if (ratio >= this.memoryPressureThreshold) return;

    // Evict oldest-heartbeat standby first (LRU). Fall back to oldest
    // start time if heartbeat is null.
    const agents = this.registry
      .list()
      .filter((a) => a.status === "standby")
      .sort((a, b) => {
        const ah = heartbeatMs(a) ?? Date.parse(a.started_at);
        const bh = heartbeatMs(b) ?? Date.parse(b.started_at);
        return ah - bh;
      });
    if (agents.length === 0) return;
    await this.evict(agents[0].id);
  }

  private async evict(agentId: string): Promise<void> {
    try {
      await this.onEvict(agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[PolicyEngine] onEvict callback failed for ${agentId}: ${message}`,
      );
    }
    try {
      this.registry.markError(agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[PolicyEngine] registry.markError failed for ${agentId}: ${message}`,
      );
    }
  }
}

/**
 * Parse an AgentRecord's last_heartbeat column (SQLite TEXT timestamp) into
 * epoch ms. Returns null if the column is null or not parseable.
 */
function heartbeatMs(record: AgentRecord): number | null {
  if (!record.last_heartbeat) return null;
  // SQLite CURRENT_TIMESTAMP produces "YYYY-MM-DD HH:MM:SS" (UTC, no TZ
  // marker). Date.parse treats that as local time on some runtimes, so we
  // append a Z when it's missing to pin it to UTC.
  const raw = record.last_heartbeat;
  const normalized =
    raw.includes("T") || raw.endsWith("Z") ? raw : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}
