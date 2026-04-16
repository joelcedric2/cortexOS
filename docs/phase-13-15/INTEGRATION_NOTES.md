# Phase 13-15 Integration Notes

**Integrator:** Tester 2 (`phase13-15/integration` worktree)
**Branches merged:** `phase15/rewind` → `phase14/conv-intent` → `phase13/writing-coach`
**Base:** `main` at `820f818` (Phase 8 + 8.5 + 11 grand merge)
**Result:** `1382 / 1382` tests green, `tsc --noEmit` clean.

---

## 1. Merge order and rationale

Each branch reads and writes a different subset of the Phase 8.5 kill-audit
spine (`src/voice/intent-extractor.ts`, `src/voice/voice-orchestrator.ts`) and
the MCP tool registry (`src/mcp/tool-schema.ts`, `scripts/mcp/serve-nchinda.mjs`).
To keep the union predictable we merged in the order that minimizes resolver
complexity:

| Step | Branch | Lines added | Conflicts | Tests delta |
| --- | --- | --- | --- | --- |
| 1 | `phase15/rewind` | +1,658 | _none_ (auto-merge) | 1223 → 1279 (+56) |
| 2 | `phase14/conv-intent` | +1,758 | 1 file × 3 hunks | 1279 → 1343 (+64) |
| 3 | `phase13/writing-coach` | +1,612 | _none_ (auto-merge) | 1343 → 1373 (+30) |
| 4 | DoD smoke (new) | +424 | n/a | 1373 → 1382 (+9) |

Rewind went first because it is the only branch that adds a new
`VoiceIntentKind` (`rewind`) to `intent-extractor.ts` and therefore has to
land the enum widening before anything that references it. Conv-intent
went second because its orchestrator side-channel dispatch is appended below
the rewind short-circuit — dispatch order matters (see §3.1). Writing-coach
went last because it is fully isolated from the voice pipeline and only
extends the MCP tool list.

## 2. Conflicts encountered & resolutions

### 2.1 `phase14/conv-intent` vs `phase15/rewind` → `src/voice/voice-orchestrator.ts`

**Nature:** both branches added imports, new fields to
`VoiceOrchestratorOptions`, new private fields on the class, and a new
dispatch block inside `processVoiceInteraction`. The git ORT auto-merger
produced three `<<<<<<<` / `=======` / `>>>>>>>` regions.

**Resolution (commit `f863a7f`):**

- **Imports.** Kept both: `RewindResult` + `RewindSurface` + `RewindHandler`
  interfaces from P15 and `ConvIntent` type-only import from P14.
- **Options interface.** Kept both `rewindHandler` / `rewindSurface` and
  `conversationIntent` option blocks with their jsdoc intact.
- **Private class fields.** Kept both `rewindHandler` / `rewindSurface`
  and the P14 `conversationIntent` + `lastConvIntentTask`.
- **Dispatch order in `processVoiceInteraction`.** Kept both blocks with a
  deliberate ordering:
  1. kill short-circuit (Phase 8.5 baseline, untouched)
  2. rewind short-circuit (Phase 15 — returns early when a rewind handler is
     wired; never dispatches conv-intent side-channel for control intents)
  3. conv-intent fire-and-forget (Phase 14 — runs only for non-control
     intents that fall through to the onTask pipeline)
  4. thinking → bus emit → onTask → speaking → idle (baseline)

The comment explicitly flags that rewind consumes a control intent and so
MUST NOT also trigger a Haiku conv-intent classification. This preserves the
contract of both branches without fighting over "who runs first".

### 2.2 `scripts/mcp/serve-nchinda.mjs` and `src/mcp/tool-schema.ts`

Despite all three branches touching these files, git ORT resolved the adds
cleanly (each branch inserted its new case / schema at a different line).
A one-line docstring fix in `serve-nchinda.mjs` added `watch_draft` to the
header tool-list comment (commit `949e833`).

Final tool list surface:

```
nchinda_recall, nchinda_remember, nchinda_schedule, nchinda_research,
nchinda_send, nchinda_broadcast, nchinda_status, nchinda_escalate,
nchinda_ask_peer, nchinda_see, nchinda_rewind, watch_draft
```

## 3. Cross-phase alignment

### 3.1 VoiceOrchestrator — canonical intent-dispatch ordering

After integration, the voice pipeline honours the following precedence:

```
transcript
 │
 ├── extractIntent(…)
 │     (kill / pause / resume / config / chat / rewind / task)
 │
 ├── kind === "kill"       → killSwitch.trigger("voice"), skip onTask, idle.
 │
 ├── kind === "rewind" &&  → thinking → rewindHandler.query(…) → speaking
 │   rewindHandler            (top-1 label via TTS, top-5 to rewindSurface).
 │                            Does NOT fire conv-intent side-channel.
 │
 ├── (anything else)       → dispatchConversationIntent(transcript)   [P14]
 │                            (fire-and-forget Haiku classifier; failures
 │                             are swallowed — never blocks primary path).
 │
 └── thinking → bus.emit("VOICE_TASK") → onTask(…) → speaking → idle.
```

Every existing intent kind (`task`, `kill`, `pause`, `resume`, `config`, `chat`)
still resolves exactly as before. The three new surfaces are strictly additive:
`rewind` is a net-new kind; `stated-intent` / action-candidate is a
side-channel classification that never enters the VoiceIntent enum; and the
writing-coach lives entirely outside the voice pipeline (its own
DraftWatcher + CoachSurface + `watch_draft` MCP tool).

### 3.2 PendingSurface sensor namespace

Two new sensor names now emit into `ObservationStore`:

- `writing-coach` — P13 CoachSurface. Urgency 0.4 in anticipatory/autonomous.
- `conversation-intent` — P14 IntentSurface. Urgency 0.3 / 0.4 / 0.45 / 0.55
  depending on mode (silent / volunteer / anticipatory / autonomous).

Both coexist with the pre-existing Phase 8.5 sensor names (`perception`,
`voice_intent`) without collision.

### 3.3 MCP tool registry ordering

`NCHINDA_TOOL_SCHEMAS` ordering after integration:

1. recall, remember, schedule, research
2. send, broadcast, status, escalate, ask_peer
3. see (Phase 11), **rewind** (Phase 15)
4. web_search, tool_discovery, skill_discover, skill_execute
5. wm_focus, wm_space_switch, wm_list_windows
6. **watch_draft** (Phase 13)

This ordering is driven by the line positions at which each branch inserted
its schema; it is not load-bearing. The stdio server registers by name, not
position.

## 4. Fixes applied during integration

1. **`scripts/mcp/serve-nchinda.mjs`** — header comment appended `watch_draft`
   to the exposed tool list (`949e833`).
2. **`src/voice/voice-orchestrator.ts`** — three-way field/option/dispatch
   reconciliation documented above (`f863a7f`).

No source behaviour changes were required beyond conflict resolution.

## 5. Final test count

```
ℹ tests      1382
ℹ suites      290
ℹ pass       1382
ℹ fail          0
ℹ duration  ~11.5 s
```

Baseline was `1223 / 1223` on `main`. Delta = **+159** tests (P15 +56, P14 +64,
P13 +30, DoD smoke +9). Every added test from each source branch survives.

## 6. Quality gate status

- `npx tsc --noEmit` — **PASS** (no output)
- `npm test` — **PASS** (1382 / 1382)
- VoiceOrchestrator still honours every pre-existing intent kind plus the
  three new surfaces (`rewind`, plus the P14 side-channel and the P13
  out-of-band coach surface), with the kill path unperturbed. Covered by:
  - `tests/voice-orchestrator.test.ts` (existing)
  - `tests/voice-intent-integration.test.ts` (existing)
  - `tests/rewind-voice-integration.test.ts` (P15)
  - `tests/voice-conv-integration.test.ts` (P14)
  - `tests/phase13-15-dod.test.ts` (new integration smoke)

## 7. Handoff

- Branch is **not** merged to `main` — left for human review per the
  Tester 2 assignment.
- Reviewers own `docs/phase-13-15/REVIEW.md`; this file
  (`INTEGRATION_NOTES.md`) is the integration ledger.
- Open follow-ups (not blockers):
  - The rewind handler expects `runtime.rewindEmbedder` to be wired by the
    orchestrator bootstrap; `serve-nchinda.mjs` throws a clear error if it
    is missing. Consider adding a smoke in the bootstrap once the shared
    CLIP embedder lands.
  - The Swift `ax-watch` binary still needs packaging for the writing-coach
    default deployment path; tests drive a `NativeBridge` stub, so no runtime
    blocker for CI today.
