# Phase 9-12 Reviewer 1 — Independent Read-Only Review

> Scope: `phase9/camera`, `phase10/computer-use`, `phase12a/comms-drivers`,
> `phase12b/content-drivers`, plus the in-flight `phase9-12/integration` (T1).
> Reviewer 2 owns phases 13/14/15.
>
> Basis: `docs/phase-8/VISION.md` §4 (Phase 9, 10, 12) and §7 privacy invariants.
> This review is strictly read-only — no source edits, only this file.

## Verdict

**TBD** — skeleton committed; sections below filled in as the branches are walked.

## 1. Scorecard (1–5, 5 = excellent)

| Branch                     | Correctness | Security | TS Rigor | Test Quality | Design | Spec Adherence |
| -------------------------- | ----------- | -------- | -------- | ------------ | ------ | -------------- |
| phase9/camera              | –           | –        | –        | –            | –      | –              |
| phase10/computer-use       | –           | –        | –        | –            | –      | –              |
| phase12a/comms-drivers     | –           | –        | –        | –            | –      | –              |
| phase12b/content-drivers   | –           | –        | –        | –            | –      | –              |
| phase9-12/integration (T1) | –           | –        | –        | –            | –      | –              |

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
