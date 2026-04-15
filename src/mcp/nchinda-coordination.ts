/**
 * Phase 3 — Agent A
 *
 * MCP tool handlers for Nchinda-to-agent coordination:
 *
 *   nchinda_send       — targeted slot-to-slot message
 *   nchinda_broadcast  — fan-out to all occupied slots
 *   nchinda_status     — current registry view (active/standby counts)
 *   nchinda_escalate   — raise a user-facing question + persist it
 *   nchinda_ask_peer   — ask a peer agent by role and await a reply
 *
 * All handlers take narrow dependency-injected interfaces so tests can stub
 * the bus / registry / event bus without standing up tmux or SQLite.
 *
 * DECISIONS:
 *   • `ask_peer` piggy-backs the correlation id in the `task_id` slot of the
 *     AgentEvent shape. This lets us reuse `EventBus.once({task_id: id})`
 *     without appending a new filter axis — Phase 5 may widen this later.
 *   • `escalate` emits `kind: "error"` on the bus (plan §3 preserves the
 *     existing EventKind union) with `payload.where === "escalation"` so
 *     consumers can disambiguate from genuine agent errors. A future
 *     EventKind `escalation_raised` may be appended; not required here.
 *   • `send` defaults `from_slot` to -1 (system/nchinda) — MessageBus will
 *     resolve that via SlotManager if slot -1 is present; otherwise callers
 *     must ensure a system slot exists. Handlers do NOT assert this; they
 *     propagate MessageBus errors verbatim.
 *   • `level: "ask"` is an LLM-ergonomic alias for the DB level "question".
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { EscalationsDB, EscalationLevel } from "./escalations-db.js";
import type { AgentEvent, EventBus } from "../ipc/event-bus.js";
import type { AgentRecord } from "../registry/agent-registry.js";

// --------------------------- Narrow DI interfaces --------------------------

export interface MessageBusLike {
  send(fromSlot: number, toSlot: number, content: string): Promise<void>;
  broadcast(fromSlot: number, content: string): Promise<void>;
}

export interface AgentRegistryLike {
  list(): AgentRecord[];
}

export type PeerSlotResolver = (agent: AgentRecord) => number | undefined;

// --------------------------- Schemas ---------------------------------------

const SendInputSchema = z.object({
  to_slot: z.number().int().min(0),
  body: z.string().min(1).max(10_000),
  from_slot: z.number().int().min(0).optional(),
});

const BroadcastInputSchema = z.object({
  body: z.string().min(1).max(10_000),
  from_slot: z.number().int().min(0).optional(),
});

const StatusInputSchema = z.object({}).strict();

const EscalateInputSchema = z.object({
  question: z.string().min(1).max(4_000),
  level: z.enum(["info", "question", "blocker", "ask"]).optional(),
  task_id: z.string().min(1).max(128).optional(),
  agent_id: z.string().min(1).max(128).optional(),
});

const AskPeerInputSchema = z.object({
  role: z.string().min(1).max(64),
  question: z.string().min(1).max(4_000),
  timeout_s: z.number().int().min(1).max(600).optional(),
});

export type SendInput = z.infer<typeof SendInputSchema>;
export type BroadcastInput = z.infer<typeof BroadcastInputSchema>;
export type EscalateInput = z.infer<typeof EscalateInputSchema>;
export type AskPeerInput = z.infer<typeof AskPeerInputSchema>;

// --------------------------- Output types ---------------------------------

export interface SendResult { ok: true; to_slot: number; from_slot: number; }
export interface BroadcastResult { ok: true; from_slot: number; }
export interface StatusRow {
  id: string;
  role: string;
  status: string;
  task_id: string | null;
  tmux_session: string | null;
  uptime_s: number;
}
export interface StatusResult {
  agents: StatusRow[];
  active_count: number;
  standby_count: number;
}
export interface EscalateResult { escalation_id: string; }
export type AskPeerResult =
  | { ok: true; answer: string; correlation_id: string }
  | { ok: false; reason: "no-peer" | "timeout"; correlation_id?: string };

// --------------------------- Dependency bundle ----------------------------

export interface NchindaCoordinationDeps {
  messageBus: MessageBusLike;
  registry: AgentRegistryLike;
  eventBus: EventBus;
  escalationsDb: EscalationsDB;
  resolvePeerSlot: PeerSlotResolver;
  now?: () => Date;
}

// --------------------------- Handlers -------------------------------------

export class NchindaCoordination {
  constructor(private readonly deps: NchindaCoordinationDeps) {}

  async send(raw: unknown): Promise<SendResult> {
    const input = SendInputSchema.parse(raw);
    const fromSlot = input.from_slot ?? -1;
    await this.deps.messageBus.send(fromSlot, input.to_slot, input.body);
    return { ok: true, to_slot: input.to_slot, from_slot: fromSlot };
  }

  async broadcast(raw: unknown): Promise<BroadcastResult> {
    const input = BroadcastInputSchema.parse(raw);
    const fromSlot = input.from_slot ?? -1;
    await this.deps.messageBus.broadcast(fromSlot, input.body);
    return { ok: true, from_slot: fromSlot };
  }

  status(raw?: unknown): StatusResult {
    StatusInputSchema.parse(raw ?? {});
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const rows = this.deps.registry.list();
    const agents: StatusRow[] = rows.map((r) => {
      const startedMs = Date.parse(r.started_at);
      const uptimeS = Number.isFinite(startedMs)
        ? Math.max(0, Math.floor((now - startedMs) / 1000))
        : 0;
      return {
        id: r.id,
        role: r.role,
        status: r.status,
        task_id: r.task_id,
        tmux_session: r.tmux_session,
        uptime_s: uptimeS,
      };
    });
    const active_count = agents.filter((a) => a.status === "running").length;
    const standby_count = agents.filter((a) => a.status === "standby").length;
    return { agents, active_count, standby_count };
  }

  escalate(raw: unknown): EscalateResult {
    const input = EscalateInputSchema.parse(raw);
    const requested = input.level ?? "ask";
    const dbLevel: EscalationLevel =
      requested === "ask" ? "question" : requested;
    const row = this.deps.escalationsDb.create({
      question: input.question,
      level: dbLevel,
      task_id: input.task_id ?? null,
      agent_id: input.agent_id ?? null,
    });
    const event: AgentEvent = {
      kind: "error",
      payload: {
        where: "escalation",
        question: input.question,
        level: requested,
        escalation_id: row.id,
      },
      ts: this.deps.now?.() ?? new Date(),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
    };
    this.deps.eventBus.emit(event);
    return { escalation_id: row.id };
  }

  async askPeer(raw: unknown): Promise<AskPeerResult> {
    const input = AskPeerInputSchema.parse(raw);
    const timeoutMs = (input.timeout_s ?? 30) * 1000;

    const peer = this.deps.registry
      .list()
      .find((a) => a.role === input.role && a.status === "running");
    if (!peer) return { ok: false, reason: "no-peer" };

    const peerSlot = this.deps.resolvePeerSlot(peer);
    if (peerSlot === undefined) return { ok: false, reason: "no-peer" };

    const correlationId = randomUUID();
    const envelope = `[ASK ${correlationId}]: ${input.question}`;
    await this.deps.messageBus.send(-1, peerSlot, envelope);

    try {
      const event = await this.deps.eventBus.once(
        { task_id: correlationId },
        timeoutMs,
      );
      const answer = extractAnswer(event.payload, input.question);
      return { ok: true, answer, correlation_id: correlationId };
    } catch {
      return { ok: false, reason: "timeout", correlation_id: correlationId };
    }
  }
}

function extractAnswer(payload: unknown, fallbackQuestion: string): string {
  if (payload === null || payload === undefined) {
    return `(empty reply to "${fallbackQuestion}")`;
  }
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.body === "string") return p.body;
    if (typeof p.answer === "string") return p.answer;
    if (typeof p.text === "string") return p.text;
  }
  return JSON.stringify(payload);
}

export function createNchindaCoordination(
  deps: NchindaCoordinationDeps,
): NchindaCoordination {
  return new NchindaCoordination(deps);
}

export {
  SendInputSchema,
  BroadcastInputSchema,
  StatusInputSchema,
  EscalateInputSchema,
  AskPeerInputSchema,
};
