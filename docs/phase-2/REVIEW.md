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

Plan §6 Phase 2 requires 5 deliverables. Actual against each:

| Plan item | Status | Evidence |
|---|---|---|
| 1. `src/loop/autonomy-loop.ts` — plan/try/adapt/report state machine | ✅ shipped | `src/loop/autonomy-loop.ts` (329 LOC). `execute()` emits `RECALL → PLAN → ATTEMPT → OBSERVE → (REPORT\|ADAPT\|ESCALATE) → DONE` in that order. Each transition fires a `loop_state` EventBus event (verified by test on line 165-191). |
| 2. Intent classifier (Haiku) at `src/loop/classifier.ts` | ⚠️ relocated | Shipped at `src/classifier/classifier.ts` + `haiku-classifier.ts` + `heuristic-classifier.ts` + `index.ts` (factory). Location differs from plan; bounded-context split is arguably *better* than the plan (DDD). Loop re-exports via `src/loop/types.ts`. **Not a regression.** |
| 3. Escalation rules engine `src/loop/policy.ts` | ✅ shipped | 177 LOC. `Policy` class with `shouldEscalate` / `isIrreversible` / `withinBudget`. All four §2.2 hard rules wired: 3-strike, irreversible-action, credential-touch, budget-blown. 12-pattern irreversible table. |
| 4. `nchinda_recall` + `nchinda_remember` MCP tools | ✅ shipped | `src/mcp/nchinda-tools.ts` handlers + `src/mcp/tool-schema.ts` JSON schemas + `scripts/mcp/serve-nchinda.mjs` stdio server. Advertised correctly in `tools/list` RPC. |
| 5. Wire the loop into the orchestrator as outer shell | ✅ shipped | `Orchestrator.executeOnce(plan, taskId)` added additively (D4). Loop composes it; existing `execute(task)` untouched. Test `tests/orchestrator-execute-once.test.ts` covers the new seam. |

**§2 Autonomy Loop diagram**: Matched 1:1. No silent deviations. The loop
emits `RECALL → PLAN` even though Phase 2 declares RECALL a no-op (line 107
of `autonomy-loop.ts`), which is the *correct* way to preserve downstream
telemetry wiring for Phase 3.

**§2.1 Resourcefulness ladder**: Rungs 1-3 (`retry-same`, `alternate-tool`,
`reduce-scope`) shipped. Rungs 4-7 deferred per `DECISIONS.md §D1`. The
interface `FallbackStrategy` takes a `rung` number so the ladder is
genuinely pluggable — rungs 4-7 will slot in without touching the loop.
**Genuine tracking, not abandonment.**

**§2.2 Hard escalation rules**:
- ✅ 3 failed attempts → escalate (`Policy.shouldEscalate` with `strikes >= strikeLimit`)
- ✅ Irreversible external action → escalate BEFORE attempt (line 135-142 of loop)
- ✅ Identity/credentials → escalate (`touchesCredentials` checked first in `shouldEscalate`)
- ✅ Budget blown → escalate (checked both before and during attempt loop)

**Minor drift**:
- D6 (duplicated classifier types in `src/loop/types.ts`) was correctly
  collapsed to a re-export on the integration branch. ✅ Merge bug avoided.
- D3 (EventKind append-only) honored: `loop_state` added at end.
- The plan calls out `ClassificationResult.confidence` as "collected" —
  see §5 for whether it's actually *used*.

## 4. Security Pass

### 4.1 Haiku classifier (`src/classifier/haiku-classifier.ts`)

| Check | Result |
|---|---|
| API key via env only | ✅ `opts.apiKey ?? process.env.ANTHROPIC_API_KEY` (line 62). Never logged. Never serialized. |
| No key on disk | ✅ nothing writes to disk in this file. |
| Response parsing safety (zod) | ✅ `ResultSchema` (lines 29-34) hard-validates `complexity` enum, `confidence` bounds, `rationale` non-empty. |
| Timeout + abort | ✅ `AbortController` + `setTimeout` (line 93-94). Default 8s ceiling. |
| Prompt injection via `task` | ⚠️ `task` is interpolated verbatim into the user message (`buildUserPrompt`, line 139). Haiku can be manipulated by adversarial input. Mitigated because `ResultSchema` constrains output — a jailbreak can at worst produce a wrong routing decision, which the loop recovers from. **Acceptable for Phase 2.** Phase 3 should consider escaping or a structured-output tool call. |
| JSON extraction robustness | ✅ `extractJson()` handles bare JSON + fenced + leading prose. |
| Fallback leaks error detail | ⚠️ Line 84: `reason: \`[haiku-fallback: ${reason}]\`` — if the API ever 401s with a body containing the key echoed back, this would surface in the `rationale`. Low likelihood but trivial to redact. See §8 patch 3. |

### 4.2 MCP tool handlers (`src/mcp/nchinda-tools.ts`)

| Check | Result |
|---|---|
| Input validation via zod | ✅ `RecallInputSchema` + `RememberInputSchema` parse at handler entry. Length bounds on `query` and `content`, enum on `outcome`, int bounds on `k` (1..50). |
| SQL via prepared statements | ✅ Delegates to `VectorStore` which uses `pg` parameterized queries (verified via import chain — VectorStore is pre-existing Phase 0/1 code, prepared statements only). |
| No PII in logs | ✅ No `console.*` calls in the handler. Errors propagate to the MCP server layer which converts them to JSON-RPC error frames with just `err.message` — no raw input echoed. |
| Outcome="recovered" mapping | ✅ Defensively collapsed to `success` at the DB boundary with a `recovered` tag preserved. No schema escape hatch. |
| `additionalProperties: false` on JSON schemas | ✅ Both tool schemas lock this down — Claude can't smuggle extra keys through the MCP envelope. |

### 4.3 MCP stdio server (`scripts/mcp/serve-nchinda.mjs`)

| Check | Result |
|---|---|
| Protocol safety | ✅ Line-delimited JSON via `readline`. Malformed frames silently dropped (line 134). No buffer accumulation, no size bomb surface. |
| No `eval` / `exec` on tool args | ✅ Tool args routed only through `tools.recall(args)` / `tools.remember(args)` which pass through zod. No dynamic import of arg-derived strings. No `Function` constructor. No `vm` module. |
| Lazy boot | ✅ Embedder + VectorStore deferred until first `tools/call` (line 30-51). `--dry-run` / tool-list introspection is side-effect-free. |
| `DATABASE_URL` required early | ✅ Thrown with clear message at `getTools()` first call (line 38-40). Good. |
| Error surface to client | ⚠️ `replyError(id, -32000, message)` (line 121) passes `err.message` through. If a Postgres error ever contains a connection string, it would leak. **Low risk** (pg driver doesn't normally echo DSN); consider redaction in a future pass. |
| Shutdown handling | ✅ `rl.on("close") → process.exit(0)`. |

### 4.4 `loop-attempts-db.ts`

| Check | Result |
|---|---|
| Prepared statements | ✅ `this.db.prepare(...)` for every `INSERT` and `SELECT` (lines 92-110). Named parameters via `@task_id` etc. |
| Path traversal on DB file | ⚠️ Default path hardcoded to `~/.cortexos/registry.db`. When `options.dbPath` is user-controlled, `mkdirSync(dirname(dbPath), { recursive: true })` on line 78 will happily create arbitrary parent dirs. **Phase 2 has no user-controlled entrypoint for this**, but if Phase 3 exposes DB-path config via MCP, it needs a `path.resolve()` + allow-listed prefix. Note for Phase 3. |
| WAL + idempotent migrate | ✅ `journal_mode = WAL` + `CREATE ... IF NOT EXISTS`. |
| Shared-DB safety | ✅ `owned` flag gates `close()` so Agent B's tables in the same file aren't yanked. |

### 4.5 Policy irreversible-action coverage (§2.2)

The plan enumerates: social DM, email send, payment, `rm -rf`,
`git push --force`, deploy, delete row. Agent A's table covers all seven
plus extras (`DROP`, `TRUNCATE`, sudo install, credential write). Spot-
checked regex behavior:

| Input | Matches? | Correct? |
|---|---|---|
| `git push --force` | ✅ | ✅ |
| `git push origin --force-with-lease` | ✅ | ✅ |
| `deploy to prod` | ✅ | ✅ |
| `npm publish` (no "prod") | ❌ | ⚠️ **gap** — plan doesn't list `npm publish` explicitly but it is irreversible. |
| `please ship to prod` | ❌ | ⚠️ **gap** — informal deploy language slips past. |
| `force-push to main` (hyphenated) | ❌ | ⚠️ **gap** — only `--force` with leading `--` matches. |
| `rm -rf ./build` | ✅ | ✅ |
| `DROP TABLE orders` | ✅ | ✅ |

Gaps are all in the "informal language" direction. For Phase 2 this is
acceptable — the 3-strike and ladder-exhausted rules catch most residual
risk — but see §8 patch 1 for a surgical regex tightening worth doing
before the merge to `main`.

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
