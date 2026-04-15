# Phase 2 — Independent Code Review

**Reviewer**: Agent D (test-agent-d, independent review lane)
**Branches under review**:
- `phase2/autonomy-loop` (Agent A) — AutonomyLoop + Policy + FallbackStrategies + loop_attempts DB
- `phase2/classifier-mcp` (Agent B) — Classifier (Haiku + heuristic) + `nchinda_*` MCP tools + stdio MCP server
- `phase2/integration` (Agent C) — merge target for the two above
**Spec of record**: `docs/NCHINDA_PLAN.md` §1.1-1.8, §2, §2.1, §2.2, §5.1, §6 (Phase 2)
**Reference doc**: `docs/phase-2/DECISIONS.md` (Agent A)

---

## 1. Verdict

**SHIP WITH FIXES.**

Both builders delivered substantial, well-structured work that meets the
Phase 2 DoD when composed via `phase2/integration`. Agent A's loop is a
genuine state machine (not a shallow retry) with observable transitions,
pluggable strategies, and clean injection seams. Agent B's classifier is
defensive (zod validation, timeout + abort, heuristic fallback on every
LLM error class) and the `nchinda_*` MCP handlers are input-validated at
the boundary with no silent catches. All 143 tests pass on
`phase2/integration`. The deferral of ladder rungs 4–7 to Phase 3 is
documented in `DECISIONS.md §D1` and is genuinely tracked, not abandoned.

Before merging to `main` we want three targeted fixes (see §8): (1) an
irreversible-action gap in `Policy` — `git push --force-with-lease` is
matched but regular `git push` + deploy verbs in imperative form ("ship
to prod") slip past some patterns; (2) the two empty catches in
`AutonomyLoop.walkLadder` swallow strategy crashes silently with no
event emission; (3) the Haiku classifier's raw `content-type` header
sends the API key via `x-api-key` but there's no redaction on the
fallback-rationale string (it prepends raw HTTP error text, which could
in principle echo back a quoted header — low risk but trivial to fix).

## 2. Scorecard (1-5)

| Dimension | Score | Notes |
|---|---|---|
| Correctness | 4 | State machine matches §2 diagram; all transitions emit on `loop_state`. One real bug: `lastError` short-circuits irreversible-action detection when task already triggered it once — see §5. |
| Security | 4 | zod everywhere at boundaries. Prepared statements. API key env-only. Timeout + abort on Haiku. Minor gaps in irreversible-table coverage (§4). |
| TypeScript rigor | 5 | Zero `any` in Phase 2 code. Discriminated unions for `LoopState`. All public interfaces typed. Readonly arrays where appropriate. |
| Test quality | 5 | 143 tests pass; real assertions against real state; explicit failure paths covered; DoD recovery test present (3-attempt→recover via rung-1). |
| Design | 4 | Clean DI, pluggable strategies, `FakeOrchestrator` seam exists in real Orchestrator (`executeOnce`). One smell: `Policy` class's `shouldEscalate` order-dependence on checks (credential-touch before budget before strike) isn't documented in types. |
| Spec adherence | 5 | §2 state diagram 1:1. §2.1 rungs 1–3 shipped with names matching plan. §2.2 rules: 3-strike ✓, irreversible ✓, credentials ✓, budget ✓. D1/D6 honored. |
| Performance | 4 | Good: lazy boot in MCP server, prepared statements, in-memory DB for tests. Watch: `executeOnce` uses `Promise.all` for executor waits (correct), no N+1. Classifier round-trip capped at 8s. |

## 3. Spec Drift Check (§6 Phase 2 DoD)

_TBD._

## 4. Security Pass

_TBD._

## 5. Correctness Deep-Dive

_TBD._

## 6. Test Quality Audit

_TBD._

## 7. Design Smells

_TBD._

## 8. Top 3 Patches Before Merging to `main`

_TBD._

## 9. Follow-ups for Phase 3

_TBD._
