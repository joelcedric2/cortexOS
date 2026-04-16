/**
 * Canon pattern promotion — Phase 7 consolidation, piece 2.
 *
 * Scans recent success-outcome memories, groups them into "repeat clusters"
 * using the same union-find-over-neighbours strategy as dedup (but with a
 * lower threshold so only content-equivalent memories count as "the same
 * pattern"), and promotes any cluster whose hit count crosses `minHits` by
 * inserting a new "canon" copy tagged with `canon` + original tags + a
 * `weight:canon` marker.
 *
 * We INSERT a new row rather than rewriting originals — history stays intact,
 * and re-running promotion is safe because we detect pre-existing canon rows
 * within a cluster and skip promotion for those groups.
 *
 * Determinism: sample order and promotion priority are deterministic so tests
 * and ops replays produce stable reports.
 */
import type {
  MemoryRecord,
  MemorySearchResult,
  VectorStore,
} from "../memory/vector-store.js";

export interface CanonPromotionOptions {
  minHits?: number;
  windowDays?: number;
  dryRun?: boolean;
  similarityThreshold?: number;
  neighbourK?: number;
  agentRole?: string;
  taskType?: string;
  sampleLimit?: number;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

export interface CanonPromotionReport {
  candidates: number;
  promoted: number;
  skipped: number;
  details: Array<{ id: string; reason: string; hitCount: number }>;
}

export interface CanonPromotionDeps {
  vectorStore: Pick<
    VectorStore,
    "listMemories" | "searchMemories" | "storeMemory"
  >;
}

const DEFAULTS = {
  minHits: 5,
  windowDays: 30,
  dryRun: true,
  similarityThreshold: 0.95,
  neighbourK: 10,
  sampleLimit: 20,
} as const;

const CANON_TAG = "canon";
const CANON_WEIGHT_TAG = "weight:canon";

export async function promoteCanonPatterns(
  deps: CanonPromotionDeps,
  opts: CanonPromotionOptions = {},
): Promise<CanonPromotionReport> {
  const cfg = {
    minHits: opts.minHits ?? DEFAULTS.minHits,
    windowDays: opts.windowDays ?? DEFAULTS.windowDays,
    dryRun: opts.dryRun ?? DEFAULTS.dryRun,
    similarityThreshold: opts.similarityThreshold ?? DEFAULTS.similarityThreshold,
    neighbourK: opts.neighbourK ?? DEFAULTS.neighbourK,
    agentRole: opts.agentRole,
    taskType: opts.taskType,
    sampleLimit: opts.sampleLimit ?? DEFAULTS.sampleLimit,
    now: opts.now ?? (() => new Date()),
  };

  if (!Number.isInteger(cfg.minHits) || cfg.minHits < 2) {
    throw new Error(
      `promoteCanonPatterns: minHits must be an integer >= 2, got ${cfg.minHits}`,
    );
  }
  if (!Number.isFinite(cfg.windowDays) || cfg.windowDays <= 0) {
    throw new Error(
      `promoteCanonPatterns: windowDays must be > 0, got ${cfg.windowDays}`,
    );
  }
  if (cfg.similarityThreshold <= 0 || cfg.similarityThreshold > 1) {
    throw new Error(
      `promoteCanonPatterns: similarityThreshold must be in (0,1], got ${cfg.similarityThreshold}`,
    );
  }

  const cutoff = new Date(
    cfg.now().getTime() - cfg.windowDays * 24 * 60 * 60 * 1000,
  );

  // 1. Pull recent success memories.
  const successes = new Map<string, MemoryRecord>();
  let offset = 0;
  const BATCH = 1000;
  while (successes.size < 10_000_000) {
    const page = await deps.vectorStore.listMemories({
      limit: BATCH,
      offset,
      outcome: "success",
      createdAfter: cutoff,
      agentRole: cfg.agentRole,
      taskType: cfg.taskType,
    });
    if (page.length === 0) break;
    for (const row of page) successes.set(row.id, row);
    if (page.length < BATCH) break;
    offset += page.length;
  }

  if (successes.size === 0) {
    return { candidates: 0, promoted: 0, skipped: 0, details: [] };
  }

  // 2. Cluster via union-find on high-similarity neighbours.
  const uf = new UnionFind(successes.keys());
  for (const anchor of successes.values()) {
    const neighbours: MemorySearchResult[] =
      await deps.vectorStore.searchMemories(
        anchor.embedding,
        cfg.neighbourK,
        { outcome: "success" },
      );
    for (const nb of neighbours) {
      if (nb.id === anchor.id) continue;
      if (!successes.has(nb.id)) continue;
      if (nb.similarity < cfg.similarityThreshold) continue;
      uf.union(anchor.id, nb.id);
    }
  }

  const clusters = new Map<string, MemoryRecord[]>();
  for (const row of successes.values()) {
    const root = uf.find(row.id);
    const bucket = clusters.get(root);
    if (bucket) bucket.push(row);
    else clusters.set(root, [row]);
  }

  // 3. Promote clusters that cross minHits AND have no existing canon row.
  let candidates = 0;
  let promoted = 0;
  let skipped = 0;
  const details: CanonPromotionReport["details"] = [];

  // Deterministic iteration for stable reports.
  const sorted = Array.from(clusters.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [, members] of sorted) {
    if (members.length < cfg.minHits) continue;
    candidates++;

    const hasExistingCanon = members.some((m) => m.tags.includes(CANON_TAG));
    const exemplar = pickExemplar(members);

    if (hasExistingCanon) {
      skipped++;
      if (details.length < cfg.sampleLimit) {
        details.push({
          id: exemplar.id,
          reason: "already_has_canon",
          hitCount: members.length,
        });
      }
      continue;
    }

    if (details.length < cfg.sampleLimit) {
      details.push({
        id: exemplar.id,
        reason: cfg.dryRun ? "dry_run_would_promote" : "promoted",
        hitCount: members.length,
      });
    }

    if (cfg.dryRun) {
      // Count as promoted-in-intent so the worker can diff vs. actual run.
      promoted++;
      continue;
    }

    // Merge + dedupe tags, keep exemplar's provenance.
    const tagSet = new Set<string>();
    for (const t of exemplar.tags) tagSet.add(t);
    tagSet.add(CANON_TAG);
    tagSet.add(CANON_WEIGHT_TAG);

    await deps.vectorStore.storeMemory({
      agentRole: exemplar.agentRole,
      taskType: exemplar.taskType,
      content: exemplar.content,
      embedding: exemplar.embedding,
      outcome: "success",
      tags: Array.from(tagSet).sort(),
    });
    promoted++;
  }

  return { candidates, promoted, skipped, details };
}

function pickExemplar(members: MemoryRecord[]): MemoryRecord {
  // Most recent wins; tiebreak by id for determinism.
  return [...members].sort((a, b) => {
    const diff = b.createdAt.getTime() - a.createdAt.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  })[0]!;
}

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();
  constructor(ids: Iterable<string>) {
    for (const id of ids) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }
  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) throw new Error(`UnionFind.find: unknown id ${id}`);
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}
