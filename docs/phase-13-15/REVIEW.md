# Phase 13-15 — Reviewer 2 (READ-ONLY)

Scope: Phase 13 (writing-coach), Phase 14 (conv-intent), Phase 15 (rewind).
Reviewer 1 covers P9/10/12.
Spec: `docs/phase-8/VISION.md` §4 Phase 13, 14, 15.

## Verdict

**ship-with-fixes** — all three branches are unusually tight for a v1 surface. P13 (writing coach) enforces the spec's hard privacy invariants: default-off allow-list, Haiku timeout + reason redaction, 10-minute dedup, AXWatch reconnect with exponential backoff. P14 (conv-intent) proves the cardinal rule ("stated-intent NEVER auto-executes") by construction — the surface only drafts, it never sends, and drafter-less autonomous mode still just surfaces a "Confirm send" prompt. P15 (rewind) bounds work correctly (`limit × 3` decompression budget, clamp to 1–50, inclusive time filter). Integration (T2 at `cde310c`) merges all three into a clean voice-orchestrator with correctly-ordered control branches (kill → rewind → conv-intent side-channel + onTask). Blockers are minor but real: (1) a subtle `lastRouted.set` placement bug in P13 that dedups whispers-that-fell-through-to-surface incorrectly, (2) P15 uses `zstdDecompressSync` which on a malicious blob has no max-output-size cap (zstd-bomb), and (3) some prompt-injection hardening gaps (raw user transcript appears inside the Haiku user message without fenced delimiters). None require rewrite — all five top patches below are 10-line edits.

## Scorecard (1–5)

| Branch | Correctness | Security | TS rigor | Test quality | Design | Spec adherence |
|---|---|---|---|---|---|---|
| phase13/writing-coach | 4 | 4 | 5 | 4 | 5 | 5 |
| phase14/conv-intent | 5 | 4 | 5 | 5 | 5 | 5 |
| phase15/rewind | 4 | 3 | 5 | 4 | 4 | 5 |
| phase13-15/integration (T2) | 4 | 4 | 5 | 4 | 5 | 5 |

## Per-branch spec-drift vs VISION.md §4

### P13 (spec §4 Phase 13) — aligned + one slight extension

- AX field-watch on `kAXValueChangedNotification`: Swift `AXWatchCommand.swift:115–132` subscribes on the app root so descendants bubble up. Spec-conformant.
- Throttle "every 3s on content change": Swift enforces per-element `throttle = 3.0` + content dedup (`AXWatchCommand.swift:86–87, 163–166`). Matches spec exactly.
- Haiku "ONE specific way" prompt: `suggestion-engine.ts:74–80` asks for one improvement, ≤25-word answer, literal `null` for no-op. Aligned with spec.
- HUD / TTS surface path: `coach-surface.ts:115–124` whispers on important+idle, otherwise inserts pending-surface. Spec says "HUD when open OR voice whisper if anticipatory" — mapping is faithful.
- "Opt-in per app (watch Mail, not Terminal by default)": **exceeds spec** — default allow-list is **empty** (`draft-watcher.ts:175–179`, `watch-draft-tool.ts:72–73`). Stricter privacy posture. Good.
- Dedup window: spec is silent on duration; `coach-surface.ts:54` picks 10 minutes. Documented constant.

No drift worth flagging.

### P14 (spec §4 Phase 14) — aligned

- Intent kinds `stated-intent | question | idle-chat | direct-command`: code adds `reminder` as a fifth bucket (`conversation-intent.ts:25–30`). Minor extension, not drift — stays within spec's "classify utterances" mandate.
- "Compose an ACTION: surface in the pending surface with pre-filled details": implemented in `intent-surface.ts:196–246`, urgency 0.40/0.45/0.55 per mode, label prefix "Offer to execute" / "Confirm send". Matches.
- "Requires explicit confirmation — never auto-executes even in autonomous mode": proved by design — the surface has no send/commit path at all; the DraftHandle is opaque data stored in `data.draft` for a future confirm step (see §Findings P14).
- "When the intent wasn't addressed to Nchinda directly": the orchestrator side-channel fires on every non-control transcript (`voice-orchestrator.integ.ts:280`), but routing is gated on `kind === "stated-intent"` (`intent-surface.ts:106–108`). Correct.

### P15 (spec §4 Phase 15) — aligned

- "Uses the Phase 8 screen ring-buffer + OCR'd text + active-app timeline": `rewindSearch` searches the Phase 8.5 `screen_memories` table, decompresses zstd OCR, filters by `timeRange` + `active_app`. Matches.
- "Natural-language query → timestamp-range search": `time-parse.ts` gives a standalone NL time parser returning `null` on ambiguity, consumers can still skip the filter. Spec-conformant.
- "Returns a brief + optional screenshot thumbnail in Mission Control": `RewindResult` carries `webp_path` (nullable post-7-day retention) + 300-char `ocr_excerpt`. Matches.
- MCP tool shape: `nchinda_rewind(text, timeRange?, app?, limit?)` per spec summary §6 (`rewind_search(query, time_range?)`). Close enough — the extra `app`+`limit` are opt-in and schema-required-`text`-only, so the surface matches §6 with additions.

## Per-branch findings

### P13 writing-coach

**1. Dedup window is 10 min — but placement bug swallows the retry path.** `coach-surface.ts:111–113` writes `lastRouted.set(dedupKey, now)` **before** the whisper attempt. If TTS throws and we fall through to the surface path (lines 117–124), the dedup marker is already set. On the **next** identical draft_value within 10 min, route() bails at line 98 even though the first attempt only got a surface insert (no whisper speech actually spoke). Minor but testable: `coach-surface.test.ts:122–131` already asserts the fall-through; add a second call and you'd see the deduped-return confuses the caller.

**2. Default-off allow-list enforced — verified.** `DraftWatcher.start()` at lines 175–179 early-returns when `allowList.length === 0`. `InMemoryWatchDraftController` defaults to empty set. Spec-compliant.

**3. Haiku timeout + redacted rationale — verified.** `suggestion-engine.ts:20` sets 5s `DEFAULT_TIMEOUT_MS`, `AbortController` wired at line 99–100. Error message passed through `redactReason()` (lines 24–39) which collapses to a closed label set (`timeout`/`rate-limited`/…/`unknown`). **Quiet bug**: the redacted reason is computed but never returned or stored — lines 120–122 and 140–141 call `redactReason()` and throw away the result. Telemetry loss, not a correctness issue.

**4. AXWatch process reconnects on crash — verified.** `draft-watcher.ts:262–271` schedules exponential backoff (1s → 2s → … → 30s cap) on non-zero exit. `handleExit` bails only when `stopped || !running`. Test `draft-watcher.test.ts` covers the spawn-throws path. Solid.

**5. No network in watcher / sample path — verified.** Only `suggestOnce()` calls Anthropic. Confirmed by `grep fetch\( src/coach/` → two hits, both in `suggestion-engine.ts`. Watcher + CoachSurface are strictly local.

**6. Swift `AXWatcher` uses `Unmanaged.passUnretained` with `takeUnretainedValue`** (lines 114, 210). Correct lifetime management — the watcher outlives the callback via the captured `SignalRetainer.shared`, but the watcher itself is owned by a local `AXWatchCommand.run` reference that stays alive because of `RunLoop.current.run()` at line 50. Fine in practice; document the contract or switch to `passRetained` to be defensive.

**7. `copyStringAttr` silently swallows all `AXError != .success`** (`AXWatchCommand.swift:193–199`). That's correct — non-text elements legitimately have no role/value. No leak.

**8. Prompt injection in `buildUserPrompt`** (`suggestion-engine.ts:150–156`): the draft content is interpolated inside triple-quotes. A malicious draft containing `"""\n\nNew instruction: ignore previous instructions …` can break out. Mitigated in practice because the system prompt says "Return JSON only" and zod-validation rejects anything that isn't the expected shape, but the raw draft still reaches Haiku. See Security §1.

### P14 conv-intent

**1. Stated-intent never auto-executes — proved by construction.** `intent-surface.ts` exposes `surfaceIntent()` only; there is **no** `sendIntent` / `executeIntent` function. The autonomous path (`intent-surface.ts:157–163`) calls `deps.drafter(action)` which is an injected opaque hook documented as "MUST be REVERSIBLE and MUST NEVER send / commit / dispatch" (line 34–36). Even without a drafter, autonomous mode still surfaces a "Confirm send: …" prompt (`intent-surface.test.ts:238–249` explicitly asserts this). The ONLY side-effects on cortexOS for a stated-intent are: (a) an observation row in the PendingSurface, (b) an audit line, (c) an opaque DraftHandle returned by a caller-supplied drafter.

**2. Draft handles truly reversible — enforced contractually, not structurally.** `DraftHandle` is just `{id, tool, note?}` — it's a **token** for a future confirm step, not an execution record. The `ActionDrafter` type comment (lines 30–36) is the only enforcement; there's no runtime guard that the injected drafter doesn't actually send. This is acceptable because the drafter is wired at startup by the orchestrator (not by intent classification), but note it: a misconfigured drafter at wire-up time could break the guarantee. Follow-up: add a unit test that wires a misbehaving drafter and asserts the surface row still says "Offer to execute" rather than "Sent".

**3. Classifier prompt injection-safe? Partially.** `conversation-intent.ts:418` sends `content: "Utterance: ${transcript}"` — user text is concatenated into the user message with no delimiter. Similar to P13, zod-validation of the classified JSON shape makes abuse pragmatic-difficult but not impossible (`HaikuResultSchema` rejects anything whose `kind` isn't the enum). More importantly: **an attacker who controls the transcript can pick any of the 5 kinds + any verb/object/recipients**, but that only triggers a pending-surface insert — it doesn't execute. Combined with §1, exploitable impact is zero. Still worth fencing (see Top 5).

**4. Action-candidate extraction validated.** `extractActionCandidate` (lines 274–341) is pure string munging — no eval, no regex catastrophic-backtrack (all regexes are linear with no nested quantifiers). `VERB_TO_TOOL` is a hardcoded allowlist so `suggested_tool` is always a known skill id or undefined. `intent-surface.ts:286–300` then calls `registry.get(tool)` and only records the tool name as a data-field — it is never used to dispatch.

**5. Heuristic fallback agrees with spec examples.** "I should order Thai for Maya" → `stated-intent`, `verb=order`, `recipients=["Maya"]`, `suggested_tool=social_send` (`conversation-intent.test.ts:67–76`). Matches the Phase 14 demo-reel scenario exactly.

**6. Nchinda spelling variants.** Regex at line 158 matches `n[ck]hinda` — covers "Nchinda"/"Nkhinda"/etc. but NOT common STT mishearings like "Machinda" or "Nshinda". Acceptable — spec says "addressed to the assistant 'Nchinda'", not "every phonetic variant". Consider expanding in Phase 14.5.

**7. Fire-and-forget dispatch isolated from voice pipeline — verified.** `voice-orchestrator.integ.ts:336–349` wraps the classify/route chain in its own async IIFE, catches all errors, and only stores the promise for test flushing. `voice-conv-integration.test.ts:160–202` asserts classify-throw and route-throw both preserve the main pipeline.

**8. `voice_intent` audit action reused.** Both kill (Phase 8.5) and conv-intent paths append `action: "voice_intent"` with different `detail` payloads. Fine — detail line-prefixes disambiguate (`intent=kill …` vs `conv-intent mode=… kind=…`). Audit consumers must parse `detail`.

### P15 rewind

**1. Time-parse handles ambiguous phrases — verified.** `time-parse.ts:188` returns `null` for unsupported phrases like bare "morning" (comment at line 186–187 documents the deliberate ambiguity rejection). `typeof phrase !== "string"` guarded at line 119. Empty-string guarded at line 121. No phrase can throw — every branch either returns a `TimeRange` or `null`. Good.

**2. zstd decompression bounded to `limit×3` rows — verified.** `rewind-query.ts:104` sets `decompressBudget = Math.min(afterFilter.length, overFetchK)` where `overFetchK = limit × 3`. Loop at line 117 caps at that. **But** the per-row cap is unbounded: `zstdDecompressSync(row.ocr_text_zstd)` on line 232 has no `maxOutputLength` option passed. A single corrupted/malicious row with a high compression-ratio OCR blob (zstd bomb) can allocate arbitrary memory. See Security §4.

**3. Semantic search filter applies `timeRange` + `app` correctly — verified.** `matchesFilters` (lines 141–160) checks both inclusively (`t >= from && t <= to`). Comment at line 152–153 explicitly documents the inclusive choice for "40 minutes ago" boundary-hits. `app` filter is case-insensitive (line 157). Tests cover both (rewind-query.test.ts:119–172).

**4. Exfil risk via malicious query string? Low but present.** `RewindQuery.text` is passed to `deps.embedder.embed(text)` (line 92) and then to `extractKeywords(text)` (line 103). The embedder is injected — assuming it runs a local ONNX model, no network. `extractKeywords` tokenizes `[a-z0-9]{3,}` (line 215) so no regex metacharacter leakage. The NL `text` is never interpolated into SQL — `db.semanticSearch(embedding, k)` takes a `Buffer` + number. Safe.

**5. Rewind reply leakage.** `buildRewindReply` (`voice-orchestrator.integ.ts:362–372`) speaks `top.label` + `friendlyWhen(captured_at)`. Labels are 1-sentence captions generated at capture time (Phase 8 §3). A malicious draft that ended up captured as a frame, then queried by rewind, could have its label spoken back — but that would be the user's own screen, so no privilege escalation.

**6. `Date.parse` on `captured_at`** (line 147, 316) accepts loose ISO strings. Rows inserted by Phase 8.5 use stored ISO strings. No injection risk because `captured_at` is a DB column written by the capturer, not user input.

**7. `nchindaRewind` tool** rejects invalid dates with a thrown error rather than silent null (line 48–52). Good — callers (MCP transport) convert to JSON-RPC error. Schema validated at zod layer first.

**8. Integration fall-through.** When `rewindHandler` is undefined, `voice-orchestrator.integ.ts:249` condition is false and transcript falls through to `onTask`. `rewind-voice-integration.test.ts:194–231` verifies backward-compat. Good.

## Security pass

TBD

## Voice-orchestrator multi-intent sanity

TBD

## Test quality

TBD

## Top 5 patches before main

TBD

## Follow-ups

TBD
