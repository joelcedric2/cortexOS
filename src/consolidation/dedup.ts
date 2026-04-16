/**
 * Near-duplicate memory collapse — Phase 7 consolidation, piece 1.
 *
 * Scans the `memories` table in batches, builds a union-find cluster over
 * pairs whose cosine similarity exceeds `similarityThreshold`, then keeps one
 * representative per cluster and (if not a dry run) deletes the rest.
 */
import type {
  MemoryRecord,
  MemorySearchResult,
  VectorStore,
} from "../memory/vector-store.js";

export interface DedupOptions {
  namespace?: string;
  similarityThreshold?: number;
  keepStrategy?: "highest_similarity" | "oldest" | "newest";
  dryRun?: boolean;
  batchSize?: number;
  neighbourK?: number;
  sampleLimit?: number;
}

export interface DedupReport {
  scanned: number;
  clusters: number;
  duplicatesRemoved: number;
  bytesFreed: number;
  samples: Array<{ kept: string; removed: string[]; similarity: number }>;
}

export interface DedupDeps {
  vectorStore: Pick<
    VectorStore,
    "listMemories" | "searchMemories" | "deleteMemory"
  >;
  embedder?: unknown;
}

const DEFAULTS = {
  similarityThreshold: 0.92,
  keepStrategy: "newest" as const,
  dryRun: true,
  batchSize: 1000,
  neighbourK: 10,
  sampleLimit: 5,
} as const;

export async function dedupMemories(
  deps: DedupDeps,
  opts: DedupOptions = {},
): Promise<DedupReport> {
  const cfg = {
    namespace: opts.namespace,
    similarityThreshold: opts.similarityThreshold ?? DEFAULTS.similarityThreshold,
    keepStrategy: opts.keepStrategy ?? DEFAULTS.keepStrategy,
    dryRun: opts.dryRun ?? DEFAULTS.dryRun,
    batchSize: opts.batchSize ?? DEFAULTS.batchSize,
    neighbourK: opts.neighbourK ?? DEFAULTS.neighbourK,
    sampleLimit: opts.sampleLimit ?? DEFAULTS.sampleLimit,
  };

  if (cfg.similarityThreshold <= 0 || cfg.similarityThreshold > 1) {
    throw new Error(
      `dedupMemories: similarityThreshold must be in (0,1], got ${cfg.similarityThreshold}`,
    );
  }
  if (!Number.isInteger(cfg.batchSize) || cfg.batchSize <= 0) {
    throw new Error(
      `dedupMemories: batchSize must be a positive integer, got ${cfg.batchSize}`,
    );
  }
  if (!Number.isInteger(cfg.neighbourK) || cfg.neighbourK <= 0) {
    throw new Error(
      `dedupMemories: neighbourK must be a positive integer, got ${cfg.neighbourK}`,
    );
  }

  const all = new Map<string, MemoryRecord>();
  let offset = 0;
  const HARD_SCAN_CAP = 10_000_000;
  while (all.size < HARD_SCAN_CAP) {
    const page: MemoryRecord[] = await deps.vectorStore.listMemories({
      limit: cfg.batchSize,
      offset,
      tag: cfg.namespace,
    });
    if (page.length === 0) break;
    for (const row of page) all.set(row.id, row);
    if (page.length < cfg.batchSize) break;
    offset += page.length;
  }

  if (all.size === 0) {
    return {
      scanned: 0,
      clusters: 0,
      duplicatesRemoved: 0,
      bytesFreed: 0,
      samples: [],
    };
  }

  const uf = new UnionFind(all.keys());
  const bestPairSim = new Map<string, number>();

  for (const anchor of all.values()) {
    const neighbours: MemorySearchResult[] =
      await deps.vectorStore.searchMemories(anchor.embedding, cfg.neighbourK);
    for (const nb of neighbours) {
      if (nb.id === anchor.id) continue;
      if (!all.has(nb.id)) continue;
      if (nb.similarity < cfg.similarityThreshold) continue;
      uf.union(anchor.id, nb.id);
      const root = uf.find(anchor.id);
      const prev = bestPairSim.get(root) ?? -Infinity;
      if (nb.similarity > prev) bestPairSim.set(root, nb.similarity);
    }
  }

  const clusters = new Map<string, MemoryRecord[]>();
  for (const row of all.values()) {
    const root = uf.find(row.id);
    const bucket = clusters.get(root);
    if (bucket) {
      bucket.push(row);
    } else {
      clusters.set(root, [row]);
    }
  }

  let duplicatesRemoved = 0;
  let bytesFreed = 0;
  let multiMemberClusters = 0;
  const samples: DedupReport["samples"] = [];

  const sortedClusters = Array.from(clusters.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [root, members] of sortedClusters) {
    if (members.length < 2) continue;
    multiMemberClusters++;

    const keeper = pickKeeper(members, cfg.keepStrategy);
    const victims = members.filter((m) => m.id !== keeper.id);
    const clusterSim = bestPairSim.get(root) ?? cfg.similarityThreshold;

    for (const v of victims) {
      duplicatesRemoved++;
      bytesFreed += Buffer.byteLength(v.content, "utf8");
      if (!cfg.dryRun) {
        await deps.vectorStore.deleteMemory(v.id);
      }
    }

    if (samples.length < cfg.sampleLimit) {
      samples.push({
        kept: keeper.id,
        removed: victims.map((v) => v.id),
        similarity: clusterSim,
      });
    }
  }

  return {
    scanned: all.size,
    clusters: multiMemberClusters,
    duplicatesRemoved,
    bytesFreed,
    samples,
  };
}

function pickKeeper(
  members: MemoryRecord[],
  strategy: NonNullable<DedupOptions["keepStrategy"]>,
): MemoryRecord {
  if (strategy === "oldest") {
    return [...members].sort((a, b) => {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    })[0]!;
  }
  if (strategy === "newest") {
    return [...members].sort((a, b) => {
      const diff = b.createdAt.getTime() - a.createdAt.getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    })[0]!;
  }
  return [...members].sort((a, b) => {
    const aCanon = a.tags.includes("canon") ? 1 : 0;
    const bCanon = b.tags.includes("canon") ? 1 : 0;
    if (aCanon !== bCanon) return bCanon - aCanon;
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
    if (p === undefined) {
      throw new Error(`UnionFind.find: unknown id ${id}`);
    }
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
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}
