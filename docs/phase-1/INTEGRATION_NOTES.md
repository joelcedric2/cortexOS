# Phase 1 Integration Notes — Agent C

Branch: `phase1/integration` (off `main`)
Merged: `phase1/hooks-ipc` (Agent A) + `phase1/orchestrator-registry` (Agent B)

## Merge summary

| Step | Result |
| --- | --- |
| `git merge phase1/hooks-ipc` into `phase1/integration` | **Fast-forward**, zero conflicts. |
| `git merge phase1/orchestrator-registry` into `phase1/integration` | **ort merge**, zero conflicts. |
| `npm install` | Up-to-date; `better-sqlite3@12.9.0`, `zod@4.3.6`, `@types/better-sqlite3@7.6.13` all resolved from A's `package.json` changes. No manual dep additions required. |
| `npm run lint` (i.e. `tsc --noEmit`) | Exit 0. |
| `npm test` | **40/40 passing** (5 suites). |

Both branches touched disjoint file sets, and A had pre-declared `zod` in
`package.json` as a courtesy, so the classic `package.json` / `package-lock.json`
contention never materialized.

## Test runner decision

Unified on **Node 20's built-in `node --test`** via `tsx/esm` loader, per Agent A's
D3/D10. The old `package.json` script referenced jest but jest was never
installed. Agent A's switch to `node --test` landed in the first merge;
Agent B authored its tests against the same runner. No reconciliation needed.

## Fixes applied during integration

### FIX-1 — `/hooks/stop` now propagates `task_id` and `success` onto the bus event

**Where:** `src/ipc/server.ts` (the handler and the `JsonBody` interface).

**Why:** Agent B's orchestrator subscribes with
`bus.once({ kind: "done", slot, task_id }, …)`. Agent A's original handler
read `session_id`, `agent_id`, `slot` from the Stop payload but **not
`task_id`** — so a `done` event carrying the task id never landed on the bus,
and the orchestrator timed out waiting for it. Agent A's `AgentEvent` type
already declares `task_id` and `plan_emitted` is in its `EventKind` union, so
this is the small API reconciliation the prompt explicitly allowed.

Also lifted optional `success: boolean` out of the payload so the
orchestrator's failure branch (`payload.success === false → markError`) has
something to read.

**Verified:** the Phase 1 DoD test posts `task_id` over HTTP, and both
executors transition `running → done` based on the bus fan-out. The existing
A tests still pass (they don't assert on `task_id`, so the addition is
strictly backwards-compatible).

### FIX-2 — `Orchestrator` gained an `openTerminal` injection hook

**Where:** `src/orchestrator/orchestrator.ts` (interface + constructor +
`openTerminal` method).

**Why:** the orchestrator calls `execFileAsync("osascript", …)` to open a
real macOS Terminal window for every agent it spawns. That's correct for
production but would actually pop Terminal windows during test runs. The
existing `capturePaneOutput` / `waitForReady` deps already follow the
"injectable side-effect" pattern, so I added `openTerminal` alongside them.

Production behaviour is unchanged — when the hook isn't supplied, the
`osascript` path runs exactly as before.

## No other module rewrites

Per the integration brief, I did not touch:

- Agent A's `src/ipc/event-bus.ts`, `events-db.ts`, hook scripts, or the
  Unix-socket `IpcServer` class.
- Agent B's `src/registry/*`, `src/orchestrator/plan-schema.ts`,
  `src/agents/claude-agent.ts`, `src/config/roles.ts`, `src/controller/cortex.ts`,
  `src/tmux/tmux-manager.ts`, or the bulk of the orchestrator flow.
- `docs/phase-1/REVIEW.md` (owned by Agent D).

## New files

- `tests/phase1-dod.test.ts` — the Phase 1 Definition-of-Done smoke test.
  Spawns an architect against a faked `CortexController`, mocks the
  `emit_plan` tool call by publishing a `plan_emitted` bus event carrying a
  valid zod-validated Plan, verifies two executors get spawned + registered +
  marked running, POSTs `/hooks/stop` to the **real** `startHooksServer` for
  each executor, and asserts that everything ends up `done` in the registry
  — with no `await waitFor…` timeouts firing. Runs in ~60ms.

## Phase 1 DoD status

**Met.** Every bullet from `docs/NCHINDA_PLAN.md` §6 Phase 1 is demonstrable:

1. ✅ Hook scripts (`scripts/claude-hooks/stop.sh`, `pre-compact.sh`) POST to
   the hooks server; tested via HTTP in both `tests/ipc.test.ts` and the DoD
   test.
2. ✅ Designer output contract is a structured Plan — `parsePlan` (zod) +
   `extractEmittedPlan`, both unit-tested on B's branch and driven
   end-to-end in the DoD test.
3. ✅ `waitForCompletion` polling is gone — the orchestrator uses
   `bus.once({ kind: 'done', …timeout })`; the DoD test proves the happy path
   with no timeout fired.
4. ✅ Agent Registry schema locked (`src/registry/schema.sql` +
   `INLINE_SCHEMA` fallback); `spawning → running → done|standby|error`
   transitions enforced in `transition()`, exercised by `tests/registry.test.ts`.
5. ✅ `tmux-manager.ts` mouse-mode edit and the new
   `setPaneBorderColor` both landed pre-Phase-1 or on B's branch; no lost work.

## Flagged for human review (not blockers)

- **`startHooksServer` isn't booted by `CortexController` yet.** Agent A's
  `DECISIONS.md` D1 flagged this as an open question. The server is fully
  functional and tested, but it needs one-line wiring from the main entry
  point (`src/index.ts` / `CortexController.initialize`) before real Claude
  Code sessions can reach it at `localhost:3102`. Not included here to avoid
  scope creep past "obvious runtime wiring"; trivial follow-up.

- **`.claude/settings.json` snippet (`docs/phase-1/settings-hooks-snippet.json`)
  has to be merged into `.claude/settings.json` by hand.** Agent A's D9 is
  explicit on why. Also a one-shot manual step, not an integration blocker.

- **`createEventBus()` returns a new bus per call.** If the hooks server and
  the orchestrator boot separately without sharing an injected bus, they will
  not see each other's events. The DoD test threads the same bus through
  both. The eventual runtime wiring (see first bullet) needs to do the same.

- **Two `better-sqlite3` databases live under `~/.cortexos/`:**
  `events.db` (A) and `registry.db` (B). Both are keyed by disjoint
  concerns, so the split is intentional; noted so the Phase 2 consolidator
  doesn't trip over it.

## Commands I ran

```bash
git checkout main && git checkout -b phase1/integration
git merge --no-edit phase1/hooks-ipc           # fast-forward
git merge --no-edit phase1/orchestrator-registry  # ort, no conflicts
npm install
npm run lint        # tsc --noEmit, exit 0
npm test            # 40/40 passing
```
