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

## 4. Cross-cutting security pass

- **Shell injection**: _TBD_
- **AppleScript injection**: _TBD_
- **Path traversal**: _TBD_
- **Audit log coverage**: _TBD_

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
