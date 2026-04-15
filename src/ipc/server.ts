import { createServer, type Socket } from "node:net";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import type { EventBus } from "./event-bus.js";
import type { EventsDB, InsertEventInput } from "./events-db.js";

const SOCKET_PATH = "/tmp/cortexos.sock";
export const HOOKS_DEFAULT_PORT = 3102;

export interface IpcRequest {
  command: string;
  args: Record<string, unknown>;
}

export interface IpcResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type IpcHandler = (req: IpcRequest) => Promise<IpcResponse>;

export class IpcServer {
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private handler: IpcHandler) {}

  start(): void {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

    this.server = createServer((socket: Socket) => {
      let buffer = "";

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line) as IpcRequest;
            this.handler(req)
              .then((res) => {
                socket.write(JSON.stringify(res) + "\n");
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                socket.write(JSON.stringify({ ok: false, error: message }) + "\n");
              });
          } catch {
            socket.write(
              JSON.stringify({ ok: false, error: "Invalid JSON in IPC request" }) + "\n",
            );
          }
        }
      });

      socket.on("error", () => {
        // Client disconnected unexpectedly — nothing to do
      });
    });

    this.server.listen(SOCKET_PATH, () => {
      console.log(`[IPC] Listening on ${SOCKET_PATH}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    console.log("[IPC] Server stopped");
  }
}

// ---------------------------------------------------------------------------
// HTTP Hooks Server (Phase 1 — Agent A)
// ---------------------------------------------------------------------------
// Separate HTTP surface (port 3102 by default) that receives Claude Code
// hook callbacks (`Stop`, `PreCompact`) and the `/health` probe. Writes events
// to the `agent_events` SQLite table and fans them out over the in-process
// EventBus so the orchestrator (Agent B) can subscribe.
//
// Kept in `server.ts` per the Phase 1 spec; the existing Unix-socket
// `IpcServer` above is untouched.

export interface PreCompactPersistHook {
  (args: {
    sessionId: string;
    transcriptPath: string | null;
    taskId?: string;
  }): Promise<void>;
}

export interface HooksServerDeps {
  bus: EventBus;
  db: EventsDB;
  port?: number;
  /** Injected so the embedder + vector-store stay out of the HTTP critical path. */
  persistCompact?: PreCompactPersistHook;
  /** Override for tests. */
  now?: () => Date;
}

export interface HooksServerHandle {
  server: HttpServer;
  port: number;
  eventsSeen: () => number;
  close: () => Promise<void>;
}

interface JsonBody {
  session_id?: unknown;
  agent_id?: unknown;
  slot?: unknown;
  transcript_tail?: unknown;
  exit_reason?: unknown;
  ts?: unknown;
  transcript_path?: unknown;
  task_id?: unknown;
}

function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as JsonBody);
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function startHooksServer(deps: HooksServerDeps): Promise<HooksServerHandle> {
  const { bus, db } = deps;
  const port = deps.port ?? HOOKS_DEFAULT_PORT;
  const now = deps.now ?? (() => new Date());
  let eventsSeen = 0;
  const startedAt = Date.now();

  const recordEvent = (input: InsertEventInput): void => {
    try {
      db.insert(input);
    } catch (err) {
      console.error("[hooks-server] Failed to persist event:", err);
    }
    eventsSeen += 1;
  };

  const server = createHttpServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, {
        ok: true,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        events_seen: eventsSeen,
      });
      return;
    }

    if (method === "POST" && url === "/hooks/stop") {
      readJsonBody(req)
        .then((body) => {
          const session_id = asString(body.session_id);
          const agent_id = asString(body.agent_id);
          const slot = asNumber(body.slot);
          const payload = {
            transcript_tail: asString(body.transcript_tail),
            exit_reason: asString(body.exit_reason),
            ts: asString(body.ts),
          };
          recordEvent({
            kind: "done",
            slot,
            session_id,
            agent_id,
            payload,
          });
          bus.emit({
            kind: "done",
            slot,
            session_id,
            agent_id,
            payload,
            ts: now(),
          });
          sendJson(res, 200, { ok: true });
        })
        .catch((err: Error) => {
          sendJson(res, 400, { ok: false, error: err.message });
        });
      return;
    }

    if (method === "POST" && url === "/hooks/pre-compact") {
      readJsonBody(req)
        .then((body) => {
          const session_id = asString(body.session_id);
          const task_id = asString(body.task_id);
          const transcript_path = asString(body.transcript_path) ?? null;
          const payload = {
            transcript_path,
            ts: asString(body.ts),
          };
          recordEvent({
            kind: "compact",
            session_id,
            task_id,
            payload,
          });
          // Respond immediately; heavy work happens on a detached promise.
          sendJson(res, 202, { ok: true, accepted: true });

          if (session_id && deps.persistCompact) {
            deps
              .persistCompact({ sessionId: session_id, transcriptPath: transcript_path, taskId: task_id })
              .then(() => {
                bus.emit({
                  kind: "compact",
                  session_id,
                  task_id,
                  payload: { transcript_path, persisted: true },
                  ts: now(),
                });
              })
              .catch((err: Error) => {
                console.error("[hooks-server] pre-compact persist failed:", err);
                bus.emit({
                  kind: "error",
                  session_id,
                  task_id,
                  payload: { where: "pre-compact", message: err.message },
                  ts: now(),
                });
              });
          } else {
            // Still emit a compact event so subscribers fire even when no persister wired.
            bus.emit({
              kind: "compact",
              session_id,
              task_id,
              payload: { transcript_path, persisted: false },
              ts: now(),
            });
          }
        })
        .catch((err: Error) => {
          sendJson(res, 400, { ok: false, error: err.message });
        });
      return;
    }

    sendJson(res, 404, { ok: false, error: `No handler for ${method} ${url}` });
  });

  return new Promise<HooksServerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`[hooks-server] Listening on http://127.0.0.1:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        eventsSeen: () => eventsSeen,
        close: () =>
          new Promise<void>((r, j) => {
            server.close((err) => (err ? j(err) : r()));
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Default transcript persister: chunks + embeds + stores in `memories`.
// Wired via `startHooksServer({ persistCompact: makeDefaultPersistCompact(...) })`.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

export interface EmbedderLike {
  embed(text: string): Promise<number[]>;
}

export interface VectorStoreLike {
  storeMemory(record: {
    agentRole: string;
    taskType: string;
    content: string;
    embedding: number[];
    outcome: "success" | "fail";
    tags: string[];
  }): Promise<string>;
}

export function makeDefaultPersistCompact(opts: {
  embedder: EmbedderLike;
  vectorStore: VectorStoreLike;
  chunkSize?: number;
  agentRole?: string;
}): PreCompactPersistHook {
  const chunkSize = opts.chunkSize ?? 1500;
  const agentRole = opts.agentRole ?? "system";

  return async ({ sessionId, transcriptPath, taskId }) => {
    if (!transcriptPath || !existsSync(transcriptPath)) {
      console.warn(`[hooks-server] transcript not found: ${transcriptPath}`);
      return;
    }
    const raw = readFileSync(transcriptPath, "utf8");
    // Transcript is JSONL; extract plain text content per line.
    const chunks: string[] = [];
    let current = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const content = extractContent(obj);
        if (!content) continue;
        if (current.length + content.length + 1 > chunkSize) {
          if (current) chunks.push(current);
          current = content;
        } else {
          current = current ? `${current}\n${content}` : content;
        }
      } catch {
        // Skip malformed lines.
      }
    }
    if (current) chunks.push(current);

    const tags = ["compact", sessionId];
    if (taskId) tags.push(taskId);

    for (const chunk of chunks) {
      const embedding = await opts.embedder.embed(chunk);
      await opts.vectorStore.storeMemory({
        agentRole,
        taskType: "transcript_chunk",
        content: chunk,
        embedding,
        outcome: "success",
        tags,
      });
    }
  };
}

function extractContent(obj: Record<string, unknown>): string | null {
  // Claude Code JSONL transcript lines vary in shape; try common fields.
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  const message = obj.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === "string") return message.content;
  if (message && Array.isArray(message.content)) {
    return message.content
      .map((part) =>
        typeof part === "string"
          ? part
          : (part as { text?: string }).text ?? "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return null;
}
