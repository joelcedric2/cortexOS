# Phase 2 — Autonomy Loop Decisions

This doc tracks load-bearing design decisions and any TODOs deferred to
later phases. Every `TODO` comment in Phase 2 source must have a tracking
line here.

## Open TODOs

_None._

## Decisions

### D1 — Fallback ladder is pluggable; only rungs 1-3 ship in Phase 2
The `FallbackStrategy` interface (`src/loop/types.ts`) is a plain object
with `canHandle` / `apply`. The loop composes them in `rung` order. Rungs
4-7 (`ask_peer`, `recall`, `web_search`, `escalate`) ship in Phase 3 when
the `nchinda_*` MCP tool suite is available; Phase 2 only ships:

  1. `retry-same` — transient errors only
  2. `alternate-tool` — placeholder until the tool registry exists
  3. `reduce-scope` — rewrites task to "smallest useful slice"

### D2 — `loop_attempts` lives in `~/.cortexos/registry.db`
Per the Phase 2 spec, we did NOT add a second SQLite file. The
`LoopAttemptLog` class opens the same DB file and runs its migration
idempotently. Agent B owns any tables they add (`mcp_tool_calls` etc.);
Agent A owns `loop_attempts` only.

### D3 — EventKind union appended, not re-ordered
`loop_state` added to the end of `EventKind` in `src/ipc/event-bus.ts`.
Any additional kinds Agent B needs must also be appended.

### D4 — `executeOnce` is additive on the Orchestrator
Current `execute(task)` is unchanged. `executeOnce(plan, taskId)` runs
a single attempt of a pre-built Plan and returns
`{success, taskId, error?}`. The loop composes it; the orchestrator's
internals are untouched.

### D5 — Policy is a class, not a bag of functions
Makes injection straightforward (the loop takes `policy: Policy` in its
deps). The "pure functions where possible" rule from the Phase 2 spec is
honored by keeping all match logic inside regex-backed predicates on the
class; no hidden state, no IO.

### D6 — Classifier contract duplicated in `src/loop/types.ts` during parallel dev
Agent B owns `src/classifier/classifier.ts`. While both Phase-2 branches
ship in parallel we declare the `Classifier` / `ClassificationResult` /
`TaskComplexity` types verbatim in `src/loop/types.ts` so that the
`phase2/autonomy-loop` branch typechecks and tests independently.

On merge to `main`, the duplicated block at the top of
`src/loop/types.ts` should be deleted and replaced with a re-export from
Agent B's canonical file. Drift between the two copies is a merge bug.
