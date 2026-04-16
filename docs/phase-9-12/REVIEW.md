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
_TBD_

### 2.2 phase10/computer-use — VISION §4 Phase 10
_TBD_

### 2.3 phase12a/comms-drivers — VISION §4 Phase 12 (Mail / Calendar / Messages subset)
_TBD_

### 2.4 phase12b/content-drivers — VISION §4 Phase 12 (Safari / Notes / Reminders / Music / Finder subset)
_TBD_

### 2.5 phase9-12/integration — T1 integration branch
_TBD_

## 3. Per-branch findings

### 3.1 phase9/camera — deep-dive
_TBD — one-shot invariant, Continuity Camera, permission-denied, voice additive-only_

### 3.2 phase10/computer-use — deep-dive
_TBD — policy gate ordering, step/time bounds, text cap, audit coverage_

### 3.3 phase12a/comms-drivers — deep-dive
_TBD — quoteAS coverage, escalation gate on mail/messages/calendar, injection fuzzing_

### 3.4 phase12b/content-drivers — deep-dive
_TBD — sanitizePath vs traversal/symlink/NUL, finder_trash escalation, Safari history read-only_

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
