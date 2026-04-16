# Phase 8 + Phase 11 — Independent Review (Tester 2)

> Read-only audit of branches `phase8/screen-capture`, `phase8/vision-brief-sensor`,
> `phase11/yabai-bridge`, `phase11/pane-ornaments-mcp`, and the in-flight
> integration branch `phase8-11/integration` against `docs/phase-8/VISION.md`
> §4 (Phase 8 + Phase 11) and §7 (privacy posture).
>
> No source edits. No merges. Verdict at top, evidence below.

## 0. Verdict

**Verdict: BLOCK.**

`phase8-11/integration` is **not ready to merge into `main`**. Only ~25% of the
artifacts that VISION §4 Phase 8 + Phase 11 require actually exist across the
four coder branches. Two of the four branches (`phase8/vision-brief-sensor` and
`phase11/pane-ornaments-mcp`) carry **zero diff versus `main`** — their tip
commit is the Phase 8+ vision-plan doc itself. The integration branch carries
only `docs/phase-8/INTEGRATION_NOTES.md`; no code has been merged into it.

| Spec item (§4) | Status |
|---|---|
| `src/perception/screen-capture.ts` (ring buffer, private-app allowlist, kill-switch) | **Missing** — never committed on any branch |
| `src/perception/ocr.ts` (local OCR wrapper) | **Missing** (Apple Vision CLI exists, TS wrapper does not) |
| `src/perception/vision-brief.ts` | **Missing** on `phase8/vision-brief-sensor` |
| `screen_context` sensor (real) | **Missing** |
| `nchinda_see()` MCP tool | **Missing** |
| `src/window-manager/yabai-bridge.ts` (CLI wrap + AppleScript fallback) | **Missing** — only `layouts.ts` (pure math) shipped |
| `src/window-manager/pane-ornaments.ts` + `wm_*` MCP tools | **Missing** |

The only real deliverables are:
1. **C1:** Swift `cortexos-vision` helper + `src/perception/native-bridge.ts`
   (a thin, well-typed, injection-safe bridge — 150 LOC).
2. **C3:** `src/window-manager/layouts.ts` — pure layout math + 17 green tests.

Both landed items are **high-quality primitives**, but they are prerequisites
for the phases' actual deliverables. Shipping `integration` as-is would merge a
README-level façade for capabilities that do not exist, violating VISION §7
(the `screen_context` sensor must be a real, auditable thing with a kill-switch
and allowlist — not a TODO).

See §8 for the ordered fix list required before re-review.

## 1. Scorecard (1-5)

Scale: 1 = unacceptable; 3 = fine for this phase's scope; 5 = exemplary.
`N/A` = nothing on the branch to grade (zero diff vs `main`).

| Branch | Correctness | Security | TS rigor | Test quality | Design | Spec adherence |
|---|---|---|---|---|---|---|
| **C1** `phase8/screen-capture` | 4 | 4 | 5 | 2 | 4 | **2** |
| **C2** `phase8/vision-brief-sensor` | N/A | N/A | N/A | N/A | N/A | **1** |
| **C3** `phase11/yabai-bridge` | 5 | 5 | 5 | 5 | 5 | **2** |
| **C4** `phase11/pane-ornaments-mcp` | N/A | N/A | N/A | N/A | N/A | **1** |
| **Integration** `phase8-11/integration` | 2 | 3 | 3 | 1 | 2 | **1** |

Notes:
- **C1 test quality = 2**: The primitive has zero direct tests on the branch;
  an untracked `tests/screen-capture.test.ts` exists in working trees that
  references a `ScreenCapturer` class that was never committed. The `execFile`
  wrapper, error hierarchy, and JSON parsing have no coverage at all.
- **C1 spec adherence = 2**: builds the Swift helper (§4.1 item 1 half-done —
  only the capture primitive, not the `ScreenCapturer` class with ring buffer,
  allowlist, kill-switch), skips OCR TS wrapper (§4.1 item 2), does not wire
  the sensor (§4.1 item 4) or MCP tool (§4.1 item 5).
- **C2 / C4**: scored 1 on spec adherence because the branches exist but carry
  no implementation — the contract with the planner was to ship code, not just
  hold a branch name.
- **C3**: layout math is exemplary (pure, exhaustive switch, 17 tests covering
  edge cases + over-capacity + viewport offset + clone semantics), but it is
  ~15% of Phase 11 item 1 in §4 — the actual yabai CLI wrapper, AppleScript
  fallback, driver factory, and MCP tool surface are all absent. Grading the
  slice landed = 5; grading against the Phase 11 mandate = 2.
- **Integration**: grade reflects that the branch exists but has merged none of
  C1/C3, shows no test pass on `main`'s 921/921 baseline has been re-verified
  post-merge, and no stub-kill commits have landed.

## 2. Per-branch spec-drift vs VISION §4

_TBD — filled in commit #3._

## 3. Per-branch findings

### 3.1 C1 — `phase8/screen-capture`

_TBD — filled in commit #3._

### 3.2 C2 — `phase8/vision-brief-sensor`

_TBD — filled in commit #3._

### 3.3 C3 — `phase11/yabai-bridge`

_TBD — filled in commit #3._

### 3.4 C4 — `phase11/pane-ornaments-mcp`

_TBD — filled in commit #3._

## 4. Privacy pass (§7)

_TBD — filled in commit #4._

## 5. Security pass

_TBD — filled in commit #4._

## 6. Test quality

_TBD — filled in commit #5._

## 7. Design smells

_TBD — filled in commit #5._

## 8. Top 5 patches before merging `phase8-11/integration` → `main`

_TBD — filled in commit #5._

## 9. Follow-ups for later phases

_TBD — filled in commit #5._

---

_Author: Tester 2 (independent reviewer, read-only)._
