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
