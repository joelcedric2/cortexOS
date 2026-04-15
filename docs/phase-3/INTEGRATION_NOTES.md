# Phase 3 — Integration Notes

Integrator: Test Agent C
Base: `main` @ `bbefe5e` (Merge Phase 2.5)
Branch: `phase3/integration`

## Merge order (chronological)

1. **`phase3/coordination-tools`** (Agent A) — foundation
   - `src/mcp/escalations-db.ts` (SQLite store)
   - `src/mcp/nchinda-coordination.ts` (send / broadcast / status / escalate / ask_peer)
   - `tool-schema.ts` appended — 5 new schemas
   - `scripts/mcp/serve-nchinda.mjs` refactored to a `dispatch()` switch
   - +24 tests (`escalations-db.test.ts`, `nchinda-coordination.test.ts`)
   - Clean merge (no conflicts).

2. **`phase3/utility-tools-policy`** (Agent B1) — utility tools
   - `src/tools/shell.ts`, `docs-fetch.ts`, `web-search.ts`, `tool-discovery.ts`
   - `tool-schema.ts` appended — 2 MCP-exposed schemas (`web_search`, `tool_discovery`).
     `shell` and `docs_fetch` are library code with no MCP surface (per B1 design).
   - `serve-nchinda.mjs` registered web_search + tool_discovery dispatch branches
   - +40 tests
   - **Conflicts**
     - `src/mcp/tool-schema.ts` — both-sides appenders. Concatenated canonically: A's 5 coord schemas first, then B1's 2 utility schemas. `NCHINDA_TOOL_SCHEMAS` array now lists all 11 in the canonical order.
     - `scripts/mcp/serve-nchinda.mjs` — B1 was built against the pre-refactor if/else-if chain; coord-tools had already replaced it with a `dispatch()` switch. I also saw an embedded historical `phase2.5/integration` conflict marker dragged along by B1's HEAD. Resolved by keeping the cleaner `dispatch()` switch + appending `web_search` and `tool_discovery` cases to it. Result: one place to dispatch, unknown-tool handling uniform.

3. **`phase3/worktree-policy`** (Agent B2) — worktree + policy
   - `src/workspace/worktree-manager.ts` (mandatory git worktree per agent)
   - `src/registry/policy-engine.ts` (standby vs kill + memory-pressure LRU)
   - `src/orchestrator/orchestrator.ts` + `src/controller/cortex.ts` integration seam
   - +17 tests
   - **Stray commit `fc45392`**: this was a partial duplicate of Agent B1's `67c8c68` that only touched `serve-nchinda.mjs` and predated A's `dispatch()` switch. Because the canonical dispatch was already in HEAD (from step 2), this produced the same both-sides conflict in `serve-nchinda.mjs`. Resolved identically: kept `dispatch()` from HEAD. No coordination code was lost; verified by grepping all 5 coord case labels + both utility case labels after the merge.

## Quality gate

- `npx tsc --noEmit` — **exit 0**
- `npm test` — **370 pass / 0 fail** (main baseline was ~270; +~100 added by Phase 3 branches + DoD file)
- `tool-schema.ts` — `NCHINDA_TOOL_SCHEMAS` length: **11**
  - Originals (4): recall, remember, schedule, research
  - Coordination (5): send, broadcast, status, escalate, ask_peer
  - Utility (2 exposed over MCP): web_search, tool_discovery
  - Library-only (not in schema list): shell, docs_fetch

## DoD

Plan §6: *"two agents collaborating mid-flight — coder asks tester 'does this pass the contract test?' via `nchinda_ask_peer`, tester replies, coder continues"*.

Covered by `tests/phase3-dod.test.ts`:
- **Part 1**: coder (slot 1) calls `ask_peer({role:'tester', question:'does this pass?', timeout_s:5})`. A scripted `MessageBusLike` plays the tester: on receiving the `[ASK <correlation_id>]` envelope targeted at slot 2, it emits a bus event with `task_id = correlation_id` and `payload.body = 'yes'`. `ask_peer` resolves `{ok:true, answer:'yes', correlation_id:<uuid>}`.
- **Part 2**: allocate a real git worktree in a tmpdir repo, assert the path exists, `runShell(['ls'], {cwd: info.path})` returns exit 0, release, assert the path is gone. Second release is a no-op.

**Phase 3 DoD: met.**

## Commit trail (this branch)

- `c0b3f30` chore(phase-3): scaffold integration branch + notes
- `20c4bdd` merge(phase-3): coordination tools
- `3390313` merge(phase-3): utility tools (conflicts resolved)
- `8a809ab`..`19b4b08` merge(phase-3): worktree manager + policy engine (Agent B2 branch tip, with REVIEW.md verdict commits from Agent D landing in the same merge boundary — left untouched)
- `6488f93` test(phase-3): DoD smoke
- (this file) docs(phase-3): INTEGRATION_NOTES finalized

## Files not touched by this agent

- `docs/phase-3/REVIEW.md` — owned by Agent D (Test Agent). Observed concurrent edits landed directly on the branch; no conflicts with integration work.
