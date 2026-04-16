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

### 6.1 Coverage by branch

| Branch | Test file(s) | Count | Mocks vs. real behaviour | Failure-path coverage |
|---|---|---|---|---|
| C1 | **none committed** | 0 | N/A | N/A |
| C2 | none | 0 | N/A | N/A |
| C3 | `tests/layouts.test.ts` | 17 | Pure — no mocks needed; tests the real math directly. Exemplary. | ✅ n=0, negative n, non-integer n, zero-size viewport, over-capacity cycling, clone independence. |
| C4 | none | 0 | N/A | N/A |
| `main` (baseline) | 178 suites / 921 tests | 921 | Mostly in-process mocks; good discipline. | — |

### 6.2 C3 test assessment (the one suite that exists)

- **Mocks vs. real:** Zero mocks — appropriate because `layouts.ts` is pure. Tests call the real function and assert geometry. This is the right approach; any mock here would be over-engineering.
- **Failure paths:** `n < 0` throws `RangeError` (asserted), `n` non-integer throws (asserted), zero-viewport returns zero-area slots (asserted). Missing: what happens with `Number.NaN`? (Not tested; `Number.isInteger(NaN)` is `false`, so it correctly throws, but an explicit test would document intent.)
- **Property-based gap:** Every test is example-based. Since the function is pure and the invariants are strong (coverage of viewport = sum of slot areas, no overlap), a `fast-check` property test like `forall(viewport, n ≤ capacity) ⇒ slots tile exactly` would catch regressions far better than 17 examples. Non-blocking, nice-to-have.

### 6.3 Orphaned test files observed

During review, two uncommitted test files surfaced in a working tree:
`tests/screen-capture.test.ts` and `tests/yabai-bridge.test.ts`. Both were
seen during a previous `git status` but neither is in any branch. They
describe the *correct* shape of the missing implementations
(`ScreenCapturer` with `forceOff()`, `DEFAULT_PRIVATE_APPS`,
`PrivateAppSkippedError`, `purge(olderThanSec)`; `createYabaiDriver(exec)`
with `WMUnavailableError` + `YabaiCommandError`). Tester 1 appears to have
written them as a spec-from-tests exercise but Coders 1/3 never picked them
up. **These files should either be committed with their implementations or
explicitly deleted — leaving them as untracked is a footgun for merge-day.**

### 6.4 Integration branch test status

- `phase8-11/integration` does not carry `src/perception/` or
  `src/window-manager/` yet (no merges happened).
- Running the full suite on `phase8-11/integration` currently yields
  exactly what `main` does (921/921 green) — **because no integration has
  occurred**. This is not evidence of health; it is evidence of missing
  work. After C1 + C3 are merged and before C2 + C4 are written, the
  expected test count is `921 + 17 = 938`. That's the floor number
  integration must show before the next coder cycle starts.

## 7. Design smells

1. **"Branch-as-placeholder" pattern.** Two of four coder branches ship zero
   code while claiming the name of a deliverable. This pattern let C2/C4 slip
   for a full cycle undetected. Recommend: the integration-notes template
   should require a "last-code-commit ≠ plan-doc" precondition before an
   integration window opens.
2. **Stub files referenced but never committed.** `INTEGRATION_NOTES.md`
   plans to "kill `_c1-stub.ts` after C2 merge" and "kill `_c3-stub.ts`
   after C4 merge" — but neither stub was ever committed to the integration
   branch. Either the stubs should be real (committed, typed, with `TODO:
   implement in C2/C4`) so merges have a seam to replace, or the plan
   should drop the stub-kill step.
3. **Privacy enforcement lives in modules that don't exist.** §7 is the
   strictest section of the spec and depends entirely on `screen-capture.ts`
   (allowlist, ring buffer, kill-switch) and `vision-brief.ts` (no-network
   in local-only, private-app LLM block). When those files are absent, §7
   is a promise without a guardian. A `tests/phase8-privacy.dod.test.ts`
   that fails loudly when these modules are missing — asserting the exports
   exist, asserting grep-cleanness, asserting the allowlist contains the
   required bundle IDs — would make the gap visible on every CI run.
4. **C1's Swift helper has no back-channel to the allowlist.** Even when
   `screen-capture.ts` lands, the Swift helper *already* wrote a PNG to
   disk before the TS layer can check the allowlist. A robust design
   passes the deny-list to the helper as `--deny-bundle-id ...` arguments
   and lets the helper short-circuit before `SCScreenshotManager.captureImage`.
   Today's design leaks one PNG per skipped capture to `$TMPDIR` between
   the Swift emit and the TS delete.
5. **Inconsistent storage location.** Swift emits to `NSTemporaryDirectory()`
   when `--out` is absent; the spec implies `~/.cortexos/screens/` as the
   canonical home. The TS layer in WIP uses the canonical path but the
   helper still falls back to tmp if called directly. Pick one and enforce.
6. **`NativeBridgeUnavailableError` is caught as `ENOENT` only.** If the
   binary exists but is not executable (chmod 644), `execFile` will fail
   with `EACCES` — which maps to `NativeBridgeError`, not
   `NativeBridgeUnavailableError`. Users installing on a shared disk where
   `cp` dropped exec bits will get a confusing error. Low priority.

## 8. Top 5 patches before merging `phase8-11/integration` → `main`

Ordered by blast radius × likelihood.

### P-1 — Ship `screen-capture.ts` with allowlist + ring-buffer + kill-switch

**Blocker. Cannot merge without.** New file at `src/perception/screen-capture.ts`
exporting `ScreenCapturer`, `DEFAULT_PRIVATE_APPS`, `PrivateAppSkippedError`,
and the `ScreenFrame` type. Required invariants:

- Constructor takes `{ intervalSec, ringBufferSize, storageDir, privateAppAllowlist, bridge, scheduler }` — all optional, all injectable for tests.
- `start()` / `stop()` idempotent; `captureNow()` works without `start()`.
- `DEFAULT_PRIVATE_APPS` frozen, includes minimum bundle IDs:
  `com.agilebits.onepassword7`, `com.1password.1password`,
  `com.apple.keychainaccess`, `com.bitwarden.desktop`, `com.apple.DiskUtility`,
  `com.apple.systempreferences`, plus a banking bundle-ID set (Chase, BoA, Wells, Citi).
- `isPrivateBundle()` checked *before* the PNG is accepted — evicted PNG must be `unlink`ed if the Swift helper already wrote it.
- `forceOff()` stops loop, purges memory + disk, latches the instance.
- `purge(olderThanSec?)` both for scheduled GC and session-end.
- Full test file `tests/screen-capture.test.ts` mirroring the 12-case shape observed in the orphaned leftover (start/stop idempotent, ring-buffer eviction unlinks PNGs, allowlist skips, kill-switch wipes disk, custom allowlist override, `purge(60)` honors age, `getRecent(n)` orders most-recent-first).

Target LOC: ~300 impl + ~350 tests. Reviewer: Tester 2.

### P-2 — Ship `vision-brief.ts` with network-free default + private-app LLM block

**Blocker.** New file at `src/perception/vision-brief.ts` exporting
`buildBrief(frame, deps?, opts?)`, `PRIVATE_APPS`, `isPrivateApp()`,
`classifySentimentHeuristic()`. Required invariants:

- `mode: "local-only"` **must not** call `fetch` — test with sentinel spy + CI grep.
- `mode: "llm"` uses `AbortController` with 8 s default timeout; failures map to a fixed label set (`timeout | rate-limited | server-error | client-error | parse-error | schema-mismatch | network | privacy-block | unknown`). Never leak raw error messages (rationale: don't log API keys / URLs to the returned summary).
- Private-app frames **short-circuit before the LLM call**, regardless of mode. Separate test asserts `fetchImpl` not called when `active_app` is in `PRIVATE_APPS`.
- `LlmBriefSchema` validated via zod before the response is trusted.
- Falls back to local-only brief on any LLM path failure — caller never sees a thrown error.

Target LOC: ~400 impl + ~300 tests.

### P-3 — Ship `yabai-bridge.ts` + AppleScript fallback + `driver-factory.ts`

**Blocker for Phase 11.** Three new files:

- `src/window-manager/yabai-bridge.ts` — `createYabaiDriver(exec?)` returning `WMDriver`. All `execFile("yabai", args, { shell: false, timeout: 5000, maxBuffer: 1 * 1024 * 1024 })`. Never template a shell string.
- `src/window-manager/applescript-bridge.ts` — fallback driver when `yabai` unavailable. Must use `execFile("osascript", ["-e", template])` with a parameterized template or with the same `escapeAppleScript()` helper as `src/social/drivers/imessage-driver.ts`.
- `src/window-manager/driver-factory.ts` — `createWMDriver(): Promise<WMDriver>` that probes yabai first (via `isAvailable()`) and falls back to AppleScript. Must throw `WMUnavailableError` (not silently return a no-op) when both paths fail.

Target LOC: ~250 + ~200 + ~80 + tests.

### P-4 — Wire audit log + kill-switch hotkey

**Blocker for §7.** Three small changes:

- `src/perception/screen-capture.ts` and `src/perception/vision-brief.ts` accept an optional `auditLog?: AuditLog` dep; every `capture()`, `ocr()`, and `buildBrief({ mode: "llm" })` invocation appends: `{ kind, ts, bundle_id, active_app, bytes?, duration_ms, success }`. No PNG bytes, no OCR text, no LLM output.
- `src/controller/cortex.ts` wires the existing `AuditLog` instance into the capturer + brief builder at boot.
- `src/ui/hotkey.ts` registers `cmd+shift+escape` → `capturer.forceOff()`. Persist the latched state to `~/.cortexos/session.json` so the kill-switch survives process restarts.

Target LOC: ~80 deltas across three files + tests.

### P-5 — Register `nchinda_see` + `wm_*` MCP tools + integration DoD test

**Blocker for §4.1.5 + §4.2.5.**

- Extend `src/mcp/tool-schema.ts` with `nchinda_see`, `wm_move_window`, `wm_tile`, `wm_focus`, `wm_space_switch` — zod-validated inputs matching the existing `nchinda_*` / `social_*` tool patterns.
- Extend `src/mcp/nchinda-tools.ts` (or new `src/mcp/perception-tools.ts`) with the handler that calls `capturer.captureNow()` → `buildBrief()` → returns.
- Extend `src/mcp/wm-tools.ts` (new) with handlers that call the `WMDriver`.
- Register both in `scripts/mcp/serve-nchinda.mjs`.
- Add `tests/phase8-11-dod.test.ts` with the DoD bullets from VISION §4:
  - allowlist bundle IDs set non-empty
  - local-only brief has no network egress (fetch spy)
  - capturer.forceOff() purges storage dir
  - yabai driver `isAvailable()` handles missing binary
  - computeLayout matches driver-reported frames within ±1 px
  - `nchinda_see()` + `wm_tile({layout:"grid-2x2"})` survive round-trip

Target LOC: ~200 + ~300 tests.

## 9. Follow-ups for later phases

1. **Phase 8.5 (UI) — Waveform eye/camera indicators (§7.6)** — when screen-watching active, the waveform dot pulses; when webcam capturing, a red camera dot overlays. Scope: `src/ui/*`. Non-blocking for Phase 8 DoD but required for §7.6 sign-off.
2. **Phase 8.6 — Property-based tests for `computeLayout`** — replace the 17 example tests with `fast-check` properties (viewport coverage, no overlap, slot count == n). Non-blocking.
3. **Phase 8.7 — Helper path hardening** — `native-bridge.ts` should reject `imagePath` / `outPath` containing `..` or not under `$HOME` / `$TMPDIR`. Low-exploit-probability risk but trivial to close.
4. **Phase 9 dependency** — before Phase 9 (camera) starts, Phase 8's §7 allowlist + audit log + kill-switch MUST be green, because Phase 9 extends the same primitives to the webcam (higher-stakes capture surface).
5. **Phase 10 computer-use dependency** — the `AuditLog.append("perception.actuator.*")` kind must be reserved now so Phase 10's actuator events can share the same log without a migration.
6. **Documentation** — `CLAUDE.md` "privacy rules" section should enumerate the §7 invariants as hard gates; today's file documents file-location rules but not privacy posture.
7. **Orphaned test leftover cleanup** — either commit `tests/screen-capture.test.ts` and `tests/yabai-bridge.test.ts` alongside their implementations (as part of P-1 / P-3) or delete them; do not leave untracked.
8. **Integration-branch hygiene** — `phase8-11/integration` currently holds only `INTEGRATION_NOTES.md`. After P-1…P-5 land, the first real merge must re-run `npm test` and record the pass count (expected: `921 + 17 (C3) + ~30 (C1 P-1) + ~30 (C2 P-2) + ~40 (C3 P-3) + ~20 (P-4 + P-5) ≈ 1060` tests) in `INTEGRATION_NOTES.md`.

---

## 10. Addendum — State update at commit `ea9674c`

Between commits #2 (verdict BLOCK) and #5, coders landed substantial new work on
`phase8-11/integration`. Re-scanning at HEAD = `ea9674c`:

**Now landed:**
- `src/perception/screen-capture.ts` (292 LOC) — `ScreenCapturer` with ring
  buffer, `DEFAULT_PRIVATE_APPS` (1Password, Safari-bank, Keychain, etc.),
  `forceOff()` kill-switch, `purge(olderThanSec?)`, idempotent start/stop.
- `src/perception/ocr.ts` (131 LOC) — TS `ocrImage()` wrapper over the Swift helper.
- `src/perception/vision-brief.ts` (438 LOC) — `buildBrief()` with local-only
  default + Haiku llm mode, `PRIVATE_APPS` deny-list enforcement, redacted
  error labels via `SAFE_REASON_PATTERNS`, `AbortController` timeout, zod
  schema validation on llm response.
- `src/window-manager/yabai-bridge.ts` (360 LOC) — full yabai CLI driver with
  `execFile(..., { shell: false })`, 5 s timeout, 1 MB maxBuffer, typed
  `YabaiCommandError` + `WMUnavailableError`.
- `src/window-manager/applescript-fallback.ts` (330 LOC) — AppleScript driver.
- `src/window-manager/pane-ornaments.ts` (330 LOC) — JankyBorders wrapper.
- `src/mcp/wm-tools.ts` (222 LOC) — `wm_move_window`, `wm_tile`, `wm_focus`, `wm_space_switch`.
- Test files: `screen-capture.test.ts`, `vision-brief.test.ts`,
  `yabai-bridge.test.ts`, `applescript-fallback.test.ts`,
  `pane-ornaments.test.ts`, `wm-tools.test.ts`.

**Objective signals:**
- `npm test` (on integration): **1053/1053 pass** (up from 921/921 on main; delta = 132 new tests).
- `tsc --noEmit`: clean.
- Grep `": any\b\|as any"` across `src/perception src/window-manager src/mcp`: **0 matches**.
- Grep `"fetch(\|https://"` across `src/perception`: **1 hit** —
  `vision-brief.ts:71` `const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"`.
  Correct — that's the single sanctioned LLM egress point, only reached when
  `mode === "llm"` AND `!isPrivateApp(frame.active_app)` AND `apiKey` is set.

**Still missing from §4 / §7 (hard gates for main merge):**
1. **Audit log wiring.** `src/perception/` contains zero references to
   `AuditLog.append()`. Captures, OCR calls, and Haiku vision calls all
   happen silently — §7.5 unsatisfied.
2. **`screen_context` sensor.** No new file in `src/sensors/`. `sensor-manager.ts`
   does not register a screen-context source. §4.1 item 4 unsatisfied.
3. **`nchinda_see()` MCP tool.** Only referenced in a comment in
   `screen-capture.ts:150`. Not in `src/mcp/tool-schema.ts`, not in
   `src/mcp/nchinda-tools.ts`, not in `scripts/mcp/serve-nchinda.mjs`. §4.1
   item 5 unsatisfied.
4. **⌘⇧Esc hotkey.** `forceOff()` exists but is not wired to a global
   hotkey. `src/ui/hotkey.ts` has no binding. §7.4 half-satisfied (the
   API exists; the trigger does not).
5. **Banking bundle IDs in allowlist.** `DEFAULT_PRIVATE_APPS` in
   `screen-capture.ts:68` covers password managers + Safari-bank but no
   concrete banking bundle IDs (Chase, BoA, Wells, Citi) or general
   banking-URL regex. §7.7 partial.
6. **`buildBrief` URL is unconfigurable.** `ANTHROPIC_URL` is a module
   constant. Makes it impossible to point at a local stub server in a dev
   env and hard to enforce "no-egress" via network firewalls per-env. Minor.
7. **WorktreeManager seam.** Phase 11 item 4 (agent → window slot mapping)
   — pane-ornaments exists, but the orchestrator doesn't consume it. §4.2
   item 4 unsatisfied; the "cyan researcher, blue coder" binding has no
   caller.

**Revised verdict: SHIP-WITH-FIXES.**

The primitives are now in place and well-built. `screen-capture.ts` answers
all four C1 targeted questions correctly (Swift gate clean, allowlist
enforced BEFORE frame accepted + evicted-PNG unlinked, ring-buffer GC
calls `tryUnlink`, permission-denied surfaces cleanly). `vision-brief.ts`
answers all three C2 questions (local-only mode has zero fetch when
private-app guarded, Haiku path has `AbortController` timeout + redacted
`SAFE_REASON_PATTERNS`, private-app frames short-circuit before the LLM
call). `yabai-bridge.ts` answers all three C3 questions (`execFile` with
arg-array only, typed `WMUnavailableError` on probe failure, pure
`computeLayout` untouched).

But §7.4 (kill-switch wired to hotkey), §7.5 (audit log), §4.1.4
(sensor), §4.1.5 (`nchinda_see`), and §4.2.4 (orchestrator seam) remain
**must-fix before main**. Top-5 §8 list is revised accordingly:

- **P-1** ~~Ship `screen-capture.ts`~~ ✅ **DONE** (`71382f0`).
- **P-2** ~~Ship `vision-brief.ts`~~ ✅ **DONE** (`d4e55cd`).
- **P-3** ~~Ship yabai + AppleScript + driver-factory~~ ✅ **PARTIAL** — both drivers shipped but no `driver-factory.ts`; callers must pick manually.
- **P-4 (still open)** Wire `AuditLog` into `screen-capture.ts` (`capture.success|skip|error`) + `vision-brief.ts` (`llm.call|fallback`) + bind `⌘⇧Esc` in `src/ui/hotkey.ts` to `capturer.forceOff()`.
- **P-5 (still open)** Register `nchinda_see` in `src/mcp/tool-schema.ts` +
  handler in `nchinda-tools.ts` + scripts/mcp/serve-nchinda.mjs. Add
  `src/sensors/screen-context.ts` that wraps `ScreenCapturer` as a
  `Sensor` (debounce on active-app change, idle > 5 min, draft > 5 min).
  Add `tests/phase8-11-dod.test.ts` gating the §4 bullets.

**Main-merge blocked?** Yes, until P-4 + P-5 land. The §7 privacy
guarantees depend on sensor+audit+hotkey wiring that is not yet done.

---

_Author: Tester 2 (independent reviewer, read-only). Initial verdict at
`0d7582c` was BLOCK (only C1 + C3 primitives landed). Revised at
`ea9674c` to SHIP-WITH-FIXES after ScreenCapturer, vision-brief,
yabai-bridge, applescript-fallback, pane-ornaments, and wm-tools
landed in parallel with the review — 1053/1053 tests now green, but
audit log / hotkey / sensor / `nchinda_see` MCP wiring still open._
