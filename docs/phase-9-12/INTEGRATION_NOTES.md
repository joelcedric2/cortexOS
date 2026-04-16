# Phase 9–12 Integration Notes — Tester 1

**Branch**: `phase9-12/integration`  
**Base**: `main` @ `820f818` (Phase 8 + 8.5 + 11 merge, 1223 tests)  
**Worktree**: `/tmp/cortex-int1`  
**Final test count**: **1478 / 1478 passing** (1223 base + 239 cross-branch additions − 15 after de-duplication of shared fixtures)

## Scope

| Phase | Branch | New tests | Surface |
|-------|--------|-----------|---------|
| 9 | `phase9/camera` | 31 | camera bridge · `nchinda_look` MCP tool · voice camera-query branch |
| 10 | `phase10/computer-use` | 58 | Swift input+ax bridges · `Actuator` · see-plan-act-verify agent loop · `cu_*` MCP tools |
| 12a | `phase12a/comms-drivers` | 83 | Mail / Messages / Calendar AppleScript drivers + MCP tools |
| 12b | `phase12b/content-drivers` | 67 | Safari / Notes / Reminders / Music / Finder drivers + MCP tools · path-security |

## Merge Order

Chosen simplest-first so the conflict surface grows monotonically. Each step was kept green before moving on (`tsc --noEmit` + `npm test`).

1. `phase12b/content-drivers` — no conflicts (pure-additive: 5 driver files + appended MCP schemas). Tests 1223 → 1290.
2. `phase12a/comms-drivers` — conflicts in `src/mcp/tool-schema.ts` + `scripts/mcp/serve-nchinda.mjs`. Resolved as pure-append union. Tests 1290 → 1373.
3. `phase9/camera` — conflicts in `src/mcp/tool-schema.ts`, `src/proactivity/audit.ts`, plus auto-merges in `serve-nchinda.mjs`. Tests 1373 → 1404.
4. `phase10/computer-use` — conflicts in `src/mcp/tool-schema.ts`, `src/proactivity/audit.ts`, `scripts/mcp/serve-nchinda.mjs`, `scripts/native/cortexos-vision/Sources/cortexos-vision/main.swift`. Biggest delta. Tests 1404 → 1462.

The `tests/phase9-12-dod.test.ts` smoke added 16 more cases after all four merges landed → 1478.

## Conflicts & Resolutions

### `src/mcp/tool-schema.ts` (every merge)

Every branch appends new `*_SCHEMA` constants and adds entries to `NCHINDA_TOOL_SCHEMAS`. Each pair of branches conflicts because they both appended near the same tail location. Resolution pattern:

- Keep **all** schema constants from every side.
- Group Phase 12b content schemas into `PHASE12_CONTENT_SCHEMAS` bundle (kept as-is from branch).
- Group Phase 12a comms schemas into a new `PHASE12A_COMMS_SCHEMAS` bundle (added during integration so canonical list stays readable).
- `NCHINDA_TOOL_SCHEMAS` canonical list now spreads both bundles and enumerates the five `CU_*` schemas explicitly (matching phase10's shape).
- Placement: `NCHINDA_LOOK_SCHEMA` follows `NCHINDA_SEE_SCHEMA`; `CU_*` schemas live between `NCHINDA_LOOK_SCHEMA` and the Phase-12 bundles.

Final order in the canonical list:

```
…nchinda / web / skill / cdp / social / wm tools…
CU_CLICK, CU_TYPE, CU_SCREENSHOT, CU_FIND_ELEMENT, CU_SCROLL,
…PHASE12A_COMMS_SCHEMAS (mail/messages/calendar),
…PHASE12_CONTENT_SCHEMAS (safari/notes/reminders/music/finder)
```

### `scripts/mcp/serve-nchinda.mjs` (every merge)

Each branch adds new `case "..."` arms to the dispatch `switch`. Git auto-merged the phase9 addition of `nchinda_look`. Phase 12a/12b/10 conflicts were resolved as union: **every** branch's dispatch arm is preserved — Phase-12b content-tools block, Phase-12a comms-tools block, Phase-10 `cu_*` block all coexist as separate `case` groups.

### `src/proactivity/audit.ts` (phase9 + phase10 conflicts)

Every branch appends a variant to the `AuditAction` union and a doc-comment paragraph. Resolution: keep **every** variant — `camera_capture`, `camera_llm` (P9), `app_mutation` (P12), `cu_action` (P10) — and concatenate each branch's doc paragraph in order (P9, P12, P10). Verified at runtime by `DoD cross-cut — AuditAction union`.

### `scripts/native/cortexos-vision/Sources/cortexos-vision/main.swift` (phase10)

Phase 9 adds a `camera-capture` subcommand; Phase 10 adds `input` and `ax`. Both conflict in the dispatch `switch` and usage string. Resolved as union so the Swift binary now dispatches all 5 subcommands (`capture`, `ocr`, `camera-capture`, `input`, `ax`). The exit-code-3 description was merged to cover all permission types: Screen Recording / Vision / Camera / Accessibility.

## Cross-phase API checks

- `NchindaLookResult.frame.path` uses the on-disk JPEG path. DoD test verifies field round-trips.
- `runComputerUse` policy gate fires **before** actuation (DoD test asserts zero actuation calls after an irreversible escalation at step 2).
- `AppCommsTools.mailSend` calls `escalate(...)` before `driver.send(...)`. When the escalator throws, `driver.send` must not fire — DoD test asserts the fake driver's AppleScript script log stays empty.
- `sanitizePath` rejects both literal `..` traversal and realpath escape via an injected `realpathFn` that resolves a honeypot path to `/etc/passwd`.
- `computeGaps` produces exactly 4 gaps for a 3-busy-period day (09:00–10:00, 10:30–12:00, 13:00–15:00, 15:30–17:00).

No cross-phase API mismatches surfaced. The four branches touched disjoint dispatch groups and shared only the three append-list files called out above.

## Commit trail

```
6eb49c0 merge(phase-10): computer-use MCP tools + see-plan-act-verify loop
053b1fe merge(phase-9): camera bridge + nchinda_look + voice camera-query routing
2044d88 merge(phase-12a): Mail/Messages/Calendar comms drivers
417af63 merge(phase-12b): Safari/Notes/Reminders/Music/Finder content drivers
820f818 (main) Merge Phase 8 + 8.5 + 11: perception + embodiment
```

## Quality gate

- [x] `npx tsc --noEmit` exit 0 after every merge
- [x] `npm test` — 1478 / 1478 passing
- [x] No silent catches introduced by merge-conflict resolution
- [x] Every branch's tests survive the merge (verified by count deltas)
- [x] DoD smoke `tests/phase9-12-dod.test.ts` — 16 assertions passing

**Ready for human review.** Do NOT merge to `main` — reviewers own the `docs/phase-9-12/REVIEW.md` artefact; this file is the integration-tester deliverable.
