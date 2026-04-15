# Nchinda — Autonomous Multi-Agent Desktop Operator
## Master Plan (v1 · 2026-04-15)

> Nchinda is the agent; cortexOS is the platform. Nchinda lives inside cortexOS, runs on your Mac, listens for you, plans, delegates to specialist `claude` CLI instances in tmux, coordinates them like a team, learns from every task, and operates your computer like Iron Man's JARVIS.

---

## 1. Guiding Principles (non-negotiable)

### 1.1 Autonomy
Given a goal, Nchinda picks the method. It does not ask permission for reversible reads/lookups. It **does** confirm before any action that is external, irreversible, or involves your identity (DMs, email, payments, deletes, git push, deploy).

### 1.2 Resourcefulness
On failure, Nchinda tries an alternative *before* asking. The fallback chain is: (a) different tool, (b) reduced scope, (c) ask a peer agent, (d) search memory for a similar past failure, (e) search the web, (f) only then escalate to you. Every attempt is logged.

### 1.3 Learning
Every task leaves a trace in pgvector:
- `success` — positive exemplar, boosts recall for similar tasks
- `recovered` — failure path + the recovery that worked → anti-pattern + fix pattern
- `escalated` — surfaces to you for feedback, then written back tagged with your verdict

### 1.4 Proof of work
Every decision is emitted as a structured event on the bus. Mission Control surfaces a live journal so you trust without micromanaging.

### 1.5 Personality
Nchinda has a voice (not robotic TTS). It remembers you. It addresses you by name. It volunteers help when it notices something (e.g. "You haven't committed in 3 hours, want me to draft a message?"). Warm, confident, concise.

### 1.6 Hypothesis-driven action (Karpathy auto-research)
When facing uncertainty, Nchinda does not guess. It treats reasoning like science: enumerate hypotheses → design the smallest probe that distinguishes them → run probes in parallel → aggregate evidence into a brief → plan from evidence, not vibes. This is the Andrej Karpathy "research, don't answer" pattern. It is a first-class primitive, not an afterthought, and every agent can invoke it.

### 1.7 Self-extension
When Nchinda encounters a capability it doesn't have and no trusted external skill fits, it **creates** the skill itself. And once a skill is in use, Nchinda improves it over time — every run leaves telemetry; the consolidator reads that telemetry and proposes validated patches. The system is never static; skills evolve toward higher accuracy and lower latency with use. OpenClaw's self-improving skills are the reference.

### 1.8 Proactive agency
Nchinda does not wait silently. It observes the system — unfinished work, unsent drafts, unread email, stalled git trees, calendar gaps, battery, open-but-neglected apps — and **surfaces** or **acts** according to a proactivity mode you pick (`silent`, `volunteer`, `anticipatory`, `autonomous`). Proactivity is opt-in per sensor, rate-limited, and auditable. The goal is the feeling of a colleague who notices what you missed — never a nag, never a surveillance tool.

---

## 2. The Autonomy Loop (the heart of the system)

Every agent — including Nchinda-Core itself — runs this loop:

```
         ┌─────────────────────────────────────┐
         │                                     │
  RECALL ▶  PLAN ▶ ATTEMPT ▶ OBSERVE ▶ ADAPT ▶ REPORT
   ↑                                      │     │
   │                                      │     ▼
   │       (if failed, try next           │  MEMORY
   │        strategy in fallback chain)   │  (pgvector)
   │                                      │
   └──────────────────────────────────────┘
```

### 2.1 Fallback chain (Resourcefulness ladder)

| Rung | Action | When it fires |
|------|--------|--------------|
| 1 | Retry with the same tool, adjusted parameters | Transient error, rate-limit, timeout |
| 2 | Switch to alternate tool for same capability | Primary tool unavailable or hard-failing |
| 3 | Reduce scope (smaller unit, narrower query) | Capability failing on breadth |
| 4 | `nchinda_ask_peer(role, question)` | Another agent probably knows |
| 5 | `nchinda_recall(similar past failure)` | Memory might have the fix |
| 6 | `web_search` + `docs_fetch` | Documented external answer exists |
| 7 | `nchinda_escalate` | Everything above exhausted |

### 2.2 Hard escalation rules (never autonomous)

- 3 failed attempts on the same step → escalate
- Any irreversible external action → confirm (social DM, email send, payment, `rm -rf`, `git push --force`, deploy, delete row)
- Any action touching your identity or credentials → confirm
- Budget blown (time or tokens) → escalate

### 2.3 The Research Agent (Karpathy auto-research loop)

A dedicated role AND an MCP tool. Both exist.

**As a role** (`researcher` in the registry): Designer delegates here when the task has unknowns that can't be resolved from memory alone. Gets its own tmux pane (cyan), own worktree, own budget.

**As a tool** (`nchinda_research`): any agent can call it inline for quick investigations without spinning up a full pane.

**The loop** (runs inside both forms):

```
  QUESTION
     │
     ▼
  ┌──────────────────────────┐
  │ 1. HYPOTHESIZE           │   Generate 3–5 plausible explanations /
  │                          │   approaches. Structured output, each with
  │                          │   a priors-confidence (0..1).
  └──────────────────────────┘
     │
     ▼
  ┌──────────────────────────┐
  │ 2. DESIGN PROBES         │   For each hypothesis, the smallest
  │                          │   experiment that would confirm or falsify
  │                          │   it. Probes must be cheap and parallelizable.
  └──────────────────────────┘
     │
     ▼
  ┌──────────────────────────┐
  │ 3. EXECUTE IN PARALLEL   │   Probes run as concurrent tool calls
  │                          │   (web_search, docs_fetch, shell, cdp_*,
  │                          │   recall, peer-ask). Each probe writes its
  │                          │   result + observed evidence to a scratchpad.
  └──────────────────────────┘
     │
     ▼
  ┌──────────────────────────┐
  │ 4. UPDATE BELIEFS        │   Bayesian-flavored update: posterior =
  │                          │   prior × likelihood. Hypotheses are
  │                          │   confirmed, falsified, or inconclusive.
  └──────────────────────────┘
     │
     ▼
  ┌──────────────────────────┐
  │ 5. BRIEF                 │   Structured brief: winning hypothesis,
  │                          │   evidence, open questions, recommended
  │                          │   next action, confidence.
  └──────────────────────────┘
     │
     ▼
  ┌──────────────────────────┐
  │ 6. PERSIST               │   Brief embedded to pgvector with tag
  │                          │   `research_brief`. Recalled for future
  │                          │   similar questions. This is where the
  │                          │   "scientific thinking over time" payoff
  │                          │   compounds.
  └──────────────────────────┘
```

**Brief schema** (JSON):

```json
{
  "question": "…",
  "hypotheses": [
    { "h": "…", "prior": 0.3, "probe": "…", "result": "…", "posterior": 0.7, "verdict": "confirmed|falsified|inconclusive" }
  ],
  "winning": "hypothesis id",
  "evidence": ["url or pointer", "…"],
  "open_questions": ["…"],
  "recommended_action": "…",
  "confidence": 0.82,
  "cost_tokens": 4200,
  "cost_seconds": 18
}
```

**When to use role vs tool**:

| Situation | Form | Why |
|---|---|---|
| Plan phase has a critical unknown | Role (spawn `researcher`) | Needs budget and parallel probes |
| Coder hits an unfamiliar API error | Tool (inline `nchinda_research`) | Quick, local, don't need a pane |
| Designer unsure which library to pick | Role | Compare 3 libs in parallel = 3 probes |
| Operator needs platform login steps | Tool | Usually cached in memory after first research |

**Why this was the right instinct all along**: the failed first attempt had the embedder and pgvector but no hypothesis structure — it was just "store everything, hope the right thing comes back." Adding the H→P→R→B loop is what turns storage into science.

---

## 3. Current State Audit

### 3.1 What already exists in cortexOS (salvage, don't rewrite)

| Module | File | Quality |
|---|---|---|
| Tmux session lifecycle | `src/tmux/tmux-manager.ts` (uncommitted edits) | Solid foundation |
| Designer → executors flow | `src/orchestrator/orchestrator.ts` | Right shape, fragile text-scraping |
| Inter-agent messaging | `src/communication/message-bus.ts` | Works, persisted to pgvector |
| `@mention` routing | `src/communication/router.ts` | Works |
| pgvector + MiniLM memory | `src/memory/vector-store.ts`, `embedder.ts` | Works |
| Learning loop | `src/memory/learning-loop.ts` | Works |
| Multi-model agents | `src/agents/{claude,gemini,codex}-agent.ts` | Works |
| Telegram bot + IPC | `src/telegram/`, `src/ipc/` | Ready to extend |
| Roles registry | `src/agents/roles.ts`, `src/config/roles.ts` | Works |

### 3.2 What's broken or missing

| Gap | Consequence | Fix |
|---|---|---|
| No `Stop` hook — uses `waitForCompletion` polling + 120s timeout | "Agent is done?" is unreliable; timeouts kill in-flight work | Native Claude Code `Stop` hook → IPC server |
| No `PreCompact` hook | Context loss on `/compact` = "not self-aware" across sessions | Hook reads transcript JSONL, embeds, stashes in pgvector |
| Designer outputs free text → `parseAssignments()` scrapes it | Brittle — format drift silently breaks orchestration | Designer emits JSON via a tool call, not text |
| No MCP tools exposed to agents | Agents can't talk to core or each other programmatically | Ship `nchinda_*` MCP tool suite |
| No autonomy loop | Orchestrator is a pipeline, not an agent | Add Autonomy-Loop module with plan/try/adapt/report |
| No CDP browser | Chrome extension is unreliable; requires manual approval | `chrome --remote-debugging-port=9222` + Playwright `connect_over_cdp` |
| No voice | Not JARVIS yet | Wake word + streaming STT + TTS + VAD |
| No waveform UI | Can't tell when it's listening | `mission-control` canvas component + WebSocket audio stream |
| No git worktree per agent | Specialists step on each other's edits | Spawn adds `git worktree add` under a workspace root |
| No kill/standby policy | Every agent is either running or destroyed | Policy engine: keep idle agents warm with low TTL, kill on memory pressure |

---

## 4. Target Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  VOICE I/O LAYER                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐               │
│  │Porcupine │→ │ Whisper  │→ │ VAD +    │→ │ Piper/ElevenLabs TTS        │
│  │wake word │  │ (local)  │  │interrupt │  │                             │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘               │
│                                                                          │
│  WebSocket: audio RMS + state {idle|listening|thinking|speaking}         │
└──────────────────────────────────────┬───────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  NCHINDA CORE  (cortexOS daemon)                                         │
│                                                                          │
│  ┌──────────┐    ┌────────────┐    ┌──────────┐    ┌─────────────┐      │
│  │ Intent   │ →  │ Autonomy   │ →  │ Policy   │ →  │ Spawner     │      │
│  │ Classifier│   │ Loop       │    │ Engine   │    │ (tmux +     │      │
│  │(Haiku)   │    │(plan/try/  │    │(kill /   │    │ worktree)   │      │
│  │          │    │ adapt)     │    │ standby) │    │             │      │
│  └──────────┘    └────────────┘    └──────────┘    └─────────────┘      │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ Agent Registry (SQLite) · Event Bus (IPC) · Memory (pgvector)   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└──┬───────────────────┬───────────────────┬───────────────────┬──────────┘
   │                   │                   │                   │
   ▼                   ▼                   ▼                   ▼
┌──────────┐       ┌──────────┐       ┌──────────┐       ┌──────────┐
│ tmux:    │       │ tmux:    │       │ tmux:    │       │ tmux:    │
│Architect │       │ Coder    │       │ Tester   │       │ Operator │
│(green)   │       │(blue)    │       │(yellow)  │       │(magenta) │
│          │       │          │       │          │       │ + CDP    │
│ claude   │       │ claude   │       │ claude   │       │ claude   │
│ CLI      │       │ CLI      │       │ CLI      │       │ CLI      │
│          │       │          │       │          │       │          │
│ own git  │       │ own git  │       │ own git  │       │ browser  │
│ worktree │       │ worktree │       │ worktree │       │ context  │
└────┬─────┘       └────┬─────┘       └────┬─────┘       └────┬─────┘
     │                  │                  │                  │
     └── Stop hook ─────┴── PreCompact ────┴── Post-tool ─────┘
          (writes event to IPC; embeds transcript chunk to pgvector)

  MCP tools available to every agent:
    nchinda_send, nchinda_broadcast, nchinda_ask_peer,
    nchinda_recall, nchinda_remember, nchinda_escalate,
    cdp_navigate, cdp_click, cdp_type, cdp_screenshot,
    web_search, docs_fetch, shell, tool_discovery
```

---

## 5. Autonomy & Resourcefulness Primitives

### 5.0 Universal tool access (every agent, every tool)

Every spawned `claude` CLI gets **the full MCP tool suite** — no role-based whitelisting. The Coder can call `cdp_*`, the Operator can call `shell`, the Researcher can call `social_*`. Role is enforced via system prompt, not tool gating.

**Why**: we'd rather a specialist occasionally reach across lanes than have it blocked from a tool it genuinely needs. Resourcefulness > purity.

**Trade-off (honest)**: Claude focuses better when tool lists are short. We mitigate this by:
- System-prompt priming: "You are the Coder. Prefer `shell`, `cdp_*`, `nchinda_recall`. Only use `social_*` if a peer asks."
- Usage telemetry: if a role routinely uses tools outside its "preferred" set, that's a signal to rebalance roles — not to gate tools.
- `tool_discovery` meta-tool: for very long tool lists, Haiku pre-filters candidates before the main model sees them.

### 5.1 MCP tool suite (exposed to every spawned `claude` CLI)

| Tool | Signature | Purpose |
|---|---|---|
| `nchinda_send` | `(to_slot, body)` | Inject a message into another live agent's pane |
| `nchinda_broadcast` | `(body)` | Send to all live agents |
| `nchinda_ask_peer` | `(role, question, timeout_s)` | Blocking question to a peer; waits for reply event |
| `nchinda_recall` | `(query, k=5)` | Top-k memory search, filtered by current agent's role |
| `nchinda_remember` | `(content, outcome, tags)` | Explicit memory write (used in the loop's Report phase) |
| `nchinda_escalate` | `(question)` | Surfaces to user via voice + dashboard; blocks for answer |
| `nchinda_status` | `()` | Returns current agent registry — who's up, what they're doing |
| `cdp_navigate` | `(url)` | Browser nav via DevTools Protocol |
| `cdp_click`, `cdp_type`, `cdp_read_text`, `cdp_screenshot` | … | Browser interaction |
| `web_search` | `(query)` | Search-engine wrapper |
| `docs_fetch` | `(url)` | Smart page-to-text extractor |
| `tool_discovery` | `(need)` | Meta-tool: given a description, Haiku picks best MCP tool |
| `nchinda_research` | `(question, depth=normal\|deep)` | Inline Karpathy auto-research loop (§2.3) |
| `skill_discover` | `(need)` | Search GitHub for high-star repos matching capability |
| `skill_install` | `(repo_url, subpath?)` | Vet, clone, register as skill in `.claude/skills/` |
| `skill_use` | `(skill_name, args)` | Invoke an installed skill |
| `social_send` | `(platform, target, message)` | Generalized DM across IG/X/LinkedIn/Reddit/TikTok/etc. |
| `social_post` | `(platform, content)` | Publish on a platform (always confirmed) |

### 5.2 Dynamic skill acquisition (GitHub → `.claude/skills/`)

When Nchinda encounters a capability it doesn't have — say, "scrape TikTok profiles" or "convert Figma to React" — it doesn't give up or ask you. It fetches a skill.

**Discovery pipeline**:

```
  need description
       │
       ▼
  skill_discover(need)
       │  GitHub Search API:
       │    q = "<keywords>" stars:>100 pushed:>2025-01-01
       │    sort = stars desc
       │    license in (MIT, Apache-2.0, BSD-*, ISC)
       ▼
  top-5 candidates, ranked by: stars × recency × license-freedom
       │
       ▼
  skill_vet(candidate)
       │  - Size < 20 MB
       │  - No unknown shelled binaries
       │  - Has README or SKILL.md
       │  - Static scan for obvious secrets / eval / exec
       ▼
  escalate to user for FIRST install of a given skill
       │  (after confirmation, skill is trusted for future autonomous use)
       ▼
  skill_install(repo_url)
       │  git clone to .claude/skills/<skill_name>/
       │  parse SKILL.md (or auto-generate from README via Haiku)
       │  register tool signature in skill registry
       ▼
  skill_use(name, args)
       │  Runs skill inside a dedicated git worktree,
       │  with shell sandboxed (macOS sandbox-exec profile),
       │  network-allow-list per skill declaration.
       ▼
  Outcome (success/fail) logged to pgvector with tag
  `skill_usage:<name>` — skills that fail often get demoted;
  skills that succeed become preferred for similar needs.
```

**Skill registry schema** (SQLite):

| id | name | repo_url | commit_sha | installed_at | trust_level | preferred_for_tags | success_rate |
|---|---|---|---|---|---|---|---|
| … | `tiktok-scraper` | `github.com/…/tiktok-scraper` | `a1b2c3` | 2026-04-15 | `user-trusted` | `["social","scraping","tiktok"]` | 0.92 |

**Trust levels**:
- `unvetted` — cloned, not yet approved; can only run in dry-run mode
- `user-trusted` — you confirmed the first install; autonomous use OK
- `system-trusted` — >20 successful autonomous uses; used without friction
- `quarantined` — failure rate > 30% or produced unexpected network calls

**Announcement**: Nchinda speaks when pulling a new skill — "I don't have a TikTok driver; pulling `awesome-tiktok-scraper` (2.1k stars, MIT). Approve?" — so you always know when the tool surface is expanding.

### 5.3 Plan schema (Designer output — JSON via tool call)

```json
{
  "task_id": "uuid",
  "goal": "short human-readable goal",
  "complexity": "single-shot | multi-agent",
  "agents": [
    {
      "role": "coder|tester|pentester|ui-ux|researcher|operator|...",
      "color": "green|blue|yellow|magenta|cyan|red",
      "worktree": "feature/xyz",
      "system_prompt": "...",
      "task": "...",
      "success_criteria": "...",
      "budget": { "max_tokens": 80000, "max_minutes": 15 },
      "depends_on": ["other_agent_slot"]
    }
  ],
  "coordination": {
    "checkpoints": ["every_10min", "on_step_complete"],
    "reporting_to": "slot_0"
  }
}
```

---

## 5.4 Social Operator Layer (generalized beyond IG)

A single abstraction `social_send(platform, target, message)` with per-platform drivers. Each driver implements a common interface, so roles above don't care which platform.

### 5.4.1 Driver interface

```ts
interface SocialDriver {
  platform: 'ig' | 'x' | 'linkedin' | 'reddit' | 'tiktok' | 'discord' | 'telegram' | 'whatsapp' | 'imessage';
  transport: 'api' | 'cdp' | 'native-app' | 'appleScript';
  loginCheck(): Promise<'logged-in' | 'expired' | 'never'>;
  resolveTarget(handle: string): Promise<{ id: string; display: string; avatar?: string }>;
  openConversation(targetId: string): Promise<void>;
  typeMessage(msg: string): Promise<void>;
  confirmAndSend(): Promise<{ ok: boolean; messageId?: string }>;
  sendPost?(content: PostContent): Promise<{ ok: boolean; postId?: string }>;
}
```

### 5.4.2 Driver selection matrix

| Platform | Preferred transport | Fallback | Notes |
|---|---|---|---|
| Instagram | CDP (web) | Native app via AppleScript | DM API is restricted to Meta partners |
| X / Twitter | API v2 if key present | CDP (web) | API preferred; CDP for read-only without key |
| LinkedIn | CDP (web) | — | API is heavily gated |
| Reddit | API via PRAW | CDP fallback | API key is free |
| TikTok | CDP (web) | — | No public DM API |
| Discord | API via bot | — | Bot token setup required |
| Telegram | API (already exists in cortexOS) | — | Reuse existing bot infra |
| WhatsApp | macOS native app + AppleScript | — | No automation-friendly API |
| iMessage | AppleScript | — | Native only |

### 5.4.3 Universal flow

1. `social_send("tiktok", "@jobed", "hey")` called
2. Registry picks `tiktok-driver` (CDP)
3. `loginCheck()` → `logged-in`; if `expired`, Nchinda speaks "TikTok login expired, please log in in the browser I just opened" and waits
4. `resolveTarget("@jobed")` → profile id
5. `openConversation(id)`
6. `typeMessage(msg)` — text appears in the input field but NOT submitted
7. `confirmAndSend()` always triggers escalation (voice + dashboard modal): "Send to @jobed on TikTok: 'hey' — confirm?"
8. On user confirm → click Send; on deny → abort + log
9. Outcome persisted to `social_actions` table: `(platform, target, message, sent_at, outcome, driver_version)`

### 5.4.4 Skills integration

Each new platform driver starts as an installable skill (§5.2). The initial set (IG, X, LinkedIn, Reddit, TikTok) ships built-in; new ones (e.g. Bluesky, Mastodon, Threads) arrive via `skill_discover` on demand.

### 5.4.5 Safety rails (non-negotiable) — social

- **Always** human-confirm the first send to a given contact on a given platform. Subsequent sends within 24h to the same contact on the same platform can be auto-confirmed if explicitly delegated ("Nchinda, you don't need to ask me every time for Jobed on IG today")
- Rate limits per platform are enforced platform-side; Nchinda layers its own conservative limits (e.g. max 20 DMs/platform/hour) to avoid bans
- Every send logged with full payload for audit
- If a platform detects automation (captcha, unusual-activity flag), driver fails fast and escalates — we don't fight captchas

---

## 5.5 Skill Creation & Evolution (the meta-skill)

When `skill_discover` returns nothing acceptable — or the top candidates fail vetting — Nchinda does not stop. It invokes `skill_create`, the meta-skill that writes new skills. And once a skill exists, the **Evolution Loop** improves it over time with use.

### 5.5.1 Skill creation flow

```
    need description
         │
         ▼
  ┌──────────────────────────┐
  │ 1. INVESTIGATE           │   Runs nchinda_research (§2.3):
  │                          │   what libs/APIs/CLIs exist for this?
  │                          │   Minimum viable contract?
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ 2. DESIGN CONTRACT       │   SKILL.md skeleton: name, purpose,
  │                          │   inputs, outputs, preconditions,
  │                          │   dependencies, network requirements.
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ 3. TDD SCAFFOLD          │   Tests written first (from contract):
  │                          │   happy path + 2 failure cases + 1 edge.
  │                          │   Test harness in .claude/skills/<name>/tests/
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ 4. IMPLEMENT             │   Code generated against tests.
  │                          │   Iterates until all tests green.
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ 5. VET                   │   Same vet pipeline as external skills
  │                          │   (size, scan, sandbox profile).
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ 6. REGISTER              │   Trust level = `system-authored` — higher
  │                          │   than `unvetted` (we know its provenance),
  │                          │   lower than `system-trusted` (not yet proven).
  └──────────────────────────┘
         │
         ▼
  ┌──────────────────────────┐
  │ 7. INVOKE                │   Runs once as validation; result logged
  │                          │   to the usage ledger → feeds §5.5.3.
  └──────────────────────────┘
```

### 5.5.2 Skill usage ledger (telemetry every skill writes)

Every skill invocation — whether downloaded, created, or evolved — writes a row:

```ts
interface SkillRun {
  run_id: string;
  skill_name: string;
  skill_version: string;
  input_hash: string;            // sha256 of serialized input, for dedup
  input_category: string;         // classified by Haiku: "search" | "write" | etc.
  output_summary: string;         // short, vectorized for recall
  outcome: 'success' | 'fail' | 'partial' | 'escalated';
  latency_ms: number;
  token_cost?: number;
  error_msg?: string;
  error_class?: string;           // "NETWORK" | "AUTH" | "PARSE" | ...
  timestamp: Date;
}
```

### 5.5.3 The Skill Evolution Loop (self-improvement)

Runs as a background consolidation worker (the ruflo `consolidate` worker is the natural home). Triggered daily or after every 50 skill runs, whichever first.

```
  SkillRun rows (last N days)
           │
           ▼
  ┌──────────────────────────┐
  │ A. CLUSTER FAILURES      │   Group runs by (error_class, input_category).
  │                          │   Clusters with ≥3 runs become "patch candidates".
  └──────────────────────────┘
           │
           ▼
  ┌──────────────────────────┐
  │ B. PROPOSE PATCH         │   For each candidate cluster, a coder agent
  │                          │   reads the skill + failure traces + research
  │                          │   loop on the error class. Emits a PatchSet.
  └──────────────────────────┘
           │
           ▼
  ┌──────────────────────────┐
  │ C. VALIDATE              │   Apply patch in a git worktree for the skill.
  │                          │   Run:
  │                          │    (1) existing test suite — must all pass
  │                          │    (2) historical replay — run last 100 real
  │                          │        inputs, compare outcome. No regressions.
  │                          │    (3) benchmark — latency must not regress >10%.
  └──────────────────────────┘
           │
           ▼
  ┌──────────────────────────┐
  │ D. APPLY + VERSION       │   Merge worktree, bump skill version,
  │                          │   append entry to SKILL.md changelog,
  │                          │   git commit with "evolve: <rationale>".
  └──────────────────────────┘
           │
           ▼
  ┌──────────────────────────┐
  │ E. ANNOUNCE              │   Nchinda voices (per proactivity mode):
  │                          │   "Your `tiktok-scraper` skill evolved —
  │                          │   29% faster, fixed auth edge case."
  └──────────────────────────┘
```

### 5.5.4 Evolution safety rails

- **No evolution without tests.** Skills shipped without tests get a `needs_tests` flag; Nchinda writes tests first (autonomously) before any evolution is attempted.
- **No evolution that fails replay.** If the patched skill produces different outputs on historical real inputs, the patch is rejected and logged as a proposal-failure.
- **No evolution on user-vetted skills without re-confirmation.** If a `user-trusted` external skill is being rewritten beyond a diff threshold (>30% code delta), user confirms before merge.
- **Evolution version cap per week.** Max 3 evolutions per skill per 7 days to avoid thrash.

### 5.5.5 Skill lifecycle states

```
    created / installed
           │
           ▼
      unvetted ───── first use confirm ─────► user-trusted
                                                    │
                                    20 successful autonomous runs
                                                    │
                                                    ▼
                                             system-trusted
                                                    │
                                   failure-rate > 30% (rolling 7d)
                                                    ▼
                                              quarantined
                                                    │
                                       remains failing after
                                       3 evolution attempts
                                                    ▼
                                              deprecated
```

A `deprecated` skill stays in the registry for history but is never auto-invoked; user can manually resurrect.

---

## 5.6 Persistent Scheduler (cron-backed autonomy)

Nchinda runs scheduled actions — the way OpenClaw does. Reminders, recurring summaries, watchdog checks, time-triggered research. This is orthogonal to event-triggered proactivity (§5.7).

### 5.6.1 Architecture

Hybrid: `launchd` for boot-time daemon start; application-level scheduler (node-cron) for dynamic jobs. All jobs live in a SQLite `cron_jobs` table.

### 5.6.2 Schema

```ts
interface CronJob {
  id: string;
  name: string;                     // human-readable
  cron_expr: string;                 // "0 8 * * 1-5" standard cron
  task: string;                      // natural-language task description
  role_hint?: AgentRole;             // preferred spawn role
  depth?: 'single-shot' | 'multi-agent';
  enabled: boolean;
  timezone: string;                  // IANA (e.g. "America/New_York")
  last_run?: Date;
  next_run: Date;
  outcome_history: Array<{
    run_at: Date;
    outcome: 'success' | 'fail' | 'escalated';
    duration_ms: number;
    summary?: string;
  }>;
  created_by: 'user' | 'nchinda_proactive' | 'skill_install' | 'onboarding';
  created_at: Date;
}
```

### 5.6.3 Example jobs Nchinda ships with (user can enable during onboarding)

| Name | When | What |
|---|---|---|
| `morning_brief` | `0 8 * * *` | Summarize overnight emails/messages; draft 3 priority replies |
| `git_watchdog` | `0 */2 * * *` | Check all known repos for uncommitted work > 2h; nudge gently |
| `inbox_zero_friday` | `0 17 * * 5` | Draft responses to all unanswered email threads ≥2 days old |
| `meeting_prep` | `*/10 * * * *` | If meeting starts in 30min and has no prep doc, draft one |
| `skill_evolution_tick` | `0 3 * * *` | Run the skill evolution loop (§5.5.3) |
| `memory_consolidation` | `0 4 * * *` | Dedupe memories, promote canon patterns |

### 5.6.4 Natural-language cron creation

Nchinda can create crons from your voice:
- "Remind me every Friday at 5pm to review the week" → creates cron + reminder action
- "Stop the morning brief" → disables job
- "You don't need to check email on weekends" → modifies cron_expr

And Nchinda can **propose** crons based on observed patterns:
- Notices you check Slack every morning at 9:15 ± 5min for 10 days → "Want me to brief you on Slack at 9:15 every weekday?"

### 5.6.5 Safety rails — scheduling

- Jobs run inside the Autonomy Loop (§2) — same plan/try/adapt/report
- Jobs that escalate in 3 consecutive runs get auto-paused
- Any cron job that would trigger an irreversible external action (send message, payment) still requires user-confirm at runtime — cron can't bypass §2.2
- Cron registry is fully visible in mission-control (list, edit, pause, disable)

---

## 5.7 Proactive Sensors & System Awareness

This is the layer that turns Nchinda into something that feels like a colleague. Sensors observe the system; a Proactivity Policy decides whether to speak, act, or stay silent. Access to the whole system is the prerequisite — handled in Phase 0.

### 5.7.1 Sensor catalog

| Sensor | What it detects | Mechanism | Interval | Default mode |
|---|---|---|---|---|
| `unfinished_work` | Repos with uncommitted work > 2h; recently edited files with `TODO`/`FIXME`; dangling diffs | `git status` over watchlist + lightweight AST scan | 15 min | volunteer |
| `unsent_drafts` | Drafts in Mail.app, iMessage, Telegram, Slack; text fields with content + idle > 5 min | FDA-read drafts databases; Accessibility API for live fields | 10 min | volunteer |
| `unread_email` | New/important email prioritized by sender-reply-rate | Read Mail.app envelope index (FDA) | 5 min | volunteer |
| `calendar_gap` | Meetings in next 30 min with no prep doc / agenda | macOS EventKit | 10 min | anticipatory |
| `system_health` | Battery < 20%, disk > 90%, stuck or runaway processes | `sysctl`, `df`, `ps` | 5 min | volunteer |
| `app_attention` | App open > 30 min without focus | `NSWorkspace` active-app events | passive | silent |
| `focus_violation` | Distracting app opened during a declared focus block | `NSWorkspace` + focus-mode integration | passive | volunteer |
| `screen_context` (opt-in) | Vision inference on periodic screenshots — "what is the user working on" | `screencapture` + Claude vision | 5 min or idle-triggered | silent (off by default) |

Each sensor has:
- **Enable toggle** (global + per-sensor)
- **Sampling rate** (user-tunable)
- **Retention** (observations older than N days expire from the local store)
- **LLM boundary** (what, if anything, leaves the local box — some sensors never do)

### 5.7.2 Proactivity modes

User picks one, changeable via voice ("Nchinda, go quiet for an hour") or dashboard:

| Mode | Speaks? | Takes action? | When appropriate |
|---|---|---|---|
| `silent` | Never, unless asked | Never autonomously | Recording, presenting, deep focus |
| `volunteer` | At most 1×/30min, always a question | No | Default for most users |
| `anticipatory` | Same rate limit, but pre-drafts responses | Drafts only (reversible), e.g. saves email reply to drafts folder | Power users who want prep |
| `autonomous` | Speaks for irreversibles only | Takes all reversible actions without asking | Expert users who've earned trust over time |

### 5.7.3 Urgency scoring

Each observation gets a score `urgency = f(time_sensitivity, reversibility, user_history_weight)`. The policy engine uses this score × current mode × quiet-hours to decide: **speak now**, **bundle for next session**, or **log only**.

Examples:
- Email from your boss at 11pm, unread → urgency high but quiet-hours active → log + surface at morning's `volunteer` window
- Meeting in 15 minutes with no prep doc → urgency critical + not quiet-hours → interrupt with a short vocal nudge regardless of mode
- Unused app open 45 min → urgency very low → log only

### 5.7.4 Pending Surface (dashboard page)

New mission-control page: **Pending Surface**. Single unified list of every observation Nchinda has made but not yet acted on. Grouped by kind, with quick actions:
- `[Reply]` on unread email → spawns operator with draft
- `[Commit]` on uncommitted repo → spawns coder with commit message draft
- `[Skip]` → suppress this type of observation for 24h
- `[Never]` → disable sensor for this source

### 5.7.5 Privacy, consent, and audit

- Sensors never send observations to any LLM API unless the user explicitly takes an action on that observation (e.g. clicks `[Reply]`)
- All sensor data is local-only by default; explicit per-sensor toggle to allow LLM processing
- Daily audit log: "Nchinda ran 247 sensor samples today. 12 were surfaced. 3 resulted in actions you approved."
- One-click "pause all sensors" for sensitive moments

---

## 5.8 Whole-System Access (macOS permissions)

Proactive agency and many sensors require specific macOS permissions. These are explicit, auditable, per-capability. User is walked through each during onboarding (§Phase 0); every permission is revocable; each sensor declares which permissions it needs and degrades gracefully if denied.

| Permission | What unlocks | Prompt copy |
|---|---|---|
| **Accessibility** | Read/write UI across apps (drafts, live text fields, focus) | "Nchinda uses this to see when you've typed a message but haven't sent it" |
| **Automation** (per app) | AppleEvents — scripting Mail, Messages, Calendar, etc. | "Nchinda uses this to draft replies and move messages on your behalf" |
| **Full Disk Access** | Read Mail, Messages, Calendar, Notes databases | "Nchinda uses this to summarize your inbox; nothing leaves your Mac unless you ask" |
| **Screen Recording** | `screencapture` for `screen_context` sensor (opt-in) | "Only if you enable the screen context sensor. Off by default." |
| **Microphone** | Wake word + voice input | "Required for voice. Can be disabled per session." |
| **Input Monitoring** | Global hotkey fallback (⌘⇧Space) | "Only used for the voice-toggle hotkey." |
| **Notifications** | Dashboard + voice surfacing | "So Nchinda can surface things without being loud." |

Everything behind these permissions stays on-device by default. Any capability that would send data off-device (LLM API calls) shows a clear prompt the first time, with a remember-my-choice toggle per data category.

---

- **Always** human-confirm the first send to a given contact on a given platform. Subsequent sends within 24h to the same contact on the same platform can be auto-confirmed if explicitly delegated ("Nchinda, you don't need to ask me every time for Jobed on IG today")
- Rate limits per platform are enforced platform-side; Nchinda layers its own conservative limits (e.g. max 20 DMs/platform/hour) to avoid bans
- Every send logged with full payload for audit
- If a platform detects automation (captcha, unusual-activity flag), driver fails fast and escalates — we don't fight captchas

---

## 6. Phased Roadmap

### Phase 0 — Pre-flight: Permissions, Consent, Installer (½ week)
1. Installer script: checks for tmux, Postgres, pgvector, Chrome, Node, Python, ffmpeg; installs missing via Homebrew where possible
2. Onboarding CLI/UI: walks user through the 7 macOS permissions (§5.8), one at a time, with plain-language copy
3. Consent document: short, per-capability, stored in `~/.cortexos/consent.json` with checksums; re-prompts when Nchinda gains a new capability
4. Audit log scaffolding: `~/.cortexos/audit.ndjson` that records every sensor sample, action, escalation, skill install
5. LaunchAgent plist for `cortexos` daemon (autostart on login)
6. First-run: user records their name + preferred address form ("Cedric", "Joel", "Mr. Yantio") + picks a wake word (default: "Nchinda")

**DoD**: fresh install on a Mac gets from zero to "Nchinda, are you there?" working in under 10 minutes, with all permissions explicitly and clearly consented.

### Phase 1 — Foundation (Week 1) — *fixes reliability*
1. Run `ruflo init` inside cortexOS → inherit 7 hook types + worker scaffolding
2. Write `Stop` hook script in `.claude/hooks/` → POSTs to `ipc/server.ts`
3. Write `PreCompact` hook → reads `~/.claude/projects/.../*.jsonl`, chunks, embeds, stashes in `memories` table tagged `(session_id, task_id, kind=transcript)`
4. Rewrite designer output contract: structured JSON via new `emit_plan` tool call
5. Replace `waitForCompletion` timeout polling with IPC event subscription
6. Lock SQLite Agent Registry schema: `agents(id, role, color, tmux_session, worktree, status, task_id, started_at, last_heartbeat)`
7. Commit the currently-uncommitted `tmux-manager.ts` edits first (don't lose in-flight work)

**Definition of done**: spawn an architect, have it emit a JSON plan, spawn 2 executors, they all report via Stop hook, registry reflects it, no timeouts used.

### Phase 1.5 — Persistent Scheduler (Week 1, parallel track)
1. `src/scheduler/scheduler.ts` — node-cron based ticker reading `cron_jobs` SQLite table
2. Job spawn wraps Autonomy Loop — no special path
3. Natural-language cron creation via voice or text (Haiku parses "every Friday at 5pm" → cron expr)
4. 5 default jobs pre-seeded but disabled (user opts in during onboarding)
5. Dashboard: cron list / edit / pause / history page

**DoD**: schedule "every minute print 'alive'" works; schedule "every weekday at 8am draft a morning brief" fires and completes within the autonomy loop; outcome history populates.

### Phase 2 — Autonomy Loop (Week 2)
1. `src/loop/autonomy-loop.ts` — the plan/try/adapt/report state machine
2. Intent classifier (`src/loop/classifier.ts`, Haiku) — single-shot vs multi-agent routing
3. Escalation rules engine (`src/loop/policy.ts`)
4. `nchinda_recall` + `nchinda_remember` MCP tools
5. Wire the loop into the orchestrator as the outer shell

**DoD**: give Nchinda a task that's *designed* to fail on first attempt; it recovers via the fallback chain without asking.

### Phase 2.5 — Research Agent (Week 2, parallel track)
1. Implement the H→P→R→B loop (§2.3) as `src/research/research-loop.ts`
2. Expose it two ways: as an MCP tool `nchinda_research` AND as a spawnable role `researcher` (cyan pane)
3. Brief schema + persistence with tag `research_brief` in pgvector
4. Recall integration: Designer's Plan phase auto-recalls top-3 relevant briefs before planning

**DoD**: ask Nchinda an open question with unknowns ("should we migrate from pg to sqlite for the registry?"); it enumerates 3+ hypotheses, runs parallel probes (doc-fetch + benchmark shell + recall), produces a structured brief with confidence. The brief gets recalled next time a similar question is asked.

### Phase 3 — Resourcefulness Primitives (Week 3)
1. Full `nchinda_*` MCP tool suite (send, broadcast, ask_peer, status, escalate)
2. `web_search`, `docs_fetch`, `shell`, `tool_discovery` tools
3. Git worktree per agent (mandatory) — `workspace/<agent_id>/`
4. Standby vs kill policy: idle agents keep session but sleep; memory-pressure triggers LRU kill

**DoD**: two agents collaborating mid-flight — coder asks tester "does this pass the contract test?" via `nchinda_ask_peer`, tester replies, coder continues.

### Phase 3.5 — Dynamic Skill Loader (Week 3, parallel track)
1. `src/skills/discover.ts` — GitHub Search API wrapper (stars + license + recency filters)
2. `src/skills/vet.ts` — size, license, static-scan, no-eval checks
3. `src/skills/install.ts` — git clone, SKILL.md parse (Haiku auto-generate if missing), registry insert
4. `src/skills/runner.ts` — sandboxed execution (macOS `sandbox-exec` profile, network-allow-list per skill)
5. MCP tools: `skill_discover`, `skill_install`, `skill_use`
6. Skill registry SQLite schema + trust levels

**DoD**: voice command "Nchinda, scrape the Hugging Face papers page". System has no such skill; searches GitHub; finds e.g. `awesome-hf-scraper` (MIT, 500 stars); speaks "I don't have this, pulling `awesome-hf-scraper`, approve?"; on approval, installs and runs it, returns results.

### Phase 3.7 — Skill Creation & Evolution (Week 3-4)
1. `src/skills/create.ts` — meta-skill implementing §5.5.1 (investigate → contract → TDD → impl → vet → register → invoke)
2. `src/skills/ledger.ts` — SkillRun telemetry schema + writer, used by every skill invocation via a shared wrapper
3. `src/skills/evolve.ts` — the evolution loop (§5.5.3): cluster failures, propose patches, validate, apply
4. Hook `skill_evolve_nightly` into the `consolidate` worker (already in ruflo)
5. Evolution safety rails: test-required, replay-required, regression-budgets, per-week evolution cap
6. Skill lifecycle state machine (§5.5.5) + dashboard visualization
7. Voice hooks for announcements: "Your `tiktok-scraper` skill evolved — 29% faster, auth fix applied."

**DoD (create)**: voice command for a capability no GitHub skill exists for ("Nchinda, I need to diff two videos frame-by-frame"). System investigates, writes SKILL.md + tests + implementation, validates, registers, and invokes it — all without user intervention beyond initial consent.

**DoD (evolve)**: inject 5 artificial failure patterns into a skill's log. Evolution loop detects cluster, proposes patch, validates against historical replay, applies, and the version bumps. No regressions.

### Phase 4 — Browser via CDP + Social Operator Layer (Week 4)
1. `src/browser/cdp.ts` — launcher + Playwright `connect_over_cdp` wrapper
2. MCP tools: `cdp_navigate`, `cdp_click`, `cdp_type`, `cdp_read_text`, `cdp_screenshot`, `cdp_wait_for`
3. `src/social/` — driver layer per §5.4: `ig-driver.ts`, `x-driver.ts`, `linkedin-driver.ts`, `reddit-driver.ts`, `tiktok-driver.ts`, `discord-driver.ts`, `telegram-driver.ts` (reuse existing bot), `imessage-driver.ts` (AppleScript)
4. `social_send` / `social_post` universal dispatch
5. Confirm-before-send modal + voice confirmation flow
6. Login-state cache with auto-refresh-prompt flow
7. Conservative per-platform rate limits
8. Acceptance test: **multi-platform DM flow** — "DM Jobed on IG, X, and LinkedIn 'quick chat today?'" → three drivers execute in parallel, three confirmation prompts batched into one UI modal

**DoD**: cross-platform DM to yourself succeeds end-to-end; zero Chrome-extension approvals; expired-login flow handled gracefully; all sends logged to `social_actions` audit table.

### Phase 5 — Voice (Week 5)
1. Wake-word: `pvporcupine` keyword "Nchinda" (train custom keyword)
2. STT: `whisper.cpp` streaming (local) with 500ms chunks
3. VAD + interruption detection (port from `Cedric-Joel-YantioII/jarvis` — already shipped "wake detection + interruption reliability" in v0.4.0)
4. TTS: Piper (local, fast, warm voice) + ElevenLabs fallback for personality moments
5. Audio state machine publishes `{rms, state}` over WebSocket to mission-control
6. Hotkey fallback (⌘⇧Space) for noisy environments

**DoD**: "Nchinda, what's running?" → he hears you, replies verbally with current registry, dashboard waveform animates.

### Phase 5.5 — Proactive Sensors & System Awareness (Week 5-6)
1. `src/sensors/` — each sensor is a module implementing a common interface (`sample()`, `describe()`, `permissions_required()`, `privacy_level`)
2. Implement 7 default sensors (§5.7.1): unfinished_work, unsent_drafts, unread_email, calendar_gap, system_health, app_attention, focus_violation. `screen_context` stubbed, off by default
3. `src/proactivity/policy.ts` — urgency scoring + mode-aware decision (speak/bundle/log)
4. `src/proactivity/modes.ts` — silent/volunteer/anticipatory/autonomous, changeable at runtime
5. Observation event bus + SQLite `observations` table with retention policy
6. Pending Surface page in mission-control
7. Voice interactions: "Nchinda, what's pending?", "go quiet for an hour", "never mention X again"
8. Privacy audit log + daily summary view

**DoD**: enable 3 sensors (unfinished_work, unread_email, calendar_gap) in `volunteer` mode. Real unfinished git work + a test email + a real meeting all trigger observations. One gets surfaced as a voice prompt; others appear on Pending Surface. Hitting "Skip" on one suppresses it for 24h. Nothing is sent to an LLM API unless the user clicks an action button.

### Phase 6 — Mission Control UI wiring (Week 6)
1. WebSocket bridge `src/ui/ws-bridge.ts` → publishes events: agent_spawned, agent_done, message_sent, memory_written, audio_state, wake_detected
2. Wire existing `mission-control` pages to consume events
3. **Nchinda Waveform component** (see §7 below) — top-right of header, persistent across pages
4. Live agent roster with color-coded pane tiles + kill/standby/follow buttons
5. Activity journal streaming IPC events
6. Memory browser: pgvector top-k search UI + tag filters
7. Confirmation modal for escalations (physical button + voice "yes")

**DoD**: a task runs end-to-end visible in the dashboard; waveform pulses while listening; you can interrupt via voice or UI.

### Phase 7 — Learning + Hardening (Week 7+)
1. Nightly consolidation worker (runs via `.claude-flow/` consolidate worker): dedupe memories, promote frequent success patterns to a higher-weight "canon" namespace
2. Anti-pattern detection: cluster failures; tag clusters with "avoid"
3. Success-rate dashboard per role
4. 100-task stress test — random tasks of varied complexity; measure autonomy % (tasks completed without escalation)
5. Budget + observability — per-agent token spend, per-task wall time

---

## 7. Mission Control — Nchinda Waveform Spec

### 7.1 Location & always-on
Top-right of the header bar, persistent across all pages. 200×64px default, click to expand.

### 7.2 States

| State | Visual | Data source |
|---|---|---|
| `idle` | Slow ambient pulse, 30% opacity sine, copper color | Heartbeat only |
| `listening` | Live waveform bars driven by mic RMS, 60fps | WS `{rms: 0-1}` |
| `thinking` | Indeterminate shimmer (gradient wave travelling L→R) | State flag |
| `speaking` | Waveform driven by TTS output audio level | WS `{rms: 0-1}` from TTS out |
| `error` | Red pulse, 2s cadence | Last event has `level=error` |

### 7.3 Tech
- Canvas 2D + `requestAnimationFrame` at 60fps
- Source: `ws://localhost:3100/audio` emitting `{rms, state, caption?}` at 30Hz
- Caption strip below waveform shows live STT partials when `state === "listening"`
- Click → full-screen **Conversation overlay**: live transcript, mic meter, interrupt button (big), "stop listening" toggle

### 7.4 Component file
`mission-control/src/components/dashboard/nchinda-waveform.tsx` (uses existing `glass-card` for frame consistency)

### 7.5 Tiny state contract
```ts
type NchindaWaveState = {
  state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
  rms: number;              // 0..1 instantaneous
  caption?: string;          // live STT partial
  lastEventAt: number;       // ms epoch; if > 10s stale, show disconnected
};
```

---

## 8. Definition of "Working" — MVP line

**MVP (Phase 1 + 2 + minimal 5 + minimal 6)** ≈ ~3 focused weeks:

- You say "Nchinda, review my PR and tell me if it's safe to merge"
- Wake word fires, waveform goes `listening`, STT transcribes
- Classifier: multi-agent. Spawns architect (green), reviewer (blue), security (red) in tmux, each in its own worktree
- Architect produces JSON plan, reviewers work in parallel, communicate via `nchinda_send`
- Architect consolidates, Nchinda speaks the verdict back to you + shows it in dashboard
- Memory persists; next day you say "what did we find in yesterday's review?" and it recalls via pgvector

Everything else (CDP, voice personality, full UI polish, learning consolidation) layers on top.

---

## 9. Risks & Honest Caveats

| Risk | Mitigation |
|---|---|
| Claude CLI `Stop` hook format drift | Pin claude-code version; contract-test the hook payload |
| `tmux send-keys` quoting hell with free-form text | Use heredoc files + `load-buffer` + `paste-buffer`; never inline-quote raw strings |
| pgvector 384-dim may be too weak for long-horizon recall | Tracked; can upgrade to 1536-dim bge-large later without schema break |
| Agent specialists stepping on each other's edits | Mandatory git worktree per agent from Phase 3 |
| Voice wake word false-positive on TV/podcast noise | Confidence threshold + cooldown; dashboard toggle to mute |
| CDP Chrome quit kills debugging session | Dedicated profile dir + relaunch watchdog |
| 7 phases is a lot | MVP is 3. Everything after MVP is iterative, can be deferred |
| Cost of always-on Claude instances on standby | Standby = tmux pane held open, `claude` CLI idle (no tokens burning); only re-activates on `send-keys` |
| Universal tool access overwhelms model focus | System-prompt role priming + `tool_discovery` meta-tool pre-filter for very long lists |
| GitHub-sourced skill runs malicious code | Vet step + first-install user confirm + sandbox-exec + network allow-list + trust-level progression |
| Auto-research loop over-spends tokens on easy questions | Depth parameter defaults to `normal` (max 3 hypotheses, 3 probes, 2min budget); `deep` requires explicit opt-in or a complexity threshold |
| Social driver breaks when platform ships UI changes | CDP drivers are auto-healing (element resolution via multiple selectors + vision fallback); each failure triggers a research loop to find new selectors |
| Cross-platform DM fan-out could look spammy | Rate limits enforced per-platform; any fan-out > 3 recipients requires explicit "yes this is a broadcast" confirmation |
| Self-written skill introduces a subtle bug | Tests required before evolution; historical-replay gate; user-confirm on large diffs of user-trusted skills; evolution version cap per week |
| Skill evolution silently drifts skill behavior | Every evolution commits to git + SKILL.md changelog; diff viewable in mission-control; user can roll back with one click |
| Cron job runs during a meeting, interrupts you | Quiet-hours respected by scheduler AND policy engine; `silent` mode globally suppresses scheduled voice output |
| Sensors feel like surveillance | Local-only by default, per-sensor toggles, retention limits, clear audit log, one-click pause-all, explicit consent at each new capability |
| Proactive agency becomes annoying | Rate limits (max 1 voice surface / 30 min in `volunteer`), "never mention X" suppression, user-trainable priority (teach by accepting/rejecting surfaces) |
| Whole-system permissions too invasive for some users | Every sensor degrades gracefully when its permission is denied; onboarding is skippable per permission; sensors declare which permissions they need so users can cherry-pick |

---

## 10. Immediate Next Action

**Today, in order**:

1. Commit the in-flight `src/tmux/tmux-manager.ts` edits (don't lose them; do it before anything else)
2. Run `ruflo init` inside `~/Documents/Github/cortexOS` to inherit the hook scaffolding
3. Write `.claude/hooks/stop.sh` — ~30 lines, POSTs `{session_id, transcript_tail, exit_reason}` to `ipc/server.ts`
4. Extend `ipc/server.ts` with a `/hooks/stop` endpoint that writes to the Agent Registry and fires a `done` event on the bus
5. Replace `orchestrator.waitForCompletion` with event-driven subscription (`await bus.once({kind: 'done', slot})`)
6. Run the architect→2-executor flow end-to-end; no polling, no timeouts

**Estimated effort**: 1 solid morning. Unblocks everything in Phase 1.

---

## 11. Naming & conventions locked

- **Platform**: cortexOS (folder stays, imports stay)
- **Agent persona**: Nchinda (voice, name, TTS persona, memory owner)
- **Prefix for MCP tools**: `nchinda_*` (not `cortex_*`)
- **tmux session prefix**: `cortexos_*` (stays — it's internal)
- **Worktree root**: `~/.cortexos/workspaces/<agent_id>/`
- **Memory namespace**: `nchinda` (so future platforms don't collide)
- **Audio WS port**: 3100 · Event WS port: 3101 · IPC port: 3102
