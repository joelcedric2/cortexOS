# Phase 7 — Independent Review (Tester 2, read-only)

Reviewer: Tester 2 (Phase 7). Read-only sweep across four coder branches
plus the in-flight integration branch. See `docs/NCHINDA_PLAN.md` §6 Phase
7 DoD (bullets 1–5), §5.5 (evolution loop that consumes the anti-pattern
clusters), and §2.1 (Resourcefulness ladder — relevant to C4).

**Final state captured at this pass** (HEAD = `phase7/integration`):

| Branch | Commits beyond `main` | What shipped |
|---|---:|---|
| `phase7/consolidation`          | 7  | dedup + canon + worker + scheduler wiring + DECISIONS.md |
| `phase7/antipatterns-dashboard` | 6  | anti-patterns + success-rate + analytics UI routes + 60s cache |
| `phase7/bench-observability`    | 6  | stress + seed-tasks + BudgetTracker + `/ui/budgets` |
| `phase7/hardening-backlog`      | 4  | orchestrator split (×2) + rungs 4–7 + INTEGRATION_NOTES |
| `phase7/integration` (target)   | 16 | everything from the four coders **except worktree default**, plus DoD smoke suite |

Key CLAUDE.md rules exercised: file < 500 LOC; no `any`; no silent catches;
parameterized SQL; input validation at system boundaries.

---

## 1. Verdict

**ship-with-fixes.**

Phase 7 is effectively done. Tester 1's late integration sweep picked up
everything that the earlier Tester 2 pass flagged as outstanding:

- C1 consolidation trio (dedup + canon + worker) — on integration.
- C2 analytics modules + `/ui/anti-patterns` + `/ui/success-rate` + 60s
  cache — all on integration as of `13b40f6`.
- C3 stress + seed + BudgetTracker + `/ui/budgets` + totals — on
  integration, zod-validated.
- C4 orchestrator split (810 → 484 LOC, under the 500 budget) + rungs 4–7
  of the Resourcefulness ladder — on integration as of `f9d40db`
  (with `1145d95` loosening a flaky ladder-walk counter).
- A DoD smoke suite (`b079d8f`) codifies §6 bullets 1–7 as runnable
  assertions.

What's left before `phase7/integration` → `main`:

1. **Worktree default ON + `CORTEXOS_WORKTREE=off` env bypass.** Last
   un-landed C4 bullet. `grep CORTEXOS_WORKTREE src/` still returns 0.
2. Two small security/TS-rigor fixes: flip dedup `keepStrategy` default
   to `"highest_similarity"`; cap per-event token deltas in
   `BudgetTracker.record`; replace `as unknown as LoopLogInternal` shims
   with narrow query methods on the log classes.

None of those are gate-stoppers in the engineering sense, but they
should land before the merge because (a) the CLAUDE.md security rules
were explicit about input validation at boundaries, and (b) the worktree
default is a named C4 DoD bullet — shipping Phase 7 while skipping it
would be de-facto spec drift.

---

## 2. Scorecard (1–5 per branch)

Rubric: 1 = blocker, 3 = shippable with follow-up, 5 = exemplary.

| Branch | Correctness | Security | TS rigor | Tests | Design | Spec |
|---|---|---|---|---|---|---|
| `phase7/consolidation` (C1)          | 4 | 3 | 4 | 5 | 4 | 5 |
| `phase7/antipatterns-dashboard` (C2) | 4 | 4 | 4 | 4 | 4 | 5 |
| `phase7/bench-observability` (C3)    | 4 | 4 | 5 | 4 | 5 | 4 |
| `phase7/hardening-backlog` (C4)      | 4 | 4 | 4 | 4 | 4 | 3 |
| `phase7/integration` (overall)       | 4 | 3 | 4 | 4 | 4 | 4 |

Notes:
- **C1 Security = 3** because the `keepStrategy: "newest"` default is a
  known poisoning surface and the worker doesn't override it. Fix in P-3.
- **C2 Spec = 5** — both analytics modules AND their HTTP routes + cache
  shipped. Cleanest coder spec delivery of the four.
- **C3 Design = 5** — `zod` at HTTP boundary, pure-handler shape, real-
  HTTP tests via `fetch` on port-0 server.
- **C4 Spec = 3** — 2 of 3 bullets shipped (orchestrator split + rungs
  4–7); worktree default is the open item. See P-1.
- **Integration Spec = 4** — 4.5 of 5 DoD bullets are on the branch;
  only the worktree-default piece of C4 is missing.

---

## 3. Spec-drift check (per branch, against §6 Phase 7 DoD)

### 3.1 Consolidation (C1) — bullets 1–2

All three modules (dedup, canon, worker) + paginated
`VectorStore.listMemories` + tests + `DECISIONS.md` are on integration.
**Verdict: zero drift.**

### 3.2 Anti-patterns + success-rate dashboard (C2) — bullets 2–3

Anti-pattern clustering, success-rate, AND `/ui/anti-patterns` +
`/ui/success-rate` routes + 60s cache + 9 route tests — all on
integration after Tester 1's cherry-pick of `13b40f6`. **Verdict: zero
drift.**

### 3.3 Stress + observability (C3) — bullets 4–5

Stress harness + 100-task seed (40/40/20 + 5 escalation-acceptable) +
BudgetTracker + `/ui/budgets` + `/ui/budgets/totals?days=<n>` —
zod-validated, shipped with 4 test suites. **Verdict: zero drift.**

### 3.4 Hardening (C4) — orchestrator split + rungs 4–7 + worktree default

| DoD bullet | Status |
|---|---|
| Orchestrator split < 500 LOC | **shipped** — 810 → 484 LOC after two passes (`12c22da` + `5273533`) |
| Rungs 4–7 | **shipped** on integration (`f9d40db`) + `1145d95` test fix |
| Worktree default on + `CORTEXOS_WORKTREE=off` | **not shipped** on any branch |

**Verdict:** 2/3 bullets clean; worktree default is the one real gap.

---

## 4. Per-branch findings

### 4.1 Consolidation (C1)

**`dedup.ts` (237 LOC)** — union-find with path compression, strict
default threshold (0.92), `dryRun: true` library default,
`HARD_SCAN_CAP = 10_000_000` guard, idempotent (DoD test
`"100 duplicate memories collapse to 1"` passes). **Concern:
`keepStrategy: "newest"` default enables dedup poisoning** — P-3.

**`canon.ts` (249 LOC)** — stricter threshold (0.95),
skip-on-existing-canon idempotency, INSERT (never mutate) preserves
provenance, deterministic `pickExemplar`. UnionFind duplicated from
`dedup.ts` — extract when a 3rd caller lands.

**`worker.ts` (174 LOC)** — dedup → canon order is correct. Emits bus
events for observability. Audit JSON persisted under
`~/.cortexos/consolidation/runs/`. `buildConsolidationRunHandler` is a
thin scheduler adapter documented in `DECISIONS.md`. Worker flips
`dryRun: false` at the entrypoint.

### 4.2 Anti-patterns + success-rate (C2)

Two analytics modules + `/ui/*` routes shipped. Typed
`AntiPatternPersistError` — no silent catches. Signature stability
verified. Success-rate derives terminal outcome from the last
`loop_attempts` row per `task_id`; clock injection (`opts.now`) makes
windowing deterministic. `round(n)` prevents `-0` in JSON. Pre-seeded
zero-trend-points keep the chart x-axis contiguous.

Three call sites still use `as unknown as LoopLogInternal` /
`SkillLedgerInternal` to reach `.db`. See P-4.

Cache (60s, keyed by `pathname + days`) is correct-enough for low load
but not stampede-safe — see follow-up item 8.

### 4.3 Stress + budget observability (C3)

All three deliverables + HTTP surface on integration. `budget-api.ts`
exemplary: `zod` at the boundary, pure `{ status, body }` handlers,
real-HTTP tests via `fetch` on port-0 server. Cost math cross-checked
against CLAUDE.md (Haiku 0.80/4, Sonnet 3/15, Opus 15/75 per 1M).

**Concern:** `BudgetTracker.record` has no upper bound on tokens —
P-2.

### 4.4 Hardening (C4)

**Orchestrator split (integrated).** Two passes landed. Result:

```
src/orchestrator/
  orchestrator.ts        484  ✓ under the 500 budget
  designer-recall.ts      80
  plan-role-resolver.ts   34
  pane-helpers.ts        104
  plan-schema.ts         160
  researcher-executor.ts 130
  task-planner.ts        157
```

**Rungs 4–7 (integrated).** `f9d40db` adds four strategies to
`src/loop/fallback-strategies.ts`:
- `AskPeerStrategy` (rung 4) — `nchinda_ask_peer`, attaches reply
- `RecallMemoryStrategy` (rung 5) — `nchinda_recall` against failure
  signature, attaches top successful memory as hint
- `WebSearchStrategy` (rung 6) — `webSearch`, inlines top snippet
- `EscalateStrategy` (rung 7) — terminal via `nchinda_escalate`

`1145d95` loosens a ladder-walk counter to `>= 1` — reasonable given
scheduling non-determinism; flag it as a tiny test-brittleness signal
for future work.

**Worktree default — not shipped.** Nothing anywhere. P-1.

### 4.5 DoD smoke suite (`b079d8f`, Tester 1)

Encodes §6 bullets 1–7 as runnable assertions with injected fakes.
Strong guardrail.

---

## 5. Security pass (cross-branch)

- `grep -rn ":\s*any\b|as\s+any" src/{analytics,bench,observability,consolidation,loop}` → **0**.
- `grep -rn "catch\s*\(.*\)\s*\{\s*\}|catch\s*\{\s*\}" src/` → **0**.
- All SQL parameterized. `budget-api.ts` validates via zod.
- `WorktreeManager` validates `agentId` against
  `/^[A-Za-z0-9_-]{1,64}$/` before `execFile`.
- No hardcoded secrets in Phase 7 code.
- `as unknown as X`: 3 occurrences in analytics reaching `.db` — see P-4.

**Attack surface 1 — dedup poisoning via `keepStrategy: "newest"`.**
Worker does not override the default. 1-LOC fix. See P-3.

**Attack surface 2 — `BudgetTracker.record` no upper token cap.** Buggy
or malicious caller can inflate peer costs. See P-2.

**Observation — analytics 60s cache** is a time-keyed `Map`, not
single-flight. Cold-key stampede will fan out concurrent aggregations.
Low severity today; promise-memo fix in follow-up item 8.

---

## 6. Test quality — theater check

All Phase 7 suites exercise real behavior:

| Suite | Cases | Key guarantees |
|---|---:|---|
| `consolidation-dedup.test.ts` | 10 | DoD 100→1, idempotence, each `keepStrategy`, threshold validation |
| `consolidation-canon.test.ts` | 10 | DoD 5→canon, skip-existing, idempotence, window filter |
| `consolidation-worker.test.ts` | ~6 | event emission, audit JSON, ordering |
| `success-rate.test.ts` | ~12 | outcome collapsing, per-role, trend contiguity, clock injection |
| `anti-patterns.test.ts` | 12 | signature stability, source merging, knownSignatures dedup, no-sink fallback |
| `analytics-routes.test.ts` (via `13b40f6`) | 9 | HTTP via `fetch`, cache, bad-query 400 |
| `fallback-strategies.test.ts` (via `f9d40db` + `1145d95`) | rungs 4–7 | ladder walk, escalation terminality |
| `budget-tracker.test.ts` | 8 | round-trip, per-model cost, windowing, ordering, validation |
| `budget-api.test.ts` | 6 | real HTTP via `fetch`, empty/populated trackers, bad-query 400 |
| `stress-harness.test.ts` | ~10 | outcomes, timeouts, never-throws, p95, byComplexity |
| `seed-tasks.test.ts` | 5 | 100 total, 40/40/20, unique ids, ≥3 escalation-acceptable |
| `phase7-dod.test.ts` (smoke) | ~7 | §6 bullets 1–7 end-to-end with injected fakes |

Gaps:
- No unit test for the worktree-default env bypass (not shipped).
- No concurrency-bound assertion in `stress-harness.test.ts`.
- No cold-key stampede test for the analytics cache.
- Ladder-walk test relaxed to `>= 1` by `1145d95` — flag as a
  brittleness signal.

No test-theater spotted.

---

## 7. Top 5 patches before merging `phase7/integration` → `main`

### P-1. Worktree default ON + `CORTEXOS_WORKTREE=off` env bypass
**Where:** `src/controller/cortex.ts` (CortexController constructor).
**Why:** last un-shipped C4 bullet. Without it, every new orchestrator
run is still gated on an explicit `worktreeManager` dep, which means
Phase 3's worktree isolation is effectively off unless the caller
opts in.
**Fix:**
```ts
const worktreeManager =
  process.env.CORTEXOS_WORKTREE === "off"
    ? undefined
    : (opts.worktreeManager ?? new WorktreeManager());
```
Document in `CLAUDE.md` under the File Organization / Worktree section.
Add 1 integration test (`worktree allocated by default`) + 1
regression test (`CORTEXOS_WORKTREE=off skips allocation`).

### P-2. Cap per-event token deltas in `BudgetTracker.record`
**Where:** `src/observability/budget-tracker.ts` (`record()` body).
**What:**
```ts
const PER_EVENT_TOKEN_CAP = 1_000_000; // Anthropic per-call max
const d_in  = Math.min(PER_EVENT_TOKEN_CAP, Math.max(0, Math.floor(event.tokens_in  ?? 0)));
const d_out = Math.min(PER_EVENT_TOKEN_CAP, Math.max(0, Math.floor(event.tokens_out ?? 0)));
```
**Why:** §5 attack-surface 2. Cheap belt-and-suspenders before cost-
driven throttling is exposed.
**Fix:** 2 LOC + 1 test case
(`"clamps runaway tokens_in to PER_EVENT_TOKEN_CAP"`).

### P-3. Flip dedup default `keepStrategy` to `"highest_similarity"`
**Where:** `src/consolidation/dedup.ts:65` (the `DEFAULTS` object).
**Why:** §5 attack-surface 1. `highest_similarity` already privileges
canon-tagged rows (verified by existing test); making it the default
closes the poisoning surface for every caller that forgets to
override, including the nightly worker.
**Fix:** change `keepStrategy: "newest" as const` →
`keepStrategy: "highest_similarity" as const`. Update the existing
tests that rely on the "newest" default (they pass explicit
`keepStrategy: "newest"` already).

### P-4. Replace `as unknown as LoopLogInternal` / `SkillLedgerInternal` with narrow query methods
**Where:** `src/analytics/anti-patterns.ts:249,271`,
`src/analytics/success-rate.ts:276`.
**Why:** three files reach into private `.db` fields. A rename or
refactor of either log's internal handle silently breaks runtime —
TS can't see it.
**Fix:**
1. On `LoopAttemptLog`, add
   `failuresSince(cutoffISO: string): LoopAttemptRow[]` +
   `rowsSince(cutoffISO: string): LoopAttemptRow[]`.
2. On `SkillUsageLedger`, add
   `failuresSince(cutoffISO: string): SkillRunRow[]`.
3. Narrow the `Deps` interfaces in the three analytics modules.
4. Delete the `LoopLogInternal` / `SkillLedgerInternal` shim types and
   the `as unknown as` casts.

### P-5. Re-tighten the `fallback-strategies` test loosened by `1145d95`
**Where:** `tests/fallback-strategies.test.ts` ladder-walk counter
assertion.
**Why:** `1145d95` relaxed the assertion to `>= 1`. That hides an
ordering bug if one exists. Pin exact expected rung counts using an
injected deterministic scheduler / time source, not wall-clock.
**Fix:** inject a `Clock` into the AutonomyLoop for strategy
invocation timing (it's already `opts.now`-capable elsewhere); assert
exact counters per rung.

---

## 8. Follow-ups beyond Phase 7

1. **Dedup / canon shared UnionFind.** 2 copies in `dedup.ts` +
   `canon.ts`. Extract to `src/consolidation/union-find.ts` when a
   third caller appears.
2. **Anti-pattern clock injection.** Apply `opts.now` pattern from
   `success-rate.ts` so windowDays filter is fully deterministic.
3. **Stress-harness concurrency-bound test.** Instrument `runTaskFn`
   with an in-flight counter; assert max never exceeds `concurrency`.
4. **BudgetTracker rolling per-agent cap.** Per-event cap (P-2) stops
   single-call abuse; a rolling $/hour cap stops slow-drain. Phase 8.
5. **Dedup search-cost documentation.** `DECISIONS.md` doesn't call
   out the O(N·K) HNSW cost; add a note and benchmarks at
   `N ∈ {1k, 10k, 100k}` before the worker runs on a real corpus.
6. **`AgentRegistry.list()` `started_at DESC` invariant.**
   `success-rate.ts` depends on it; add an explicit assertion or
   switch to `reduce`.
7. **Analytics cache single-flight.** `13b40f6` uses a simple
   time-keyed `Map`; promise-memo instead so cold-key stampede
   doesn't fan out N concurrent aggregations.
8. **Phase 7 retro.** `INTEGRATION_NOTES.md` documents the
   branch-switch chaos when four coders + two testers shared a single
   git worktree. Phase 8 should default to per-agent worktrees —
   exactly the primitive C4's P-1 lands.
9. **Phase 7.1 — any truly deferred items should land here.** Today
   that's just P-1 (worktree default) and some of the security
   hardening; neither is large. A mini sprint, not a new phase.
10. **Public-facing changelog / release notes.** Phase 7 is the first
    phase where "Learning + Hardening" is a legitimate claim — name
    the dedup + canon + anti-pattern + success-rate + BudgetTracker
    + ladder bundle as the user-visible milestone it is.
