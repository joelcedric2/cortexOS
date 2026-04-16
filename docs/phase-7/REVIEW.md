# Phase 7 — Independent Review (Tester 2, read-only)

Reviewer: Tester 2 (Phase 7). Read-only sweep across four coder branches plus
the in-flight integration branch. See `docs/NCHINDA_PLAN.md` §6 Phase 7 DoD
(bullets 1–5), §5.5 (evolution loop that consumes the anti-pattern clusters),
and §2.1 (Resourcefulness ladder — relevant to C4).

Repo state at review time (HEAD = `phase7/consolidation`, but Tester 1 is
actively moving HEAD around as they merge):
- `phase7/consolidation`          4 commits beyond `main` (review doc + C3 merges)
- `phase7/antipatterns-dashboard` 1 commit  beyond `main` (anti-patterns only)
- `phase7/bench-observability`    4 commits beyond `main` (bench + budget + C2)
- `phase7/hardening-backlog`      **0 commits beyond `main` — empty**
- `phase7/integration`            4 commits (bench + C2), **no BudgetTracker yet**

Key CLAUDE.md rules exercised: file < 500 LOC; no `any`; no silent catches;
parameterized SQL; input validation at system boundaries.

---

## 1. Verdict

**block** — do not merge `phase7/integration` to `main`.

Two hard reasons up front, fleshed out in §4:

1. **C4 (`phase7/hardening-backlog`) is empty.** Zero commits beyond `main`.
   No orchestrator split, no rungs 4–7 in `src/loop/fallback-strategies.ts`,
   no worktree env bypass. Three of the four C4 DoD bullets silently did
   not ship. Spec drift is total.
2. **C1 (`phase7/consolidation`) never shipped the consolidation code.**
   The branch does not commit `src/consolidation/dedup.ts`, `canon.ts`, or
   `worker.ts`. I observed an uncommitted `src/consolidation/dedup.ts`
   transiently on disk during Tester 1's branch-juggling, but nothing is
   on any ref. Phase 7 §6 bullets 1–2 (nightly dedup + canon promotion)
   never landed in git.

What DID ship and looks strong (§4.2–§4.3): C2 anti-pattern clustering,
C3 stress harness + 100-task seed battery + BudgetTracker. But without
C1's dedup worker and without C4's rung 4–7 + orchestrator split, the
"Learning + Hardening" phase is neither learning (no canon promotion
loop, no nightly worker) nor hardened (ladder tops out at rung 3,
single 810-LOC orchestrator).

`phase7/integration` at review time is also missing the BudgetTracker
cherry-pick that exists on `phase7/bench-observability` — so even what
DID ship isn't yet fully present on the target branch.

A subset **can** still be shipped as a partial Phase-7a release: C2 + C3
are healthy. But Phase 7 in full is not green.

---

## 2. Scorecard (1–5 per branch)

Rubric: 1 = blocker, 3 = shippable with follow-up, 5 = exemplary.
"–" = nothing to score (branch is empty or deliverable absent).

| Branch | Correctness | Security | TS rigor | Tests | Design | Spec |
|---|---|---|---|---|---|---|
| `phase7/consolidation` (C1 — dedup+canon+worker) | – | – | – | – | – | **1** |
| `phase7/antipatterns-dashboard` (C2)             | 4 | 3 | 4 | 4 | 4 | **2** |
| `phase7/bench-observability` (C3)                | 4 | 4 | 5 | 4 | 5 | 4 |
| `phase7/hardening-backlog` (C4)                  | – | – | – | – | – | **1** |
| `phase7/integration` (overall)                   | 3 | 3 | 4 | 3 | 3 | **2** |

Notes:
- **C1 Correctness/Tests scored "–"**: the branch shipped nothing. See §4.1.
  (Transient working-tree artifacts — `src/consolidation/dedup.ts` + a
  `tests/consolidation-dedup.test.ts` — were observed during the sweep;
  none are committed on any ref. They don't count.)
- **C2 Spec = 2** because only 1 of the 2 bullets owned by this coder
  landed: anti-pattern clustering is there, but the "success-rate
  dashboard per role" (§6 bullet 3) is absent — no
  `src/analytics/success-rate.ts`, no `/ui/success-rate` route, no UI API
  changes at all. The merge commit on `phase7/bench-observability`
  (`"failure clustering + success-rate (C2)"`) is inaccurate — only the
  clustering half shipped.
- **C3 Spec = 4** because the stress harness + 100-task seed + BudgetTracker
  all shipped and tested cleanly. Docked one point because the UI routes
  (`/ui/budgets`, `/ui/stress-reports`) are missing — budgets are in
  SQLite but no HTTP surface exposes them yet.
- **C4 = all "–" / Spec = 1** because the branch is empty (0 commits
  beyond `main`). Everything downstream in §3.4 and §4.4 is inferred
  from the non-existence of commits + the state of the files on `main`.
- **Integration Spec = 2** because C1 and C4 are missing entirely and
  the BudgetTracker cherry-pick from C3 hasn't been pulled onto
  `phase7/integration` (it's still only on `phase7/bench-observability`).

---

## 3. Spec-drift check (per branch, against §6 Phase 7 DoD)

### 3.1 Consolidation (C1) — bullets 1–2
| DoD bullet | Expected | Reality on `phase7/consolidation` |
|---|---|---|
| Nightly consolidation worker | `src/consolidation/worker.ts` scheduled | **missing** — no file, no cron wire-up |
| Dedup memories | `src/consolidation/dedup.ts` + tests | **not committed** — transient working-tree copy only |
| Promote frequent successes to `canon` namespace | `src/consolidation/canon.ts` | **missing** entirely |
| `VectorStore.listMemories` paginator | new method on `src/memory/vector-store.ts` | **not committed on `phase7/consolidation`** (only lived in stashes) |
| Tests | `tests/consolidation-dedup.test.ts`, `canon.test.ts`, `worker.test.ts` | dedup test existed transiently as untracked; canon + worker tests never authored |

Verdict: **total drift** — the branch is effectively untouched beyond merges
of C3's work. Phase 7 §6 bullets 1–2 did not land.

### 3.2 Anti-patterns + success-rate dashboard (C2) — bullets 2–3
| DoD bullet | Expected | Reality on `phase7/antipatterns-dashboard` |
|---|---|---|
| Anti-pattern clustering with `avoid` tag | `src/analytics/anti-patterns.ts` | **shipped** (commit `5564ee7`) |
| Success-rate dashboard per role | `src/analytics/success-rate.ts` + UI | **missing** — no file, no UI route, no test |
| UI API wire-up | `/ui/anti-patterns`, `/ui/success-rate` | **missing** — `src/ui/ui-api.ts` untouched |
| Tests | `tests/anti-patterns.test.ts` | **shipped** (12 well-scoped tests) |

Verdict: **half-drift** — clustering landed cleanly; success-rate and UI
surface never did. The merge commit that pulled C2 into
`phase7/bench-observability` claims both half-bullets in its title, which
is misleading and should be corrected in the final merge message.

### 3.3 Stress + observability (C3) — bullets 4–5
| DoD bullet | Expected | Reality on `phase7/bench-observability` |
|---|---|---|
| 100-task stress battery | `src/bench/seed-tasks.ts` with 40/40/20 + ≥3 escalation-acceptable | **shipped** (commit `6a37b53`), exact split enforced |
| Stress harness | `src/bench/stress-harness.ts` — bounded worker pool, timeouts, autonomy % | **shipped** — `runStressBattery`, never-throws contract |
| Budget + observability | `src/observability/budget-tracker.ts` | **shipped** (commit `27f22fc`) |
| UI API routes | `/ui/budgets`, `/ui/stress-reports` | **missing** — no HTTP handler ties BudgetTracker to `src/ui/ui-api.ts` |
| Tests | `tests/stress-harness.test.ts`, `tests/seed-tasks.test.ts`, `tests/budget-tracker.test.ts` | **shipped** — 3 suites, ~30 cases total |

Verdict: **minor drift** — all core code landed with solid tests. Missing
piece is the HTTP surface (would need ~40 LOC of handler wiring).

### 3.4 Hardening (C4) — orchestrator split + rungs 4–7 + worktree default
| DoD bullet | Expected | Reality on `phase7/hardening-backlog` |
|---|---|---|
| Orchestrator split (< 500 LOC) | `orchestrator.ts` under the 500-LOC budget | **not done** — `src/orchestrator/orchestrator.ts` is still **810 LOC** |
| Rungs 4–7 in Resourcefulness ladder | `AskPeerStrategy`, `RecallStrategy`, `WebSearchStrategy`, `EscalateStrategy` in `src/loop/fallback-strategies.ts` | **not done** — file explicitly comments `"Rungs 4–7 ship in Phase 3"`; still only rungs 1–3 |
| Worktree default (with `CORTEXOS_WORKTREE` env bypass) | Worktree-per-agent on by default, env var to disable | **not done** — `CortexController` still gates on `worktreeManager` being explicitly passed; no env bypass anywhere in the codebase |
| Tests | coverage for the above | **none** |

Verdict: **total drift** — the branch is empty. The orchestrator is still
810 LOC (violating CLAUDE.md's 500-line rule), rungs 4–7 are still deferred
to Phase 3 (per the comment that was never updated), and the worktree flip
was not performed.

---

## 4. Per-branch findings

### 4.1 Consolidation (C1) — `phase7/consolidation`

**Status:** no consolidation work committed. Branch only contains merges of
C3 + a skeleton of this very review doc.

**Evidence:**
- `git log main..phase7/consolidation --oneline` returns exactly:
  `5bc4b87` (review skeleton), `51b29b0` (merge bench-observability),
  `5564ee7` (anti-patterns), `6a37b53` (bench). None is a consolidation
  commit.
- `git ls-tree -r phase7/consolidation -- src/consolidation` returns empty.
- The work I reviewed in working-tree (`src/consolidation/dedup.ts`,
  `tests/consolidation-dedup.test.ts`) was untracked and disappeared across
  branch switches — it was never `git add`-ed on any branch.

**Assessment of the transient dedup.ts I did see** (for completeness, since
Tester 1 may resurrect it):

Positive:
- Union-find with path compression + union-by-rank — O(α(N)) per merge.
- Threshold validation: rejects `similarityThreshold ≤ 0` or `> 1` up front.
- `dryRun: true` by default — safest possible default.
- `keepStrategy` supports `oldest | newest | highest_similarity`;
  `highest_similarity` intentionally prefers `canon`-tagged rows (good call).
- Idempotent-by-construction: after one pass, every cluster has size 1 and
  the next pass returns `duplicatesRemoved: 0` (the test
  `"idempotent: second run after actual dedup is a no-op"` verifies this).
- No `any`, no silent catches, no SQL concat.

Concerns (must be addressed if/when C1 re-commits):
- **Search cost O(N·K)**: the anchor loop calls `searchMemories` once per
  memory. For `N=100k` that's 100k HNSW searches. Document the upper bound
  or add a pre-filter (cluster candidates by coarse tag first).
- **`keepStrategy: "newest"` as default is a security concern.** A malicious
  memory writer who knows the worker runs nightly can poison: inject a
  near-duplicate with fresher `createdAt` just before consolidation fires,
  and the older (trusted, canonicalized) row gets culled. The caller is
  responsible for choosing strategy, but the library's DEFAULT should be
  `highest_similarity` (which respects `canon` tags) — especially because
  the test suite's own demonstration of the safe path uses that strategy.
- **`bytesFreed` is content-only** — ignores embeddings (384 × 4 bytes ≈
  1.5KB per vector, dominating content size in practice). Rename to
  `contentBytesFreed` or fold in the embedding footprint.

### 4.2 Anti-patterns + success rate (C2) — `phase7/antipatterns-dashboard`

**Status:** clustering shipped; success-rate + UI routes did not.

**Anti-patterns — `src/analytics/anti-patterns.ts` (346 LOC, commit
`5564ee7`)**

Positive:
- **Signature stability is verified.** The canonical form is
  `<source>:<errorClass>:<discriminator>` — identical inputs deterministically
  produce the same cluster id (sha256 first-16-hex of the signature). The
  test `"clusters 3 network timeouts into a single auto-flagged cluster"`
  asserts both the signature string and the tag that flows to pgvector.
  A second failure at the same site, same strategy, same error class will
  land in the same cluster. Good.
- Regex-based error-class extractor is intentionally coarse — unknowns fall
  to `UNKNOWN` rather than getting lost. Case-insensitive, normalized to
  upper. Explicit `error_class` on `skill_runs` preempts the regex (right
  priority).
- `knownSignatures: Set<string>` prevents double-writes on repeat runs
  (verified by test).
- **Typed `AntiPatternPersistError`** — no silent catches. The dashboard
  route will be able to map this to a 500, which the author explicitly
  calls out in the comment block.
- `maxSamplesPerCluster` caps memory.
- Works without a vector store (regression-guarded by the test
  `"runs without a vector store and still returns the report"`).

Concerns:
- **`as unknown as LoopLogInternal` / `as unknown as SkillLedgerInternal`**
  (lines 249, 271): `anti-patterns.ts` reaches into the private `.db`
  handles of `LoopAttemptLog` and `SkillUsageLedger`. This is a TS rigor
  smell — the right move is to expose a narrow read-only query method on
  both classes (`loopFailuresSince(cutoffISO): LoopAttemptRow[]`) and
  inject it via `DetectAntiPatternsDeps`. Current code is brittle to the
  internal layout of those modules.
- **No caching and no `/ui/anti-patterns` route** — the file is designed
  to be called from a dashboard route, but no route exists yet. Cache
  semantics question ("stampede-safe?") does not apply yet; when the route
  lands it should use a single-flight cache keyed on `(windowDays, cutoff)`
  with a TTL of ~5 min.
- `readLoopFailures` builds a SQL string using template literals — but
  the ONLY interpolation is via `?` placeholder with `stmt.all(cutoffISO)`,
  so no injection. Still, worth a reviewer-note so future edits stay in
  that pattern.
- `windowCutoff(days)` uses `Date.now()` directly — not injectable. Tests
  currently paper over this with real elapsed time, which makes the
  `"windowDays filters out ancient failures"` test susceptible to flake
  in extremely slow CI. Low-severity; follow-up.

**Success-rate dashboard: absent.** This is a Phase 7 §6 bullet 3 miss.
Should be a ~150 LOC companion file (`src/analytics/success-rate.ts`)
grouping rows from the same two tables by `agent_role`, returning
`{ role, total, succeeded, successRate }`. Follow-up P-1.

### 4.3 Stress + budget observability (C3) — `phase7/bench-observability`

**Status:** three solid deliverables, one missing HTTP surface.

**Stress harness — `src/bench/stress-harness.ts` (309 LOC, commit `6a37b53`)**

Positive:
- **Bounded worker pool** is correctly implemented via a shared cursor and
  N worker loops that drain `tasks[]` FIFO. At most N tasks in flight, as
  specified. The test
  `"enforces concurrency and runs exactly N in parallel"` is conspicuously
  absent from the suite, but the design reviewed by eye is sound:
  `cursor++` race is safe because JS is single-threaded at the microtask
  boundary.
- **Timeout correctness**: `runWithTimeout` uses `Promise.race` against a
  `.unref()`-ed `setTimeout` so short-lived test invocations don't pin the
  event loop. Does NOT `await` the dangling runner promise — the comment
  explicitly calls this out and the invariant
  "`runStressBattery` always completes" holds.
- **Never-throws contract**: runner exceptions are caught and coerced to
  `outcome: 'failed'`; `onProgress` callback exceptions are swallowed
  (this IS a silent catch, but correctly scoped to a callback whose failure
  must not poison the run — acceptable and documented by the inline
  `"progress callbacks must not break the run"` comment).
- **Autonomy semantics are right**: `escalated` only counts as autonomy when
  `expectedOutcome === 'escalation-acceptable'`; otherwise it's a failure.
  Verified by `"computes autonomy, outcomes, tokens, and byComplexity
  correctly"` — very thorough integration-style test with a hand-rolled
  outcome map.
- Nearest-rank p95 (not linear interp). Defensive result normalization
  (clamps attempts ≥ 1, durations ≥ 0).

**Seed battery — `src/bench/seed-tasks.ts` (212 LOC)**

- 40/40/20 distribution is **exactly correct** (asserted by test).
- 5 escalation-acceptable tasks across all three complexity buckets
  (1 simple / 2 moderate / 2 complex) — meets the "≥3" spec with margin.
- Replacements preserve bucket sizes (the file drops the last 1/2/2 of
  each bucket and inserts the matching-complexity escalations —
  mechanically clean).
- Every task has `id`, `task` (non-trivial string, > 10 chars), complexity,
  expected outcome, expectedMaxAttempts. Id uniqueness enforced by test.

**BudgetTracker — `src/observability/budget-tracker.ts` (291 LOC, commit
`27f22fc`, on `phase7/bench-observability` only — NOT on
`phase7/integration`)**

Positive:
- Cost math matches CLAUDE.md 3-tier table: `haiku { in: 0.8, out: 4 }`,
  `sonnet { in: 3, out: 15 }`, `opus { in: 15, out: 75 }` per 1M tokens.
  Cross-checked: 1000 input + 500 output Haiku → 0.0008 + 0.002 =
  `0.0028` — test `"record + snapshot round-trips a single event"` asserts
  exactly this number.
- **All SQL parameterized** — named-parameter style throughout. No string
  concat, no injection surface.
- WAL journaling on the owned DB; `mkdir -p` on parent dir before opening.
- Safe defaults: `Math.max(0, Math.floor(...))` on every delta.
- Input validation: throws on empty `agentId` or empty `role`.
- Clean seam: `BudgetDB` interface lets tests pass an in-memory
  `better-sqlite3` handle.
- `totalsInWindow(days)` rolling view + `listActive()` ordered by
  `updated_at DESC` — both needed for the dashboard that hasn't landed.

Concerns (cost computation manipulation):
- **Caller-supplied `tokens_in` is trusted verbatim.** A buggy or
  malicious caller can inflate a peer's budget beyond any downstream
  throttle. We clamp to `Math.max(0, ...)` (no underflow) but there is
  no upper cap. The BudgetTracker is a **write-side trust boundary**;
  either (a) document that only trusted producers (the orchestrator
  itself) call `record`, or (b) cap `tokens_in`/`tokens_out` at a
  reasonable per-event ceiling (e.g. 1M, which is the Anthropic per-call
  max anyway). See P-5.
- No test for cost math on very-large token values (>1B). The `round6`
  rounding is fine for typical ranges but should be stress-tested on
  edge cases where cost exceeds what a float can represent precisely.
- `snapshot` returns a fresh object each call (no caching) — fine.

**UI integration gap:** `src/ui/ui-api.ts` has no `/ui/budgets` handler.
Adding one is ~40 LOC (instantiate tracker lazily, map `listActive()`
and `totalsInWindow(7)` to JSON). Follow-up.

### 4.4 Hardening (C4) — `phase7/hardening-backlog`

**Status: empty branch.** `git log main..phase7/hardening-backlog --oneline`
returns zero lines. I inspected `main` directly to confirm the three
hardening bullets' state.

1. **Orchestrator LOC.** `src/orchestrator/orchestrator.ts` is **810
   lines**, well over the 500-LOC CLAUDE.md ceiling. The functions that
   should have been extracted (`buildPriorResearchSection` at line 374,
   `runResearcherDetour` at line 528, `isResearcherRole` at line 807) are
   still inline.
   - I did briefly see `src/orchestrator/designer-recall.ts` and
     `src/orchestrator/researcher-executor.ts` as untracked files in
     Tester 1's working tree. Those files are structurally correct
     (they lift the three functions verbatim), but they are (a) not
     committed on any branch, and (b) not `import`-ed from
     `orchestrator.ts`. If Tester 1 commits the extracted files without
     deleting the old inline bodies, the result will be duplication, not
     a split. See P-4.

2. **Rungs 4–7.** `src/loop/fallback-strategies.ts` still exports only
   `RetrySameStrategy`, `AlternateToolStrategy`, `ReduceScopeStrategy`.
   The file-level comment — unchanged since Phase 2 — explicitly says:
   `"Rungs 4–7 ship in Phase 3 when the nchinda_* MCP tool suite lands."`
   Phase 3 shipped the MCP tools (`nchinda_ask_peer`, `nchinda_recall`,
   `nchinda_escalate` all exist in `src/mcp/`), but no one ever wired
   them into the ladder. Phase 7's C4 was supposed to be exactly this
   wire-up; it did not happen.

3. **Worktree default.** `CortexController` in `src/controller/cortex.ts`
   still threads `worktreeManager` as an explicit, optional dep; there
   is no env-var bypass (`CORTEXOS_WORKTREE` / `CORTEXOS_NO_WORKTREE`)
   anywhere in the source. `git grep` for `CORTEXOS_WORKTREE` returns
   zero matches.

**Net:** all three C4 bullets are open work.

---

## 5. Security pass (cross-branch)

Sweep focus: `any`, silent catches, SQL concat, shell injection, hardcoded
secrets, and the two specific attack surfaces called out in the review
brief (dedup poisoning + budget manipulation).

- `grep -rn ":\s*any\b|as\s+any" src/{analytics,bench,observability}` →
  **0 matches**. No explicit `any` types in shipped Phase 7 code.
- `grep -rn "catch\s*\(.*\)\s*\{\s*\}|catch\s*\{\s*\}" src/` →
  **0 matches**. No empty catches. The only catch without a logger is in
  `runStressBattery` around the `onProgress` callback; that swallow is
  intentional and documented inline — acceptable.
- SQL concat / shell injection:
  - `budget-tracker.ts` — all prepared statements, named params. Clean.
  - `anti-patterns.ts` — prepared statements, positional params; the one
    template literal in `readLoopFailures`/`readSkillFailures` is a
    STATIC query string (no interpolation of user data). Clean.
  - `seed-tasks.ts` and `stress-harness.ts` — no DB / no shell.
  - `WorktreeManager` on `main` validates `agentId` against a strict regex
    (`/^[A-Za-z0-9_-]{1,64}$/`) before `execFile` and never shells out via
    a string. Clean.
- Hardcoded secrets / API keys: `grep -rn "sk-|api[_-]key" src/` against
  Phase 7 code → **0 matches**.
- `as unknown as X` escape hatches: 2 occurrences in `anti-patterns.ts`
  reaching into private `.db` fields of `LoopAttemptLog` +
  `SkillUsageLedger`. Not a security issue per se, but a fragility risk —
  covered in §4.2 and P-3 below.

**Attack surface 1 — dedup `keepStrategy: "newest"` poisoning.**

Scenario: an attacker (or a skill with a bug) writes a near-duplicate of
a trusted memory with a fresher `createdAt`. On the next nightly
consolidation, `pickKeeper(members, "newest")` culls the original and
keeps the attacker's row. Net effect: long-lived trusted canon can be
overwritten from any code path that can call `storeMemory`.

This is best handled by **the caller**, not `dedupMemories`: trusted
writers should tag with `canon` (which `keepStrategy: "highest_similarity"`
already privileges — see the test
`"keepStrategy='highest_similarity' prefers canon-tagged members"`), and
the worker should default to `highest_similarity`. Belt-and-suspenders:
the canon-promotion worker (C1 bullet 2, not yet shipped) must tag
canonical rows with `canon` + preserve the original `createdAt` so
"newest" never wins against canon. Document this in the SECURITY section
of whatever consolidation README eventually lands.

Risk if shipped as-is: **medium**. With no consolidation worker in git,
no attack surface exists yet — but the default in the dedup library
needs to flip before the worker lands.

**Attack surface 2 — `BudgetTracker` cost manipulation.**

Scenario: a caller passes forged `tokens_in`/`tokens_out`. With
`Math.max(0, Math.floor(...))` we clamp negatives to 0 (good), but we do
not cap the upper bound. An adversarial caller can inflate peer-agent
cost by any integer ≤ `Number.MAX_SAFE_INTEGER`, crossing any downstream
budget gate.

Mitigation: cap per-event token deltas at the Anthropic per-request
ceiling (≤ 1_000_000 in/out) or document the trust model. The fix is
~4 LOC in `BudgetTracker.record` (see P-5).

Risk if shipped as-is: **low** (only trusted callers today) but worth
fixing before we expose it over IPC or MCP.

---

## 6. Test quality — theater check

Combed `tests/anti-patterns.test.ts`, `tests/stress-harness.test.ts`,
`tests/seed-tasks.test.ts`, `tests/budget-tracker.test.ts` for mock-only
assertions that don't exercise real behavior.

Findings:
- **No test-theater.** Every assertion binds to an externally observable
  value: the cluster signature string, the cost in USD, the outcome enum,
  the rowcount, the tag on the persisted memory.
- `anti-patterns.test.ts` uses a `stubSink` that records `writes[]` —
  but the tests assert the tag contents (`"anti-pattern:avoid"`,
  `"loop_attempts:TIMEOUT:retry_same"`), the `taskType` field, etc. That's
  behaviour-under-test, not "sink was called". Good.
- `stress-harness.test.ts` drives with scripted outcomes via
  `runTaskFn: async (t) => outcomes[t.id]` — that's the correct seam
  since the real runner would be the live autonomy loop.
- `budget-tracker.test.ts` round-trips through a real in-memory
  SQLite — not a mock — so the schema, upsert-on-conflict, WAL setup,
  and cost math are genuinely exercised.
- `seed-tasks.test.ts` is pure data-shape: 100 tasks, 40/40/20, unique
  ids, ≥3 escalation-acceptable. Concise and correct.

One mild gap: `stress-harness.test.ts` does not assert the **concurrency
bound** (that never more than N promises are in flight). A deterministic
concurrency-bound test is ~20 LOC (instrument `runTaskFn` to bump a
counter, record the max, and assert `max ≤ concurrency`). Follow-up.

Missing suites:
- No test for the consolidation worker / dedup (the test file existed
  transiently in working tree but has not been committed to any branch).
- No test for any of C4's deliverables (because none shipped).
- No test for the C2 success-rate dashboard (not shipped).
- No end-to-end DoD test: "after a consolidation run, 100 duplicate
  memories collapse to 1" — this DOES exist in the transient
  `consolidation-dedup.test.ts` on disk (see `"100 duplicate memories
  collapse to 1 (DoD)"` test) but is not committed.

---

## 7. Top 5 patches before merging `phase7/integration` → `main`

Listed highest-impact first. Each is concrete: file:line, what, why, fix.

### P-1. Block the merge, or retitle as "Phase 7a" and add DEFERRED.md
**Why:** the integration branch claims to be Phase 7 but ships 2 of 5 DoD
bullets (§6 bullet 3 partial, §6 bullets 1–2 absent, §6 bullet 5
observability present but no UI, §6 bullet 4 present). Shipping this as
"Phase 7 complete" will mislead downstream consumers and rot the
roadmap.
**What:** either (a) hold the merge until C1 + C4 land, or (b) retitle
the merge `"feat(phase-7a): anti-pattern clustering + stress bench +
budget observability"` AND add `docs/phase-7/DEFERRED.md` listing the
un-shipped bullets (C1 dedup+canon+worker, C2 success-rate dashboard,
C3 UI routes, C4 orchestrator split + rungs 4–7 + worktree default).

### P-2. Cherry-pick `27f22fc` (BudgetTracker) onto `phase7/integration`
**Where:** `phase7/integration` HEAD currently lacks
`src/observability/budget-tracker.ts`; the commit exists on
`phase7/bench-observability`.
**Why:** §6 bullet 5 is observability. Without the cherry-pick, the
integration branch does not actually ship the bullet it claims.
**Fix:**
```bash
git checkout phase7/integration
git cherry-pick 27f22fc
npm test  # budget-tracker tests should pass on an empty ~/.cortexos
```

### P-3. Replace `as unknown as LoopLogInternal` / `SkillLedgerInternal` with narrow query methods
**Where:** `src/analytics/anti-patterns.ts:249,271`.
**What:** anti-patterns reaches into the private `.db` handle of
`LoopAttemptLog` + `SkillUsageLedger`.
**Why:** any renaming of the internal `db` field, or any refactor that
moves it behind a getter, silently breaks anti-patterns at runtime
(TypeScript can't see the dependency).
**Fix:** add
`LoopAttemptLog.failuresSince(cutoffISO: string): LoopAttemptRow[]` and
`SkillUsageLedger.failuresSince(cutoffISO: string): SkillRunRow[]`;
change `DetectAntiPatternsDeps.attemptsLog` to take a narrow interface
with that method (+ existing `.record` etc.). Same code, stronger seam.

### P-4. Do not commit `designer-recall.ts` + `researcher-executor.ts` without also removing the inline bodies from `orchestrator.ts`
**Where:** `src/orchestrator/orchestrator.ts:178, 374, 450, 528, 807`.
**Why:** I saw both extracted files untracked on disk. If Tester 1 or
C4 commits them without also deleting the three inline functions
(`buildPriorResearchSection`, `runResearcherDetour`, `isResearcherRole`)
AND updating the call sites to `import` from the new files, the
orchestrator will be 810 + 210 = ~1020 LOC of duplication, not the
promised split.
**Fix:**
1. Delete the inline copies at the line numbers above.
2. Add imports at the top of `orchestrator.ts`.
3. Rewrite `this.runResearcherDetour(...)` → `runResearcherDetour(...)`
   and `this.buildPriorResearchSection(task)` →
   `buildPriorResearchSection(task, { briefStore: this.briefStore })`.
4. Rerun `wc -l src/orchestrator/orchestrator.ts` → confirm < 500.

### P-5. Cap per-event token deltas in `BudgetTracker.record`
**Where:** `src/observability/budget-tracker.ts:195–220` (the
`record()` body).
**What:** add `PER_EVENT_TOKEN_CAP = 1_000_000` (Anthropic max) and
clamp `d_in`/`d_out` against it.
**Why:** currently a malicious or buggy caller can inflate any peer's
cost beyond recovery (see §5 attack-surface 2). The fix is tiny and
forces an explicit breach before any follow-up throttling can be wrong.
**Fix:** 2 lines of `Math.min` + 1 test case
(`"clamps runaway tokens_in to PER_EVENT_TOKEN_CAP"`).

---

## 8. Follow-ups beyond Phase 7

Actual Phase 7 work deferred, or adjacent cleanup surfaced by this review:

1. **C1 re-attempt as Phase 7.1.** Ship
   `src/consolidation/{dedup,canon,worker}.ts` + tests. The dedup draft
   I saw is solid; canon promotion (promote memories with ≥ N successful
   outcomes to `namespace: "canon"`) is a fresh ~150 LOC + worker
   schedule. §5.5 evolution loop will consume these.
2. **C2 re-attempt — ship `success-rate.ts` + `/ui/success-rate` +
   `/ui/anti-patterns`.** The clustering is done; the dashboard surface
   is a straight-line ~200 LOC in Phase 7.1.
3. **C3 — ship `/ui/budgets` + `/ui/stress-reports` handlers in
   `src/ui/ui-api.ts`.** The tracker + harness are ready to plug in.
4. **C4 — rungs 4–7.** `AskPeerStrategy` wraps `nchinda_ask_peer`;
   `RecallStrategy` wraps `nchinda_recall`; `WebSearchStrategy` wraps
   the Phase 3 `web_search` tool; `EscalateStrategy` wraps
   `nchinda_escalate` and marks the loop terminal. Update the file-level
   comment in `src/loop/fallback-strategies.ts` that still says
   `"Rungs 4–7 ship in Phase 3"`.
5. **C4 — orchestrator split.** Already drafted in `designer-recall.ts`
   + `researcher-executor.ts`; just needs the removal of the inline
   duplicates (see P-4) and commit.
6. **C4 — worktree default.** Make `CortexController` allocate a
   `WorktreeManager` by default. Honor `CORTEXOS_WORKTREE=off` (env
   bypass) so the scaffolding doesn't break tests that don't want git
   worktrees. Document in `CLAUDE.md`.
7. **Anti-pattern clock injection.** `windowCutoff(days)` in
   `anti-patterns.ts` should accept an optional `now()` so tests can be
   fully deterministic.
8. **Dedup default strategy flip.** Change
   `DEFAULTS.keepStrategy = "highest_similarity"` before the worker
   lands (see §5 attack-surface 1).
9. **Stress-harness concurrency-bound test.** Instrument `runTaskFn`
   with a counter; assert the in-flight max never exceeds
   `concurrency`.
10. **Phase 7 DECISIONS.md.** No `docs/phase-7/DECISIONS.md` ever
    landed; coders should each append an entry describing what was
    deferred and why (parity with Phase 1–3 which all have this doc).
