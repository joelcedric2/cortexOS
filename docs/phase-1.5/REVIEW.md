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

**SQL — prepared statements everywhere.** `cron-jobs-db.ts` uses `this.db.prepare(...).run(params)` for every write (create, update, delete, markRan). Updates build column lists server-side from a static key whitelist; only values are bound. No string interpolation of user-supplied data into SQL. `listDue` and `runsByJob` both bind via positional parameters. Clean.

**Haiku call in `nl-parser.ts`.** API key read from `opts.apiKey ?? process.env.ANTHROPIC_API_KEY` — never hardcoded, never logged, never written back to the DB. `AbortController` with `timeoutMs` (default 8s) wraps every `fetch`. Error path is the best part of this module: `redactHaikuReason()` maps raw errors to a fixed set of labels (`timeout`, `rate-limited`, `server-error`, `client-error`, `parse-error`, `schema-mismatch`, `network`, `unknown`). The Haiku-500 redaction test explicitly asserts that a response body containing `"secret=abc123"` does **not** bleed into `rationale` — good. One minor note: raw `err.message` is still passed into `redactHaikuReason` before matching, which is fine because only the label escapes.

**IPC `cron.*` cases.** All seven cases in `CortexController.handleIpcRequest` delegate to the `cronCreate / cronUpdate / …` handlers in `api.ts`, each of which parses its raw input with zod (`CronCreateInputSchema`, `CronUpdateInputSchema`, `IdSchema`) before touching the DB. Max lengths enforced: name 128, task 4000, role_hint 64, timezone 64 — sensible caps. `cron_expr` goes through `isValidCronExpr()` on both create and update.

**MCP `nchinda_schedule`.** Input validated with `ScheduleInputSchema` (utterance ≤ 2000 chars, timezone ≤ 64, createdBy enum). But there are two abuse paths worth noting:

1. **No cron-frequency ceiling.** `isValidCronExpr` accepts `* * * * *` (every minute) and `*/1 * * * *`. An NL utterance "every minute burn CPU" will schedule a once-per-minute firing. Given that `Scheduler.run` wraps the Autonomy Loop (which can spawn agents), a hostile or careless MCP caller can trivially create a DoS. Recommend: in `api.ts::CronExprSchema`, reject minute-resolution patterns unless `createdBy === "onboarding"` or a new `requireConfirm: true` flag is passed. Alternatively, enforce at the scheduler layer (skip dispatch if same-job has fired in the last N minutes).
2. **No rate-limit on tool calls.** A caller can invoke `nchinda_schedule` in a tight loop and spam the `cron_jobs` table. The existing unique-name collision in the DB does not apply (IDs are generated from `Date.now().toString(36).slice(-6)`, so collisions are unlikely within the same 36ms, and there's no UNIQUE constraint on `name` anyway).

**Feature flag bypass.** `CORTEXOS_SCHEDULER=on` gates both `CronJobsDB` open and the ticker start. Off-path correctness: `this.cronDb` stays null → `getCronDb()` helpers throw only if called → IPC `cron.*` cases route through Agent B's `getCronDb()` fallback which lazy-opens a fresh DB on demand. That fallback on the B branch uses the **stub DB**, which is in-memory only — so with the flag off, `cron.create` succeeds and `cron.list` returns rows, but nothing fires and nothing persists across reboots. This is not a correctness bug per se (by design, the ticker is opt-in) but it is a footgun: a user who types "Nchinda, schedule me a morning brief" with the flag off gets silent acceptance and no action. Recommend: `api.ts` should refuse writes when the real scheduler isn't running, or the MCP tool should return a visible warning.

**No raw-SQL surface via `cron.update`.** zod `CronUpdateInputSchema.strict()` is not set, but the key whitelist in `cron-jobs-db.ts::update` means unknown keys are dropped on the floor before hitting SQL.

## 5. Correctness deep-dive

**Dedup under contention.** `Scheduler.inFlight` is a `Map<string, Promise<void>>`. `dispatch()` inserts; `promise.finally()` removes. Between ticks, the `Map.has` check blocks re-dispatch. Single-threaded JS means the check-then-set is atomic, so there is no TOCTOU here. The test `dedup: slow job does not double-fire on re-tick` explicitly re-injects the job into the due list between ticks and asserts exactly one fire — this is the right test and it passes. **But:** correctness only holds across re-ticks, not across process restarts or across the window after `markRan` but before `next_run` is updated. See next item.

**`next_run` is never re-computed after `markRan`.** This is the single biggest functional gap. `Scheduler.runJob` calls `db.markRan(id, outcome, durationMs, summary, finishedAt)` which updates `last_run` and inserts a `cron_runs` row, but leaves `next_run` untouched. On the next tick 10s later, `listDue(now)` still returns the job (because `next_run` is still in the past and the job is still enabled). With `inFlight` cleared, the job fires again. Then again. Result: any enabled cron fires continuously until `next_run` is explicitly updated — the scheduler is effectively broken for real use. The plan mentions node-cron precisely because node-cron handles next-run computation internally; by rolling their own ticker, Agent A inherited the responsibility. Fix: after `markRan`, call `db.update(id, { next_run: computeNext(job.cron_expr, now, job.timezone) })` inside `runJob`. Requires adding a cron-expr→Date helper (cron-parser package or similar). This is the #1 pre-merge patch.

**`durationMs` and timezones.** `durationMs = finishedAt.getTime() - startedAt.getTime()`. Both come from `this.now()`, which defaults to `() => new Date()`. `Date.getTime()` returns UTC ms-since-epoch regardless of local timezone, so the subtraction is timezone-immune. `Math.max(0, …)` guards against a clock going backwards during the run (NTP step). Clock injection via the `now` dep is present and exercised in tests. Good.

**NL parser on empty / garbage input.** `parseNl("", {apiKey: ""})` → heuristic path → no pattern matches → returns `mk("0 * * * *", tz, 0.2, "unrecognized-pattern, defaulting to hourly", "")`. **It returns; it does not throw.** The test `unknown phrasing → conservative hourly with low confidence` exercises this. The utterance length is not checked in the heuristic path (only at the MCP boundary, which caps at 2000), so absurdly long garbage is fine at this layer.

**Haiku fallback when network flakes.** The try-catch in `parseNl` catches any throw from `callHaiku`, redacts the reason, and composes a fallback result using the heuristic path. Prefix `[haiku-fallback: <label>]` is added to `rationale` so the caller can see what happened. This means: cron scheduling never blocks on the LLM, which matches the §1 principles call for "graceful degradation".

**Defaults seeder idempotence.** `seedDefaults(db)` reads `db.listAll()` once, builds a Set of existing names, and inserts only missing ones. The partial-state test asserts that a user-customized `morning_brief` is preserved (not overwritten) and the other 5 defaults are added. Result shape `{inserted, skipped, insertedNames, skippedNames}` is logged without side effects. **Gap:** the seeder matches by `name` only. If a default name already exists but with a different `cron_expr` or a different `created_by`, the seeder silently skips — no warning. Plan is ambiguous here; I'd argue the current behaviour (skip + log) is correct for user-customization preservation, but worth calling out explicitly in docs.

**Test-only clock in `markRan`.** `markRan(…, runAt: Date = new Date())` accepts an injected time. Agent A's test uses `const now = new Date("2026-05-01T12:00:00.000Z")` and passes it explicitly; the round-trip asserts `job.last_run === now.toISOString()`. Clean.

## 6. Test-quality audit

**Coverage by file (approximate line counts):**
- `tests/scheduler.test.ts` — 22 tests, ~370 LOC (CRUD + ticker + dedup + stop + fail)
- `tests/nl-parser.test.ts` — 20 tests: 15 heuristic + 4 Haiku mock + 1 redaction
- `tests/scheduler-defaults.test.ts` — 13 tests: DEFAULT_JOBS shape + seeder idempotence + isValidCronExpr positive/negative
- `tests/scheduler-api.test.ts` — 14 tests: every CRUD handler's happy + sad paths
- `tests/nchinda-schedule-tool.test.ts` — 6 tests: schedule handler end-to-end
- `tests/probe-executors.test.ts` — 7 tests (shared with phase2.5/researcher)

**Behavior vs. stub.** Every test file I inspected exercises real code paths:
- `nl-parser.test.ts` uses a real `fetch`-shaped function (either `apiKey: ""` to force heuristic or a mock Response) — no fake parseNl
- `scheduler.test.ts` uses a real `EventBus` and subscribes to assert `cron_fire` propagation — no mocked bus
- `scheduler-api.test.ts` uses the real stub DB, so the round-trip is a genuine DB hit (even if the store is the stub)
- `nchinda-schedule-tool.test.ts` uses the real `parseNl` (heuristic path) and the real stub DB

**Assertion-less / accidentally-passing tests?** Scanned all 75 tests; none pass without assertions. Counter-example: `start() is a no-op when already running` asserts via `sched.start(60); sched.start(60)` not throwing and `stop()` settling cleanly — this is a weaker assertion but it is an assertion. Good.

**Failure-path coverage.**
- Haiku 500 error → redacted label ✓
- Haiku malformed JSON → redacted label ✓
- Haiku timeout → redacted "timeout" label ✓
- Scheduler executor rejection → markRan outcome='fail' ✓
- Scheduler `listDue` throws → tick returns, no crash (covered by the implementation, not directly by a test — worth adding)
- Scheduler `bus.emit` throws → dispatch continues, no crash (same — covered by code, not test)
- DB lock contention → not exercised (better-sqlite3 is single-threaded, largely N/A, but worth a note)

**End-to-end gap.** There is no test that exercises the full seeder → Scheduler → markRan → update(next_run) loop. Each layer is tested in isolation. For the DoD smoke ("schedule every-minute, observe it firing") this needs an integration test. Agent C's smoke should cover it.

**Test isolation.** Each scheduler test opens `new CronJobsDB({dbPath: ":memory:"})` → 100% isolated, no fs leaks. NL parser tests pass `apiKey: ""` explicitly to stop the ambient `ANTHROPIC_API_KEY` from pulling tests onto the Haiku path. Good defensive testing.

## 7. Design smells

- **`_cron-jobs-db-stub.ts` (117 LOC)** — the leading-underscore "delete-me" file. It exists because Agent B needed to land without Agent A's `cron-jobs-db.ts` on main; that was a reasonable short-term move but it encoded an interface that diverges from Agent A's. The file's own header tells you to delete it. Integration branch is the moment to do it.
- **`api.ts::cronHistory` reads `job.outcome_history`** — which only exists on the stub row shape. Agent A's `CronJob` has no `outcome_history`. Compiler will fail on this line after the stub is removed unless the adapter translates `db.runsByJob(id)` into the expected shape.
- **Scheduler.run callback factory (D-1.5-1)** — not a smell per se, but the fallback "warn and skip" behaviour when no factory is registered is a silent trap in production. If `CORTEXOS_SCHEDULER=on` but no integrator registered a factory, every cron fire is a warning log and no action. Better: throw on `initialize()` if the flag is on but no factory is set.
- **`ScheduleResult.next_run` assumes Agent B's Date-typed stub.** `fresh.next_run.toISOString()` on line ~200 of `nchinda-tools.ts` will break against Agent A's DB where `next_run` is `string | null`. Need either `new Date(fresh.next_run).toISOString()` with a null guard, or the adapter should normalize.
- **IPC boundary not re-validated in tests.** `scheduler-api.test.ts` calls the handler functions directly; it does not exercise the `CortexController.handleIpcRequest` switch. The `cron.update` case unpacks `req.args as { id: unknown; patch: unknown }` — if a caller sends `cron.update` without `patch`, zod catches it inside `cronUpdate`, but the cast is fragile. Minor, not blocking.
- **No `any` types, no silent catches** — grep for `: any\b` in `src/scheduler/` and `src/mcp/` turns up nothing. `catch` blocks all either rethrow, or call `console.warn` with a redacted message. No empty catches.
- **File sizes.** `cron-jobs-db.ts` = 373 LOC, `scheduler.ts` = 150 LOC, `nl-parser.ts` = 392 LOC, `defaults.ts` = 177 LOC, `api.ts` = 150 LOC, `nchinda-tools.ts` = 235 LOC. All under the 500-line ceiling from project standards.
- **Boundaries.** `src/scheduler/` imports from `../ipc/event-bus.js` only. No imports from `src/orchestrator/` or `src/loop/` — correct per the DDD rule that the scheduler should not reach into orchestration. The controller is the aggregation point.
- **Cross-branch type bleed.** `src/mcp/nchinda-tools.ts` imports `CronJobsDB` from `../scheduler/_cron-jobs-db-stub.js` (Agent B's branch). Once integration removes the stub, every import must be re-pointed.

## 8. Top 3 patches before merging to main

### Patch 1 — Delete `_cron-jobs-db-stub.ts`, adapt Agent B's code to the real `CronJobsDB`

**Files:** `src/scheduler/_cron-jobs-db-stub.ts` (delete), `src/scheduler/api.ts`, `src/scheduler/defaults.ts`, `src/mcp/nchinda-tools.ts`, `src/controller/cortex.ts`.

**Why:** The stub and real DB expose mutually incompatible method names and row shapes. Any attempt to `git merge phase1.5/nl-cron-defaults` onto `phase1.5/integration` as-is produces code that does not compile.

**Fix:**
1. Delete `src/scheduler/_cron-jobs-db-stub.ts`.
2. In `api.ts` and `defaults.ts`: change imports from `./_cron-jobs-db-stub.js` to `./cron-jobs-db.js`; rename `db.insert(...)` → `db.create(...)`, `db.listAll()` → `db.list()`. For `cronCreate` you now need to generate an `id` (stub did it; real DB requires caller to supply): use `randomUUID()` or `` `cron_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}` ``.
3. In `api.ts::cronHistory`: replace `job.outcome_history` with `db.runsByJob(id, 50)` and map to the handler's `CronHistoryResult.runs` shape.
4. In `nchinda-tools.ts::schedule`: `fresh.next_run` is `string | null`; either pass through as-is in the response (rename field to `next_run: string | null`), or call `computeNextRun(parsed.cron_expr, now, parsed.timezone)` on insert and bind it on `db.create({..., next_run: Date})`. The latter is the correct fix because the real DB requires `next_run` to be populated for `listDue` to pick the job up.
5. In `defaults.ts::DEFAULT_JOBS`: add an `id` field to each entry (real DB requires it) and a `next_run: null` field (seeder leaves scheduling to first enable).

### Patch 2 — Compute `next_run` after every `markRan`

**File:** `src/scheduler/scheduler.ts`, `runJob()` near line 120.

**Why:** Without this, every enabled cron fires on every tick forever once it becomes due (see §5). This is the difference between a scheduler and an "always-on job runner".

**Fix:**
```ts
// After markRan(…)
try {
  const next = computeNextRun(job.cron_expr, finishedAt, job.timezone);
  this.db.update(job.id, { next_run: next });
} catch (err) {
  // If the cron expr can't be parsed (shouldn't happen; validated on insert),
  // disable the job to prevent a tight loop.
  this.db.update(job.id, { enabled: false, next_run: null });
  console.warn(`[Scheduler] disabled ${job.id}: bad cron_expr`);
}
```
Where `computeNextRun` uses a cron parser library (either the already-present `node-cron` or the lighter `cron-parser`). This also retroactively fulfills DoD bullet 1's "node-cron-based" requirement without rewriting the ticker.

### Patch 3 — Reject minute-resolution cron expressions from non-onboarding callers

**File:** `src/scheduler/api.ts::CronCreateInputSchema`.

**Why:** §4 security gap — `nchinda_schedule` + NL parser will happily create a job with `* * * * *`. Given the Scheduler wraps the Autonomy Loop (which spawns agents), this is a trivial DoS.

**Fix:** Add a `superRefine` on `CronCreateInputSchema` that parses the minute field; if it resolves to more than 1 firing per hour AND `createdBy !== "onboarding"`, throw. Or less aggressive: cap to ≥5min resolution for MCP-originated jobs. This gates the surface without breaking defaults (the minimum-frequency default is `meeting_prep = */10 * * * *`).

## 9. Follow-ups for later phases

- **Dashboard cron page (Phase 6).** Explicitly deferred per the plan. All backend handlers are in place on Agent B's branch (`cron.list/create/update/enable/disable/delete/history`) so the UI is a straightforward read-model over existing IPC. Decide at that point whether the cron table should drop its `outcome_history` implicit read and call `cronHistory` instead.
- **node-cron integration (or switch to it).** Rolling the ticker was pragmatic for Phase 1.5 but `node-cron`'s `schedule(expr, fn)` handles timezone + next-run for free. If the next-run patch (#2 above) ends up pulling in `cron-parser`, consider just adopting `node-cron` wholesale in Phase 6.
- **Auto-pause after 3 consecutive escalations** (§5.6.5). Not implemented. The `cron_runs.outcome` column supports this — needs a tick-time check that reads the last 3 runs and flips `enabled=false` if all are `escalated`. One SQL + one conditional.
- **Nchinda proactively proposes crons** (§5.6.4 "Want me to brief you on Slack at 9:15?"). This is a Phase 3/4 feature — hook off the observation stream + pattern detector.
- **Live MCP roundtrip test** for `nchinda_schedule`. The unit tests cover everything up to JSON-RPC framing. A spawn-stdio-and-talk-to-it test (same pattern as whatever the existing `nchinda_recall` harness does) would cover the `tools/list` + `tools/call` handshake.
- **Cron-expr frequency floor enforcement at the Scheduler layer** as a defense-in-depth to Patch #3. Even if the API accepts it, the Scheduler could refuse to dispatch a job that has fired more than N times in the last hour.
- **Pretty DB path override.** `CronJobsDB` defaults to `~/.cortexos/registry.db`. Tests use `:memory:`. There's no env-var override for production relocation — fine for now, worth a follow-up when we ship the onboarding installer.
- **Consolidate the run-metrics event.** `cron_fire` fires at dispatch. There's no `cron_settled` event at completion, which means a subscriber can see a fire but not know if it succeeded. Consider adding `cron_settled` with outcome + duration so dashboards can tail events instead of polling `cron_runs`.
