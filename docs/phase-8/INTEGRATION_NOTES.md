# Phase 8 + Phase 11 — Integration Notes

Baseline: `main` at `1db22d8` — 921/921 tests green.

Integration branch: `phase8-11/integration` off `main`.

## Coder branches

| # | Branch | Owner | Scope |
|---|---|---|---|
| C1 | `phase8/screen-capture` | Coder 1 | Swift `cortexos-vision` helper + TS `native-bridge.ts` + `screen-capture.ts` + `ocr.ts` |
| C2 | `phase8/vision-brief-sensor` | Coder 2 | `vision-brief.ts` + `screen_context` sensor + `nchinda_see` MCP tool |
| C3 | `phase11/yabai-bridge` | Coder 3 | `yabai-bridge.ts` + AppleScript fallback + `layouts.ts` + `driver-factory.ts` |
| C4 | `phase11/pane-ornaments-mcp` | Coder 4 | `pane-ornaments.ts` + `wm_*` MCP tools + orchestrator seam |

## Merge order

1. **C1** → integration (provides types + bridge for C2)
2. **C2** → integration (kill `_c1-stub.ts`, repoint imports to C1 modules)
3. **C3** → integration (provides driver types + layouts for C4)
4. **C4** → integration (kill `_c3-stub.ts`, repoint imports to C3 modules)

Conflicts expected (pure-append, easy resolve):
- `src/mcp/tool-schema.ts` — C2 and C4 both append tool definitions
- `scripts/mcp/serve-nchinda.mjs` — C2 and C4 both append tool handlers

## Stub kills (on integration-branch only)

- `src/perception/_c1-stub.ts` — deleted after C2 merge; `vision-brief.ts` imports repointed to `./screen-capture.js` / `./ocr.js`.
- `src/window-manager/_c3-stub.ts` — deleted after C4 merge; `pane-ornaments.ts` imports repointed to `./driver-factory.js`.

## Status

_Filled in as merges land._

## Follow-ups

_Filled in at final report._
