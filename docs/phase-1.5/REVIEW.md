# Phase 1.5 Code Review — Persistent Scheduler

> Reviewer: Test Agent D.
> Scope: read-only review of `phase1.5/scheduler-core` (Agent A), `phase1.5/nl-cron-defaults` (Agent B), and the partially-merged `phase1.5/integration` (Agent C).
> Baseline plan: `docs/NCHINDA_PLAN.md` §1 (principles), §5.6 (Persistent Scheduler), §6 Phase 1.5 DoD.

## 1. Verdict

**ship-with-fixes.** Both agents delivered clean, plan-aligned work individually — Agent A's `CronJobsDB` + `Scheduler` ticker matches §5.6.2 closely and ships with rigorous dedup / stop / error-path tests; Agent B's NL parser, defaults seeder, CRUD API, and `nchinda_schedule` MCP tool cover §5.6.3/§5.6.4 with good security hygiene (Haiku error redaction, zod-validated inputs). The block to merging to main is that the two branches were built against **incompatible `CronJobsDB` interfaces**: Agent B coded against a self-declared stub (`_cron-jobs-db-stub.ts`) that uses `insert/listAll/markRan(void)` and `Date` fields, while Agent A's real DB exposes `create/list/markRan(CronRun)` and ISO-string fields. Agent C must bridge these before the nl-cron-defaults branch lands on `phase1.5/integration`. Fix the interface adapter + three smaller items below and this ships.

## 2. Scorecard (1–5)

| Dimension | Score | Notes |
|---|---|---|
| Correctness | 4 | Scheduler ticker semantics (dedup, stop, error-to-fail) are tight. NL heuristic covers all 12+ phrasings the plan implies. Primary wart: stub-vs-real DB interface drift (§5/§8). |
| Security | 4 | Prepared statements throughout `cron-jobs-db.ts`. Haiku errors redacted via `SAFE_REASON_PATTERNS`. API key env-only + per-request `AbortController` timeout. IPC cases use zod at the API boundary. One gap: no rate-limit on `nchinda_schedule` or ceiling on cron frequency — a user utterance "every minute fire a shell" is accepted. |
| TypeScript rigor | 5 | No `any` in scheduler or MCP code, explicit typed interfaces, `readonly`/`Object.freeze` on `DEFAULT_JOBS`, zod `z.infer` used for schema/type alignment. One cast-through-unknown in the test helper only. |
| Test quality | 4 | Agent A: 22 scheduler tests (CRUD + ticker + dedup + stop + failure). Agent B: 45 tests across nl-parser, defaults, api, schedule-tool. Real behaviour, not stubbed assertions. Minor: no end-to-end "seeder → scheduler fires → markRan" integration test; each layer tested in isolation. |
| Design | 3 | Scheduler callback factory injection (D-1.5-1) is a clean decoupling. But the stub file `_cron-jobs-db-stub.ts` is a design smell — it is the *single source of the interface drift* and its removal is explicitly TODO'd in its own header. Also: `api.ts`'s `cronHistory` reads `outcome_history` off the row shape, which only exists on the stub; won't compile against Agent A's DB. |
| Spec adherence | 4 | 6/7 DoD items shipped (schema, ticker, NL parser, 6 defaults, MCP tool, controller wiring). Dashboard page correctly deferred per plan. Stub table schema diverges from §5.6.2 (outcome_history inline vs `cron_runs` FK table) but Agent A's real DB matches §5.6.2. |
| Performance | 4 | 10s tick is reasonable. `listDue` has `idx_cron_jobs_enabled` + `idx_cron_jobs_next_run`. Dedup map is O(1). One concern: scheduler never calls `update(next_run=…)` after `markRan` — same-minute jobs will re-fire on the next tick once the in-flight map clears. Covered under §5. |

## 3. Spec-drift check (§6 Phase 1.5 DoD)

TBD

## 4. Security pass

TBD

## 5. Correctness deep-dive

TBD

## 6. Test-quality audit

TBD

## 7. Design smells

TBD

## 8. Top 3 patches before merging to main

TBD

## 9. Follow-ups for later phases

TBD
