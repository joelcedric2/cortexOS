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

Walking the plan's ASCII diagram step-by-step against
`src/research/research-loop.ts`:

**Step 1 — HYPOTHESIZE (3–5 explanations, each with prior 0..1)**
→ Honored. `hypothesizePrompt` asks for `{h, prior, probe}` with
`prior: z.number().min(0).max(1)` validated by `HypothesisSeedSchema`.
Cap enforced by `seeds.hypotheses.slice(0, maxHypotheses)` — defends
against a chatty Haiku. Structured-output via strict JSON prompt +
zod parse, not tool-call; acceptable because Haiku messages API doesn't
expose tool-use guarantees here, and the fail-safe covers malformed
output. **Status: ✅ match.**

**Step 2 — DESIGN PROBES (one probe per hypothesis, cheap + parallelizable)**
→ Partial. The probe is emitted inside the HYPOTHESIZE call as the
`probe` field of each seed — it's not a separate Haiku call. That's a
cost-saving collapse; §2.3 doesn't forbid it, and DECISIONS.md D1 calls
this out. The shortcut means Haiku can't refine a probe based on
self-review of the hypothesis set. Minor drift; not blocking.
`maxProbes > 1` is accepted in the options but never consumed — it's
telemetry-only (line 373 emits it on the bus). **Status: ⚠️ collapsed
into step 1; `maxProbes` is dead until Phase 3.**

**Step 3 — EXECUTE IN PARALLEL**
→ Honored. `Promise.all(hypotheses.map(async h => ...))` at line 374.
`ProbeExecutor` is a real pluggable interface: `canRun` /`run`, with
`echoExecutor` as catch-all fallback (so no probe deadlocks). Tests
verify parallelism via the spy executor. **Status: ✅ match.**

**Step 4 — UPDATE BELIEFS (Bayesian posterior = prior × likelihood)**
→ Honored. Line 406: `h.prior * score.likelihood`. Then normalized
across all posteriors (line 414: `posteriors[i]! / sum`) so the array
is a proper distribution. Zero-total fallback to 0 is correct.
Verdicts round-trip via `HypothesisVerdictSchema`. **Status: ✅ match.**

**Step 5 — BRIEF (consolidation + zod validation)**
→ Honored. Third Haiku call, `BriefDraftSchema` validated, then the
full Brief built from `{question, hypotheses, winning, draft.*,
confidence}` and run through `parseBrief` (= `BriefSchema.parse`).
Even the fail-safe path runs through `BriefSchema.parse` (line 459)
so contract drift is caught at dev time. **Status: ✅ match.**

**Step 6 — PERSIST (`research_brief` tag in pgvector)**
→ Honored. `src/research/brief-store.ts::persist` sets
`taskType: "research_brief"`, tags `["research_brief", task_id,
session_id?]`, embeds a composed summary, stores the full Brief JSON
in `content`. Orchestrator's researcher detour calls this after
`runResearch` returns (orchestrator.ts:518-527). **Status: ✅ match.**

**Designer recall (briefs surface on similar future questions, ≥ 0.5)**
→ Honored. `Orchestrator.buildPriorResearchSection` calls
`briefStore.recall(task, 3, 0.5)` and injects a `## Relevant prior
research` block into the Designer's planning prompt.
`designer-recall.test.ts` verifies the actual prompt text contains
the injected section (not just that the recall method was called) —
good. **Status: ✅ match.**

**Role vs Tool duality (§2.3 "When to use" matrix)**
→ Both shipped: the `nchinda_research` MCP tool
(`src/mcp/research-tool.ts`, registered in `tool-schema.ts` and
dispatched in `scripts/mcp/serve-nchinda.mjs`), and the `researcher`
role detour in `orchestrator.spawnExecutor → runResearcherDetour`.
Case-insensitive role detection (`"researcher" | "ai-ml-researcher"`)
has explicit test. **Status: ✅ match.**

## 4. Security pass

**API key handling (`runResearch`)**
- Read from `opts.apiKey ?? process.env.ANTHROPIC_API_KEY` (line 292).
  Never hardcoded, never logged. Missing-key path throws before fetch
  (line 216). **✅ clean.**
- Key travels in `x-api-key` header only; never in the user prompt or
  returned Brief. **✅ clean.**

**Budget enforcement**
- Per-call 8s `AbortController` + overall `timeBudgetMs`
  `AbortController`; outer signal is wired into each per-call controller
  via `addEventListener("abort", onOuterAbort, { once: true })` and
  cleaned up in `finally`. A stuck fetch cannot outlive the budget.
- Verified by `runResearch — budget enforcement` test: 50ms budget +
  5s fetch → completes in <1s with `recommended_action:
  'research-failed'`. **✅ real, tested.**

**Error / reason redaction**
- `redactReason` maps raw error text to one of 8 safe labels
  (`timeout`, `rate-limited`, `server-error`, `client-error`,
  `parse-error`, `schema-mismatch`, `network`, `budget-exceeded`,
  `unknown`). The `research_brief_emitted.reason` field only ever
  carries these labels.
- Verified by `runResearch — redaction` test: raw `sk-ant-super-secret`
  in the error message is NEVER on the event payload. **✅ real, tested.**

**MCP `nchinda_research` input validation**
- `ResearchInputSchema` (zod) at `research-tool.ts:25`: `question` must
  be `string().min(1)`, `depth` constrained to enum, `timeBudgetMs`
  clamped to `[1_000, 600_000]` (1s..10min). The cap is a real DoS
  guard: a hostile caller can't set `timeBudgetMs: 10**9`. **✅ clean.**
- Maximum cost per call: `depth=deep` with 5 hypotheses, 3 Haiku
  messages, each 1024 `max_tokens` → bounded. No loop that could
  multiply hypothesis counts. **✅ bounded.**

**`brief-store.persist`**
- Content is `JSON.stringify(brief)` — plain text, no eval path on
  recall. `safeParseBrief` uses `JSON.parse` with a narrow shape check,
  catches syntax errors, returns `null` on corruption (no throw into
  call site). **✅ clean.**

**Designer recall injection (prompt-injection surface)**
- Recalled Brief content lands in the Designer's system/planning prompt
  verbatim via `buildPriorResearchSection`. Today, Briefs are only
  written by the in-process detour (output of our own Haiku), so the
  attack surface is limited to Haiku emitting hostile content that
  later influences the Designer's plan. Not a live exploit, but
  **⚠️ caution**: if Phase 3 adds user-authored briefs or skill-brief
  imports, this becomes a real prompt-injection vector. Recommend
  marking recalled content with an explicit `<prior-research>...
  </prior-research>` fence the Designer is told not to trust for tool
  authorization.

**Logging hygiene**
- Orchestrator's detour logs `[CortexOS] ${agentId} (researcher) →
  inline (no tmux)` — no secrets, no full Brief. Error paths redact via
  `err instanceof Error ? err.message : String(err)`; the message could
  still contain sensitive pieces, but the only upstream callers here
  are Haiku errors already wrapped through `redactReason`. **✅ acceptable.**

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
