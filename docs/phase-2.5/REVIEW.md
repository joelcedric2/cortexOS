# Phase 2.5 Code Review — Agent D

**Scope**: Independent review of the Karpathy auto-research loop (§2.3 of
`docs/NCHINDA_PLAN.md`). Read-only across:

- `phase2.5/research-loop` (Agent A) — H→P→R→B loop, MCP tool, zod schemas, probe executors
- `phase2.5/researcher-role` (Agent B) — BriefStore, orchestrator detour, designer recall,
  controller wiring
- `phase2.5/integration` (Agent C) — merge in flight

This file is the single artifact. No source edits.

## 1. Verdict

**`ship-with-fixes`** — the H→P→R→B loop is real science, not retry-in-a-
trench-coat. Agent A shipped a properly structured Karpathy loop with
Bayesian posterior normalization, per-call + overall AbortController
budgeting, fail-safe Brief contract, redacted error labels, and a
pluggable `ProbeExecutor` interface. Agent B's BriefStore + Designer
recall + researcher-detour close the "role vs tool" duality that plan
§2.3 demands. Agent C resolved the stub conflict cleanly in
`be04941` — the temporary `_research-stub.ts` is gone, imports were
redirected, and all 189 tests remain green on `phase2.5/integration`.
Blocking issues are cosmetic (orchestrator.ts is 731 LOC, over the
500-line rule) and spec-drift around multi-probe-per-hypothesis (only
1:1 modelled; `maxProbes` is telemetry-only). Nothing security-grade
is unsafe. Fix the top-3 patches below and merge.

## 2. Scorecard (1–5)

| Dimension | Score | Notes |
|---|---|---|
| Correctness | 4 | Budget abort works (verified by 50ms deadline test), posteriors normalized, fail-safe Brief always round-trips through `BriefSchema.parse`. One gap: `ResearchOptions.task_id` accepted but never emitted on events. |
| Security | 4 | API key env-only, redacted reason labels, zod at every boundary, JSON.stringify on brief content (no eval). Prompt-injection surface in Designer recall is theoretical (briefs come only from our own Haiku) but worth noting. |
| TypeScript rigor | 5 | Zero `: any`, no silent catches, every Haiku response runs through a zod `.parse(...)`, fallback shape is validated against `BriefSchema` (not just typed). |
| Test quality | 4 | 189 pass; probe parallelism tested via spy; redaction test asserts `sk-ant` never leaks; budget test asserts wall-clock < 1s under a 50ms budget. Missing: no test verifies the Haiku `user` prompt actually contains the hypothesis data (input verification) — tests mostly verify outputs. |
| Design | 3 | `orchestrator.ts` at 731 LOC violates the <500-line rule. Researcher detour carved in-line rather than as a `ResearcherExecutor` strategy. `_research-stub.ts` was the right seam but leaked through test fixtures until Agent C fixed it. |
| Spec adherence (§2.3) | 4 | All six steps land (H, DP, E, U, B, PERSIST), role + tool duality ships. Drift: DESIGN_PROBES collapsed into HYPOTHESIZE (Haiku returns `{h, prior, probe}` in one call), and `maxProbes` is telemetry, not executed. Plan §2.3 allows this interpretation but doesn't demand it. |
| Performance | 4 | Probes run `Promise.all`. Haiku calls are sequential (H → E → U → B = 3 serial calls) — fine per plan, but a `deep` 5-hypothesis run still bottlenecks on the single UPDATE call. |

## 3. Spec drift (§2.3 diagram walk)

_TBD_

## 4. Security pass

_TBD_

## 5. Correctness deep-dive

_TBD_

## 6. Test quality

_TBD_

## 7. Design smells

_TBD_

## 8. Top 3 patches before main-merge

_TBD_

## 9. Follow-ups for Phase 3

_TBD_
