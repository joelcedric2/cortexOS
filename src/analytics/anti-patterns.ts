/**
 * Anti-pattern clustering — plan §6 Phase 7 (bullet 2).
 *
 * Pulls failure rows from `loop_attempts` and `skill_runs`, normalizes each
 * into a canonical signature, groups them into clusters, and (when a cluster
 * exceeds `flagThreshold` hits inside a rolling window) emits a pgvector
 * memory tagged `anti-pattern:avoid` so RECALL can surface the warning to
 * future agents before they repeat the mistake.
 *
 * The algorithm is deliberately simple — a regex-based error-class extractor
 * plus string concat — so the clustering is cheap, debuggable, and good enough
 * at the volumes Phase 7 is targeting. A richer embedding-based approach can
 * replace `canonicalSignature` later without changing the public shape.
 */
import type { LoopAttemptLog, LoopAttemptRow } from "../loop/loop-attempts-db.js";
import type { SkillUsageLedger, SkillRunRow } from "../skills/usage-ledger.js";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

// ─── Public types ────────────────────────────────────────────────────────────

export type AntiPatternSource = "loop_attempts" | "skill_runs";

export interface AntiPatternSample {
  timestamp: string;
  agentRole?: string;
  skillName?: string;
  errorMsg: string;
}

export interface AntiPatternCluster {
  /** Stable hash of the signature. Safe to use as a pgvector memory id seed. */
  id: string;
  /** Canonical form, e.g. "loop_attempts:NETWORK:retry_same" or "skill_runs:TIMEOUT:docs-fetch". */
  signature: string;
  hitCount: number;
  firstSeen: string;
  lastSeen: string;
  sources: AntiPatternSource[];
  samples: AntiPatternSample[];
  autoFlagged: boolean;
}

export interface AntiPatternReport {
  windowDays: number;
  totalFailures: number;
  clusters: AntiPatternCluster[];
  newClustersSinceLastRun: number;
}

export interface AntiPatternMemorySink {
  storeMemory(record: {
    agentRole: string;
    taskType: string;
    content: string;
    embedding: number[];
    outcome: "success" | "fail";
    tags: string[];
  }): Promise<string>;
}

export interface AntiPatternEmbedder {
  embed(text: string): Promise<number[]>;
}

export interface DetectAntiPatternsDeps {
  attemptsLog: LoopAttemptLog;
  skillUsageLedger: SkillUsageLedger;
  /** Optional sink. When omitted the function still returns the report but does not persist. */
  vectorStore?: AntiPatternMemorySink;
  embedder?: AntiPatternEmbedder;
}

export interface DetectAntiPatternsOpts {
  /** Rolling window for failure aggregation. Default 7. */
  windowDays?: number;
  /** Clusters below this hit count are excluded from the report. Default 1. */
  minCluster?: number;
  /** Clusters at or above this hit count are flagged + persisted. Default 3. */
  flagThreshold?: number;
  /** Maximum samples carried per cluster (memory budget). Default 5. */
  maxSamplesPerCluster?: number;
  /**
   * Signature strings already persisted as anti-pattern memories. Used to
   * compute `newClustersSinceLastRun` and avoid double-writing. Callers
   * typically pass a set read from pgvector at the start of the run.
   */
  knownSignatures?: Set<string>;
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface NormalizedFailure {
  source: AntiPatternSource;
  errorClass: string;
  discriminator: string; // strategy or skillName
  errorMsg: string;
  timestamp: string;
  agentRole?: string;
  skillName?: string;
}

const ERROR_CLASS_REGEX =
  /NETWORK|TIMEOUT|AUTH|PARSE|PERMISSION|NOTFOUND|RATELIMIT|5\d\d|4\d\d/i;

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MIN_CLUSTER = 1;
const DEFAULT_FLAG_THRESHOLD = 3;
const DEFAULT_MAX_SAMPLES = 5;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract a canonical error class from a free-form message. Exported for tests
 * and for the per-row signature builder above. Returns `"UNKNOWN"` when no
 * known class matches — intentionally coarse so unknown failures still cluster.
 */
export function parseErrorClass(msg: string | null | undefined): string {
  if (!msg) return "UNKNOWN";
  const m = ERROR_CLASS_REGEX.exec(msg);
  if (!m) return "UNKNOWN";
  return m[0].toUpperCase();
}

/**
 * Build the canonical `<source>:<errorClass>:<discriminator>` signature for a
 * single failure row. Exported so tests can assert normalization
 * independently of clustering.
 */
export function canonicalSignature(n: NormalizedFailure): string {
  const disc = (n.discriminator ?? "").trim() || "unknown";
  return `${n.source}:${n.errorClass}:${disc}`;
}

export async function detectAntiPatterns(
  deps: DetectAntiPatternsDeps,
  opts: DetectAntiPatternsOpts = {},
): Promise<AntiPatternReport> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minCluster = opts.minCluster ?? DEFAULT_MIN_CLUSTER;
  const flagThreshold = opts.flagThreshold ?? DEFAULT_FLAG_THRESHOLD;
  const maxSamples = opts.maxSamplesPerCluster ?? DEFAULT_MAX_SAMPLES;
  const knownSignatures = opts.knownSignatures ?? new Set<string>();

  const cutoffISO = windowCutoff(windowDays);

  const loopRows = readLoopFailures(deps.attemptsLog, cutoffISO);
  const skillRows = readSkillFailures(deps.skillUsageLedger, cutoffISO);

  const normalized: NormalizedFailure[] = [
    ...loopRows.map(normalizeLoop),
    ...skillRows.map(normalizeSkill),
  ];

  // Group by signature.
  const buckets = new Map<string, NormalizedFailure[]>();
  for (const n of normalized) {
    const sig = canonicalSignature(n);
    const bucket = buckets.get(sig);
    if (bucket) bucket.push(n);
    else buckets.set(sig, [n]);
  }

  const clusters: AntiPatternCluster[] = [];
  let newClusters = 0;
  const flaggedForPersist: AntiPatternCluster[] = [];

  for (const [signature, rows] of buckets) {
    if (rows.length < minCluster) continue;

    rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const samples: AntiPatternSample[] = rows.slice(0, maxSamples).map((r) => ({
      timestamp: r.timestamp,
      agentRole: r.agentRole,
      skillName: r.skillName,
      errorMsg: r.errorMsg,
    }));

    const sources = uniqueSources(rows);
    const autoFlagged = rows.length >= flagThreshold;
    const cluster: AntiPatternCluster = {
      id: hashSignature(signature),
      signature,
      hitCount: rows.length,
      firstSeen: rows[0].timestamp,
      lastSeen: rows[rows.length - 1].timestamp,
      sources,
      samples,
      autoFlagged,
    };
    clusters.push(cluster);
    if (autoFlagged && !knownSignatures.has(signature)) {
      newClusters += 1;
      flaggedForPersist.push(cluster);
    }
  }

  clusters.sort((a, b) => b.hitCount - a.hitCount);

  // Fire-and-forget persistence — deliberate: the report itself must always
  // come back even if pgvector is down, so callers can still render the UI.
  if (deps.vectorStore && deps.embedder && flaggedForPersist.length > 0) {
    for (const cluster of flaggedForPersist) {
      try {
        const content = composeAntiPatternContent(cluster);
        const embedding = await deps.embedder.embed(content);
        await deps.vectorStore.storeMemory({
          agentRole: "system",
          taskType: "anti_pattern",
          content,
          embedding,
          outcome: "fail",
          tags: ["anti-pattern:avoid", cluster.signature, cluster.id],
        });
      } catch (err) {
        // Re-throw a typed error so the dashboard route can map it to 500.
        // Never silently swallow — that's how learning loops rot.
        throw new AntiPatternPersistError(cluster.signature, err);
      }
    }
  }

  return {
    windowDays,
    totalFailures: normalized.length,
    clusters,
    newClustersSinceLastRun: newClusters,
  };
}

export class AntiPatternPersistError extends Error {
  constructor(public readonly signature: string, public readonly cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`failed to persist anti-pattern memory for ${signature}: ${causeMsg}`);
    this.name = "AntiPatternPersistError";
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface LoopLogInternal {
  db: Database.Database;
}

function readLoopFailures(log: LoopAttemptLog, cutoffISO: string): LoopAttemptRow[] {
  // LoopAttemptLog owns its DB; we piggy-back on its connection for a single
  // read-only query. This is safer than constructing a new connection which
  // could race WAL mode setup.
  const db = (log as unknown as LoopLogInternal).db;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("readLoopFailures: LoopAttemptLog did not expose a SQLite handle");
  }
  const stmt = db.prepare(
    `SELECT * FROM loop_attempts
      WHERE ended_at >= ?
        AND (
          (state = 'ATTEMPT' AND error IS NOT NULL AND error != '')
          OR state = 'ESCALATED'
          OR state = 'STRATEGY_ERROR'
        )
      ORDER BY ended_at ASC`,
  );
  return stmt.all(cutoffISO) as LoopAttemptRow[];
}

interface SkillLedgerInternal {
  db: Database.Database;
}

function readSkillFailures(ledger: SkillUsageLedger, cutoffISO: string): SkillRunRow[] {
  const db = (ledger as unknown as SkillLedgerInternal).db;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("readSkillFailures: SkillUsageLedger did not expose a SQLite handle");
  }
  const stmt = db.prepare(
    `SELECT * FROM skill_runs
      WHERE created_at >= ?
        AND outcome != 'success'
      ORDER BY created_at ASC`,
  );
  return stmt.all(cutoffISO) as SkillRunRow[];
}

function normalizeLoop(row: LoopAttemptRow): NormalizedFailure {
  return {
    source: "loop_attempts",
    errorClass: parseErrorClass(row.error),
    discriminator: row.strategy ?? "no-strategy",
    errorMsg: row.error ?? "",
    timestamp: row.ended_at,
    agentRole: undefined,
  };
}

function normalizeSkill(row: SkillRunRow): NormalizedFailure {
  const klass = row.error_class && row.error_class.trim().length > 0
    ? row.error_class.toUpperCase()
    : parseErrorClass(row.error_msg);
  return {
    source: "skill_runs",
    errorClass: klass,
    discriminator: row.skill_name,
    errorMsg: row.error_msg ?? "",
    timestamp: row.created_at,
    skillName: row.skill_name,
  };
}

function uniqueSources(rows: NormalizedFailure[]): AntiPatternSource[] {
  const seen = new Set<AntiPatternSource>();
  for (const r of rows) seen.add(r.source);
  return Array.from(seen).sort();
}

function windowCutoff(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function hashSignature(sig: string): string {
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

function composeAntiPatternContent(cluster: AntiPatternCluster): string {
  const sampleLines = cluster.samples
    .slice(0, 3)
    .map((s) => {
      const who = s.agentRole ?? s.skillName ?? "agent";
      const msg = truncate(s.errorMsg, 200);
      return `  - [${s.timestamp}] ${who}: ${msg}`;
    })
    .join("\n");
  return [
    `ANTI-PATTERN: ${cluster.signature}`,
    `hits=${cluster.hitCount}, firstSeen=${cluster.firstSeen}, lastSeen=${cluster.lastSeen}`,
    `sources=${cluster.sources.join(",")}`,
    `recent:`,
    sampleLines,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
