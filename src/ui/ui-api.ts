/**
 * UI HTTP API — Phase 6, plan §6 (port 3103). Extended in Phase 7 with
 * analytics routes: /ui/anti-patterns, /ui/success-rate (cached 60s) and
 * observability routes: /ui/budgets, /ui/budgets/totals.
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
import type { LoopAttemptLog } from "../loop/loop-attempts-db.js";
import type { SkillUsageLedger } from "../skills/usage-ledger.js";
import type {
  AntiPatternReport,
  AntiPatternMemorySink,
  AntiPatternEmbedder,
} from "../analytics/anti-patterns.js";
import { detectAntiPatterns } from "../analytics/anti-patterns.js";
import type { SuccessRateReport } from "../analytics/success-rate.js";
import { computeSuccessRate } from "../analytics/success-rate.js";
import type { BriefRow } from "./types.js";

export interface UIApiOptions {
  port?: number;
  registry?: AgentRegistry;
  briefStore?: BriefStore;
  skillRegistry?: SkillRegistryDB;
  cronDb?: CronJobsDB;
  auditLog?: AuditLog;
  budgetTracker?: BudgetTracker;
  attemptsLog?: LoopAttemptLog;
  skillUsageLedger?: SkillUsageLedger;
  antiPatternSink?: AntiPatternMemorySink;
  antiPatternEmbedder?: AntiPatternEmbedder;
  analyticsCacheMs?: number;
  logger?: (msg: string, err?: unknown) => void;
}

const DEFAULT_PORT = 3103;
const DEFAULT_ANALYTICS_CACHE_MS = 60_000;
const ROUTES = [
  "GET /ui/agents",
  "GET /ui/briefs",
  "GET /ui/skills",
  "GET /ui/crons",
  "GET /ui/audit",
  "GET /ui/budgets",
  "GET /ui/budgets/totals",
  "GET /ui/anti-patterns",
  "GET /ui/success-rate",
  "GET /ui/health",
] as const;

const briefsQuery = z.object({
  q: z.string().min(1, "missing required query param 'q'"),
  k: z.string().optional()
    .transform((v) => (v === undefined ? 5 : Number.parseInt(v, 10)))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, { message: "'k' must be a positive integer <= 100" }),
});

const auditQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO format YYYY-MM-DD"),
});

const daysQuery = z.object({
  days: z.string().optional()
    .transform((v) => (v === undefined ? 7 : Number.parseInt(v, 10)))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 90, { message: "'days' must be a positive integer <= 90" }),
});

interface CacheEntry<T> { at: number; value: T; }

export class UIApiServer {
  private readonly port: number;
  private readonly registry?: AgentRegistry;
  private readonly briefStore?: BriefStore;
  private readonly skillRegistry?: SkillRegistryDB;
  private readonly cronDb?: CronJobsDB;
  private readonly auditLog?: AuditLog;
  private readonly budgetTracker?: BudgetTracker;
  private readonly attemptsLog?: LoopAttemptLog;
  private readonly skillUsageLedger?: SkillUsageLedger;
  private readonly antiPatternSink?: AntiPatternMemorySink;
  private readonly antiPatternEmbedder?: AntiPatternEmbedder;
  private readonly analyticsCacheMs: number;
  private readonly logger: (msg: string, err?: unknown) => void;

  private server: HttpServer | null = null;
  private readonly startedAt = Date.now();
  private boundPort: number | null = null;
  private readonly analyticsCache = new Map<string, CacheEntry<unknown>>();

  constructor(opts: UIApiOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.registry = opts.registry;
    this.briefStore = opts.briefStore;
    this.skillRegistry = opts.skillRegistry;
    this.cronDb = opts.cronDb;
    this.auditLog = opts.auditLog;
    this.budgetTracker = opts.budgetTracker;
    this.attemptsLog = opts.attemptsLog;
    this.skillUsageLedger = opts.skillUsageLedger;
    this.antiPatternSink = opts.antiPatternSink;
    this.antiPatternEmbedder = opts.antiPatternEmbedder;
    this.analyticsCacheMs = opts.analyticsCacheMs ?? DEFAULT_ANALYTICS_CACHE_MS;
    this.logger = opts.logger ?? ((msg, err) => {
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
        this.boundPort = addr && typeof addr === "object" ? addr.port : this.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => { this.server!.close(() => resolve()); });
    this.server = null;
    this.boundPort = null;
  }

  address(): number | null { return this.boundPort; }
  clearAnalyticsCache(): void { this.analyticsCache.clear(); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") { this.sendError(res, 405, "Method not allowed"); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const params = Object.fromEntries(url.searchParams.entries());
    switch (url.pathname) {
      case "/ui/agents": return this.handleAgents(res);
      case "/ui/briefs": return this.handleBriefs(res, params);
      case "/ui/skills": return this.handleSkills(res);
      case "/ui/crons":  return this.handleCrons(res);
      case "/ui/audit":  return this.handleAudit(res, params);
      case "/ui/budgets": return this.handleBudgets(res);
      case "/ui/budgets/totals": return this.handleBudgetsTotals(res, params);
      case "/ui/anti-patterns": return this.handleAntiPatterns(res, params);
      case "/ui/success-rate":  return this.handleSuccessRate(res, params);
      case "/ui/health": return this.handleHealth(res);
      default: this.sendError(res, 404, `Not found: ${url.pathname}`);
    }
  }

  private handleAgents(res: ServerResponse): void {
    try { this.sendJson(res, 200, this.registry?.list() ?? []); }
    catch (err) { this.logger("GET /ui/agents failed", err); this.sendError(res, 500, "Failed to list agents"); }
  }

  private async handleBriefs(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const parsed = briefsQuery.safeParse(params);
    if (!parsed.success) { this.sendError(res, 400, parsed.error.issues.map((i) => i.message).join("; ")); return; }
    if (!this.briefStore) { this.sendJson(res, 200, []); return; }
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
    } catch (err) { this.logger("GET /ui/briefs failed", err); this.sendError(res, 500, "Failed to recall briefs"); }
  }

  private handleSkills(res: ServerResponse): void {
    try { this.sendJson(res, 200, this.skillRegistry?.list() ?? []); }
    catch (err) { this.logger("GET /ui/skills failed", err); this.sendError(res, 500, "Failed to list skills"); }
  }

  private handleCrons(res: ServerResponse): void {
    try { this.sendJson(res, 200, this.cronDb?.list() ?? []); }
    catch (err) { this.logger("GET /ui/crons failed", err); this.sendError(res, 500, "Failed to list cron jobs"); }
  }

  private handleAudit(res: ServerResponse, params: Record<string, string>): void {
    const parsed = auditQuery.safeParse(params);
    if (!parsed.success) { this.sendError(res, 400, parsed.error.issues.map((i) => i.message).join("; ")); return; }
    if (!this.auditLog) { this.sendJson(res, 200, { totalSamples: 0, surfaced: 0, actedOn: 0 }); return; }
    try {
      const date = new Date(`${parsed.data.date}T00:00:00.000Z`);
      this.sendJson(res, 200, this.auditLog.dailySummary(date));
    } catch (err) { this.logger("GET /ui/audit failed", err); this.sendError(res, 500, "Failed to summarise audit log"); }
  }

  private async handleAntiPatterns(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const parsed = daysQuery.safeParse(params);
    if (!parsed.success) { this.sendError(res, 400, parsed.error.issues.map((i) => i.message).join("; ")); return; }
    if (!this.attemptsLog || !this.skillUsageLedger) { this.sendJson(res, 200, emptyAntiPatternReport(parsed.data.days)); return; }
    const cacheKey = `anti-patterns:${parsed.data.days}`;
    const cached = this.readCache<AntiPatternReport>(cacheKey);
    if (cached) { this.sendJson(res, 200, cached); return; }
    try {
      const report = await detectAntiPatterns(
        { attemptsLog: this.attemptsLog, skillUsageLedger: this.skillUsageLedger, vectorStore: this.antiPatternSink, embedder: this.antiPatternEmbedder },
        { windowDays: parsed.data.days },
      );
      this.writeCache(cacheKey, report);
      this.sendJson(res, 200, report);
    } catch (err) { this.logger("GET /ui/anti-patterns failed", err); this.sendError(res, 500, "Failed to compute anti-patterns"); }
  }

  private async handleSuccessRate(res: ServerResponse, params: Record<string, string>): Promise<void> {
    const parsed = daysQuery.safeParse(params);
    if (!parsed.success) { this.sendError(res, 400, parsed.error.issues.map((i) => i.message).join("; ")); return; }
    if (!this.attemptsLog || !this.registry) { this.sendJson(res, 200, emptySuccessRateReport(parsed.data.days)); return; }
    const cacheKey = `success-rate:${parsed.data.days}`;
    const cached = this.readCache<SuccessRateReport>(cacheKey);
    if (cached) { this.sendJson(res, 200, cached); return; }
    try {
      const report = await computeSuccessRate(
        { attemptsLog: this.attemptsLog, registry: this.registry },
        { windowDays: parsed.data.days },
      );
      this.writeCache(cacheKey, report);
      this.sendJson(res, 200, report);
    } catch (err) { this.logger("GET /ui/success-rate failed", err); this.sendError(res, 500, "Failed to compute success rate"); }
  }

  private handleBudgets(res: ServerResponse): void {
    if (!this.budgetTracker) { this.sendJson(res, 200, []); return; }
    try {
      const result = handleBudgetsList(this.budgetTracker);
      this.sendJson(res, result.status, result.body);
    } catch (err) { this.logger("GET /ui/budgets failed", err); this.sendError(res, 500, "Failed to list budgets"); }
  }

  private handleBudgetsTotals(res: ServerResponse, params: Record<string, string>): void {
    if (!this.budgetTracker) { this.sendJson(res, 200, { tokens_in: 0, tokens_out: 0, cost_usd: 0 }); return; }
    try {
      const result = handleBudgetsTotals(this.budgetTracker, params);
      if (result.status === 400) { this.sendError(res, 400, result.body.error); return; }
      this.sendJson(res, result.status, result.body);
    } catch (err) { this.logger("GET /ui/budgets/totals failed", err); this.sendError(res, 500, "Failed to compute budget totals"); }
  }

  private handleHealth(res: ServerResponse): void {
    const uptime_s = Math.floor((Date.now() - this.startedAt) / 1000);
    this.sendJson(res, 200, { ok: true, uptime_s, routes: [...ROUTES] });
  }

  private readCache<T>(key: string): T | undefined {
    const entry = this.analyticsCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.analyticsCacheMs) { this.analyticsCache.delete(key); return undefined; }
    return entry.value as T;
  }

  private writeCache(key: string, value: unknown): void {
    this.analyticsCache.set(key, { at: Date.now(), value });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload).toString(),
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    this.sendJson(res, status, { error: message });
  }
}

function emptyAntiPatternReport(windowDays: number): AntiPatternReport {
  return { windowDays, totalFailures: 0, clusters: [], newClustersSinceLastRun: 0 };
}

function emptySuccessRateReport(windowDays: number): SuccessRateReport {
  return {
    windowDays,
    byRole: [],
    byOverall: {
      role: "all",
      totalAttempts: 0,
      successCount: 0,
      recoveredCount: 0,
      escalatedCount: 0,
      failedCount: 0,
      successRate: 0,
      autonomyRate: 0,
      avgAttemptsToResolve: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
    },
    trend: [],
  };
}
