# Phase 7 Decisions — Consolidation Worker (coder 1)

**Branch:** `phase7/consolidation`
**Scope:** nightly memory consolidation — dedup + canon promotion + scheduler wiring.

## 1. Shape of consolidation

Two pure functions + one orchestrator, all in `src/consolidation/`:

| File | Exports | Purpose |
|---|---|---|
| `dedup.ts` | `dedupMemories`, `DedupOptions`, `DedupReport` | Collapse near-duplicate memories |
| `canon.ts` | `promoteCanonPatterns`, `CanonPromotionOptions`, `CanonPromotionReport` | Insert a `canon`-tagged row for repeated-success clusters |
| `worker.ts` | `runConsolidation`, `buildConsolidationRunHandler`, `ConsolidationRunReport` | Orchestrate both + emit bus events + persist audit JSON |

Design constraints:

- **`dryRun` defaults to `true`** at the function level. The worker entrypoint is the only caller that flips it — Phase 7 hardening mandates safe-by-default.
- **Pure functions** depend on a typed `Pick<VectorStore, ...>` subset, never the concrete class, so tests use trivial fakes.
- **No `any`**; `unknown`-based parsing at boundaries.

## 2. Storage API addition

`VectorStore.listMemories(opts)` was added because the existing `searchMemories` only returns top-K by similarity — not suitable for full-corpus streaming. It:

- Sorts by `(created_at ASC, id ASC)` so offset paging is deterministic
- Accepts `limit/offset/agentRole/taskType/outcome/tag/createdAfter` filters (ANDed)
- Uses parameterized queries only; no SQL string concatenation

All other methods are unchanged.

## 3. Dedup algorithm

1. Stream memories in 1000-row pages (bounded memory even at 10M rows)
2. For each memory, fetch top-10 neighbours from the same pgvector HNSW index that powers normal semantic search
3. Union-find pairs above `similarityThreshold` (default 0.92 — strict)
4. Pick a cluster keeper per `keepStrategy`: `newest` (default), `oldest`, or `highest_similarity` (prefers `canon`-tagged rows)
5. Delete victims (prepared-statement DELETE via `deleteMemory`)

**Idempotence**: a second pass finds every cluster has size 1, removes nothing. Tested.

## 4. Canon promotion algorithm

1. Pull recent (within `windowDays`) `outcome='success'` memories
2. Cluster via union-find on high-similarity neighbours (`similarityThreshold` default 0.95 — stricter than dedup, since we only promote when things are basically the same pattern)
3. For clusters ≥ `minHits` (default 5) with no existing `canon` member, INSERT a new row tagged with `canon` + `weight:canon` + exemplar's original tags
4. Leave originals alone — provenance stays intact, and the next dedup run's `highest_similarity` keeper strategy will favour the canon row if we later consolidate both

**Idempotence**: existing `canon` tag on any cluster member → skip promotion for that cluster. Tested.

## 5. Scheduler wiring

`src/scheduler/defaults.ts` already seeds a `memory_consolidation` job with cron `0 4 * * *`, disabled by default. No edits to `defaults.ts` — the wire-up lives in the worker module so the scheduler stays agnostic of consolidation.

The Controller ultimately wires this in by writing something like:

```ts
const consolidationHandler = buildConsolidationRunHandler({
  vectorStore, embedder, bus,
});

const scheduler = new Scheduler({
  db: cronJobsDb,
  bus,
  run: async (job) => {
    if (job.name === "memory_consolidation") {
      return consolidationHandler(job);
    }
    return defaultAutonomyRun(job);
  },
});
```

The Scheduler keeps its one-`run`-callback contract; the Controller routes by job name. Same pattern as the `skill_evolution_tick` job per §5.5.3.

## 6. Bus events

Two events per run, both `kind: 'plan_emitted'` per the frozen EventBus contract:

- `{ phase: "CONSOLIDATION_STARTED", ts: <ISO> }` at entry
- `{ phase: "CONSOLIDATION_COMPLETE", report: ConsolidationRunReport }` at exit
- `{ phase: "CONSOLIDATION_PERSIST_FAILED", error, ts }` if audit JSON write fails (non-fatal)

Mission Control's existing WS bridge picks these up unchanged — no new EventKind needed.

## 7. Audit log

Each run writes `~/.cortexos/consolidation/runs/<ISO-timestamp>.json` containing the full `ConsolidationRunReport`. Filename sanitizes `:` → `-` for Windows FS compatibility. Directory is created with `{recursive: true}`; write is best-effort (failure logs via bus, does not fail the run).

## 8. Why UNION-FIND rather than pairwise hashing

Content hashing misses paraphrases ("email the team" vs "send an email to the team"). Embeddings catch them. Once we're in embedding space, union-find over top-K neighbour edges is O(N·K·α(N)) — effectively linear on the 1M-memory corpus we expect by year-end.

## 9. Tests

- `tests/consolidation-dedup.test.ts` — 10 tests, includes 100→1 DoD case
- `tests/consolidation-canon.test.ts` — 10 tests, includes 5→canon DoD case
- `tests/consolidation-worker.test.ts` — 4 end-to-end tests: bus emission order, audit file written to tmp dir, idempotence, skipPersist suppression

All use in-memory `FakeVectorStore` / `FakeEmbedder` / `CapturingBus`. No DB dependency.
