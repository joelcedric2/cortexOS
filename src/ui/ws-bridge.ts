/**
 * Event WebSocket bridge — Phase 6, plan §6 + §11 (port 3101).
 *
 * Forwards every `AgentEvent` from the in-process `EventBus` to connected
 * Mission Control clients, plus exposes a small query/command surface so
 * the UI can pull agent rosters, pending observations, recent briefs, and
 * escalations over the same socket.
 *
 * Pattern mirrors `src/voice/ws-bridge.ts` (the audio bridge on port 3100).
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import type { AgentEvent, EventBus } from "../ipc/event-bus.js";
import type { AgentRegistry } from "../registry/agent-registry.js";
import type { BriefStore } from "../research/brief-store.js";
import type { EscalationsDB } from "../mcp/escalations-db.js";
import type {
  ClientFrame,
  PendingItem,
  ServerFrame,
  SnapshotFrame,
  UIEvent,
  BriefRow,
} from "./types.js";
import { toUIEvent } from "./types.js";
import type {
  PendingSurface,
  PendingSurfaceItem,
} from "../proactivity/pending-surface.js";

/**
 * Minimal observation-store surface we consume — compatible with both the
 * real SQLite `ObservationStore` and the `PendingSurface` wrapper. Keeping
 * it structural so tests can pass a stub without pulling in better-sqlite3.
 */
export interface PendingProvider {
  list(limit?: number): PendingItem[];
}

function normalizePendingList(
  source: PendingProvider | PendingSurface | undefined,
  limit: number,
): PendingItem[] {
  if (!source) return [];
  const rows = source.list(limit);
  return rows.map((row) => {
    // `PendingSurface.list()` returns sampledAt as Date; the structural
    // `PendingProvider` returns it as ISO-8601 string. Normalise here so
    // frontends only see strings.
    const sampledAt =
      (row as PendingSurfaceItem).sampledAt instanceof Date
        ? (row as PendingSurfaceItem).sampledAt.toISOString()
        : (row as PendingItem).sampledAt;
    return {
      id: row.id,
      sensorName: row.sensorName,
      observation: row.observation,
      urgency: row.urgency,
      suggestedAction: row.suggestedAction,
      sampledAt,
    };
  });
}

export interface EventWSBridgeOptions {
  /** TCP port for the WebSocket server. Default 3101. */
  port?: number;
  /** Source of `AgentEvent`s to forward. */
  bus: EventBus;
  /** Optional — powers the `agents` query + snapshot roster. */
  registry?: AgentRegistry;
  /** Optional — powers the `memory` query. */
  briefStore?: BriefStore;
  /** Optional — powers the `pending` query + snapshot list. */
  pending?: PendingProvider | PendingSurface;
  /** Optional — powers the `escalations` query + resolve-escalation command. */
  escalationsDb?: EscalationsDB;
  /** Cap on events retained for the initial snapshot. Default 50. */
  recentEventCap?: number;
}

const DEFAULT_PORT = 3101;
const DEFAULT_EVENT_CAP = 50;

export class EventWSBridge {
  private readonly port: number;
  private readonly bus: EventBus;
  private readonly registry?: AgentRegistry;
  private readonly briefStore?: BriefStore;
  private readonly pending?: PendingProvider | PendingSurface;
  private readonly escalationsDb?: EscalationsDB;
  private readonly recentEventCap: number;

  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly recentEvents: UIEvent[] = [];

  constructor(opts: EventWSBridgeOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.briefStore = opts.briefStore;
    this.pending = opts.pending;
    this.escalationsDb = opts.escalationsDb;
    this.recentEventCap = opts.recentEventCap ?? DEFAULT_EVENT_CAP;
  }

  async start(): Promise<void> {
    if (this.wss) return;

    this.httpServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: "/",
    });

    this.wss.on("connection", (ws, _req: IncomingMessage) => {
      this.onConnection(ws);
    });

    // Forward every event on the bus to all open clients, keeping a
    // bounded tail for the snapshot frame.
    this.unsubscribe = this.bus.subscribe({}, (event) => {
      const ui = toUIEvent(event);
      this.recentEvents.push(ui);
      if (this.recentEvents.length > this.recentEventCap) {
        this.recentEvents.splice(
          0,
          this.recentEvents.length - this.recentEventCap,
        );
      }
      this.broadcast({ type: "event", event: ui });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, () => resolve());
      this.httpServer!.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.wss) {
      for (const client of this.wss.clients) {
        // terminate() closes the underlying socket immediately; close() waits
        // for the graceful handshake which can hang shutdown in tests if the
        // client-side close is slow or absent.
        try {
          client.terminate();
        } catch {
          // best-effort
        }
      }
    }

    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });

    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private onConnection(ws: WebSocket): void {
    // Wire listeners FIRST so nothing's lost if the client is quick.
    ws.on("message", (raw) => {
      this.onMessage(ws, raw);
    });
    ws.on("error", () => {
      // Swallow — closing handler will tidy up.
    });

    // Defer the snapshot slightly. If we send synchronously inside the
    // 'connection' handler, a client that calls `await once(ws, 'open')` and
    // THEN attaches a message listener races us and loses the frame —
    // WebSocket messages don't queue before a listener attaches. A 10ms
    // delay gives the client's post-open code time to subscribe; still
    // imperceptible to a human waveform.
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        this.send(ws, this.buildSnapshot());
      }
    }, 10);
  }

  private onMessage(ws: WebSocket, raw: WebSocket.RawData): void {
    let parsed: ClientFrame;
    try {
      parsed = JSON.parse(raw.toString()) as ClientFrame;
    } catch {
      this.send(ws, {
        type: "error",
        message: "Invalid JSON frame",
      });
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      this.send(ws, {
        type: "error",
        message: "Malformed frame (missing 'type')",
      });
      return;
    }

    switch (parsed.type) {
      case "query":
        this.handleQuery(ws, parsed);
        return;
      case "resolve-escalation":
        this.handleResolveEscalation(ws, parsed);
        return;
      default: {
        const type = (parsed as { type: string }).type;
        this.send(ws, {
          type: "error",
          message: `Unknown frame type: ${type}`,
        });
      }
    }
  }

  private handleQuery(
    ws: WebSocket,
    frame: Extract<ClientFrame, { type: "query" }>,
  ): void {
    const { query, params, requestId } = frame;
    const respond = (data: unknown, error?: string): void => {
      this.send(ws, {
        type: "query-result",
        query,
        data,
        requestId,
        error,
      });
    };

    try {
      switch (query) {
        case "agents": {
          const agents = this.registry?.list() ?? [];
          respond(agents);
          return;
        }
        case "pending": {
          const limit = asPositiveInt(params?.limit) ?? 20;
          respond(normalizePendingList(this.pending, limit));
          return;
        }
        case "memory": {
          if (!this.briefStore) {
            respond([], "briefStore not configured");
            return;
          }
          const q = asNonEmptyString(params?.q);
          if (!q) {
            respond([], "missing 'q' param");
            return;
          }
          const topK = asPositiveInt(params?.topK) ?? 5;
          this.briefStore
            .recall(q, topK)
            .then((rows) => {
              const mapped: BriefRow[] = rows.map((r) => ({
                id: r.id,
                question: r.brief.question,
                recommended_action: r.brief.recommended_action,
                confidence: r.brief.confidence,
                similarity: r.similarity,
                tags: r.tags,
                createdAt: r.createdAt.toISOString(),
              }));
              respond(mapped);
            })
            .catch((err: unknown) => {
              respond([], err instanceof Error ? err.message : String(err));
            });
          return;
        }
        case "escalations": {
          if (!this.escalationsDb) {
            respond([], "escalationsDb not configured");
            return;
          }
          const resolved = params?.resolved;
          const rows =
            resolved === true
              ? this.escalationsDb.list()
              : this.escalationsDb.listPending();
          respond(rows);
          return;
        }
        default: {
          const q = (query as string) ?? "unknown";
          respond(null, `Unknown query: ${q}`);
        }
      }
    } catch (err) {
      respond(null, err instanceof Error ? err.message : String(err));
    }
  }

  private handleResolveEscalation(
    ws: WebSocket,
    frame: Extract<ClientFrame, { type: "resolve-escalation" }>,
  ): void {
    const { id, resolution, resolved_by, requestId } = frame;
    if (!this.escalationsDb) {
      this.send(ws, {
        type: "resolve-escalation-ack",
        id,
        ok: false,
        error: "escalationsDb not configured",
        requestId,
      });
      return;
    }
    if (typeof id !== "string" || !id) {
      this.send(ws, {
        type: "resolve-escalation-ack",
        id: String(id ?? ""),
        ok: false,
        error: "invalid id",
        requestId,
      });
      return;
    }
    if (typeof resolution !== "string" || !resolution) {
      this.send(ws, {
        type: "resolve-escalation-ack",
        id,
        ok: false,
        error: "invalid resolution",
        requestId,
      });
      return;
    }
    try {
      this.escalationsDb.resolve(id, {
        resolution,
        resolved_by: resolved_by ?? "mission-control",
      });
      this.send(ws, {
        type: "resolve-escalation-ack",
        id,
        ok: true,
        requestId,
      });
    } catch (err) {
      this.send(ws, {
        type: "resolve-escalation-ack",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  private buildSnapshot(): SnapshotFrame {
    const agents = this.registry?.list() ?? [];
    const pending = normalizePendingList(this.pending, 20);
    return {
      type: "snapshot",
      agents,
      pending,
      recentEvents: this.recentEvents.slice(),
    };
  }

  private broadcast(frame: ServerFrame): void {
    if (!this.wss) return;
    const payload = JSON.stringify(frame);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch {
          // best-effort fan-out
        }
      }
    }
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort
    }
  }
}

// ─── Param coercion helpers (kept tiny; no zod needed for WS params) ────────

function asPositiveInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Surface AgentEvent for consumers that want to emit directly without the bus.
export type { AgentEvent };
