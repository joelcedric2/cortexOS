# Phase 2.5 — Integration Notes

**Integrator**: Test Agent C
**Branch**: `phase2.5/integration`
**Merged branches**:
- `phase2.5/research-loop` (Agent A, 6 commits) — H→P→R→B loop, MCP tool, probe executors, Brief schema, 14 tests, `research_brief_emitted` EventKind
- `phase2.5/researcher-role` (Agent B, 4 commits off `main`, not rebased on A) — BriefStore persistence + recall, orchestrator detour for role=researcher, Designer recall injection, controller wiring, 18 tests

## Merge order

1. **Branched from `main`** (`ab88e9f`).
2. **Merged `phase2.5/research-loop`** (`--no-ff`). Clean merge; A's files live under `src/research/` + `src/mcp/` + `tests/` and don't overlap `main`. Post-merge baseline: 171 tests green.
3. **Merged `phase2.5/researcher-role`** (`--no-ff`). Also a clean file-level merge — A and B touched disjoint paths under `src/research/`. But B's code still imported from the temporary `src/research/_research-stub.ts` (intentional; pre-integration contract-matching shim).

## Conflicts & fixes

### Stub elimination

`src/research/_research-stub.ts` — **deleted**. All imports redirected:

| Consumer | Was | Now |
|---|---|---|
| `src/research/brief-store.ts` | `import type { Brief } from "./_research-stub.js"` | `import type { Brief } from "./brief-schema.js"` |
| `src/orchestrator/orchestrator.ts` | `import { runResearch } from "../research/_research-stub.js"` | `import { runResearch } from "../research/research-loop.js"` |
| `tests/brief-store.test.ts` | same stub Brief import | `./brief-schema.js` |
| `tests/designer-recall.test.ts` | same | `./brief-schema.js` |
| `tests/researcher-role.test.ts` | same | `./brief-schema.js` |

### Hypothesis shape mismatch

A's canonical `Hypothesis` schema (`src/research/brief-schema.ts`):

```ts
{ h: string; prior: number; probe: string; result?: string; posterior?: number; verdict: "confirmed"|"falsified"|"inconclusive" }
```

B's stub used a throwaway `{ id, claim, evidence_for[], evidence_against[], confidence }`. Only one test (`tests/brief-store.test.ts` `SAMPLE_BRIEF`) had a non-empty hypothesis — rewritten to match A's shape (h/prior/probe/result/posterior/verdict). B's other two tests used `hypotheses: []`, which is TS-legal against A's schema (empty array passes `z.array(...).min(1)` at compile time via `z.infer`; this test never runs zod validation on the sample — it only round-trips it through BriefStore's JSON layer, which duck-types).

### `runResearch` signature alignment

B's call site: `runResearch(planAgent.task, { depth, bus, task_id })`.
A's `ResearchOptions` did **not** carry a `task_id` field.

**Fix**: added optional `task_id?: string` to A's `ResearchOptions` (documented as "reserved for future `research_brief_emitted.task_id` wiring; accepted but not emitted"). Cleaner than dropping it from B's call site — B's intent was traceability, and the field is now a no-op hook we can light up later.

The rest of B's opts (`depth`, `bus`) matched A's interface exactly.

### EventKind

Only A touched `src/ipc/event-bus.ts` (appended `research_brief_emitted`). B didn't. No conflict.

## Phase 2.5 Definition-of-Done smoke

`tests/phase2.5-dod.test.ts` (2 tests, both passing).

Wiring:
- real `Orchestrator` shell (Claude Code spawn faked via `FakeController` — we aren't testing the tmux/Designer interaction)
- real `BriefStore` with in-memory `FakeVectorStore` + `FakeEmbedder`
- real `EventBus`
- real `runResearch` driven by a scripted fetch (mocked Haiku)

Tests:
1. **researcher plan → H→P→R→B → Brief persisted + events emitted**
   - Plan carries `role: "researcher"` → Orchestrator detours (only the Designer slot gets spawned; the researcher runs in-process).
   - Brief persisted via BriefStore: `FakeVectorStore` received `storeMemory` tagged `research_brief`; embedder received a summary carrying `sqlite` + `registry`.
   - Bus saw all four emitted phases (`HYPOTHESIZE`, `EXECUTE_PROBES`, `UPDATE_BELIEFS`, `BRIEF`) + a single `research_brief_emitted` with `winning` + `confidence` in its payload.
2. **second Designer run recalls the prior Brief into its system prompt**
   - First run persists; `similarityMap[storedId] = 0.92` forces a match on recall (FakeEmbedder returns zero vectors, so cosine → 0 without the override).
   - Second run's planning prompt contains `## Relevant prior research` with the recalled question + winner + recommendation.

### Emitted-phase note

The plan (§2.3) names **five** phases: HYPOTHESIZE, DESIGN_PROBES, EXECUTE_PROBES, UPDATE_BELIEFS, BRIEF. A's loop collapses HYPOTHESIZE + DESIGN_PROBES into a single Haiku call and only emits four `plan_emitted` events. The DoD test asserts the **four that actually appear on the bus** — matching shipped behaviour. `DESIGN_PROBES` still lives in the `RESEARCH_PHASES` constant in `brief-schema.ts` for future wiring.

## Final test count

| Milestone | Count |
|---|---|
| `main` (pre-Phase-2.5) | 157 |
| + `phase2.5/research-loop` merge | 171 (+14) |
| + `phase2.5/researcher-role` merge + stub kill | 189 (+18) |
| + `tests/phase2.5-dod.test.ts` | **191 (+2)** |

- `tsc --noEmit`: exit 0
- `npm test`: 191 tests, 27 suites, 0 failing, 0 skipped

## Commits on `phase2.5/integration`

1. `a9f39c4` — merge(phase2.5): research-loop branch
2. `beb0a76` — merge(phase2.5): researcher-role branch — pre-resolution
3. `82d429c` — docs(phase-2.5): seed REVIEW.md skeleton *(Agent D — not mine)*
4. `be04941` — fix(phase2.5): integrate research-loop with researcher-role, drop stub
5. `3bcb281` — test(phase-2.5): Definition-of-Done smoke — H→P→R→B + BriefStore recall
6. *(this commit)* — docs(phase-2.5): INTEGRATION_NOTES

## DoD: **met**.
