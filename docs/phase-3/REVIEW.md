# Phase 3 Code Review — Test Agent D

**Reviewer**: Test Agent D (independent, read-only)
**Base**: `main` @ `bbefe5e`
**Branches reviewed**:
- `phase3/coordination-tools` (Agent A)
- `phase3/utility-tools-policy` (Agent B1)
- `phase3/worktree-policy` (Agent B2)
- `phase3/integration` (Agent C, in flight — coordination + utility merged, worktree pending)
**Plan**: `docs/NCHINDA_PLAN.md` §1 principles, §2.1 ladder, §5.1 tool table, §6 Phase 3 DoD.

---

## 1. Verdict

**ship-with-fixes.**

All three Phase 3 branches clear the §6 DoD bar — the five `nchinda_*`
coordination tools, four utility tools, mandatory per-agent worktree,
and the standby-vs-kill PolicyEngine are all present, zod-validated
where inputs come from the LLM, argv-array-only for every `execFile`,
and backed by real assertion-heavy tests (351/351 passing on
`phase3/integration` with coordination + utility merged). What keeps
this from a clean "ship-it" is (a) `docs_fetch` has no DNS/SSRF host
guard — an LLM-crafted `http://169.254.169.254/latest/meta-data/`
will happily reach cloud metadata, and (b) ladder rungs 4–7 were
shipped as standalone tools only; they are NOT wired into
`src/loop/fallback-strategies.ts` as FallbackStrategy extensions, so
§2.1's ladder is only half-real at runtime. Both are small patches,
neither blocks a merge to `main` behind a feature flag, but both must
land before rung 7 can autonomously fire in production.

## 2. Scorecard (1–5)

| Dimension | Score | Notes |
|---|---|---|
| Correctness | 4 | `ask_peer` correlation-id isolation proven by the two-concurrent-asks test; `executeOnce` + `awaitExecutorsDone` both drive worktree release on terminal; idle sweep + LRU ordering correct. One real risk: `task_id` carrying a correlation-id could theoretically collide with a plan task-id (see §5). |
| Security | 3 | `shell` is genuinely locked down (execFile + allow-list + metachar regex); `worktree-manager` regex is tight (`/^[A-Za-z0-9_-]{1,64}$/`); DDG parser sanitizes extracted fields. BUT `docs_fetch` has zero host filtering — SSRF to link-local + RFC1918 is trivially reachable (see §4). |
| TypeScript rigor | 5 | Zero new `: any` / `as any` in the Phase 3 diff. Public APIs strongly typed; zod schemas export inferred types; discriminated unions for `AskPeerResult`. |
| Test quality | 5 | 1106 LOC of tests across 7 suites, all with real assertions. Failure-path coverage (timeout, rate-limit, schema mismatch, no-peer, zod rejection, git failure) is genuinely present, not mocked-away. |
| Design | 4 | DI-heavy, narrow interfaces (`MessageBusLike`, `AgentRegistryLike`), pure policy engine that takes `freemem`/`now`/`onEvict` overrides. Minor: `orchestrator.ts` now 810 lines (carry-over + 99 new). |
| Spec adherence | 4 | All §5.1 tools present and shipped; §6 DoD met. Drift: rungs 4–7 not wired into `FallbackStrategy` composition; `nchinda_send`/`broadcast` use `from_slot=-1` which isn't documented in the plan table. |
| Performance | 4 | Bounded caps everywhere (shell stdout 256KB, fetch 5MB, DDG results 10, snippet 500ch). `WorktreeManager` dedups concurrent allocates via `inFlight` map. One concern: `PolicyEngine.sweepIdle` is O(N) per tick over all agents; fine at 15-agent scale, pessimal at 100+. |

## 3. Spec drift

TBD

## 4. Security pass

TBD

## 5. Correctness deep-dive

TBD

## 6. Test quality

TBD

## 7. Design smells

TBD

## 8. Top 3 patches before merging to main

TBD

## 9. Follow-ups for later phases

TBD
