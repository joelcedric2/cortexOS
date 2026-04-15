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

| DoD bullet | Plan requirement | Shipped? | Evidence / gap |
|---|---|---|---|
| 1 | `src/scheduler/scheduler.ts` — node-cron-based ticker reading `cron_jobs` SQLite table | Partial | Ticker exists (150 LOC, interval-based, dedup, graceful stop). Does **not** use `node-cron`; rolls its own `setInterval(10s)` poll + DB `listDue`. Functionally equivalent and simpler; acceptable deviation but the Scheduler never re-computes `next_run` after a firing — see §5. |
| 2 | Job spawn wraps Autonomy Loop — no special path | Partial | `Scheduler` accepts an injected `SchedulerRun` callback (D-1.5-1). Controller plumbs a factory, so the real integrator wires the loop in. When no factory is set the callback warns-and-skips — keeps test paths green but a real `cortex dev` boot without wiring is a silent no-op. |
| 3 | SQLite `cron_jobs` table shape matches plan §5.6.2 | Yes (in Agent A) | `cron-jobs-db.ts` INLINE_SCHEMA matches §5.6.2: id, name, cron_expr, task, role_hint, depth, enabled, timezone, last_run, next_run, created_by, created_at. `outcome_history` is correctly promoted to a separate `cron_runs` FK table with indexes on `job_id` + `run_at`. **Drift:** `_cron-jobs-db-stub.ts` on Agent B's branch embeds `outcome_history` as an array on the row — structurally incompatible. |
| 4 | Scheduler actually ticks + dispatches + fires `cron_fire` | Yes | `dispatch()` emits `AgentEvent{kind:"cron_fire", task_id: job.id, payload:{name, task}, ts}` before invoking `run(job)`. Union updated in `src/ipc/event-bus.ts`. Unit test "dispatches a due job, emits cron_fire once" confirms the round-trip. |
| 5 | NL parser covers ≥ 10 default phrasings | Yes — 12+ | `heuristicParse` ships: at midnight, at noon, hourly, nightly, every morning, every evening, every N minutes, every N hours, every weekday at HH, weekday mornings at HH, every weekend at HH, daily at HH, every day at HH, every {dow} at HH. Unrecognised input → conservative hourly with confidence 0.2 (explicit fallback path, not a throw). |
| 6 | 6 default jobs shipped per §5.6.3 | Yes — exactly 6 | `DEFAULT_JOBS` in `src/scheduler/defaults.ts` frozen; test asserts `length === 6` and each cron_expr matches the plan table verbatim. All disabled by default (user opts in during onboarding). |
| 7 | MCP tool `nchinda_schedule` works end-to-end | Yes (unit) | Tool handler in `src/mcp/nchinda-tools.ts`, JSON-schema in `src/mcp/tool-schema.ts`, registered in `scripts/mcp/serve-nchinda.mjs`. Unit tests confirm utterance → job_id + cron_expr + persisted row. No live MCP roundtrip, but the serve-nchinda.mjs harness is unchanged from Phase 2 where `nchinda_recall`/`nchinda_remember` are already deployed. |
| 8 | CortexController boot wiring live (behind `CORTEXOS_SCHEDULER=on` flag) | Yes | Agent A's controller opens `CronJobsDB`, constructs `Scheduler` with injected run factory, calls `start()`. `shutdown()` awaits `scheduler.stop()` then closes the DB. Flag-gated per D-1.5-2 so existing Phase 1 tests stay untouched. |
| 9 | Dashboard cron list/edit/pause/history page | Deferred (correct) | Not shipped. The master plan §6 moves mission-control pages to Phase 6 — this is not a forgotten item. IPC handlers `cron.list/create/update/enable/disable/delete/history` are in place on Agent B's branch, so a dashboard can plug in without further backend work. |
| 10 | DoD smoke: "every minute print 'alive'" works; weekday 8am draft works; outcome history populates | Not yet run | Scheduler + DB + NL path all exist; no end-to-end boot-and-watch-for-fires smoke on the integration branch yet. Agent C's responsibility. |

**Net:** 8/10 shipped, 1 correctly deferred, 1 pending Agent C. No drift from the plan that is actually harmful — the stub-vs-real interface issue is an integration problem, not a spec deviation.

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
