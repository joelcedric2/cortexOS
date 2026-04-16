/**
 * UI-facing type contracts for Mission Control (plan §6 Phase 6).
 *
 * This file is the single source of truth for what the Next.js dashboard
 * receives over the event WebSocket bridge (port 3101) and the one-shot
 * HTTP API (port 3103). It is duplicated in
 * `mission-control/src/lib/nchinda-types.ts` for now; a full monorepo
 * sharing pass is deferred to Phase 7.
 *
 * Kept schema-only — no runtime deps. If you add fields, append at the end
 * of each object and mark them optional so the frontend stays decoupled.
 */
import type { AgentEvent } from "../ipc/event-bus.js";

// --------------------------- Audio / Nchinda waveform ----------------------

/**
 * One frame of the Nchinda waveform visualiser, broadcast on port 3100
 * (voice WS bridge). Mirrored here so the frontend can import from one
 * place. Keep in sync with `src/voice/ws-bridge.ts` manually.
 */
export interface NchindaWaveState {
  state: string;
  rms: number;
  caption?: string;
  lastEventAt: string; // ISO-8601
}

// --------------------------- Agent roster ----------------------------------

/** Row shape of the "Agents" tile on Mission Control. */
export interface AgentRow {
  id: string;
  role: string;
  color: string;
  tmux_session: string | null;
  worktree: string | null;
  status: "spawning" | "running" | "standby" | "done" | "error";
  task_id: string | null;
  started_at: string;
  last_heartbeat: string | null;
}

// --------------------------- Pending surface -------------------------------

/** Row of the "Pending" observation list. */
export interface PendingItem {
  id: number;
  sensorName: string;
  observation: string;
  urgency: number;
  suggestedAction?: string;
  sampledAt: string; // ISO-8601
}

// --------------------------- Escalations -----------------------------------

/** Row of the "Escalations" tile. */
export interface EscalationRow {
  id: string;
  question: string;
  level: "info" | "question" | "blocker";
  task_id: string | null;
  agent_id: string | null;
  resolved: boolean;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

// --------------------------- Memory browser --------------------------------

/** Row of the "Memory" browser. Flat view of a BriefSearchResult. */
export interface BriefRow {
  id: string;
  question: string;
  recommended_action: string;
  confidence: number;
  similarity: number;
  tags: string[];
  createdAt: string; // ISO-8601
}

// --------------------------- Event bus frames ------------------------------

/** Initial snapshot sent once per WS connection. */
export interface SnapshotFrame {
  type: "snapshot";
  agents: AgentRow[];
  pending: PendingItem[];
  recentEvents: UIEvent[];
}

/** One live event forwarded from the in-process EventBus. */
export interface EventFrame {
  type: "event";
  event: UIEvent;
}

/** Query request from client → server. */
export interface QueryFrame {
  type: "query";
  query: "agents" | "pending" | "memory" | "escalations";
  params?: Record<string, unknown>;
  requestId?: string;
}

/** Query response from server → client. */
export interface QueryResultFrame {
  type: "query-result";
  query: QueryFrame["query"];
  data: unknown;
  requestId?: string;
  error?: string;
}

/** Client-initiated escalation resolution. */
export interface ResolveEscalationFrame {
  type: "resolve-escalation";
  id: string;
  resolution: string;
  resolved_by?: string;
  requestId?: string;
}

/** Acknowledgement of a resolve-escalation command. */
export interface ResolveEscalationAckFrame {
  type: "resolve-escalation-ack";
  id: string;
  ok: boolean;
  error?: string;
  requestId?: string;
}

/** Error frame emitted by the bridge on malformed client input. */
export interface ErrorFrame {
  type: "error";
  message: string;
  requestId?: string;
}

/**
 * Wire-safe projection of `AgentEvent` — ts is serialised as an ISO
 * string to round-trip cleanly through JSON.
 */
export interface UIEvent {
  kind: AgentEvent["kind"];
  slot?: number;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  payload?: unknown;
  ts: string; // ISO-8601
}

/** All frames sent server → client. */
export type ServerFrame =
  | SnapshotFrame
  | EventFrame
  | QueryResultFrame
  | ResolveEscalationAckFrame
  | ErrorFrame;

/** All frames sent client → server. */
export type ClientFrame = QueryFrame | ResolveEscalationFrame;

// --------------------------- Helpers ---------------------------------------

/** Serialise an AgentEvent for transport to the UI. */
export function toUIEvent(e: AgentEvent): UIEvent {
  return {
    kind: e.kind,
    slot: e.slot,
    session_id: e.session_id,
    agent_id: e.agent_id,
    task_id: e.task_id,
    payload: e.payload,
    ts: e.ts.toISOString(),
  };
}
