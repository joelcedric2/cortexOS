# Phase 7 Integration Notes

Owner: Tester 1 (integration lead)
Branch: `phase7/integration` (forked from `main` @ `0fc007f`)
Status: in-flight — updating as coder branches land.

## Merge order

Chronological order of integration commits (each row = one commit on `phase7/integration`):

| # | Source | Source SHA | Integration SHA | Summary |
|---|--------|------------|-----------------|---------|
| 1 | C3 `phase7/bench-observability` (merge) | `6a37b53` | `3a8e4bb` | stress-harness + seed-tasks (§6.4) |
| 2 | C2 `phase7/antipatterns-dashboard` (merge) | `5564ee7` | `00dfc29` | anti-pattern clustering (§6.2) |
| 3 | C3 cherry-pick `27f22fc` | `27f22fc` | `cdeff65` | BudgetTracker (§6.5) |
| 4 | C2 cherry-pick `911b4f0` | `911b4f0` | `2051cbb` | per-role success-rate dashboard (§6.3) |
| 5 | C3 cherry-pick `175675f` | `175675f` | `57e6438` | UI `/ui/budgets` + `/ui/budgets/totals` routes |
| 6 | C1 cherry-pick `0577a64` | `0577a64` | `7b1123f` | VectorStore.listMemories + dedup union-find (§6.1 piece 1) |

Cherry-picks over merge commits were used from step 3 onward because C2 and C3 branches became cross-contaminated with Tester 2's in-progress commits (`5bc4b87`, `51b29b0`, `91a3a69`) and with a misdirected commit of mine (`9db7b2a`). Cherry-picking kept `phase7/integration` free of that noise.

## Conflicts resolved

None so far — every new C2/C3/C1 file lands in a fresh path (`src/analytics/*`, `src/bench/*`, `src/observability/*`, `src/consolidation/*`, `tests/*`) or in an append-only region (`src/memory/vector-store.ts` +listMemories, `src/ui/ui-api.ts` + route case). `git` merged cleanly via `ort` and cherry-pick applied with no 3-way conflict on any of the six integration commits listed above.

## Fixes applied

None required so far. TypeScript `--noEmit` is clean and `npm test` reports **all green** when run on a clean working tree (see test-count timeline below).

## Working-tree chaos caveat

Four coder agents + two tester agents share **one** git worktree. `git checkout` in any agent's session changes the branch for every other agent, so:

- `git status` on `phase7/integration` often shows untracked/modified files belonging to other coder branches.
- Tests must be run on a **clean** tree (`git reset --hard HEAD && git clean -fd`) to avoid false failures from leaked WIP (e.g. partial `dedup.ts` that referenced a not-yet-committed `listMemories`).
- Branch-switch interference during `npm test`, `git commit`, and `git stash` has been observed — every critical step must capture `git branch --show-current` **both before and after** the operation and retry if the branch changed unexpectedly.
- My INTEGRATION_NOTES seed commit landed on `phase7/bench-observability` as `9db7b2a` instead of integration because the tree was flipped mid-`git commit`. Rather than re-writing history across branches, I re-created INTEGRATION_NOTES directly on `phase7/integration` after the final coder commits landed.

## Test count timeline

All rows are a clean-tree `npm test` run pinned to `phase7/integration` HEAD.

| Checkpoint | Integration HEAD | tests | suites | pass | fail |
|------------|-----------------:|------:|-------:|-----:|-----:|
| main baseline | `0fc007f` | 810 | 153 | 810 | 0 |
| after C3 bench | `3a8e4bb` | 833 | 158 | 833 | 0 |
| after C2 anti-patterns | `00dfc29` | 841 | 159 | 841 | 0 |
| after C3 BudgetTracker | `cdeff65` | 841 | 159 | 841 | 0 |
| after C2 success-rate | `2051cbb` | TBD | TBD | TBD | TBD |
| after C3 budget-api UI | `57e6438` | 843 | 159 | 843 | 0 |
| after C1 dedup | `7b1123f` | TBD | TBD | TBD | TBD |

(TBD rows will be filled as I re-run the clean suite; intermediate cherry-picks were verified only through typecheck during branch-flip storms.)

## Blockers

- **C1 (consolidation)** — dedup landed, but canon promotion + nightly worker still outstanding. Waiting.
- **C4 (hardening-backlog)** — no commits yet. Orchestrator split (`researcher-executor.ts`, `designer-recall.ts`) + ladder rungs 4–7 + worktree-default still owed.
- Expected conflicts on `src/ui/ui-api.ts` (C2 + C3 both append routes) have not materialized because C3 isolated its additions into `src/observability/budget-api.ts` and only touched ui-api.ts with a single new route case.

## Next steps

1. Merge the next C1 commit(s): canon + nightly worker.
2. Merge C4 when it lands: orchestrator split + ladder rungs 4–7 + worktree-default.
3. Write `tests/phase7-dod.test.ts` covering the 7 DoD bullets once all four modules are in tree.
4. Final clean-tree `npx tsc --noEmit` + `npm test` green on every DoD bullet.
5. Append the closing verdict (test count + DoD y/n) to this file.
