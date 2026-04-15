# Phase 2 — Integration Notes

Author: Agent C (integration + DoD).
Branch: `phase2/integration` (off `main`, not yet merged back).

## Merge order

1. `phase2/autonomy-loop` → `phase2/integration` (Agent A first — extends
   EventBus union + Orchestrator interface)
2. `phase2/classifier-mcp` → `phase2/integration` (Agent B second)

Both merges landed cleanly — zero conflicts. This is the dividend of
DECISIONS §D3 (EventKind union appended, not re-ordered) and §D4
(`executeOnce` is additive on the Orchestrator).

## Known coordination issue — Classifier type duplication

Resolution: the canonical Classifier contract lives in
`src/classifier/classifier.ts` (Agent B's file). The duplicated block in
`src/loop/types.ts` that shipped on `phase2/autonomy-loop` per DECISIONS §D6
has been removed and replaced with a re-export:

```ts
export type {
  Classifier,
  ClassificationResult,
  ClassifierContext,
  ClassifyOptions,
  TaskComplexity,
} from "../classifier/classifier.js";
```

One `import type` was also added inside `src/loop/types.ts` so the locally
referenced `ClassificationResult` in `FallbackContext` and `LoopResult`
keeps type-resolving. `src/loop/autonomy-loop.ts` and
`src/loop/fallback-strategies.ts` did not need changes — they already
imported from `./types.js` which now re-exports from the canonical source.

Commit: `refactor(loop): consolidate Classifier types into src/classifier (canonical)`
Verification: `tsc --noEmit` clean. No downstream consumer required a
patch.

## Wiring the real Classifier into the AutonomyLoop

New file: `src/loop/loop-factory.ts`. Exposes `createAutonomyLoop()` which
takes the three core deps (orchestrator, registry, bus) and plugs in
production defaults for everything else:

- Classifier via `createClassifier({ mode: 'auto' })` — Haiku when
  `ANTHROPIC_API_KEY` is set, heuristic otherwise.
- Policy — default constructor (all §2.2 predicates enabled).
- Fallback strategies — `defaultStrategies()` (rungs 1–3; 4–7 ship in
  Phase 3).
- `LoopAttemptLog` — lazily constructed when `attemptsDbPath` is passed,
  otherwise the loop still runs without persistence.

The factory is intentionally narrow: it does NOT accept `planFactory` (a
test seam). Production call sites route through `orchestrator.execute()`
as the inner shell; tests use the raw `AutonomyLoop` constructor.

Commit: `feat(loop): wire real classifier via auto factory`

## LoopResult.outcome — new derived field

The Phase 2 DoD asserts `LoopResult.outcome === 'recovered'`. The existing
shape only carried a terminal `state` (DONE | FAILED | ESCALATED) which
cannot distinguish a first-attempt success from a recovery-after-adapt.

Added `outcome: LoopOutcome` ( `'done' | 'recovered' | 'failed' | 'escalated'` ).
`finalize()` now takes `Omit<LoopResult, 'outcome'>` and computes the
descriptor from `state` + attempt history. All existing finalize call
sites are unchanged; no test in `tests/autonomy-loop.test.ts` had to be
updated because it only asserts on `state` today.

Commit: `feat(loop): derive LoopResult.outcome — first-attempt 'done' vs 'recovered'`

## MCP registration (step 6)

Pending manual confirmation: adding the `nchinda` server entry from
`docs/phase-2/mcp-snippet.json` to the repo-local `.mcp.json` required
modifying that file, and the harness denied Write/Edit permission on
`.mcp.json` during this session. The exact fragment to append inside
`mcpServers` is:

```json
"nchinda": {
  "command": "node",
  "args": ["scripts/mcp/serve-nchinda.mjs"],
  "env": { "DATABASE_URL": "postgres://localhost/cortexos" },
  "autoStart": false
}
```

All other Phase 2 MCP work is in place — `scripts/mcp/serve-nchinda.mjs`
ships on this branch, `NchindaTools` + zod schemas ship in
`src/mcp/nchinda-tools.ts`, and the DoD test exercises
`nchinda_remember` end-to-end through the real handler against an
in-memory vector store fake.

Follow-up task: apply the above fragment and commit under
`chore(mcp): expose nchinda_recall + nchinda_remember via local MCP server`.

## Phase 2 DoD test

New file: `tests/phase2-dod.test.ts`. Literal encoding of §6 Phase 2
DoD — "task designed to fail on first attempt recovers via the fallback
chain without asking."

Stack wired:
- `AutonomyLoop` (real) via `createAutonomyLoop()` *and* a direct
  `new AutonomyLoop()` (the direct build gets a `planFactory` test seam).
- `AgentRegistry` (real, in-memory SQLite).
- `createEventBus()` (real, with a `loop_state` subscriber capturing
  emitted transitions).
- `LoopAttemptLog` (real, in-memory SQLite) — asserted to hold the
  `ATTEMPT → ADAPT → DONE` trajectory.
- `HeuristicClassifier` (real, deterministic, no API key).
- `Policy` + full default ladder + a custom `FlakyRecoveryStrategy` that
  throws on first `apply` and succeeds on the second, so both the ladder
  walk AND the loop's resilience-to-throwing-strategies are exercised.
- `NchindaTools.remember` backed by an in-memory vector-store fake so we
  can assert a `recovered`-tagged row lands.

Assertions (all must hold):
- `result.state === 'DONE'`
- `result.outcome === 'recovered'`
- `result.escalation === undefined`
- at least one ADAPT record
- `orchestrator.executeOnce` called exactly twice
- `loop_attempts.byTask(taskId).state` === `['ATTEMPT', 'ADAPT', 'DONE']`
- emitted bus states include ATTEMPT + ADAPT + DONE and NOT ESCALATE
- `vectorStore` has one row tagged `recovered`

Commit: `test(phase2): Definition-of-Done smoke — designed-to-fail task recovers`

## Final test count

144 tests across 11 suites, all green. Broken down:

- Phase 1 baseline (`phase1-dod`, ipc, orchestrator, registry): ~40
- Phase 2 from Agent A (autonomy-loop, fallback-strategies,
  orchestrator-execute-once, policy): ~60
- Phase 2 from Agent B (classifier, nchinda-tools): ~43
- Integration — this branch (`phase2-dod`): 1

`tsc --noEmit` exit 0.

## Decisions taken (in addition to DECISIONS.md)

- **D6 resolution — canonical home for Classifier types** is
  `src/classifier/classifier.ts`. `src/loop/types.ts` re-exports. Do
  not duplicate.
- **D7 — `LoopResult.outcome` is derived, not explicit.** Callers do
  not set it. `finalize()` is the single source of truth. This keeps
  the attempt list and outcome consistent by construction.
- **D8 — `createAutonomyLoop` does not expose `planFactory`.** That
  hook is a test seam and belongs only on the raw constructor.

## What is NOT on this branch (Phase 3 scope)

- Rungs 4–7 of the ladder (`nchinda_ask_peer`, `nchinda_recall` inside
  the loop, `web_search`, `nchinda_escalate`). Tracked in
  DECISIONS §D1.
- RECALL phase is still a no-op state emission. Wiring
  `nchinda_recall` into the loop's RECALL phase is Phase 3.
- Alternate-tool strategy is a placeholder until the tool registry lands.
