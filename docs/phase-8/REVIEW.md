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

Measured by `git diff --stat main..<branch>` and by mapping landed files to
the seven Phase 8 / five Phase 11 items in the plan.

| §4 item | Branch expected | Landed? | Evidence |
|---|---|---|---|
| 8.1 ScreenCaptureKit loop @ 1–2 fps + active-window detection | C1 | **Partial** | Swift `CaptureCommand.swift` does one-shot capture + active-app. No loop, no 1–2 fps scheduler, no ring buffer. |
| 8.2 Apple Vision OCR TS wrapper | C1 | **Partial** | Swift `OCRCommand.swift` ships; TS `ocr.ts` does not. OCR is only reachable by direct `bridge.ocr(path)` calls. |
| 8.3 `vision-brief.ts` (screenshot → `{activeApp, windowTitle, visibleText, uiElements[], sentiment?}`) | C2 | **Missing** | Branch tip = `1db22d8` (plan-doc). Zero code. |
| 8.4 Real `screen_context` sensor (debounced, active-app change, idle > 5 min, draft > 5 min) | C2 | **Missing** | Not on any branch. `src/sensors/` on main does not gain a new file. |
| 8.5 `nchinda_see()` MCP tool | C2 | **Missing** | `src/mcp/tool-schema.ts` and `src/mcp/nchinda-tools.ts` unchanged vs main. |
| 8.6 Tests: fixture PNGs, OCR fallback, sensor debounce | C1 + C2 | **Missing** | Only `tests/layouts.test.ts` is new, and it is on C3. |
| 11.1 `yabai-bridge.ts` CLI wrap + AppleScript fallback | C3 | **Missing** | Branch ships only `layouts.ts`. No `yabai-bridge.ts`, no AppleScript driver, no `driver-factory.ts`. |
| 11.2 Preset grids (1/2/3/4/5+ → 1-pane/vsplit/columns/grid) | C3 | **Landed** | `layouts.ts` defines `full`, `vsplit`, `hsplit`, `columns-3`, `columns-4`, `grid-2x2`, `grid-3x2`. |
| 11.3 `pane-ornaments.ts` (JankyBorders colors per agent) | C4 | **Missing** | Branch tip = plan-doc commit. |
| 11.4 WorktreeManager integration (window slot per agent) | C4 | **Missing** | No orchestrator seam. `src/orchestrator/*` unchanged vs main. |
| 11.5 `wm_move_window`, `wm_tile`, `wm_focus`, `wm_space_switch` | C4 | **Missing** | `src/mcp/tool-schema.ts` unchanged. |

§7 privacy items (non-negotiable):

| §7 item | Required | Landed? |
|---|---|---|
| §7.1 Opt-in per sensor + per app, default off | sensor ctor gates, UI toggles | **N/A — sensor missing** |
| §7.2 No frames leave Mac without explicit LLM action | allowlist of LLM destinations | **Partially** — `native-bridge.ts` is network-free (verified: zero matches for `fetch\|https://` in `src/perception` on C1), but `vision-brief.ts` is unshipped so end-to-end property is unverified. |
| §7.3 Local OCR first | Apple Vision path preferred | **Partially** — Swift OCR primitive exists, but no TS caller routes to it. |
| §7.4 ⌘⇧Esc kill-switch disables perception session-wide | capturer method + hotkey wiring | **Missing** — no `forceOff()` or equivalent on any module; plan is only tested by the untracked leftover test file. |
| §7.5 Audit log every frame / vision call / actuator | `~/.cortexos/audit.ndjson` append | **Missing** — `AuditLog` class exists at `src/proactivity/audit.ts` but no perception module calls `append()`. |
| §7.6 Visible state: eye/camera icon on waveform | UI wiring | **Missing** |
| §7.7 Private-app allowlist (1Password, banking, disk-encryption) | deny-list inside capturer | **Missing** — no `DEFAULT_PRIVATE_APPS` constant or `isPrivateApp()` check lives in any tracked file in `src/perception`. |

## 3. Per-branch findings

### 3.1 C1 — `phase8/screen-capture`

**Landed (2cf391f, rebased to a2568cc on main already):**
- `scripts/native/build-vision.sh` — gates on `command -v swift` and `uname -s == Darwin`; exits 0 (not 1) when either is missing, so `npm install` or a bootstrap hook can call it unconditionally. ✅
- `scripts/native/cortexos-vision/` — Swift Package (`platforms: .macOS(.v13)`), three sources (`main.swift`, `CaptureCommand.swift`, `OCRCommand.swift`, `VisionError.swift`). Uses `ScreenCaptureKit` + `Vision`, no network APIs.
- `src/perception/native-bridge.ts` — `execFile`-based bridge with `NativeBridgeUnavailableError` / `ScreenPermissionDeniedError` / `NativeBridgeError` hierarchy. `VisionBridge` interface + `BridgeOptions` injectable for tests.

**Answers to the 4 targeted questions:**

1. **Swift helper build gated cleanly when Swift missing?** ✅ Yes. `build-vision.sh:16-19` prints a notice and `exit 0` when `swift` isn't on PATH — the rest of cortexOS keeps running, and the TS bridge's `isAvailable()` returns `false`, surfacing as a `NativeBridgeUnavailableError` on first use.
2. **Private-app allowlist enforced BEFORE capture (not after)?** ❌ **No allowlist exists anywhere on the branch.** `CaptureCommand.swift` captures whatever is frontmost, emits PNG to disk, *then* returns metadata. A caller has no way to opt out of capturing 1Password / banking windows — they'd have to filter after the bytes are already on disk. Grep for `DEFAULT_PRIVATE_APPS|isPrivateApp|allowlist` in `src/perception` on this branch: 0 hits. This is the single largest §7 violation.
3. **Ring-buffer GC actually unlinks files?** ❌ **There is no ring buffer.** No `ScreenCapturer` class, no `frames[]`, no `evictOverflow()`, no `tryUnlink()`. The Swift helper cheerfully writes a fresh UUID-named PNG to `$TMPDIR` on every call and walks away. Disk usage grows monotonically until the OS purges `$TMPDIR` on reboot.
4. **Permission-denied surfaced cleanly?** ✅ Yes. Three-layer defense:
   - Swift side: `VisionError.permissionDenied` → prints `permission-denied\n` to stderr, exits code 3 (`VisionError.swift:23-25`, `main.swift:33`).
   - TS side: `runHelper` matches `stderr.includes("permission-denied")` → `reject(new ScreenPermissionDeniedError())` (`native-bridge.ts:142-145`).
   - Error has a user-actionable message pointing at System Settings → Privacy & Security → Screen Recording.
   Only nit: the string match is substring-based; if the Swift error path ever prints `permission-denied: user-revoked` the match still works, but a future refactor could collide (e.g. `capture-failed: permission-denied-by-tcc`). Consider exit-code matching (code 3) as the primary signal with the stderr string as a secondary hint.

**Additional C1 observations:**
- `CaptureCommand.swift:88` — temp-path construction uses `NSTemporaryDirectory() + UUID().uuidString + ".png"`. Safe: the UUID is Swift-generated, not user-controlled; no path traversal.
- `CaptureCommand.swift:37` — if `--app <bundle-id>` is supplied but the frontmost app doesn't match, the helper throws `VisionError.noMatchingWindow` (tag `no-matching-window`, exit 1). The TS bridge does not currently distinguish this from a generic `NativeBridgeError` — it will reject with `err.message` only. Consider exporting a `NoMatchingWindowError` or letting callers opt into a null-return.
- `OCRCommand.swift:26-34` — `VNRecognizeTextRequest` uses `.accurate` + language correction. No rate-limit or request cap; a caller passing a 50MB PNG could tie up the helper for seconds. Timeout is imposed at the TS layer (`timeoutMs` default 15s) which is the right place.
- `native-bridge.ts:104` — `access(binary)` proves existence but not executability. On Unix that means a user who chmod-stripped the binary would still have `isAvailable()` return `true` and get an `ENOENT`-lite failure on first invocation. Marginal — `access(binary, X_OK)` is tighter.

### 3.2 C2 — `phase8/vision-brief-sensor`

**Landed:** nothing. `git diff --stat main..phase8/vision-brief-sensor` returns empty. Tip commit (`1db22d8`) is literally the `docs(phase-8+)` plan commit.

**Answers to the 3 targeted questions:**

1. **Local-only mode NEVER hits the network (grep test present)?** ❌ Un-answerable — module doesn't exist. A reviewable implementation must include an explicit test such as:
   ```ts
   test("local-only mode refuses to call fetch", async () => {
     let fetchCalls = 0;
     const spy = () => { fetchCalls++; return new Response("{}"); };
     await buildBrief(frame, {}, { mode: "local-only", fetchImpl: spy });
     assert.equal(fetchCalls, 0);
   });
   ```
   plus a `grep -r "fetch(\|https://" src/perception/vision-brief.ts` CI guard.
2. **Haiku path has timeout + redacted rationale?** ❌ Un-answerable.
3. **Private-app frames blocked from LLM path?** ❌ Un-answerable. The spec requires this to be enforced inside `vision-brief.ts` itself (defense-in-depth), not only upstream at the capturer, because the capturer might deliver a cached frame whose active-app changed.

**Action: Coder 2 needs to actually ship this branch.** An untracked working-copy version was observed during review that imports from `./_c1-stub.js` and `./_c1-stub.js` — the stub was never committed either, so even the WIP doesn't compile. That WIP also has a *good* shape (redacted error labels via `SAFE_REASON_PATTERNS`, `AbortController` timeout, `PRIVATE_APPS` deny-list, fallback-to-local on HTTP 5xx / parse-error / schema-mismatch) — but none of it is landed.

### 3.3 C3 — `phase11/yabai-bridge`

**Landed (f5eac99):**
- `src/window-manager/layouts.ts` — 190 LOC, pure functions only.
- `tests/layouts.test.ts` — 190 LOC, 17 tests, all green (`node --test tests/layouts.test.ts` → `pass 17 fail 0`).

**Answers to the 3 targeted questions:**

1. **`execFile` arg-array only (no shell interp)?** ❌ Un-answerable — `yabai-bridge.ts` does not exist on the committed branch. (An untracked working-copy version was seen; it does use `execFile("yabai", args, { shell: false })` correctly, with a 5 s `timeout` and 1 MB `maxBuffer` cap — but it is not committed, so it cannot be reviewed.)
2. **Unavailable-driver path throws a typed error (not silent no-op)?** ❌ Un-answerable. The WIP version has `WMUnavailableError` + `YabaiCommandError` classes and returns `false` from `isAvailable()` rather than throwing on probe, which is the correct shape — but again, unshipped.
3. **`computeLayout` is pure (no side effects)?** ✅ **Yes, verifiably.** `layouts.ts` has no imports from `node:*` at all (no `fs`, no `child_process`, no `os`, no `process`). Every function is a pure computation. Slots returned are per-call clones (`out[i] = { x: src.x, y: src.y, w: src.w, h: src.h }`) so caller mutation cannot poison future calls. Test `tests/layouts.test.ts:199-203` explicitly asserts clone independence. The `layoutCapacity` table is frozen by being a `Record<Layout, number>` const and accessed only through `layoutCapacity()` which returns the number by value.

**Additional C3 observations:**
- `layouts.ts:89-95` — `computeLayout` rejects non-integer and negative `n` with `RangeError` (test at `tests/layouts.test.ts:55-60`). Good — fail-fast over silent clamp.
- `layouts.ts:120-135` — remainder-absorbing last-slice is correct: `assertCoversViewport` test (`tests/layouts.test.ts:18-32`) proves no one-pixel gaps and no overlap.
- Over-capacity cycling (`grid-2x2` + 6 windows) is documented + tested (`tests/layouts.test.ts:175-181`). Good: the spec says "N agents → layout", and cycling is a reasonable disambiguation for an over-capacity user choice.
- `layoutCapacity()` is exported — useful for the orchestrator to preflight-check "should I split to a new space?".

### 3.4 C4 — `phase11/pane-ornaments-mcp`

**Landed:** nothing. `git diff --stat main..phase11/pane-ornaments-mcp` returns empty. Tip commit = `1db22d8` (same plan-doc commit as C2).

**Answers to the 4 targeted questions:**

1. **`borders` CLI detected at runtime (not at import)?** ❌ Un-answerable.
2. **Orchestrator seam is back-compat (no ornamentManager → tests still pass)?** ❌ Un-answerable. `src/orchestrator/*` has no changes vs main; the existing 921/921 test suite pre-merge suggests nothing broke *yet*, but that's only because no integration happened.
3. **Window-title matching doesn't false-positive on unrelated Terminal windows?** ❌ Un-answerable.
4. **MCP tool surface (`wm_move_window`, `wm_tile`, `wm_focus`, `wm_space_switch`)?** ❌ Not registered. `src/mcp/tool-schema.ts` and `src/mcp/nchinda-tools.ts` have no `wm_*` additions.

**Action: Coder 4 needs to ship.** Same situation as C2 — a branch-name exists but no code.

## 4. Privacy pass (§7)

This is the section that carries the most weight, per the Tester 2 brief.
The headline finding: **three of the four non-negotiable privacy invariants
are not met today**, because the modules that would enforce them are missing
from every committed branch.

### 4.1 "No frames leave the Mac without explicit LLM action" (§7.2)

- `grep -rn "fetch(\|https://\|axios\|node-fetch\|undici" src/perception/` → **0 matches** on C1 / `main`. ✅ for C1's primitives in isolation.
- No `vision-brief.ts` on C2 → cannot verify end-to-end. The LLM call has to go somewhere; the spec pins it to a *single* egress point in `vision-brief.ts` + (future) `nchinda_see`, guarded by explicit consent.
- **The test that must exist**: a unit test that instantiates `buildBrief(frame, {}, { mode: "local-only" })` with a sentinel `fetchImpl` spy and asserts `fetchImpl` is never called. Without this, a future contributor can add a network lookup (telemetry, caching, model-card fetch) and the invariant silently rots. Gating via `grep` in CI is a secondary but complementary signal.

### 4.2 Private-app allowlist (§7.7)

Spec requires "1Password, banking sites, disk-encryption fields — never sampled."

- **No tracked file** contains `1Password`, `Keychain`, `FileVault`, `Bitwarden`, `Disk Utility`, or any `private-app` / `allowlist` keyword. Confirmed by `grep -rn -i "1password\|keychain\|filevault\|bitwarden\|private.app" src/` across `phase8/screen-capture` and `main`: 0 hits.
- **Required shape** (minimum):
  - Bundle-ID set (persuasive because it's harder to spoof than display names): at least `com.1password.1password`, `com.1password.onepassword7`, `com.agilebits.onepassword7`, `com.bitwarden.desktop`, `com.apple.keychainaccess`, `com.apple.DiskUtility`, `com.apple.systempreferences`, and a regex/set for `com.apple.Safari.*bank*` and common banking bundle IDs (Chase, BOA, Wells, Citi).
  - Allowlist is checked *before* the Swift helper touches `SCShareableContent` OR the helper must accept `--deny-bundle-id <id>` and skip capture entirely (no PNG on disk) when the frontmost app matches. Current `CaptureCommand.swift:37` honors `--app <bundle-id>` as a positive filter only; there is no negative filter.
  - Window-title fallback for Safari — because the active-app check will miss a banking tab inside Safari. Allowlist must be checked against `active_app + window_title` joined, with banking URL/title regex.
- Until this is enforced structurally (not just documented), **a screenshot of 1Password WILL land on disk** if the sensor is turned on and 1Password is frontmost. Hard §7 violation.

### 4.3 Kill-switch (§7.4)

- Spec: "⌘⇧Escape globally disables all perception for the rest of the session."
- Landed: **nothing**. No `forceOff()` method, no `KILL_SWITCH` flag, no hotkey registration in `src/ui/hotkey.ts` for `⌘⇧Esc`.
- `src/controller/cortex.ts` does not hold a reference to any `ScreenCapturer`, so even if the capturer existed there's no wired path from a global hotkey to `capturer.forceOff()`.
- **Required:** `ScreenCapturer.forceOff(): Promise<void>` that (a) stops the interval, (b) purges in-memory frame list, (c) `unlink`s every PNG in the storage dir, (d) latches the instance so further `start()`/`captureNow()` calls throw. Plus a UI hotkey wiring in `src/ui/hotkey.ts` bound to `cmd+shift+escape`, plus a persistent session flag in `~/.cortexos/session.json` honored across process restarts.

### 4.4 Audit log (§7.5)

- Spec: "every frame sample, every vision call, every actuator action — appended to `~/.cortexos/audit.ndjson`."
- `src/proactivity/audit.ts` defines an `AuditLog` class with `append()` / `dailySummary()` + `~/.cortexos/audit.ndjson` default (`audit.ts:37-45`). ✅ The plumbing exists.
- **No perception module calls it.** Grep `src/perception/` for `AuditLog|audit.ts|audit.append`: 0 hits. C1 code in `native-bridge.ts` does not log. `screen-capture.ts` doesn't exist to log. `vision-brief.ts` doesn't exist to log.
- **Required:** Every `bridge.capture()`, `bridge.ocr()`, `buildBrief({ mode: "llm" })` call must append an event: `{ kind: "perception.capture"|"perception.ocr"|"perception.llm_vision", ts, bundle_id, png_sha256, bytes, success, duration_ms }`. No PNG *contents*, no OCR text, no LLM output — just the fact-of-capture, for user review.

### 4.5 Visible state (§7.6)

- Waveform eye icon / camera dot — UI wiring is missing but is Phase 8.5/UI scope; acceptable to defer. Flag as a **follow-up** (§9).

### 4.6 Local OCR first (§7.3)

- Swift helper has the Apple Vision path (`OCRCommand.swift`). ✅ primitive exists.
- No caller chooses it yet because `vision-brief.ts` is absent. Whether the final implementation correctly prefers local OCR before any cloud path cannot be verified.

### 4.7 Network-egress audit

Grep matrix, scoped to files touched by Phase 8/11 on committed branches:

| Pattern | `src/perception/native-bridge.ts` | `src/window-manager/layouts.ts` |
|---|---|---|
| `fetch(` | 0 | 0 |
| `https://` | 0 | 0 |
| `axios` / `node-fetch` / `undici` | 0 | 0 |

Both committed files are network-free. ✅ for what exists.

## 5. Security pass

### 5.1 `any` usage in new files

`grep -rn ": any\b\|as any" src/perception src/window-manager` on the worktree with C1 + C3 files copied in: **0 matches**. ✅ Strict TypeScript discipline held.

### 5.2 Silent catches

`grep -rn "catch[^{]*\{\s*\}" src/perception src/window-manager`: **0 matches**. ✅

Two near-misses worth calling out:
- `src/perception/native-bridge.ts:104-108` — `isAvailable()` uses a catch that returns `false` rather than swallowing. This is intentional and documented.
- The untracked `screen-capture.ts` WIP has a `.catch(() => { /* swallow — tick logs internally */ })` on the interval callback. Acceptable pattern *because* the inner `tick()` does its own `try/catch` + `console.warn`. Flag for re-review when the file is actually committed.

### 5.3 Path-traversal in Swift helper args

The `cortexos-vision capture` and `cortexos-vision ocr` subcommands accept `--out <path>` and `--image <path>` respectively. Both reach the filesystem via Swift's `URL(fileURLWithPath:)` without normalization.

- **Agent-controlled filename risk:** Yes, if an agent passes `--image ../../etc/passwd` Swift will happily try to open it. Vision will return `ocr-failed: cannot read image: ...` (`OCRCommand.swift:17-20`) because it's not a valid image, but on a valid image the helper *will* read it. **Low exploitability** because (a) the OCR text path returns only OCR text, not raw bytes, (b) the attack surface requires the attacker to already be driving cortexOS, and (c) no privilege escalation is available — the helper runs with the user's own credentials. **Recommended hardening:** in `native-bridge.ts`, reject `imagePath` that contains `..` or doesn't start with `homedir()` or `tmpdir()`. Same for `outPath`.
- **`--out` in capture:** The TS bridge constructs the path itself via `randomUUID()` + `storageDir` (in the untracked `screen-capture.ts`), so the risk only applies if an external caller passes a custom `outPath`. Still worth the same normalization guard.

### 5.4 Shell injection in yabai/AppleScript calls

- `src/window-manager/yabai-bridge.ts` is **not committed**, so formally no risk surface exists on the branch today. The untracked WIP version does the right thing: `execFile("yabai", args, { shell: false })` with every user-supplied value passed as a separate `args` element. When it lands, verify this property holds.
- AppleScript fallback is also unshipped. When it lands, audit against the same pattern used in `src/social/drivers/imessage-driver.ts:90-95` (`escapeAppleScript(s)` — escapes `"` and `\` before interpolating into the `osascript -e '...'` string). That escape function handles the two main vectors (`"`, `\`) but not Unicode control characters or newlines — when C3 ships, re-audit.

### 5.5 AppleScript injection (user-controlled strings → `osascript -e`)

- Same status as §5.4 — no AppleScript in Phase 8/11 lanes today. Phase 11 item 11.1 fallback must use `execFile("osascript", ["-e", template], …)` with a **parameterized template** or with the same escape helper used in Phase 4's iMessage driver. Never string-concat user input into `-e`.

### 5.6 `execFile` / `execSync` / `shell: true` audit

`grep -rn "shell: *true\|exec\(" src/perception src/window-manager src/sensors src/mcp` → **0 matches**. ✅ All existing callers use `execFile` with arg arrays.

### 5.7 Timeout + maxBuffer on every spawn

- `native-bridge.ts:124-127` — `{ timeout: 15000, encoding: "utf8" }`. Timeout is set but `maxBuffer` is not. Default Node `maxBuffer` is 1 MB, which is enough for JSON metadata/OCR, but explicit `maxBuffer: 4 * 1024 * 1024` would document the ceiling. Minor nit.
- Future yabai wrapper (when committed) must set both `timeout` and `maxBuffer` since `yabai -m query --windows` can emit >100 KB JSON on machines with many windows. The WIP version I saw sets 5 s + 1 MB — fine.

### 5.8 Untyped child_process error codes

`native-bridge.ts:136` — `const errno = (err as NodeJS.ErrnoException).code;` then compares to `"ENOENT"`. The `as` cast is pragmatic (Node's callback signature is loose). Consider narrowing via `typeof err === "object" && err && "code" in err && err.code === "ENOENT"` for strict-mode cleanliness, but this is idiomatic Node TypeScript and does not introduce `any`. Acceptable.

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
