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

## 3. Spec drift vs §5.1 + §6 Phase 3

### 3.1 Coordination tools (§5.1 rows 1–7 that belong to Phase 3)

| Plan row | Shipped? | Notes |
|---|---|---|
| `nchinda_send(to_slot, body)` | **yes** | `src/mcp/nchinda-coordination.ts:113-118`. Zod-validated. `from_slot` defaults to `-1` (system) — undocumented in plan table but reasonable. |
| `nchinda_broadcast(body)` | **yes** | Same file, lines 120–124. Zod-validated. |
| `nchinda_ask_peer(role, question, timeout_s)` | **yes** | Lines 170–191. **Correlation id is crypto-random (`randomUUID`), isolated via `EventBus.once({task_id: id})`. `no-peer` branch fires when registry has no matching `running` role OR when `resolvePeerSlot` returns undefined. `timeout` branch tested with 1s window.** |
| `nchinda_status()` | **yes** | Lines 126–147. `StatusInputSchema.strict()` rejects unexpected keys. Uptime computed from `started_at` with a defensive `Number.isFinite` guard. |
| `nchinda_escalate(question)` | **yes** | Lines 149–168. Persists to `escalations-db` + emits `kind:"error"` with `payload.where==="escalation"`. Plan §5.1 calls it blocking-for-answer; the actual handler returns the `escalation_id` immediately and expects the voice surface (Phase 5) to resolve. Acceptable — the async-wait is a caller concern. |

All 5 handlers use `zod.parse()` on raw input and every zod schema is tight (`min`/`max` bounds, `.strict()` on status).

### 3.2 Utility tools (§5.1 rows for Phase 3 utility block)

| Tool | Shipped? | Notes |
|---|---|---|
| `shell(cmd, ...)` | **yes** | `src/tools/shell.ts`. `execFile` only (`shell: false` set explicitly). String cmd rejected if it contains `[\s;&|`$><]`. Array cmd always argv. Allow-list of 17 read-only-ish binaries; `callerRole === 'system'` bypass for trusted callers (WorktreeManager). |
| `docs_fetch(url)` | **yes, partial** | Protocol allow-list (`http:`, `https:` only). 5 MB cap. 10 s timeout. **Missing**: DNS/host guard — see §4.2. |
| `web_search(query)` | **yes** | Two adapters via a clean `WebSearchAdapter` interface; auto-select Tavily → DDG. DDG extractor strips tags + entity-decodes before surface — injection-safe. Never throws. |
| `tool_discovery(need)` | **yes** | Haiku-backed (`claude-haiku-4-5-20251001`). API key pulled from `opts.apiKey` or `ANTHROPIC_API_KEY`. 8 s timeout. Hallucinated tool names filtered via `new Set(catalog.map(c => c.name))`. |

### 3.3 §6 Phase 3 DoD items

| DoD item | Met? | Notes |
|---|---|---|
| "Full `nchinda_*` MCP tool suite" | **yes** | 5/5 shipped + registered in `scripts/mcp/serve-nchinda.mjs` dispatch switch. |
| "`web_search`, `docs_fetch`, `shell`, `tool_discovery`" | **yes** | 4/4 shipped + wired into `NCHINDA_TOOL_SCHEMAS`. |
| "Git worktree per agent (mandatory)" | **partial — see below** | `WorktreeManager` exists; `Orchestrator.spawnExecutor` calls `allocate()` BEFORE `controller.spawnAgent` and passes `worktreePath` as `workingDirectoryOverride`. BUT: the manager is **optional** on the `OrchestratorDeps` seam — if `worktreeManager` is undefined, the orchestrator falls back to the legacy `.cortexos-agents/<session>` path. Plan §6 says "mandatory." This is a deliberate back-compat choice noted in the code comment (`orchestrator.ts:66-73`) but represents a drift from the plan's wording. Suggest the default wiring in `cortex.ts` install a manager by default and let the env var disable. |
| "Idle agents keep session but sleep" | **yes** | `PolicyEngine.onDoneEvent` → `registry.markStandby`. Subscribed via `bus.subscribe({kind:"done"}, …)`. |
| "Memory pressure triggers LRU kill" | **yes** | `sweepMemoryPressure` picks oldest `heartbeatMs ?? started_at` when `free/total < 0.15`. Tested with a frozen-clock fixture. |
| "Coder asks tester via `ask_peer`, tester replies, coder continues" | **partial** | Protocol exists: `ask_peer` sends `[ASK <uuid>]: <question>` via `messageBus.send(-1, peerSlot, envelope)` and awaits `EventBus.once({task_id: uuid})`. Two-concurrent-asks test proves isolation. But **the tester-side reply path is not demonstrated end-to-end** — there is no integration test spinning two real panes + the hooks server to close the loop. Phase 3.7/4 work is likely where that lands; flagging as a follow-up, not a block. |

### 3.4 Resourcefulness ladder (§2.1 rungs 4–7)

Plan §2.1 lists the 7-rung ladder; rungs 1–3 already exist on `main` as `RetrySameStrategy`, `AlternateToolStrategy`, `ReduceScopeStrategy` (see `src/loop/fallback-strategies.ts`). Phase 3 is where rungs 4–7 (`ask_peer`, `recall`, `web_search`, `escalate`) should plug in.

**Drift**: all four rung-4-through-7 behaviors ship as **standalone MCP tools**, not as `FallbackStrategy` subclasses composed by `AutonomyLoop`. The LLM has the primitives; the autonomy loop does not automatically walk the ladder. This is a meaningful spec drift — rung 4 (`ask_peer`) is supposed to fire automatically after rungs 1–3 exhaust, but today the LLM has to remember to call it. Recommend Phase 3.5 or a follow-up Phase 3 patch adds `AskPeerStrategy`, `RecallStrategy`, `WebSearchStrategy`, `EscalateStrategy` subclasses that wrap the existing tools.

## 4. Security pass

### 4.1 `shell.ts` — PASS

- `execFile` only; `shell: false` set explicitly as a future-proof guard.
- `SHELL_ALLOWLIST` is narrow (17 entries, all read-only or toolchain; no `rm`/`mv`/`chmod`/`curl`/`ssh`).
- Untrusted-caller bypass requires `callerRole === 'system'`, a string the LLM has no way to inject through the input schema (the field exists but setting it is a noop unless the call originates in-process).
- Metachar regex (`/[\s;&|`$><]/`) rejects shell syntax in string form; argv-array form is always safe because arguments don't traverse a shell.
- Trusted bypass tested (`runShell(["true"], { callerRole: "system" })`).

### 4.2 `docs_fetch.ts` — **FAIL (SSRF)**

- Protocol allow-list (`http:`, `https:`) — good.
- 5 MB size cap via streaming reader — good.
- 10 s AbortController timeout — good.
- **Missing**: no DNS resolution + IP-range deny-list. An LLM-crafted URL like `http://169.254.169.254/latest/meta-data/iam/security-credentials/` reaches AWS metadata; `http://127.0.0.1:6379/` hits a local Redis; `http://10.0.0.5:5432/` hits internal networks. The plan brief specifically asked about `169.254.169.254`; grep confirms no host filtering anywhere in the file.
- **Fix (small)**: resolve hostname, reject if any resolved IP is link-local (169.254/16), loopback (127/8), RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), or IPv6 ULA (`fc00::/7`). Re-check after redirects (native `fetch` follows by default — either set `redirect: "manual"` + re-validate or use a `dispatcher` that rejects in the connect hook). See §8 patch 1.

### 4.3 `web-search.ts` — PASS

- DDG parser: extracted fields pass through `stripTags` → `decodeEntities` → `truncate`. Test "strips HTML tags inside extracted fields — no script injection" proves `<script>` inside a `result__a` body is neutralized.
- Tavily adapter validates response via `zod` before use.
- `webSearch()` never throws — wraps adapter in try/catch that returns `[]`.
- Redacted error taxonomy (network/timeout/schema-mismatch/etc) keeps upstream server internals out of LLM context.
- DDG `uddg` redirect unwrapping is conservative: rejects anything that isn't `http:` or `https:` post-unwrap.

### 4.4 `worktree-manager.ts` — PASS

- `AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/` — tight. Test explicitly rejects `../escape`, `'; rm -rf /`, space, dot, hash, oversized, empty.
- All git commands invoked via `execFileAsync("git", args)` — never shell-interpolated.
- Release is best-effort with a `fs.rm` fallback if `git worktree remove` fails, so a stale `.git/worktrees/<id>` lock can't block future allocates indefinitely.

### 4.5 `escalations-db.ts` — PASS

- Prepared statements for every write (`@id`, `@question`, `@level`, `@task_id`, `@agent_id`, `@resolved_by`, `@resolution`).
- `journal_mode = WAL` + `foreign_keys = ON`. The table has no foreign keys today, but the pragma is on for when `task_id` gets wired to `tasks(id)` later.
- `getById` uses parameterized `?` binding.
- `:memory:` path bypasses the `mkdirSync`, preventing tests from creating `~/.cortexos` side effects.

### 4.6 `nchinda-coordination.ts` — PASS

- `zod.parse()` at the top of every handler (5/5).
- Correlation ids are `randomUUID()` — crypto-random, 128-bit.
- No `any`/`as any`. `extractAnswer` narrows unknown payloads with explicit typeof checks.
- MessageBus errors propagate (tested: `send failed` surfaces verbatim).

### 4.7 `tool-discovery.ts` (Haiku path) — PASS with a caveat

- API key from `opts.apiKey` or `process.env.ANTHROPIC_API_KEY`; missing key returns `[]` + redacted warn.
- 8 s AbortController timeout mirrors the existing `HaikuClassifier`.
- Hallucinated tool names filtered against catalog `Set`.
- **Caveat**: the prompt builds `Given this need: '${need}'.` with `need` interpolated directly. An adversarial `need` containing backticks or `'.` terminators could break out of the single-quoted framing. Haiku will still only return catalog entries (the post-filter enforces that), so the worst case is degraded suggestions, not tool execution. Minor; not a block.

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
