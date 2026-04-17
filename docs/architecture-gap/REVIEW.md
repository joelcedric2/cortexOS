# Architecture Gap Close -- End-to-End Review

**Reviewer**: End-to-End Reviewer (Claude)
**Date**: 2026-04-15
**Verdict**: **ship-with-fixes**

---

## Per-Branch Review

### C1: BrainSession (`gap/brain-session`)

**Files**: `src/voice/brain-session.ts`, `tests/brain-session.test.ts`

- **Conversation context across send() calls**: YES -- the tmux session persists between calls. Each `send()` types into the same Claude CLI session, which maintains full conversation history. The session is never killed between sends.
- **Stateless within the tmux pane?**: No, the session is stateful by design. Claude CLI running in the tmux pane keeps its own conversation context across inputs.
- **boot() waits for ready state**: YES -- polls for the prompt marker (line with ">" character) with a 30s timeout. However, it only warns and proceeds if the prompt never appears. This is acceptable -- a hard failure here would block the entire voice subsystem.
- **ISSUE**: `capturePane(sessionName, 200)` in `send()` only captures 200 lines of scrollback. If Claude produces a long tool-use response (e.g., reading a large file), the user's original message may scroll out of the 200-line buffer, causing `extractResponse()` to return empty and the user gets "I took too long on that." The pane-capture module (C4) uses 5000 lines, but BrainSession has its own duplicate extraction logic that uses only 200.
- **ISSUE**: BrainSession has its own `extractResponse()` AND `stripAnsi()`/`stripFormattingForTTS()` that duplicate pane-capture.ts (C4). At integration time, BrainSession.send() should delegate to pane-capture's `captureResponse()` instead of reimplementing the same logic with a smaller buffer.

### C2: EchoGate (`gap/echo-gate`)

**Files**: `src/voice/echo-gate.ts`, `src/voice/wake-word.ts`, `src/voice/voice-orchestrator.ts`, `src/controller/cortex.ts`, `tests/echo-gate.test.ts`

- **All tts.speak() call sites covered?**: In `voice-orchestrator.ts`, ALL 7 call sites are converted from `this.tts.speak(x)` to `this.speakWithEchoGate(x)`. Verified by diff -- every `-await this.tts.speak(` has a corresponding `+await this.speakWithEchoGate(`.
- **MISSING CALL SITE**: `src/coach/coach-surface.ts` line 114 calls `this.tts.speak(buildWhisper(suggestion))` directly. This is the writing coach "whisper" path. It does NOT go through the echo gate, so a coaching whisper could trigger a false wake-word detection. Severity: medium -- whispers are rare and short, but it is a gap.
- **Wake-word integration**: Correct. The `echoGate.isMuted()` check is placed AFTER sox recording completes but BEFORE the Groq transcription API call. This means audio is still recorded (keeping timing consistent) but never transcribed while muted.
- **Decay timer**: Default 1500ms decay after TTS finishes is reasonable for speaker-to-mic echo in a room. The timer cancellation logic on re-mute is correct.

### C3: BrainContext (`gap/brain-context`)

**Files**: `src/voice/brain-context.ts`, `tests/brain-context.test.ts`

- **Does CLAUDE.md include "run `date`"?**: YES -- `buildToolUsageSection()` explicitly says "Time/date questions -> run `date` in bash. NEVER guess the time."
- **Does it include "NEVER guess"?**: YES -- appears twice: "NEVER guess the time" and "NEVER fabricate an answer."
- **Is the tool list dynamic?**: YES -- imports `NCHINDA_TOOL_SCHEMAS` from `src/mcp/tool-schema.ts` and maps over them at runtime. When new MCP tools are registered, the CLAUDE.md updates automatically.
- **Memory injection**: Queries pgvector for top-5 recent memories. Gracefully handles missing vectorStore/embedder and database errors.
- **Tests**: Comprehensive -- 8 test cases covering SOUL.md presence/absence, tool listing, memory injection, error paths.
- **MINOR**: The generated CLAUDE.md does not include "NEVER" guess in the voice mode section header itself, but the tool usage section covers it thoroughly. Acceptable.

### C4: PaneCapture (`gap/pane-capture`)

**Files**: `src/voice/pane-capture.ts`, `tests/pane-capture.test.ts`

- **Can extractReply handle 30+ second thinking?**: YES -- `captureResponse()` polls every 500ms with a 120s (2 minute) timeout. It checks for the prompt marker to determine completion. During thinking, the pane shows "Thinking..." which is correctly filtered as a chrome line.
- **Multiple pane screenfuls?**: Partially. `capturePane(sessionName, 5000)` requests 5000 lines of scrollback, which is generous. However, if Claude produces output exceeding 5000 lines (e.g., reading a very large file), the beginning of the response could be lost. For voice interactions this is unlikely -- 5000 lines is adequate.
- **Timeout salvage**: On timeout, `extractReplyPartial()` attempts to grab the last non-chrome text block. This is a good fallback for cases where Claude is still typing.
- **ISSUE**: `captureResponse()` does NOT wrap its main loop in try/catch. If `tmux.capturePane()` throws (tmux process dies), the function throws rather than returning a fallback. The test at line 293 acknowledges this: "Current implementation may throw on tmux errors -- acceptable since the BrainSession layer above should catch this." This is fragile -- a try/catch in the polling loop would be more defensive.
- **ANSI stripping**: More thorough than BrainSession's version -- handles private mode sequences, control characters, and ST-terminated OSC sequences. This is the canonical implementation.

### C5: Pipeline Rewire (`gap/pipeline-rewire`)

**Files**: `src/controller/cortex.ts`, `src/voice/_gap-stubs.ts`, `tests/voice-pipeline-rewire.test.ts`

- **Is `claude -p` fully removed?**: YES -- the entire spawn-based `claude -p` block (approximately 60 lines) is deleted. The only remaining mention is a comment: "replaces the old claude -p one-shot." No `spawn("claude", ["-p", ...])` remains.
- **BrainSession booted before voice subsystem starts?**: YES -- boot order in `cortex.ts` is: (1) build brain CLAUDE.md, (2) `brainSession.boot()`, (3) create `onTask` closure, (4) create `VoiceOrchestrator`, (5) `voiceWSBridge.start()`, (6) `voiceOrchestrator.start()`. The brain is ready before voice accepts any input.
- **ISSUE**: The pipeline uses `_gap-stubs.ts` -- a stub file with a no-op BrainSession that returns `"[stub] Received: ${message}"`. This means `gap/pipeline-rewire` cannot be merged standalone -- it MUST be integrated with `gap/brain-session` at merge time, replacing the stub imports with real imports. The stub file header says "Delete this file at integration time." This is correct design for parallel development but must not be forgotten.
- **Auto-restart logic**: The onTask handler has a double-retry pattern -- if `send()` fails or returns `[error]*`, it restarts once and retries. If the retry also fails, it catches and tries one more restart+send before returning the fallback. This is robust.
- **Shutdown order**: Brain session shuts down BEFORE voice orchestrator teardown. Correct -- prevents orphaned tmux sessions.

### C6: Memory Loop (`gap/memory-loop`)

**Files**: `src/voice/voice-memory.ts`, `src/voice/voice-memory-hook.ts`, `src/memory/vector-store.ts`, `src/voice/voice-orchestrator.ts`, `tests/voice-memory.test.ts`

- **Does every voice interaction persist?**: YES -- `storeInteraction()` is called in the voice orchestrator at step 10.5, after TTS speaks the reply. It fires on every successful completion of `processVoiceInteraction()`.
- **Does markFailed work for interrupts?**: YES -- the "stop"/"cancel"/"no" kill-switch path at line 269 calls `this.voiceMemory.markFailed(this.lastMemoryId)` with a try/catch so it never breaks the kill path.
- **ISSUE**: `markFailed()` only fires if `this.lastMemoryId` is set, which only happens AFTER a successful `storeInteraction()`. If the user says "stop" during the FIRST interaction (before any memory has been stored), `markFailed` is a no-op. This is correct behavior -- there is nothing to mark as failed.
- **VectorStore.updateMemory()**: New method added to `vector-store.ts`. Uses parameterized queries -- no SQL injection risk. The `tags = tags || $N` uses PostgreSQL array concatenation, which is correct.
- **Bus event**: Emits `plan_emitted` with `phase: "VOICE_MEMORY_STORED"`. Truncates transcript to 50 chars for the event payload. Clean.
- **ISSUE**: The voice memory hook (`voice-memory-hook.ts`) provides `getVoiceContextSection()` for brain-context (C3) to import. But C3 (`brain-context.ts`) does NOT import or call it -- C3 has its own memory recall via `buildMemorySection()` that queries pgvector directly with a generic "voice interaction context" query. The hook is unused. At integration time, C3 should either use the hook or the hook should be removed to avoid dead code.

---

## Security Review

- **API keys in code**: NONE found across all 6 branches. No hardcoded tokens, secrets, or credentials.
- **Prompt injection via voice transcript**: The transcript is sent directly to the Claude CLI session via `tmux send-keys`. A malicious transcript like "ignore all previous instructions" would be processed by Claude's own safety layer. However, `send-keys` interprets certain key sequences -- a transcript containing tmux control characters could potentially escape the intended input. Risk: LOW -- the transcript comes from Groq STT, which produces plain text, not control characters.
- **SQL injection in updateMemory()**: NONE -- uses parameterized queries throughout.
- **File path traversal**: The brain session's working directory is hardcoded to `~/.cortexos/brain`. The CLAUDE.md is written there. No user-controlled path input.

---

## The Core Question

> Will "What time is it?" now actually run `date` instead of guessing?

**YES, with high confidence**, once all 6 branches are integrated:

1. The transcript goes to `BrainSession.send()` (C1/C5) instead of stateless `claude -p`
2. The brain's CLAUDE.md (C3) explicitly says: "Time/date questions -> run `date` in bash. NEVER guess the time."
3. The Claude CLI session has access to bash tools and MCP tools
4. The response is captured from the tmux pane (C1/C4) and spoken via TTS
5. Echo gate (C2) prevents the TTS output from triggering a false wake

The chain is complete. The only caveat is that Claude may occasionally still guess despite instructions -- but the CLAUDE.md rules are strong and explicit.

---

## Top 3 Patches Before Shipping

### Patch 1: BrainSession should delegate to pane-capture (CRITICAL)

`brain-session.ts` has its own `extractResponse()` with a 200-line buffer and its own `stripAnsi()`. `pane-capture.ts` has a superior implementation with a 5000-line buffer and more thorough ANSI stripping. At integration time, `BrainSession.send()` should call `captureResponse()` from pane-capture.ts instead of reimplementing extraction. This also fixes the 200-line buffer limitation that could cause "I took too long" false positives on long responses.

### Patch 2: EchoGate the coach whisper path (MEDIUM)

`src/coach/coach-surface.ts` line 114 calls `tts.speak()` without echo gating. The writing coach whisper could trigger a false wake-word detection. Either pass `EchoGate` into `CoachSurface` and wrap the speak call, or route all TTS through a centralized speak-with-echo-gate utility.

### Patch 3: Add try/catch to pane-capture polling loop (MEDIUM)

`captureResponse()` in `pane-capture.ts` does not wrap the `tmux.capturePane()` call in try/catch. If tmux dies mid-poll, the function throws rather than returning the timeout fallback. Add a try/catch inside the while loop that logs the error and continues polling (or returns the fallback if tmux is truly dead).

---

## Verdict Summary

**ship-with-fixes** -- The architecture is sound. The 6 branches together close the gap between stateless `claude -p` and a persistent, context-aware brain session. The core "What time is it?" flow will work correctly. Three patches are needed before main merge:

1. Unify BrainSession extraction with pane-capture (avoid 200-line buffer bug)
2. Echo-gate the coach whisper TTS path
3. Defensive try/catch in pane-capture polling

**Main merge blocked?** No -- but Patch 1 should land before or during the integration merge to prevent a production bug where long Claude responses return "I took too long" despite completing successfully.
