# Phase 9-12 Reviewer 1 — Independent Read-Only Review

> Scope: `phase9/camera`, `phase10/computer-use`, `phase12a/comms-drivers`,
> `phase12b/content-drivers`, plus the in-flight `phase9-12/integration` (T1).
> Reviewer 2 owns phases 13/14/15.
>
> Basis: `docs/phase-8/VISION.md` §4 (Phase 9, 10, 12) and §7 privacy invariants.
> This review is strictly read-only — no source edits, only this file.

## Verdict

**Ship-with-fixes** — blocking main-merge until P12a's escalation truly gates and
the `cu_*` MCP surface either inherits agent-loop's policy gate or gets its own.

Phase 9 (camera) is the strongest of the four branches: the "one-shot" invariant
is enforced in three places (Swift session stop+teardown in `defer`, no ring
buffer in TS, no shared runtime handle in `serve-nchinda.mjs`), Continuity
Camera detection cleanly straddles macOS 13/14, the permission-denied path is
typed end-to-end, and the voice `camera-query` branch is purely additive (kill
path untouched). Phase 10 is well-layered (Actuator bounds-check + cap, loop
policy gate fires before actuate, bounded by steps AND time) but leaks raw
`cu_*` MCP tools without policy mediation, which defeats the whole Phase 2.2
irreversibility story when the planner speaks MCP directly. Phase 12a has
excellent `quoteAS` discipline + arg-array `osascript` invocations, but its
self-admitted "best-effort notification, gating is 12b scope" escalation is a
spec-drift violation of VISION §4 Phase 12 point 3 ("All send/compose flows
trigger escalation confirmation **before firing**"). Phase 12b's Finder
sanitizePath is the most careful piece of code in the whole review (dot-dot
rejection both raw and resolved, realpath-based containment, NUL screen,
symlink-escape catch), and notes/reminders wire a real `EscalationGate` with
boolean confirmation — exactly the contract P12a punted on. The integration
branch `phase9-12/integration` (T1) currently holds only the P12b diff; P9,
P10, P12a are not yet merged in, so integration-level concerns (duplicate
`quoteAS`, shared audit action vocabulary, `serve-nchinda.mjs` case-dispatch
collisions, tool-schema.ts conflicts) are real but not yet observed.

## 1. Scorecard (1–5, 5 = excellent)

| Branch                     | Correctness | Security | TS Rigor | Test Quality | Design | Spec Adherence |
| -------------------------- | ----------- | -------- | -------- | ------------ | ------ | -------------- |
| phase9/camera              | 5           | 5        | 5        | 4            | 5      | 5              |
| phase10/computer-use       | 4           | 3        | 5        | 4            | 4      | 3              |
| phase12a/comms-drivers     | 4           | 4        | 4        | 4            | 4      | 2              |
| phase12b/content-drivers   | 5           | 5        | 4        | 4            | 4      | 5              |
| phase9-12/integration (T1) | n/a         | n/a      | n/a      | n/a          | n/a    | n/a (empty)    |

## 2. Per-branch spec drift (vs VISION.md §4)

### 2.1 phase9/camera — VISION §4 Phase 9

- §4.P9.1 "AVFoundation one-shot capture (no always-on)" — **met**. Swift
  `CameraCommand` starts the session, awaits one photo, and the `defer`
  block calls `session.stopRunning()` + removes inputs/outputs. TS wrapper
  has no loop; every call is a fresh `execFile`. No ring buffer.
- §4.P9.1 "Continuity Camera supported automatically" — **met**. Discovery
  session includes `.external` (macOS 14+) and falls back to
  `.externalUnknown` on macOS 13; `isExternalCamera()` matches either.
  Voice/MCP can explicitly request `device: "continuity"`.
- §4.P9.2 "`nchinda_look()` MCP tool — still, Sonnet vision, OCR text"
  — **met**. Uses `claude-sonnet-4-6` (not Haiku) deliberately for visual
  reasoning quality. Returns `{description, ocr_text?, frame:{id,path,ts}}`.
- §4.P9.3 "Voice integration: 'look at this', 'what am I looking at',
  'is this Epstein' routes through VoiceOrchestrator" — **met**. Two
  regex shapes: anchored openers (`what am i looking at`, `what do you
  see`, `look at (this|that)`) and trailing-`?` questions (`is this|that
  …?`). Embedded forms intentionally not matched (e.g. "tell me what do
  you see when you open the app" routes to `task`). Additive: falls
  through to `onTask` when `onCameraQuery` is not wired.
- §7.2 "No frames leave the Mac unless the user explicitly requests an
  LLM action on them" — **met**. Fallback-to-local-only when no API key,
  redacts error reason, no fetch when offline.
- §7.5 Audit — **met**: `camera_capture` action with device + bytes.
  `voice_intent` action with `intent=camera-query`.

**Drift**: none material.

### 2.2 phase10/computer-use — VISION §4 Phase 10

- §4.P10.1 "CoreGraphics actuator primitives" — **met**. `InputCommand.swift`
  uses `CGEvent.post(tap: .cghidEventTap)` for mouse + `keyboardSetUnicodeString`
  for typing. `cliclick` fallback is not wired — spec says "`cliclick`
  fallback" but I read this as permitted-not-required given CG works when
  the helper is trusted under Accessibility. **Minor drift — no fallback.**
- §4.P10.2 "AXUIElement queries to find buttons/text fields by role +
  label" — **met**. `AXCommand.swift` walks the AX tree with depth cap
  (8) and result cap (200). TS returns typed `AXElement | null`.
- §4.P10.3 "see→plan→act→verify inner loop, Max 20 action steps per
  task, mandatory confirmation for irreversible actions" — **met but
  only in the loop path**. `AGENT_LOOP_DEFAULTS.maxSteps = 20`,
  `timeBudgetMs = 120_000`. Policy gate fires BEFORE `actuate()` — code
  explicitly structured so the `isIrreversible()` branch returns before
  any `await actuate(...)`. Verified by `agent-loop.test.ts` "policy
  gate fires BEFORE actuate; no actuator call" which asserts
  `actuator.actions === []` on escalation.
- §4.P10.4 "MCP tools: `cu_click`, `cu_type`, `cu_screenshot`,
  `cu_find_element`, `cu_scroll`" — **drift**. Tools exist, zod-validated,
  but bypass the `LoopPolicy.isIrreversible()` check. The module header
  literally says "the raw MCP tools are unmediated so a planner can
  compose them as it wishes". This means a planner reaching MCP directly
  (outside the agent-loop) can `cu_type "DROP DATABASE"` into any focused
  window with no escalation. VISION §4.P10.3 "mandatory confirmation for
  irreversible actions (same rules as Phase 2.2)" is not enforced at the
  MCP boundary.
- §4.P10.5 "'Take over' voice intent → switches session into computer-use
  mode; every action announced in Activity Journal" — **not in this
  branch**. Voice intent extractor has no `takeover` kind. This is P10's
  integration responsibility, not a drift per se.

### 2.3 phase12a/comms-drivers — VISION §4 Phase 12 (Mail / Calendar / Messages)

- §4.P12.1 Driver interface `open/query/compose/send/read` mirroring
  `SocialDriver` — **met**. Mail, Messages, Calendar all have
  `createXxxDriver()` factories and typed public interfaces.
- §4.P12.2 Ship order: "(1) Mail (compose, reply, search, archive, flag)
  (2) Calendar (create event, find gap, decline) (3) Messages (extend
  iMessage driver — group chats, reactions, attachments)" — **met**.
  Surface covers exactly this list.
- §4.P12.3 "All send/compose flows **trigger escalation confirmation per
  Phase 2.2 before firing**" — **DRIFT / P0**. `app-tools-comms.ts`
  calls `await this.deps.escalate(...)` then proceeds immediately to the
  driver mutation regardless of the user's answer. The return type is
  `{ escalation_id: string }` — no `approved` field is inspected. The
  module header admits this: *"Phase 12a treats the escalation as a
  best-effort notification; gating on the user's answer is Phase 12b
  scope."* This is not what VISION says. See §3.3 below.
- §4.P12.4 "MCP tools: `mail_compose`, `mail_send`, `calendar_create`,
  `messages_send`, …" — **met**. Tool surface comprehensive.
- §6 "All follow the existing pattern: zod-validated inputs, native
  `execFile` (no shell), sandboxed where possible, escalation-on-
  irreversible" — **partial**. zod ✅, execFile-with-argv ✅,
  escalation-on-irreversible ❌ (see §4.P12.3 drift above).

### 2.4 phase12b/content-drivers — VISION §4 Phase 12 (Safari/Notes/Reminders/Music/Finder)

- §4.P12.2 Ship order items 4–8 — **met**. Safari, Notes, Reminders,
  Music, Finder drivers all present.
- §4.P12.3 "All send/compose flows trigger escalation confirmation
  before firing" — **met for this branch's surface**. `notes.delete`,
  `reminders.remove`, `finder.move`, `finder.rename`, `finder.trash`
  go through `EscalationGate.requestConfirmation(question, ctx)`
  which returns `boolean`. `if (!approved) throw` — gate actually
  gates. This is the contract P12a should have had.
- §7.2/§7.7 "Private apps allowlist, no traversal, no symlink escape"
  — **met via `sanitizePath`**. Rejects: empty, NUL, non-absolute,
  any `..` segment (raw + normalized), realpath outside `allowedRoot`
  (default `$HOME`). `finder.reveal` is deliberately more permissive
  (skipResolve = true) because it's read-only; it still blocks NUL +
  relative.
- §7.5 Audit — **met**. Every mutation appends `app_mutation` with JSON
  detail; fully-resolved path logged.

**Drift**: none material. `finder.reveal` allowing out-of-$HOME paths
is documented and justified, but see §3.4 for a minor note.

### 2.5 phase9-12/integration — T1 integration branch

Currently `phase9-12/integration` contains only the P12b diff — P9, P10,
P12a files are absent. This is expected: T1 is merging sequentially and
has not landed the other three yet. Integration-level concerns
(duplicate `quoteAS` symbols, audit-action vocabulary conflicts in
`audit.ts`, `serve-nchinda.mjs` case dispatch, `tool-schema.ts` merge)
cannot be evaluated until T1 has actually integrated all four branches.

**Recommendation**: Reviewer 1 should re-run §4/§5 cross-cutting checks
on `phase9-12/integration` once T1 signals completion.

## 3. Per-branch findings (deep-dive)

### 3.1 phase9/camera

**One-shot invariant — really upheld?** Yes, defence in depth:

1. `CameraCommand.swift` creates a fresh `AVCaptureSession` per call. A
   Swift `defer` block calls `session.stopRunning()` + removes all inputs
   + all outputs. Even if the photo-capture continuation throws, teardown
   fires. No long-running daemon.
2. `camera-capture.ts` has no module state, no cached bridge, no ring
   buffer — every `captureCameraFrame()` call builds a new bridge (or
   uses the injected one). `outputDir` defaults to `~/.cortexos/camera/`
   with a fresh UUID filename.
3. `serve-nchinda.mjs` does NOT pass a runtime-shared capturer to
   `nchindaLook`, unlike `nchinda_see` which reuses `runtime.screenCapturer`.
   Comment says: "strictly on-demand. No runtime-shared camera; each
   call opens the AVFoundation session once and closes it."

**Continuity Camera detection correct?** Yes. `discoverDevices()` adds
`.external` (macOS 14+) and falls back to `.externalUnknown` (macOS 13).
`pickDevice("continuity")` finds by `isExternalCamera` predicate. Label
normalisation in `deviceLabel()` returns `"continuity"` back to TS so
the caller knows what was actually selected.

**Permission-denied path surfaces cleanly?** Yes. Swift throws
`VisionError.permissionDenied` on `authorized`/`notDetermined` (after
explicit `requestAccess`) / `denied` / `restricted`. Exit code 3 +
stderr "permission-denied". TS matches the stderr substring and maps to
a typed `CameraCaptureError(code="permission-denied", …)` with a
user-facing hint. `nchinda_look` propagates — callers can `switch` on
`err.code`.

**Voice routing additive-only (kill path untouched)?** Yes.

- Precedence in `voice-orchestrator.ts`: `kill > camera-query > task`.
- `camera-query` only engages when `onCameraQuery` is supplied; otherwise
  falls through to `onTask` (integration test
  "camera-query falls through to onTask when no onCameraQuery is wired"
  proves this).
- The kill block is untouched: stop TTS, fire killSwitch, audit, return.
- Camera regexes are anchored (`^`) so embedded mentions
  ("tell me what do you see when you open the app") still route to
  `task`. Test-proven.

**Nits**:
- `nchindaLook` returns `ocr_text` truncated at 2000 chars, but the
  local-only fallback reuses OCR at 400 chars. Two caps; fine.
- The camera audit detail includes `bytes=…` but not width/height; the
  successful write implies both. Low-value field to omit.

### 3.2 phase10/computer-use

**Policy gate really fires BEFORE actuation?** Yes **inside `agent-loop.ts`**:
```ts
if (deps.policy.isIrreversible(response.action)) {
  steps.push(buildStep(i, observation, response, null, now));
  recordAudit(deps.audit, `escalated step=${i} …`);
  return finish(task.goal, steps, "escalated");
}
// 4. Actuate.
await actuate(...);
```
Test `agent-loop.test.ts` asserts `actuator.actions === []` on escalation
— real proof, not a claim. **However**: see §2.2 — raw `cu_*` MCP tools
bypass this check.

**Agent loop has bounded steps AND bounded time?** Yes.

- `task.maxSteps ?? 20` caps the `for` loop.
- `task.timeBudgetMs ?? 120_000` caps wallclock via `deadline = now() +
  budget`, re-checked at the top of each iteration.
- Both bounds proven by tests ("budget-exhausted before first action"
  via faked `now()`, and "stops after maxSteps with `budget-exhausted`"
  via a 50-long script + maxSteps=3).

**Text cap enforced?** Yes, belt AND suspenders.

1. `CuTypeInput` zod schema: `z.string().min(1).max(10_000)`.
2. `Actuator.type` throws `TextTooLongError` if length > 10_000.

If the MCP layer is somehow bypassed, the actuator still refuses.

**No unaudited actions possible?** Mostly. The audit trail is
comprehensive inside the loop (start, each step, terminal outcome) and
inside the Actuator (every primitive appends `cu_action`). BUT:

- The raw `cu_*` MCP tools don't themselves append audit; they rely on
  the Actuator to do it. A `CuTools` wired without an audit-enabled
  Actuator would silently produce unaudited mouse/keyboard events.
  Production wiring in `serve-nchinda.mjs` must plumb the AuditLog
  through. Not visible in this branch — **flag for T1 verification**.
- `recordAudit` swallows sink errors with `console.warn` — reasonable
  but means a broken sink silently degrades the "every action audited"
  invariant.

**Nits**:
- `OutOfBoundsError` rejects NaN / Infinity / non-integers up front. Good.
- `Actuator.screenshot()` parses both `path` and `png_path` keys —
  thoughtful compatibility bridge.
- `haikuFetch` is the PlanFn seam name; actual planner hits Sonnet not
  Haiku. Cosmetic inconsistency; inherited from `nchinda-see` convention.
- `redactGoal()` strips PII-ish chars from goal before audit — nice.

### 3.3 phase12a/comms-drivers

**`quoteAS` applied everywhere user input meets AppleScript?** Yes on the
three drivers' hot paths.
- `mail-driver`: `subject`, `body`, `to/cc/bcc`, `draftId`, `messageId`,
  `query` all `quoteAS`'d.
- `messages-driver`: `to`, `body`, `chatId`, attachment POSIX paths all
  `quoteAS`'d.
- `calendar-driver`: `title`, `calendar`, `location`, `notes`,
  `attendees` email, `eventId` `quoteAS`'d; dates through typed
  `isoNoTZ()` helper.

Helper shape: returns the bare inner-escaped string (backslash,
double-quote, strip `\r\n` → space). Callers wrap in `"…"`. Consistent
across comms drivers. Correct.

**Irreversible escalation really gates `mail_send` / `messages_send` /
attendee-invite `calendar_create`?** **NO** — P0 finding. Current code:
```ts
async mailSend(raw: unknown) {
  const input = MailSendInput.parse(raw);
  await this.deps.escalate({ question: …, level: "question" });
  return this.deps.mail.send(input.draftId);   // fires unconditionally
}
```
`escalate` returns `{ escalation_id }` — no `approved` flag. Code
proceeds to `mail.send` regardless of the user's response (even if the
user never responded). Same for `messagesSend`, `messagesSendGroup`,
and `calendarCreate` with attendees. This violates VISION §4.P12.3
"trigger escalation confirmation before firing" directly. Module header
admits: *"Phase 12a treats the escalation as a best-effort notification;
gating on the user's answer is Phase 12b scope."* — but VISION did not
grant that punt. P12b's `EscalationGate.requestConfirmation` returning
`boolean` is the model to adopt. **Block main-merge on this.**

**AppleScript-injection tests with nasty strings?** Partial coverage.
Mail driver tests (24 cases) exercise typical flows. No dedicated
adversarial-input fuzz targeting:
- embedded `"`, `\`, `\\r`, `\\n`, `\r\n` combinations
- non-ASCII (RTL, emoji with ZWJ, combining marks)
- NUL byte attempts
- AppleScript metachar chains (`\"; do shell script …`)

`quoteAS` itself looks robust (backslash-first then quote, `\r\n` → ` `),
but "contains expected quoted fragment" style assertions after a fuzz
would close the barn door before a future `quoteAS` refactor breaks it.
P12b's finder tests are closer to this pattern; P12a should adopt it.

**Nits**:
- `calendar-driver.asDate(s)` parses positional substrings of an ISO
  string — locale/DST hostile in theory. TS `isoNoTZ()` is UTC so
  practically OK; deserves a test around fall-back DST.
- `messages-driver.listRecent` returns `[]` always (future Phase 12b
  chat.db work). Honest stub.
- `messages-driver.react` is a no-op-with-audit. Don't advertise the
  capability in public MCP tool descriptions.

### 3.4 phase12b/content-drivers

**`sanitizePath` rejects `..`, symlinks escaping $HOME, NUL bytes?** Yes.

- NUL: `if (input.includes("\0")) throw`.
- Empty / non-string: `throw`.
- Non-absolute: `isAbsolute()`.
- `..` segment: `input.split(sep).some(s => s === "..")` — correctly
  uses the RAW input (not the normalised one), so
  `/Users/a/../../etc/passwd` is caught before `normalize()` collapses.
- Symlink escape: `realpathSync(input)` + `isUnder(resolved,
  realpathSync(allowedRoot))` with `startsWith(normRoot + sep)`.
  Test "rejects realpath outside allowedRoot (symlink escape)" injects
  a `realpathFn` that returns `/etc/passwd` for a path inside $HOME and
  verifies rejection. Real proof.

**`finder_trash` is escalation-gated?** Yes. `finder.trash` →
`gateOrThrow()` → `gate.requestConfirmation()` → throws if no gate OR
user declined. Same gate covers `move` and `rename`. `reveal`, `tag`,
`listTags` are not gated (reversible; tags removable; reveal read-only).

**Safari `searchHistory` reads the system DB read-only (no mutation
possible)?** Structurally yes, with a caveat:
- SQL is a fixed `SELECT … WHERE … LIMIT ?`. Parameters only; no
  concatenation.
- LIKE special chars (`%`, `_`, `\`) escaped via `\`.
- `existsSync(historyDbPath)` guard; `if (!this.sqliteQuery) return []`
  when injector absent.
- **BUT**: no runtime invariant forces the injected `SqliteQueryFn` to
  open with `SQLITE_OPEN_READONLY` / `mode=ro` / `immutable=1`. The
  JSDoc says "Read-only SQLite query fn"; it's unenforced. Production
  wiring MUST open read-only — document this explicitly, add a
  contract test that rejects non-SELECT SQL passed through the fn
  (defensive, since current code only passes one SELECT).

**Nits**:
- Two `quoteAS` implementations coexist:
  - `mail-driver#quoteAS` — returns bare inner (callers wrap).
  - `safari-driver#quoteAS` — returns `"…"` (wraps).
  Both correct individually, but divergent. Messages imports from
  mail-driver; notes/reminders/music/finder import from safari-driver.
  **Integration (T1) MUST consolidate** — one helper module, single
  convention. Divergence is a footgun waiting for a refactor.
- `finder.listTags` runs full `sanitize()` even though it's read-only
  — you don't want the helper traversing a symlink even to read. Good
  call.
- `app-tools-content.ts` is 578 lines (exceeds the 500-line soft limit
  in `CLAUDE.md`). Candidate to split per-driver.
- `reminders-driver.dateLiteral()` includes a dead-code prefix
  `"(current date) + 0 -- will be replaced …\n"`. Cosmetic cleanup.

## 4. Cross-cutting security pass

- **Shell injection**: **clean**. `grep -rn "shell:\\s*true" src/` ⇒ zero
  hits in reviewed paths. All external-process calls go through
  `execFile` (Node) or `execFile`-promisified in drivers. The
  pre-existing sensors (`app-attention`, `focus-violation`,
  `unsent-drafts`) use an injected `exec(cmd, args[])` wrapper that is
  also `execFile` under the hood — **verified by reading
  `app-attention.ts`**, the wrapper imports `execFile` from
  `node:child_process`. **No caller is passing a shell string.**
- **AppleScript injection**: **mostly clean**, with one caveat. `grep
  -rn "osascript.*\\\${" src/apps/ src/perception/` ⇒ zero interpolations
  directly into `osascript -e`. Every interpolation is into an
  AppleScript source string variable that is then passed to
  `execFile("osascript", ["-e", script])`. User fields are `quoteAS`'d
  everywhere I inspected. Caveat: two divergent `quoteAS` helpers
  (see §3.4 nit) means a future refactor could break one and the
  unified tests would not catch it. T1 should consolidate.
- **Path traversal**: **clean** on Finder's mutating paths (see §3.4).
  `finder.reveal` is deliberately permissive but NUL + absolute checked.
  Camera output paths are server-chosen (`randomUUID()` under
  `~/.cortexos/camera`); screen capture paths similarly server-chosen
  under the perception module's own tree. No user-controllable output
  path in P9.
- **Audit log coverage**: per §7.5 of VISION. Coverage matrix:

  | Capability                          | Audit?  | Action tag       |
  | ----------------------------------- | ------- | ---------------- |
  | Camera capture (P9)                 | yes     | `camera_capture` |
  | Voice intent routing (P9)           | yes     | `voice_intent`   |
  | CU primitive (actuator-level, P10)  | yes     | `cu_action`      |
  | CU step / outcome (loop, P10)       | yes     | `cu_action`      |
  | Mail / Messages / Calendar mutation | yes     | `act_on`         |
  | Safari / Notes / etc mutation       | yes     | `app_mutation`   |
  | Escalation decision recorded        | **no**  | —                |

  Audit-action tag drift is an integration concern: `cu_action` vs
  `act_on` vs `app_mutation` all mean "mutation performed". Consolidate
  to a single vocabulary in T1 (e.g. `actuator_action`, `driver_action`,
  `intent_routed`).

## 5. Test quality

- **Mock aggression**: Appropriate. All branches avoid touching real
  AVFoundation / CoreGraphics / Mail.app / Safari in unit tests by
  threading an injected bridge or `execFileFn`. `AuditLog` is the real
  class writing to a tempdir — nice mix of real vs fake.
- **Failure-path coverage**:
  - P9: permission-denied, device-unavailable, HTTP 500, ECONNRESET,
    missing JPEG, bad JSON, stale generation, TTS interruption — all
    covered.
  - P10: planner throw → blocked, budget exhaustion (faked clock),
    maxSteps cap, irreversible → escalated, done/abort planner
    responses — all covered. Default constants asserted.
  - P12a: happy paths + zod rejection + default-limit clamping + audit
    presence — covered. **Missing**: adversarial input fuzz for
    AppleScript-injection hardening (see §3.3).
  - P12b: sanitizePath has the best failure-path coverage of the four
    (NUL, empty, non-absolute, `..` raw, `..` deep, symlink escape via
    fake realpath, legit path). Notes/Reminders gate-declined tests
    exist.
- **Policy escalation proven, not claimed**: YES in P10 (actuator.actions
  empty on escalation) and P12b (assert on `gate.requestConfirmation`
  calls). In P12a the tests ASSERT `escalate` was called — but not that
  the mutation is skipped when the escalation "fails", because in P12a's
  current design the mutation fires regardless. The test accurately
  documents the broken contract; the contract needs fixing, not the
  test.
- **Integration tests**: P9 ships a voice × camera end-to-end test
  exercising STT → intent → camera-query → onCameraQuery → TTS. No
  equivalent end-to-end test for P10 (loop × real actuator × policy)
  or for P12a (MCP call → escalate → driver). These are exactly the
  tests T1 should add in integration before main-merge.

## 5. Test quality

_TBD — mock aggression, failure-path coverage, policy proof_

## 6. Top 5 patches before merge to main

1. _TBD_
2. _TBD_
3. _TBD_
4. _TBD_
5. _TBD_

## 7. Follow-ups for later phases

_TBD_
