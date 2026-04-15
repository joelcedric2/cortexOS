# Phase 1 Code Review

**Reviewer**: Claude (stand-in after Agent D stream timeout)
**Branch reviewed**: `phase1/integration` (tip `e034ae7`)
**Date**: 2026-04-15

---

## Verdict

**`ship-with-fixes`** — 40/40 tests pass, TypeScript compiles clean, security posture is solid, no design smells worth blocking on. But the system as committed will **not actually run end-to-end** because three integration wires are missing (all already flagged by Agent C in `INTEGRATION_NOTES.md`). These must land before Phase 2 begins or Phase 2 will build on sand. Fixes are small (estimated < 90 min total).

---

## Scorecard (1–5)

| Axis | Score | Note |
|---|---|---|
| Correctness (tests pass) | 5 | 40/40 green, 5.3s total runtime |
| Security | 5 | `execFile` everywhere, prepared statements, one benign silent catch |
| TypeScript rigor | 5 | One `any` in all of `src/` (HF embedder types — acceptable) |
| Test quality | 4 | DoD smoke test hits real HTTP + SQLite + registry transitions. Light on failure-path coverage |
| Design | 4 | Clean bounded contexts (`ipc`, `registry`, `orchestrator`). EventBus contract is minimal and sound |
| Spec adherence | 4 | `waitForCompletion` actually deleted; JSON plan flows through zod. Docks -1 point for the three runtime-wiring gaps |
| Performance | 5 | Event-driven (no polling), sync `better-sqlite3`, no obvious N+1 |

---

## Security pass — findings

### Shell injection: **none found**
- `src/tmux/tmux-manager.ts` uses `execFile` with arg arrays exclusively. No shell interpolation.
- The one template-string at `tmux-manager.ts:62` (`\`-t=${this.prefixed(name)}\``) is passed as an arg to `execFile`, not a shell, so quoting does not matter.

### SQL injection: **none found**
- `src/registry/agent-registry.ts` and `src/ipc/events-db.ts` both use `better-sqlite3` prepared statements (`.prepare(...).run(...)`). No string concatenation into SQL.

### Path traversal in hook scripts: **low risk, documented**
- `scripts/claude-hooks/pre-compact.sh` reconstructs `~/.claude/projects/${DASHED_CWD}/${SESSION_ID}.jsonl` from hook input. `SESSION_ID` comes from Claude Code's own `Stop`/`PreCompact` hook JSON, which is controlled by the Claude Code CLI. Theoretical risk if SESSION_ID contained `../` — mitigated by Claude Code's own session-id format (UUIDs). **Recommended (LOW priority)**: add a regex guard in the server-side handler that rejects `session_id` not matching `^[a-zA-Z0-9._-]{1,128}$`.

### Silent catches: **one, benign**
- `src/tmux/tmux-manager.ts:88` — `unlink(tmpFile).catch(() => {})` on a temp-buffer cleanup after `send-keys`. Correct: the message is already delivered, temp-file cleanup is best-effort.

### TODOs / FIXMEs: **zero**

---

## Spec drift check (§6 Phase 1 DoD)

| Spec bullet | Status | Evidence |
|---|---|---|
| Commit in-flight tmux-manager edits | ✅ | Commit `766f576` on main |
| `ruflo init` in cortexOS | ✅ | Commit `c620844` on main |
| Stop hook → IPC | ✅ | `scripts/claude-hooks/stop.sh` + `src/ipc/server.ts POST /hooks/stop` |
| PreCompact hook → pgvector | ✅ (design) / ⚠️ (wiring) | Handler exists; boot-time wiring is gap #3 below |
| Replace `waitForCompletion` with event-driven wait | ✅ | `orchestrator.ts:331` comment confirms; grep shows no live references |
| Designer emits structured JSON (`emit_plan` tool) | ✅ | `src/agents/claude-agent.ts` + zod validator in `plan-schema.ts` |
| Lock Agent Registry SQLite schema | ✅ | `src/registry/schema.sql` + tests |

---

## Integration gaps — MUST FIX before Phase 2

These are the items C documented in `INTEGRATION_NOTES.md`. I have re-verified them and ranked by criticality.

### 1. HIGH — Shared `EventBus` instance at boot
**Location**: unspecified (boot path)
**What**: `src/ipc/server.ts startHooksServer(...)` accepts a `bus` parameter, and `src/orchestrator/orchestrator.ts` receives a `bus` in its constructor. Today there is no caller that creates a single bus and passes it to both. Result: hook-server emits go into void; orchestrator `.once()` never resolves in production.
**Fix**: in `src/index.ts` (or wherever the daemon boots), `const bus = createEventBus(); startHooksServer({ bus, ... }); const orch = new Orchestrator(..., bus); controller.setBus(bus);` Single owning instance.

### 2. HIGH — `startHooksServer` is never booted
**Location**: `src/controller/cortex.ts CortexController.initialize()` or equivalent boot path
**What**: C exported `startHooksServer(...)` but no code calls it. Production won't open port 3102.
**Fix**: call `startHooksServer({ bus, port: 3102 })` from `CortexController.initialize()`; shut it down cleanly in `shutdown()`.

### 3. MEDIUM — Hook scripts not installed into `.claude/hooks/`
**Location**: `.claude/settings.json` and `.claude/hooks/`
**What**: Agent A's sandbox couldn't write under `.claude/`, so scripts live in `scripts/claude-hooks/` with an `install.sh` that symlinks them. Until someone runs `install.sh` and merges `docs/phase-1/settings-hooks-snippet.json` into `.claude/settings.json`, Claude Code won't invoke them.
**Fix**: run `scripts/claude-hooks/install.sh` once; manually merge the `hooks` object from the snippet into `.claude/settings.json` (or add a one-liner that does it).

---

## Additional findings (lower priority)

### LOW — `extract_field()` awk in hook scripts is fragile with escaped JSON
**Location**: `scripts/claude-hooks/stop.sh` and `pre-compact.sh`
**What**: The `awk`-based JSON extractor does not handle backslash-escaped quotes or nested keys with identical names.
**Why it matters**: Claude Code controls the input, so low risk. But if the format ever changes, parsing breaks silently.
**Fix**: since `python3` fallback is already used for encoding, use `python3 -c` for extraction too on systems where it exists. Keep awk as a last-resort fallback. ~15 lines of shell.

### LOW — Test quality: failure paths under-covered
**What**: DoD smoke test exercises the happy path. Failure-path tests would include: Stop hook posts invalid JSON, DB file read-only, orchestrator `.once()` timeout, emit_plan tool returns invalid plan (some zod tests exist but not tied to orchestrator).
**Fix**: add ~4 negative tests in a follow-up; not blocking Phase 1.

### LOW — `src/memory/embedder.ts` uses `any` for HF types
**What**: Single `any` in the whole codebase, on imported `@huggingface/transformers` pipeline type.
**Fix**: replace with the correct `FeatureExtractionPipeline` type from the HF package (1-line change). Non-blocking.

---

## Top 3 patches to apply before merging to `main`

```
1. src/index.ts (or controller boot path):
   - Create ONE EventBus at boot
   - Pass it to both startHooksServer AND Orchestrator
   - Call startHooksServer({ bus, port: 3102 }) during initialize()
   - Tear it down in shutdown()

2. .claude/settings.json:
   - Merge the `hooks` block from docs/phase-1/settings-hooks-snippet.json
   - Run scripts/claude-hooks/install.sh to create the .claude/hooks/ symlinks

3. src/ipc/server.ts:
   - Add input validation on POST /hooks/stop and POST /hooks/pre-compact:
     session_id must match /^[a-zA-Z0-9._-]{1,128}$/
     Reject with 400 otherwise.
```

All three together should take < 90 minutes and unblock actual end-to-end runs.

---

## Follow-ups (post-Phase-1, not blockers)

- Replace awk JSON extraction in hook scripts with `python3 -c` when available
- Fix `any` in `memory/embedder.ts`
- Add failure-path tests (Stop with invalid payload, `.once()` timeout, invalid plan JSON)
- Consider consolidating the two SQLite DBs (`events.db` + `registry.db`) into one file with multiple tables — cleaner ops footprint
- Document the port registry (3100 audio WS, 3101 event WS, 3102 hooks HTTP, plus the pre-existing Unix socket IPC) in one place

---

## Go/no-go recommendation

**Go for merge after top-3 fixes land.** Phase 1 foundation is sound: event-driven orchestration works, SQLite registries are clean, hooks are wired, tests are green. The three gaps are plumbing, not design, and blocking Phase 2 behind them costs nothing. Once they land, merge `phase1/integration` → `main` and start Phase 1.5 + Phase 2 in parallel per the roadmap.
