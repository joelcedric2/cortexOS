# Phase 1.5 — Integration Notes

**Integrator**: Test Agent C (partial; completed inline by main thread after C hit usage-limit post-DoD-commit)
**Branch**: `phase1.5/integration`
**Merged branches**:
- `phase1.5/scheduler-core` (Agent A): CronJobsDB, Scheduler ticker, EventKind `cron_fire` append, CortexController wiring behind `CORTEXOS_SCHEDULER=on` flag, 6 scheduler tests
- `phase1.5/nl-cron-defaults` (Agent B, rebased atop scheduler-core): defaults seeder, NL parser (Haiku + heuristic), cron CRUD API + IPC wiring, `nchinda_schedule` MCP tool, ~45 new tests

## Merge order

1. Branched from `main` (`ab88e9f`)
2. Merged `phase1.5/scheduler-core` — clean fast-forward-ish (`--no-ff`)
3. Merged `phase1.5/nl-cron-defaults` — file-level clean; the API contract issue the REVIEW flagged (stub vs real `CronJobsDB`) was resolved by Agent B rebasing before the merge
4. Agent C committed DoD smoke test on a separate worktree branch `phase1.5/integration-work` due to working tree churn; rescue-merged back into `phase1.5/integration` after C's usage-limit cutoff

## Conflicts & fixes

**Stub elimination**: `docs/phase-1.5/REVIEW.md §8 Patch 1` called for deleting `_cron-jobs-db-stub.ts`. Confirmed: the stub is gone, no imports reference it (`grep -rn "_cron-jobs-db-stub" src/ tests/` returns empty on `phase1.5/integration`).

**Worktree consolidation**: Agent C's worktree at `../cortexOS-p15i` held the `phase1.5/integration-work` branch. Folded its 2 commits (merge-B + DoD test) back into `phase1.5/integration` via `--no-ff`, then removed the worktree.

## Post-review inline fixes

Two of the three top-3 items from `docs/phase-1.5/REVIEW.md §8` were applied before main-merge:

### Patch 2 — Scheduler.runJob advances next_run after every markRan
`src/scheduler/scheduler.ts`: after `markRan` succeeds, `nextRunFromCron(job.cron_expr, finishedAt)` is called and the DB row's `next_run` is updated. On parse failure (shouldn't happen — validated on insert) the job is disabled instead of tight-looping. Without this, every enabled cron fired on every tick forever.

### Patch 3 — High-frequency cron rejection for untrusted callers
`src/scheduler/api.ts CronCreateInputSchema.superRefine` now rejects minute-field schedules (`*`, `*/1`, `*/2`, `*/3`, `*/4`) when `created_by ∈ {user, mcp, api}`. Privileged callers (`onboarding`, `nchinda_proactive`) bypass so the built-in defaults (most-frequent is `meeting_prep` every 10 min) still seed.

### Patch 1 — Already resolved
Stub deletion was done during the merge. Confirmed via grep.

## Deferred to later phases

From `REVIEW.md §9`:
- Dashboard cron page — Phase 6 UI work, backend handlers ready
- Full `node-cron` switch — if a future patch touches next-run logic, consider adopting `node-cron` wholesale
- Auto-pause after 3 consecutive escalations — Phase 3
- Proactive cron proposal (§5.6.4) — Phase 5.5 observation stream
- Orchestrator.ts > 500 LOC split — Phase 3 prep (also flagged in Phase 2.5 REVIEW)

## Final state

- `tsc --noEmit` exit 0
- `npm test`: **236 / 236 passing across 29 suites** (was 144 at Phase 2 merge; +92 from Phase 1.5 alone)
- Hooks: `CORTEXOS_SCHEDULER=on` env-flag gates boot wiring per `docs/phase-1.5/DECISIONS.md §D-1.5-2`
- `EventKind` appended: `cron_fire`
- SQLite: `cron_jobs` + `cron_runs` tables live inside shared `~/.cortexos/registry.db`

## Phase 1.5 DoD

MET per `tests/phase1.5-dod.test.ts`:
- Schedule a `* * * * *` job with `enabled: true`, `next_run: now` → scheduler tick fires once, `cron_fire` event emitted, `markRan` called with outcome=success
- Seed 6 defaults → all exist with `enabled=false`
- `nchinda_schedule({utterance: "every Friday at 5pm", autoEnable: true})` → creates job with `cron_expr: "0 17 * * 5"`, `enabled: true`
