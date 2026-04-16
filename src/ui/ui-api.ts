/**
 * UI HTTP API — Phase 6, plan §6 (port 3103).
 *
 * Companion to the Event WebSocket bridge (port 3101). Where the WS surface
 * is push-oriented (live events + snapshot + small query/command RPC), this
 * is the classic pull-oriented REST surface for one-shot fetches Mission
 * Control uses from page loads, debounced search boxes, and server-side
 * render paths.
 *
 * Zero Express — we use Node's native `http` to keep the dependency graph
 * thin. Every route is GET, every response is JSON, every query param is
 * validated through zod so the frontend gets a clean 400 with a redacted
 * message (never a raw stack trace) on malformed input. Internal errors
 * become a 500 with a generic message; the underlying cause is logged
 * server-side via the provided logger hook.
 */
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AgentRegistry } from "../registry/agent-registry.js";
import type { BriefStore } from "../research/brief-store.js";
import type { SkillRegistryDB } from "../skills/skill-registry-db.js";
import type { CronJobsDB } from "../scheduler/cron-jobs-db.js";
import type { AuditLog } from "../proactivity/audit.js";
import type { BudgetTracker } from "../observability/budget-tracker.js";
import {
  handleBudgetsList,
  handleBudgetsTotals,
} from "../observability/budget-api.js";
import type { BriefRow } from "./types.js";

export interface UIApiOptions {
  /** TCP port. Default 3103. Use 0 in tests to let the kernel pick. */
  port?: number;
  /** Powers GET /ui/agents. */
  registry?: AgentRegistry;
  /** Powers GET /ui/briefs?q=...&k=... */
  briefStore?: BriefStore;
  /** Powers GET /ui/skills. */
  skillRegistry?: SkillRegistryDB;
  /** Powers GET /ui/crons. */
  cronDb?: CronJobsDB;
  /** Powers GET /ui/audit?date=YYYY-MM-DD. */
  auditLog?: AuditLog;
  /** Powers GET /ui/budgets and GET /ui/budgets/totals?days=<n>. */
  budgetTracker?: BudgetTracker;
  /** Optional logger for server-side diagnostics. Defaults to console.warn. */
  logger?: (msg: string, err?: unknown) => void;
}

const DEFAULT_PORT = 3103;
const ROUTES = [
  "GET /ui/agents",
  "GET /ui/briefs",
  "GET /ui/skills",
  "GET /ui/crons",
  "GET /ui/audit",
  "GET /ui/budgets",
  "GET /ui/budgets/totals",
  "GET /ui/health",
] as const;

// ─── Validation schemas ─────────────────────────────────────────────────────

const briefsQuery = z.object({
  q: z.string().min(1, "missing required query param 'q'"),
  k: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 5 : Number.parseInt(v, 10)))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, {
      message: "'k' must be a positive integer ≤ 100",
    }),
});

const auditQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO format YYYY-MM-DD"),
});

// ─── Server ─────────────────────────────────────────────────────────────────

export class UIApiServer {
  private readonly port: number;
  private readonly registry?: AgentRegistry;
  private readonly briefStore?: BriefStore;
  private readonly skillRegistry?: SkillRegistryDB;
  private readonly cronDb?: CronJobsDB;
  private readonly auditLog?: AuditLog;
  private readonly budgetTracker?: BudgetTracker;
  private readonly logger: (msg: string, err?: unknown) => void;

  private server: HttpServer | null = null;
  private readonly startedAt = Date.now();
  private boundPort: number | null = null;

  constructor(opts: UIApiOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.registry = opts.registry;
    this.briefStore = opts.briefStore;
    this.skillRegistry = opts.skillRegistry;
    this.cronDb = opts.cronDb;
    this.auditLog = opts.auditLog;
    this.budgetTracker = opts.budgetTracker;
    this.logger =
      opts.logger ??
      ((msg, err) => {
        // Keep server-side context; never leaks to the client.
        if (err !== undefined) console.warn(`[UIApiServer] ${msg}`, err);
        else console.warn(`[UIApiServer] ${msg}`);
      });
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.logger("unhandled request error", err);
        if (!res.headersSent) this.sendError(res, 500, "Internal error");
        else if (!res.writableEnded) res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, () => {
        const addr = this.server!.address();
        this.boundPort =
          addr && typeof addr === "object" ? addr.port : this.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    this.boundPort = null;
  }

  /** Bound port (useful in tests when port 0 was passed). */
  address(): number | null {
    return this.boundPort;
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      this.sendError(res, 405, "Method not allowed");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const params = Object.fromEntries(url.searchParams.entries());

    switch (url.pathname) {
      case "/ui/agents":
        return this.handleAgents(res);
      case "/ui/briefs":
        return this.handleBriefs(res, params);
      case "/ui/skills":
        return this.handleSkills(res);
      case "/ui/crons":
        return this.handleCrons(res);
      case "/ui/audit":
        return this.handleAudit(res, params);
      case "/ui/budgets":
        return this.handleBudgets(res);
      case "/ui/budgets/totals":
        return this.handleBudgetsTotals(res, params);
      case "/ui/health":
        return this.handleHealth(res);
      default:
        this.sendError(res, 404, `Not found: ${url.pathname}`);
    }
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private handleAgents(res: ServerResponse): void {
    try {
      const rows = this.registry?.list() ?? [];
      this.sendJson(res, 200, rows);
    } catch (err) {
      this.logger("GET /ui/agents failed", err);
      this.sendError(res, 500, "Failed to list agents");
    }
  }

  private async handleBriefs(
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const parsed = briefsQuery.safeParse(params);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join("; ");
      this.sendError(res, 400, msg);
      return;
    }
    if (!this.briefStore) {
      this.sendJson(res, 200, []);
      return;
    }
    try {
      const rows = await this.briefStore.recall(parsed.data.q, parsed.data.k);
      const mapped: BriefRow[] = rows.map((r) => ({
        id: r.id,
        question: r.brief.question,
        recommended_action: r.brief.recommended_action,
        confidence: r.brief.confidence,
        similarity: r.similarity,
        tags: r.tags,
        createdAt: r.createdAt.toISOString(),
      }));
      this.sendJson(res, 200, mapped);
    } catch (err) {
      this.logger("GET /ui/briefs failed", err);
      this.sendError(res, 500, "Failed to recall briefs");
    }
  }

  private handleSkills(res: ServerResponse): void {
    try {
      const rows = this.skillRegistry?.list() ?? [];
      this.sendJson(res, 200, rows);
    } catch (err) {
      this.logger("GET /ui/skills failed", err);
      this.sendError(res, 500, "Failed to list skills");
    }
  }

  private handleCrons(res: ServerResponse): void {
    try {
      // `CronJobsDB.list()` is the public CRUD surface; the spec-stated
      // `listAll` is an alias that doesn't exist on the real class — we
      // wire to `list()` directly.
      const rows = this.cronDb?.list() ?? [];
      this.sendJson(res, 200, rows);
    } catch (err) {
      this.logger("GET /ui/crons failed", err);
      this.sendError(res, 500, "Failed to list cron jobs");
    }
  }

  private handleAudit(
    res: ServerResponse,
    params: Record<string, string>,
  ): void {
    const parsed = auditQuery.safeParse(params);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join("; ");
      this.sendError(res, 400, msg);
      return;
    }
    if (!this.auditLog) {
      this.sendJson(res, 200, { totalSamples: 0, surfaced: 0, actedOn: 0 });
      return;
    }
    try {
      // Construct a Date at UTC midnight of the target day — the AuditLog
      // internally slices to YYYY-MM-DD anyway, so TZ drift is harmless.
      const date = new Date(`${parsed.data.date}T00:00:00.000Z`);
      const summary = this.auditLog.dailySummary(date);
      this.sendJson(res, 200, summary);
    } catch (err) {
      this.logger("GET /ui/audit failed", err);
      this.sendError(res, 500, "Failed to summarise audit log");
    }
  }

  private handleBudgets(res: ServerResponse): void {
    if (!this.budgetTracker) {
      this.sendJson(res, 200, []);
      return;
    }
    try {
      const result = handleBudgetsList(this.budgetTracker);
      this.sendJson(res, result.status, result.body);
    } catch (err) {
      this.logger("GET /ui/budgets failed", err);
      this.sendError(res, 500, "Failed to list budgets");
    }
  }

  private handleBudgetsTotals(
    res: ServerResponse,
    params: Record<string, string>,
  ): void {
    if (!this.budgetTracker) {
      this.sendJson(res, 200, { tokens_in: 0, tokens_out: 0, cost_usd: 0 });
      return;
    }
    try {
      const result = handleBudgetsTotals(this.budgetTracker, params);
      if (result.status === 400) {
        this.sendError(res, 400, result.body.error);
        return;
      }
      this.sendJson(res, result.status, result.body);
    } catch (err) {
      this.logger("GET /ui/budgets/totals failed", err);
      this.sendError(res, 500, "Failed to compute budget totals");
    }
  }

  private handleHealth(res: ServerResponse): void {
    const uptime_s = Math.floor((Date.now() - this.startedAt) / 1000);
    this.sendJson(res, 200, {
      ok: true,
      uptime_s,
      routes: [...ROUTES],
    });
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload).toString(),
      // Mission Control may call this from a different origin in dev.
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  private sendError(
    res: ServerResponse,
    status: number,
    message: string,
  ): void {
    // `message` is caller-controlled and redacted — never embed a raw Error
    // here. Callers pass a short, user-safe string.
    this.sendJson(res, status, { error: message });
  }
}
