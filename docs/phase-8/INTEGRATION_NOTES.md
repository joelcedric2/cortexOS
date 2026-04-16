# Phase 8 + Phase 11 — Integration Notes

Baseline: `main` at `1db22d8` — 921/921 tests green.

Integration branch: `phase8-11/integration` off `main`.

## Coder branches merged

| # | Branch | Commits landed on integration | What shipped |
|---|---|---|---|
| C1 | `phase8/screen-capture` | `a2568cc`, `71382f0`, `13944ce`, `7ef0dce` | Swift `cortexos-vision` helper + `native-bridge.ts` + `ScreenCapturer` (ring buffer, private-app allowlist, kill-switch) + `ocrImage` wrapper + DECISIONS doc |
| C2 | `phase8/vision-brief-sensor` | `d4e55cd`, `f71bafd`, `8ee30e1` | `vision-brief.ts` (local-only + Haiku modes) + real `screen_context` sensor + `nchinda_see` MCP tool |
| C3 | `phase11/yabai-bridge` | `f5eac99`, `2cb5bd3`, `8721331`, `b333649` | `layouts.ts` (pure math) + yabai CLI driver + AppleScript fallback + `driver-factory.ts` (yabai → applescript → unavailable) |
| C4 | `phase11/pane-ornaments-mcp` | `bfdba91`, `ea03aa0`, `8b6dfe4` | `PaneOrnamentManager` (JankyBorders + AppleScript fallback) + `wm_*` MCP tool suite + orchestrator spawn/kill seam |

## Merge order (actually executed)

1. Scaffold integration branch off main + placeholder INTEGRATION_NOTES.md
2. Merge C1 initial commit (Swift helper + native-bridge) — no conflicts
3. Merge C3 initial commit (layouts.ts) — no conflicts
4. Merge C4 initial commit (pane-ornaments.ts + _c3-stub.ts) — kept stub; C3 hadn't shipped real types yet
5. Merge C1 update (ScreenCapturer)
6. Merge C3 update (yabai driver)
7. Merge C4 update (wm_* MCP tools)
8. Merge C1 update (ocrImage)
9. Merge C3 update (AppleScript fallback)
10. Merge C2 initial commit (vision-brief.ts + _c1-stub.ts)  
    **Stub kill #1**: deleted `src/perception/_c1-stub.ts`; retargeted
    `vision-brief.ts` imports to `./screen-capture.js` (ScreenFrame) and
    `./ocr.js` (OcrResult + ocrImage). Test fixture updated to include
    the real `OcrResult.duration_ms` field.
11. Merge C3 driver-factory.ts  
    **Stub kill #2**: deleted `src/window-manager/_c3-stub.ts`; retargeted
    `pane-ornaments.ts`, `wm-tools.ts`, and their tests to
    `./driver-factory.js`. Type renames + reshapes listed below.
12. Merge C4 orchestrator seam — absorbed stub retarget cleanly via auto-merge
13. Merge C2 updates (nchinda_see + screen-context sensor).  
    **Conflict**: `src/mcp/tool-schema.ts` — both C2 and C4 appended
    schemas to the same end-of-file region. Resolved as pure append-union:
    kept all WM_* schemas from C4, appended `NCHINDA_SEE_SCHEMA` from C2,
    and realigned `WM_TILE_SCHEMA.layout.enum` to C3's real `Layout` union.
    `scripts/mcp/serve-nchinda.mjs` auto-merged.
14. Merge C1 DECISIONS.md — no conflicts
15. Author `tests/phase8-11-dod.test.ts` — 6 end-to-end assertions

## Stub kills (final)

- `src/perception/_c1-stub.ts` — DELETED at step 10. `grep -r _c1-stub` clean.
- `src/window-manager/_c3-stub.ts` — DELETED at step 11. `grep -r _c3-stub` clean.

## Field / type renames propagated

| Old (stub) | New (real) | Sites updated |
|---|---|---|
| `WMWindow` | `Window` (aliased `as WMWindow` at import) | `pane-ornaments.ts`, `wm-tools.ts`, `pane-ornaments.test.ts`, `wm-tools.test.ts` |
| `WMSpace` | `Space` | same |
| `WMTileLayout` | `Layout` | same |
| `moveWindow(id, {space,display,x,y,w,h})` | `moveWindow(id, {space,display, frame:{x,y,w,h}})` | `wm-tools.ts`, `wm-tools.test.ts` |
| `OcrResult.duration_ms?` (stub: optional) | `OcrResult.duration_ms` (real: required) | `vision-brief.test.ts` fixtures |
| Layout tokens `bsp/stack/float/grid-1x2/grid-2x1` | `full/vsplit/hsplit/columns-3/columns-4/grid-2x2/grid-3x2` | `wm-tools.ts` enum, `tool-schema.ts` enum, `wm-tools.test.ts` cases |

## Final test count

- Baseline (`main`): **921 / 921**
- After all merges + stub kills + DoD test: **1089 / 1089** (+168)
  - C1 screen-capture: +17
  - C1 ocr: +9
  - C3 layouts: +17
  - C3 yabai-bridge: +15
  - C3 applescript-fallback: +14
  - C3 driver-factory: +8
  - C4 pane-ornaments: +18
  - C4 wm-tools: +14
  - C4 orchestrator-ornament-integration: +4
  - C2 vision-brief: +20
  - C2 nchinda-see: +6
  - C2 screen-context-sensor: +20
  - Phase 8+11 DoD smoke: +6

`tsc --noEmit` clean. No new `try { … } catch {}` silent-swallow sites
introduced during integration.

## Flagged follow-ups

1. **Layout at the MCP boundary**: `wm_tile` now only accepts `Layout`
   from `layouts.ts`. Operators who previously wrote `wm_tile({layout:"bsp"})`
   (stub-era) will get `invalid-input`. Worth surfacing in the MCP tool
   docstring. yabai maps `full→stack`, `vsplit/hsplit/grid→bsp` internally.
2. **Stub Layout was a superset**: `grid-1x2`, `grid-2x1` from
   `_c3-stub.ts` are not in the real `Layout` union. `grep -rn
   "grid-1x2\|grid-2x1"` on the integration tree returns zero matches —
   nothing stranded, but any downstream agent that memorised those tokens
   will now fail zod validation.
3. **`ScreenCapturer` typed as a class**: C2 types its deps as the class
   itself rather than an interface. Tests match via TypeScript's
   structural typing. If C1 later adds a `private` field that surfaces
   structurally, `nchinda-see-tool.test.ts`, `screen-context-sensor.test.ts`,
   and `phase8-11-dod.test.ts` all break. Suggest extracting a
   `ScreenCapturerContract` interface.
4. **Default `ocrFn` silent degrade**: when the Swift helper isn't built,
   the default `ocrImage` throws `OCRUnavailableError`, the vision-brief
   `try/catch` around `ocrFn(frame.png_path)` swallows it, and briefs
   emit with empty `visible_text`. Intentional — but first prod deploy
   without the built binary will look "fine" while OCR is mute. Suggest a
   one-shot startup warn when the helper is missing.
5. **Concurrent worktree collisions during integration**: the main
   `cortexOS` checkout, plus `cortexOS-c3`, `cortexOS-c4` were all live
   while coders committed. HEAD on the primary kept getting flipped.
   I moved to `cortexOS-integration` at step 2 onwards. When the human
   finalises, work in an isolated worktree.
6. **REVIEW.md authorship**: `docs/phase-8/REVIEW.md` was authored by
   Tester 2 in commits `5cd3fad`, `0d7582c`, `5494e2c` — all present in
   integration history. I did not edit it (scope boundary). T2's BLOCK
   verdict was written BEFORE C2 + C4's later commits landed; by the time
   this note was written all four branches are merged and the DoD is
   green. T2 may want to update their verdict.

## Final integration (grand-merge)

Baseline: `phase8-11/integration` at `685aa0e` — 1089/1089 tests green
(Phase 8 + Phase 11 DoD already proven).

Integration branch: `phase8-final/integration` off `phase8-11/integration`.

### §8.5 branches merged

| # | Branch | Final commit | Net shipped |
|---|---|---|---|
| A1 | `phase8.5/retention-core` | `c8f53ab` | `screen_memories` SQLite wrapper (422 LOC) + `retention.ts` (150 LOC) + nightly-worker wiring. 28 tests. |
| A2 | `phase8.5/encode-hash-adaptive` | `74b5187` | `phash.ts` (64-bit aHash) + `webp-encoder.ts` (q=75, 1280 px) + adaptive fps + 24h byte-budget gate in `screen-capture.ts`. 42 tests. |
| A3 | `phase8.5/kill-audit` | `be03fb5` | `intent-extractor.ts` + `kill-switch.ts` + `ocr-audit.ts` + `AuditAction` extension + voice-orchestrator kill wiring + `screen-capture.ts` audit hooks. 57 tests. |

### Merge order (actually executed)

1. Branch `phase8-final/integration` off `phase8-11/integration`.
2. Merge A1 (`phase8.5/retention-core`) — clean merge, no conflicts.
   Baseline: 1117/1117 (1089 + 28).
3. Merge A2 (`phase8.5/encode-hash-adaptive`) — add/add conflict on
   `src/perception/screen-capture.ts`. Resolved by keeping A2's full
   rewrite (strict superset of HEAD; privacy + ring-buffer invariants
   preserved). Cross-agent fixups:
     * `captureNow()` now returns a `CaptureOutcome` discriminated union.
       Updated `src/mcp/nchinda-see.ts` to unwrap `outcome.frame` and
       raise explicit errors for `budget-exceeded` / `duplicate`.
     * Legacy tests `tests/screen-capture.test.ts` and
       `tests/nchinda-see-tool.test.ts` updated to use the new API
       (`startFps` instead of `intervalSec`; outcome unwrap in
       assertions).
   **Stub kill #1**: deleted `src/perception/_a1-stub.ts`. Moved the
   `ScreenMemoriesStore` structural interface into
   `src/perception/screen-memories-db.ts` (co-located with the real
   `ScreenMemoriesDB` impl). Re-pointed imports in `screen-capture.ts`
   and `tests/capture-budget.test.ts`. Extended the test's `fakeStore`
   to return the full `ScreenMemoryRow` shape (A1's interface has more
   fields than A2's minimal stub did). Baseline: 1159/1159 (1117 + 42).
4. Merge A3 (`phase8.5/kill-audit`) — six conflict regions all on
   `src/perception/screen-capture.ts`. Every conflict was A2-adaptive
   state vs A3-audit state; resolution kept BOTH in every case:
     * Imports: phash ladder + `CAPTURE_DEFAULTS` (A2) AND `AuditLog`
       (A3).
     * `ScreenCaptureOptions`: A2's `now?` field and A3's `audit?`
       field both kept.
     * Instance fields: superset — A2's dedup/budget/bus/surface/
       phash/now fields AND A3's `audit` field.
     * Constructor: A3's `this.audit = opts.audit` appended after A2's
       existing assignments.
     * `tick()` catch: A3's audit-on-skip + redact-on-error branches
       kept; A2's `maybeAdaptFps(fpsBefore)` moved to the `finally`
       block (preserving A2's rate-control invariant).
     * `doCapture()`: A2's DB insert + discriminated `{ ok: true, frame }`
       return kept; A3's `recordAudit(\`app=\${frame.active_app}\`)`
       appended before the return. Final: 1216/1216 (1159 + 57).
5. Cherry-pick `f724ea2` — re-apply VISION.md scope-rework (pre-§8.5
   doc) content that had been rolled back. Clean — no conflicts (the
   base's VISION.md was still at pre-rework state). Test count
   unchanged: 1216/1216.
6. Add `tests/phase8-full-lifecycle.test.ts` — seven-scenario DoD
   smoke covering capture / private-app / dedup / budget / retention /
   kill-switch / voice-kill. Final: **1223/1223 green**.

### Conflicts encountered + resolution (summary)

| File | Type | Conflict | Resolution |
|---|---|---|---|
| `src/perception/screen-capture.ts` | add/add (A2) | A2's 487-line rewrite vs HEAD's 292-line baseline | Kept A2 whole-file; verified all HEAD invariants (private-app allowlist, forceOff latch, ring buffer) survive. |
| `src/perception/screen-capture.ts` | content (A3) | 6 regions: imports, options iface, instance fields, ctor, tick() catch, doCapture() return | Superset merge — kept every field / call from both sides. Audit side-effects now fire for every successful capture AND every skip/error; adaptive fps + budget gate unchanged. |

### Cross-agent API mismatches reconciled

| Mismatch | Fix |
|---|---|
| A2's `captureNow()` returns `CaptureOutcome`; legacy callers expected `ScreenFrame`. | `nchinda-see.ts`: unwrap `outcome.frame`, convert `budget-exceeded` / `duplicate` to explicit errors. Legacy unit tests updated to match the new surface. |
| A2's `ScreenMemoriesStore` stub (5 fields) vs A1's `ScreenMemoryRow` (12 fields). | Stub deleted; interface moved to `screen-memories-db.ts`; the one fake store in `capture-budget.test.ts` expanded to return the full row shape. |
| A3's `recordAudit()` call site in `doCapture()` vs A2's DB-insert + return-outcome block (same function). | Appended the audit call between DB insert and the `{ok: true, frame}` return. |

### Stub kill

- `src/perception/_a1-stub.ts` fully removed. Grep for `_a1-stub`
  returns only a docstring mention inside
  `src/perception/screen-memories-db.ts` (no active imports).

### VISION.md rework re-applied

- `f724ea2` cherry-picked cleanly; §7.0 "Not hardcoded", §4 Phase 8
  rewrite (on-demand + active-task modes), and §8.5 retention +
  adaptive + audit section are all present.

### Policy defaults — no magic numbers

All three agents' numeric defaults are exported as named consts and
picked up via `opts?.x ?? DEFAULT` at the boundary:

- A1: `DEFAULT_RETENTION_DAYS = 7` in `src/perception/retention.ts`.
- A2: `CAPTURE_DEFAULTS` block in `src/perception/screen-capture.ts`
  (START_FPS, MIN_FPS, MAX_FPS, RING_BUFFER_SIZE, DEDUP_WINDOW_SEC,
  DEDUP_WINDOW_MIN_SAMPLES, DEDUP_RATE_UPSCALE_HI,
  DEDUP_RATE_DOWNSCALE_LO, DEDUP_MAX_HAMMING,
  CAPTURE_BUDGET_DAILY_BYTES, BUDGET_WINDOW_MS).
- A3: `DEFAULT_COMBO = "cmd+shift+escape"` in
  `src/perception/kill-switch.ts`; kill / pause / resume / config
  regexes at module scope in `src/voice/intent-extractor.ts`.

### Final state

- `tsc --noEmit`: exit 0.
- `npm test`: **1223/1223 green** (1089 base + 28 A1 + 42 A2 + 57 A3
  + 7 DoD full-lifecycle).
- `src/perception/_a1-stub.ts`: deleted.
- Commits on `phase8-final/integration` (6):
  * `26ef466` merge: A1 retention-core into phase8-final/integration
  * `cab0730` merge(phase8.5): A2 encode-hash-adaptive (phash + webp + budget)
  * `27ce76b` merge(phase8.5): A3 kill-audit (voice-kill + audit hooks + OCR-audit wrapper)
  * `bd09c08` docs(phase-8+): re-apply scope-rework content (was rolled back by linter)
  * `9c0cc40` test(phase-8+): full-lifecycle DoD smoke — union of A1 + A2 + A3
  * (this commit) docs(phase-8+): final integration notes

Ready for human review to merge `phase8-final/integration` → `main`.
