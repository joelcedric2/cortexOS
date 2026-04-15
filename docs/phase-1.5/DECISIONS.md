# Phase 1.5 Decisions (Agent A — Scheduler core)

Phase 1.5 Agent A owns:
- `src/scheduler/cron-jobs-db.ts` (SQLite-backed cron store)
- `src/scheduler/scheduler.ts` (10s-interval ticker + dedup + graceful stop)
- `cron_fire` event kind (appended to `EventKind` union)
- `CortexController` boot wiring for the scheduler
- `tests/scheduler.test.ts`

This file records pragmatic deviations from the prompt and their rationale.

## Decisions

### D-1.5-1 — Scheduler's `run` callback is injected, not constructed in-controller
The prompt suggests `this.scheduler = new Scheduler({ … run: (job) => autonomyLoop.execute(job.task, { task_id: job.id }) })`. To build that callback the controller would need to own an `AutonomyLoop` instance, which in turn needs an `Orchestrator`, `AgentRegistry`, `Classifier`, `Policy`, strategy list, and `EventBus` — dependencies the controller does not hold today (they're wired in `src/index.ts`).

Rather than widen the controller constructor (breaking Phase 1 tests that new-up the controller directly), I added `CortexController.setSchedulerRunFactory(factory)`. `src/index.ts` (or any integrator) wires the factory before calling `initialize()`:

```ts
const controller = new CortexController(config);
controller.setSchedulerRunFactory(() => {
  const loop = createAutonomyLoop({ orchestrator, registry, bus: controller.getBus() });
  return (job) => loop.execute(job.task, { task_id: job.id });
});
await controller.initialize();
```

When no factory is set (unit tests, bare CLI), the Scheduler still fires and markRans but the `run` callback is a warning no-op — the cron *fire event* still reaches the bus, so downstream consumers (e.g. a future MCP tool) can still observe schedule activity without an Autonomy Loop wired in.

### D-1.5-2 — Scheduler boot is behind `CORTEXOS_SCHEDULER=on`
`CortexController` is instantiated (or stubbed) by three existing test files: `phase1-dod.test.ts`, `orchestrator-execute-once.test.ts`, and `phase1/hooks.test.ts`. They all either mock the whole controller or call `new CortexController(config)` without invoking `initialize()`, so scheduler boot inside `initialize()` is transparent to them regardless of the flag.

However, a real `cortex dev` startup without the flag would eagerly open `~/.cortexos/registry.db` and spawn a polling timer even when cron is unused. The flag keeps the feature opt-in until Agent B's NL parser + MCP tool land and a user actually needs scheduled jobs. Flip it on by setting `CORTEXOS_SCHEDULER=on` in the daemon env; flip it off to skip both `CronJobsDB` open and the polling interval.

### D-1.5-3 — `scheduler.test.ts` appends to the existing CronJobsDB file
Phase 1.5 started with a `tests/scheduler.test.ts` that covered only `CronJobsDB` CRUD. Rather than rename or split, I appended a `describe("Scheduler", …)` block at the bottom. Keeps all scheduler-module tests in one file, matches the pattern `tests/ipc.test.ts` uses for its two inner suites.

### D-1.5-4 — Fake clock + fake DB in tests (no `better-sqlite3` dep in unit tests)
The Scheduler tests use a structural `FakeCronDB` that implements just the two methods the Scheduler touches (`listDue`, `markRan`) and is cast to `CronJobsDB` at the call site. This keeps the ticker semantics (dedup / stop / outcome propagation) the unit under test and avoids pulling the full SQLite schema into every test run.
