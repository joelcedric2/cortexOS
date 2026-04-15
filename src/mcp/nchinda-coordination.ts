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
 */
import { z } from "zod";
import type { EscalationsDB } from "./escalations-db.js";
import type { EventBus } from "../ipc/event-bus.js";
import type { AgentRecord } from "../registry/agent-registry.js";

// --------------------------- Narrow DI interfaces --------------------------

/**
 * Subset of `MessageBus` the coordination tools actually need. Keeps tests
 * from having to instantiate tmux + slot manager just to stub a send call.
 */
export interface MessageBusLike {
  send(fromSlot: number, toSlot: number, content: string): Promise<void>;
  broadcast(fromSlot: number, content: string): Promise<void>;
}

/** Subset of `AgentRegistry` used for status/peer lookup. */
export interface AgentRegistryLike {
  list(): AgentRecord[];
}

/**
 * Resolver from registry agent to slot index. The registry schema does not
 * (yet) carry a slot column — Agent B owns that mapping in the orchestrator.
 * For Phase 3 we accept a resolver injected at construction time. If it
 * returns `undefined` for a record, `ask_peer` treats the peer as unreachable.
 */
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

export interface SendResult {
  ok: true;
  to_slot: number;
  from_slot: number;
}

export interface BroadcastResult {
  ok: true;
  from_slot: number;
}

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

export interface EscalateResult {
  escalation_id: string;
}

export type AskPeerResult =
  | { ok: true; answer: string; correlation_id: string }
  | { ok: false; reason: "no-peer" | "timeout"; correlation_id?: string };

// --------------------------- Dependency bundle ----------------------------

export interface NchindaCoordinationDeps {
  messageBus: MessageBusLike;
  registry: AgentRegistryLike;
  eventBus: EventBus;
  escalationsDb: EscalationsDB;
  /** Maps an agent registry row to its slot index. See `PeerSlotResolver`. */
  resolvePeerSlot: PeerSlotResolver;
  /** Wall clock, injectable for tests. */
  now?: () => Date;
}

// --------------------------- Handlers -------------------------------------

export class NchindaCoordination {
  constructor(private readonly deps: NchindaCoordinationDeps) {}

  /**
   * nchinda_send({to_slot, body, from_slot?}) — thin wrapper over MessageBus.
   * Defaults `from_slot` to -1 (system/nchinda). Propagates any MessageBus
   * error (unknown slot, unoccupied target, tmux failure) unchanged.
   */
  async send(raw: unknown): Promise<SendResult> {
    const input = SendInputSchema.parse(raw);
    const fromSlot = input.from_slot ?? -1;
    await this.deps.messageBus.send(fromSlot, input.to_slot, input.body);
    return { ok: true, to_slot: input.to_slot, from_slot: fromSlot };
  }

  /**
   * nchinda_broadcast({body, from_slot?}) — fan out to all occupied slots.
   */
  async broadcast(raw: unknown): Promise<BroadcastResult> {
    const input = BroadcastInputSchema.parse(raw);
    const fromSlot = input.from_slot ?? -1;
    await this.deps.messageBus.broadcast(fromSlot, input.body);
    return { ok: true, from_slot: fromSlot };
  }
}

export function createNchindaCoordination(
  deps: NchindaCoordinationDeps,
): NchindaCoordination {
  return new NchindaCoordination(deps);
}

// Kept public so `serve-nchinda.mjs` can surface richer validation errors in
// the future without re-importing zod. Today the handlers parse internally.
export {
  SendInputSchema,
  BroadcastInputSchema,
  StatusInputSchema,
  EscalateInputSchema,
  AskPeerInputSchema,
};
