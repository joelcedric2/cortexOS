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

**Budget propagation → fetch**
- `runResearch` creates `outer = new AbortController()`; `budgetTimer =
  setTimeout(() => outer.abort(), timeBudgetMs)`. Each Haiku call
  creates its own `perCall = new AbortController()` and both the per-
  call 8s timer AND the outer signal's abort event call
  `perCall.abort()`. The fetch receives `perCall.signal`. Chain is
  complete.
- Verified: the 50ms budget + 5s fetch test completes in <1s. **✅**

**`ProbeExecutor.canRun` tie-breaking**
- `runResearch` uses `executors.find((ex) => ex.canRun(h.probe)) ??
  echoExecutor` (line 377). First match wins; echo is the implicit
  catch-all inside the loop.
- The separate `runProbe` helper (probe-executors.ts:37) does the
  same ordering but falls through to `echoExecutor` explicitly at the
  end. Both paths converge on the same semantics: **no probe ever
  goes unmatched**. Tested in `probe-executors.test.ts`. **✅**

**Researcher detour + Registry audit trail**
- Detour builds a virtual negative slot (`slot = -(this.agentIds.size +
  1)`) so it cannot collide with a real tmux slot. Good.
- Registry IS updated: `spawn(...)` with `tmux_session:
  'inline:researcher:${agentId}'` (no real session), then
  `markRunning` before `runResearch`, `markDone` after, `markError` on
  failure. Full audit trail preserved. Spawner is NOT called — no tmux
  pane, no CLI. **✅ matches "no pane, yes registry row" expectation.**

**Brief recall threshold**
- Hard-coded `0.5` at the call site
  (`orchestrator.ts:349: briefStore.recall(task, 3, 0.5)`). Not a
  CortexConfig field, not an env var. Follow-up #3 below suggests
  threading it through. **⚠️ minor.**

**Stub cleanup (Agent C integration)**
- Verified: `src/research/_research-stub.ts` no longer exists on
  `phase2.5/integration` after commit `be04941`. Imports in
  `brief-store.ts`, `orchestrator.ts`, and the three B tests all now
  point at `./brief-schema.js` (for `Brief`) and `./research-loop.js`
  (for `runResearch`). `tsc --noEmit` is clean; `npm test` reports
  189 passing. **✅ fully resolved.**
- `tests/brief-store.test.ts::SAMPLE_BRIEF.hypotheses[0]` was rewritten
  to use A's real `{h, prior, probe, verdict, ...}` shape — so the
  tests now exercise the actual contract, not a ghost schema. **✅**

**`task_id` forward-wiring**
- `ResearchOptions.task_id` is accepted (line 73) and passed by the
  orchestrator detour (line 510), but the loop doesn't thread it into
  the `plan_emitted` or `research_brief_emitted` event payloads. The
  field is a no-op today. Not blocking — documented as reserved — but
  means Mission Control can't yet correlate a Brief back to its task
  via bus events alone. **⚠️ follow-up.**

## 6. Test quality

189 tests total pass; Phase 2.5 adds 18 (Agent B) + 14 (Agent A) = 32.

**Strong points**
- `runResearch — redaction` test asserts `sk-ant` and internal hostname
  do NOT appear in the event payload. Real negative assertion.
- `runResearch — budget enforcement` asserts wall-clock <1s, confirming
  the AbortController actually propagates rather than just returning a
  "research-failed" Brief after the timer runs to completion.
- `probe-executors.test.ts::picks first matching executor in order`
  uses a `seen: string[]` side-effect to verify the second executor
  was NOT called — real parallelism/ordering assertion.
- `designer-recall.test.ts::injects a 'Relevant prior research'
  section` uses `assert.match(prompt, /## Relevant prior research/)` —
  verifies the actual injected prompt text, not a mock call log.
- `researcher-role.test.ts::mixed plan: researcher inline; coder spawns
  tmux and awaits done` verifies both paths coexist and `spawnCalls`
  only records the coder.

**Gaps**
- No test verifies the Haiku **input** prompts — e.g. that the score
  prompt actually contains `JSON.stringify(result)` for each triple.
  Tests mock `fetchImpl` to verify the response path, not to pluck the
  `init.body` and assert content. Easy fix with the existing
  `scriptedFetch.onCall` callback (already present but unused in most
  tests).
- No test for the `executors.find(...) ?? echoExecutor` fallback in
  `runResearch` itself (it's tested at the standalone `runProbe`
  layer, but not inside the loop).
- `researcher-role.test.ts::passes depth=normal when max_minutes <= 3`:
  the cutoff is "max_minutes > 3" → deep (strict greater). At exactly
  3 it's normal. Behaviour is tested for 2 (normal) and 5 (deep) but
  not the boundary 3. Off-by-one edge uncovered.
- No "passes by accident" cases spotted. Assertions are specific
  (`assert.equal(brief.winning, "TLS cert expired")`, not just
  "defined").

## 7. Design smells

- **`orchestrator.ts` = 731 LOC.** Exceeds the 500-line rule from
  `CLAUDE.md`. The researcher-detour method (`runResearcherDetour`,
  ~85 lines) is a natural extraction point into
  `src/orchestrator/researcher-executor.ts`. Same for `resolvePlanRole`
  / `inferDonePolicy` / `isResearcherRole` → a `plan-role-resolver.ts`.
  **⚠️ blocker for the <500 LOC rule but non-blocking for correctness.**
- Bounded-context check: `src/research/*` does NOT import
  `src/orchestrator/*`. Correct direction — orchestrator depends on
  research, not vice versa. **✅**
- `src/research/brief-store.ts` depends on `memory/vector-store` +
  `memory/embedder`; that's a leaf dependency, fine.
- Dead code: `_typeGate` at the bottom of
  `tests/research-loop.test.ts` (lines 366-369) is a leftover type
  anchor. Harmless. Remove during cleanup pass.
- The `researcher` plan role aliases to `ai-ml-researcher`
  (`AgentRole`), but the detour uses a fixed `researcherRole: AgentRole
  = "ai-ml-researcher"` locally. Slight duplication — `resolvePlanRole`
  already has this mapping.
- `runResearcherDetour` returns `null` on `runResearch` throw, but
  `runResearch` is documented as never throwing (fail-safe Brief). The
  try/catch is defensive but unreachable in practice. Non-blocking.
- `emit("EXECUTE_PROBES", { count, maxProbes })` emits `maxProbes`
  which is currently dead (see §3). Keep but comment the intent.

## 8. Top 3 patches before main-merge

1. **Split `orchestrator.ts` (731 LOC → <500)**
   Extract `runResearcherDetour` into
   `src/orchestrator/researcher-executor.ts`, export it from a namespace
   the main `Orchestrator` composes. Same shape, less mass. The
   CLAUDE.md rule is explicit; shipping 731 LOC in a file sets the
   wrong precedent for Phase 3.

2. **Thread `task_id` into `research_brief_emitted` events**
   `ResearchOptions.task_id` is accepted but ignored by the loop.
   Wire it into the two `bus.emit({ kind: 'research_brief_emitted',
   task_id, payload: ... })` sites (success path line ~442, fail path
   in `failBrief`). Without this, Mission Control can't correlate a
   Brief back to the originating task via events alone — the
   event-sourcing contract §1.6 asked for is half-wired.

3. **Configurable brief-recall threshold + input-verification tests**
   (a) Move the `0.5` similarity cutoff from the orchestrator call site
   into `CortexConfig` (or an `OrchestratorDeps.briefRecallThreshold`
   with a 0.5 default) so the knob is visible without a code change.
   (b) Add one test per Haiku call that uses `scriptedFetch.onCall` to
   assert the outbound `init.body` actually contains the hypothesis
   data (not just that we parsed the response). Closes the
   "tests only verify outputs" gap in §6.

## 9. Follow-ups for Phase 3

- **Real `web_search` probe executor** — swap `webSearchStub` for a
  Tavily / Brave adapter, or a CDP-driven Google fallback. Interface
  is stable; drop-in replacement.
- **Real `shell` probe executor** — sandboxed `child_process.exec`
  with jailed cwd, tight env (`PATH`, no secrets), no network, and a
  per-probe timeout. Gate behind a capability flag so researchers must
  opt in.
- **Multi-probe-per-hypothesis (§2.3 `deep` = 5 × 2)** — lift
  `maxProbes` from telemetry to actual dispatch: emit `[probe, verify-
  probe]` pairs and `Promise.all` them alongside the base probe.
  Requires extending `HypothesisSeedSchema` to `probes: string[]`.
- **Research cache** — same question asked twice within N minutes
  reuses the last Brief (keyed by `normalize(question)`). Drop into
  `BriefStore` as `recallExact(question, maxAgeMs)`. Saves 3 Haiku
  calls + wall-clock per repeat.
- **Per-role research budget** — `budget.max_research_minutes` on
  `PlanAgent`, enforced by the detour and MCP tool. Currently the loop
  is bounded per-call; roles aren't.
- **Prompt-injection fence around recalled briefs** — wrap the
  `## Relevant prior research` block in an explicit
  `<prior-research>...</prior-research>` fence with a prompt-level
  instruction not to treat recalled content as tool-authorization.
  Cheap belt-and-suspenders once multi-author briefs appear.
- **Second Haiku pass for DESIGN_PROBES** — if we see Haiku emitting
  lazy probes (just restating the hypothesis), re-introduce the
  separate design step. Currently collapsed for cost; watch telemetry.
- **`task_id` in event payloads (also in top-3 §8)** — Phase-3 must
  ship this if Mission Control's journal is going to correlate
  research activity to the autonomy loop's attempts.
