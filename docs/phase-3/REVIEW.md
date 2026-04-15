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

### 5.1 `ask_peer` correlation-id via `task_id`

The implementation piggy-backs the 128-bit `randomUUID` correlation id onto the `task_id` field of the `AgentEvent` envelope so the existing `EventBus.once({task_id: …})` filter path can be reused without a new filter axis. **Collision risk with a real plan `task_id`**: both are `randomUUID`, so the probability is 1 in 2^122 per comparison — negligible. More realistic concern: an ask correlation id will NOT match against a simultaneous plan whose task happens to have the same uuid, because the filter also lives on a different EventBus message flow (the envelope is delivered through `MessageBus.send`, while the reply event comes from the hooks server). The two-concurrent-asks test (`tests/nchinda-coordination.test.ts` "two concurrent asks are isolated by correlation id") proves isolation at the handler layer.

**Caveat**: when Phase 5 widens the envelope to add `correlation_id` as a first-class field, the handler should move off the `task_id` hack. The code comment already flags this: "Phase 5 may widen this later."

### 5.2 `PolicyEngine` LRU ordering — NULL heartbeat handling

`sweepMemoryPressure` sorts standby agents by `heartbeatMs(a) ?? Date.parse(a.started_at)`. Both branches are covered:

- `heartbeatMs` returns `null` when `last_heartbeat` is `null` OR not parseable. Fresh-spawned agents have `null` heartbeats until `markRunning`/`markStandby` bumps the column.
- Fallback to `started_at` is always a valid ISO-ish string from `AgentRegistry.spawn`, so `Date.parse` always yields a number.

**Edge case worth a test**: if TWO agents both have `null` heartbeats and identical `started_at`, the sort is stable (Array.prototype.sort in V8 is stable as of Node 12) — first-spawned wins. Not explicitly tested, but behavior is deterministic.

**One subtle correctness bug**: the SQLite `CURRENT_TIMESTAMP` string is "YYYY-MM-DD HH:MM:SS" without a `Z` marker. Node's `Date.parse` treats this as *local* time. `heartbeatMs` normalizes it by appending `Z`, which is correct. Without that normalization, every engineer in a non-UTC timezone would see eviction ordering drift by hours. Good catch; tested in `policy-engine.test.ts` via the 1.1-second delay loop.

### 5.3 `WorktreeManager.allocate` dedup race

`inFlight: Map<string, Promise<WorktreeInfo>>` gates concurrent allocates. The test explicitly proves this with `Promise.all([wm.allocate("dup-1"), wm.allocate("dup-1"), wm.allocate("dup-1")])` and asserts `strictEqual` (reference equality) across all three returned infos AND `wm.list().length === 1`. Claim verified.

**One remaining race** (not tested, not blocking): if `release(id)` runs while an `allocate(id)` promise is still in flight for the SAME id (e.g. rapid spawn→cancel), the `finally`-delete of `inFlight` might not have run yet, producing a zombie entry that resolves to a removed worktree. Low-probability in practice because `release` is only called from terminal-state branches in the orchestrator; worth a regression test in Phase 3.5.

### 5.4 Orchestrator back-compat seam

The claim: "tests without WorktreeManager still pass." Verified — the test run on `phase3/integration` after merging coordination + utility tools returned 351/351 passing. `WorktreeManager` is gated behind `deps.worktreeManager` being defined; every existing orchestrator test continues to exercise the legacy path because none of them construct a manager. The change to `controller.spawnAgent(role, provider, slot, workingDirectoryOverride?)` is additive (optional trailing param), so existing callers are untouched.

**Not verified**: there is no orchestrator test that proves spawnExecutor CALLS `worktreeManager.allocate(agentId)` before `controller.spawnAgent`. The integration is wired (`orchestrator.ts:454-472`) but a regression test would be cheap. Recommend adding.

### 5.5 Hard-escalation semantics

Plan §2.2 requires 3 failed attempts → escalate. `nchinda_escalate` is a tool the LLM calls; the automatic "3 fails → escalate" rule lives on the autonomy loop, and there is no new wiring in Phase 3 that enforces it automatically. Implies the LLM is trusted to call `escalate` after its own fallback chain exhausts. Fine for now; the FallbackStrategy gap (§3.4) is the root cause.

## 6. Test quality

### 6.1 Coverage map

| Suite | LOC | Assertion-style | Failure paths covered? |
|---|---|---|---|
| `nchinda-coordination.test.ts` | 382 | assertions per test, real EventBus | timeout, no-peer, schema rejection (zod), MessageBus errors, empty body, >10k body |
| `escalations-db.test.ts` | 105 | CRUD round-trips | missing id on resolve, second-precision ordering via 1.1s delay |
| `shell.test.ts` | 109 | real child_process | allow-list deny, metachar rejection, timeout (100ms vs 5s child), >256KB truncation, non-zero exit |
| `docs-fetch.test.ts` | 164 | mocked fetch | bad-protocol (file/ftp/javascript), 404/503 mapping, AbortController timeout, maxBytes truncation |
| `web-search.test.ts` | 232 | mocked fetch + stub adapter | script-injection in DDG fields, timeout via abort, Tavily 500, zod schema mismatch, network failure |
| `tool-discovery.test.ts` | 170 | mocked Haiku | no-API-key fast path, 500 error, malformed JSON, confidence sort + trim, catalog filter for hallucinated names |
| `worktree-manager.test.ts` | 138 | real `git init` + real worktrees | bad agent ids (path traversal, spaces, metachars, oversize), concurrent dedup, release idempotence |
| `policy-engine.test.ts` | 238 | real AgentRegistry + fake memory/clock | LRU order, healthy-memory skip, idle sweep, terminal-state non-resurrection, stop() idempotence |

**Good**: no assertion-less tests; no "mock everything and prove nothing" patterns. Mocks are narrow (DI seams: `fetchImpl`, `freemem`, `now`, `resolvePeerSlot`) and real infra is used where it's cheap (`git init` in a tmpdir for worktrees; `:memory:` SQLite for escalations).

**Test quality nits**:
- `policy-engine.test.ts` uses `setTimeout(r, 1100)` to nudge SQLite's 1-second `CURRENT_TIMESTAMP` precision. Flake risk is real on slow CI. Alternatives: inject `markStandby` with an explicit heartbeat, or mock `CURRENT_TIMESTAMP` at the registry layer. Not a blocker.
- `worktree-manager.test.ts` leaves `git worktree` artifacts in `/tmp` if `afterEach` throws between `rm(root)` and `rm(repo)`. Minor.

## 7. Design smells

- **`: any` count (new Phase 3 code)**: 0. The only `: any` hits in `grep` across `src/mcp|tools|workspace|registry` are in pre-existing files (`src/memory/embedder.ts`, `src/mcp/nchinda-tools.ts`'s doc comment). Clean.
- **Silent catches**: none found with bare `catch {}`. Every catch either rethrows a typed error, logs via `console.warn(..redactReason..)`, or is explicitly commented (e.g. the `reader.cancel()` swallowing in `docs-fetch.ts` has a justifying comment).
- **Files > 500 lines**:
  - `src/orchestrator/orchestrator.ts` — 810 lines (was 731 on main; +99 in Phase 3). Already flagged as Phase 3 follow-up; not a new problem. Suggest splitting `spawnExecutor` + `runResearcherDetour` into a separate `executor-spawn.ts` in the next cleanup pass.
  - `src/tools/web-search.ts` — 342 lines; right at the edge. Two adapters + DDG parser + redaction + public API. Splittable into `adapters/tavily.ts` + `adapters/duckduckgo.ts` + `web-search.ts` if it grows.
- **Bounded-context violations**: none spotted. Tools live in `src/tools/`, coordination in `src/mcp/`, workspace in `src/workspace/`, registry/policy in `src/registry/`. The only cross-context import is `tool-discovery.ts` importing `NCHINDA_TOOL_SCHEMAS` from `src/mcp/tool-schema.ts`, which is justified (catalog is the schema list).
- **`child_process.exec` (vs execFile)**: zero hits on any Phase 3 branch. Every child-process invocation uses `execFile` with argv arrays. Plan compliance.
- **TODOs / FIXMEs**: none planted in Phase 3 code.

## 8. Top 3 patches before merging to main

### Patch 1 — `docs_fetch.ts`: add SSRF host deny-list (CRITICAL)

**File:line**: `src/tools/docs-fetch.ts:89` (after `ALLOWED_PROTOCOLS` check).

**What**: resolve the hostname via `dns.lookup`, reject the request if ANY resolved IP falls in link-local (169.254/16), loopback (127/8), RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), IPv4 "this network" (0/8), or IPv6 ULA (`fc00::/7`) / link-local (`fe80::/10`) / loopback (`::1`). Also set `redirect: "manual"` and re-validate on every 3xx so a metadata-server redirect can't slip past.

**Why**: today an LLM-crafted URL reaches AWS/GCP metadata, local Redis, internal HTTP services, and the loopback network. The other file-access protocols are blocked but the socket layer is wide open.

**Fix sketch** (for Agent C or a follow-up):
```ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DENY_RANGES = [
  /^127\./, /^10\./, /^169\.254\./,
  /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./, /^::1$/i, /^fc/i, /^fd/i, /^fe80/i,
];

async function assertSafeHost(u: URL): Promise<void> {
  const host = u.hostname;
  const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of ips) {
    if (DENY_RANGES.some(re => re.test(address))) {
      throw new DocsFetchError(`blocked host range: ${address}`, "bad-protocol");
    }
  }
}
```

### Patch 2 — Wire rungs 4–7 into `FallbackStrategy` composition (HIGH)

**File:line**: `src/loop/fallback-strategies.ts` (new classes); `src/loop/autonomy-loop.ts` (registration).

**What**: add `AskPeerStrategy` (rung 4), `RecallStrategy` (rung 5), `WebSearchStrategy` (rung 6), `EscalateStrategy` (rung 7). Each wraps the corresponding MCP tool; `AutonomyLoop` composes them in rung order after the existing rungs 1–3.

**Why**: plan §2.1 describes the ladder as an automatic fallback chain. Today Phase 3 ships the rungs as tools the LLM may call; the loop itself doesn't walk them. Without this, "resourcefulness" is entirely a prompt-engineering concern and a distracted LLM will simply give up at rung 3.

### Patch 3 — Make worktree allocation the default in `cortex.ts` (MEDIUM)

**File:line**: `src/controller/cortex.ts` constructor / `initialize`; `src/orchestrator/orchestrator.ts:67` (comment update).

**What**: construct a `WorktreeManager` by default in `CortexController.initialize`, pass it into the `Orchestrator` constructor unless `process.env.CORTEXOS_WORKTREE === "off"`. Update the orchestrator doc-comment to reflect that the seam now defaults to enabled.

**Why**: plan §6 DoD says "mandatory." Today it's opt-in and the back-compat fallback is silent. Flipping the default honors the plan while preserving an escape hatch for broken-git environments.

## 9. Follow-ups for later phases

### Phase 3.5 (Dynamic Skill Loader)

- `tool_discovery` Haiku catalog should include dynamically-loaded skills once `skill_install` lands — i.e. the catalog becomes `NCHINDA_TOOL_SCHEMAS.concat(skillRegistry.listRegisteredTools())`.
- Worktree dedup race (§5.3) during rapid spawn→cancel: add a regression test.
- Prompt-injection caveat in `tool-discovery.ts` buildPrompt: switch from single-quoted interpolation to a fenced block or a dedicated `user_need` JSON field.

### Phase 4 (CDP + Social Drivers)

- `cdp_*` tools should register via the same `NCHINDA_TOOL_SCHEMAS` list `tool_discovery` reads from. Today that list is static; design a `registerToolSchema()` mutator so Phase 4 drivers plug in at startup.
- `docs_fetch` SSRF guard (patch 1) is a hard prerequisite before CDP social scraping — CDP navigation + `docs_fetch` chaining is how a social driver would exfiltrate AWS creds from a compromised worker pane.

### Phase 5 (Voice surfacing)

- Wire `EscalationsDB.listPending()` to the TTS + waveform "asking" state. The `kind:"error"` event with `payload.where === "escalation"` is the hook; a `ConsumerKind="voice"` subscriber should block on it.
- `nchinda_escalate` currently returns `escalation_id` immediately; the voice surface will need to `db.resolve(id, { resolution, resolved_by: "user" })` + emit a follow-up event so the caller agent can unblock. The schema already has `resolved_by` + `resolution` + `resolved_at` for this.
- Widen `AgentEvent` with a first-class `correlation_id` field so `ask_peer` can stop piggy-backing on `task_id` (§5.1 caveat).

---

## Final report

**Verdict**: ship-with-fixes. `phase3/integration` is clean: 351/351 tests green with coordination + utility merged. All §6 DoD items are demonstrated in code. Blockers are narrow.

**Top 3 issues**:
1. `docs_fetch` has no SSRF host filter — link-local + RFC1918 reachable (CRITICAL).
2. Ladder rungs 4–7 (§2.1) shipped as tools, NOT as `FallbackStrategy` subclasses — the autonomy loop doesn't automatically walk them (HIGH).
3. `WorktreeManager` is opt-in on the orchestrator seam; plan §6 says mandatory (MEDIUM).

**Main-merge blocked?**: **No** — patches 1 + 3 are small (< 60 LOC each); patch 2 is a follow-up that can land in Phase 3.5 behind a feature flag without holding Phase 3 back. Recommend merging `phase3/integration` → `main` AFTER patch 1 (SSRF) lands. Patches 2 + 3 can ship as a fast-follow.
