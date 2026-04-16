# Phase 8 — Screen Perception: non-obvious decisions (Coder 1)

Scope: `scripts/native/cortexos-vision/**`, `src/perception/native-bridge.ts`,
`src/perception/screen-capture.ts`, `src/perception/ocr.ts`.

## 1. Swift helper is a separate binary, not a Node native addon

Option A — Apple Vision via a native addon (NAPI / node-gyp).
Option B — A small Swift CLI invoked with `execFile`.

**Chose B.** Reasons:

- ScreenCaptureKit + Vision require a recent SDK and target macOS 13+; a node
  addon would drag Xcode/node-gyp into the hot path for every cortexOS user,
  including non-macOS users who never touch perception.
- A separate binary degrades cleanly: if Swift isn't installed, the helper
  simply isn't there, and the TypeScript bridge raises
  `NativeBridgeUnavailableError`. The rest of cortexOS keeps running.
- `execFile` with an argument array is already the project's convention for
  native shell-outs (`system-health`, `unfinished-work`, `stt`, etc.). No new
  pattern to teach.

Trade-off: one fork+exec per capture (~5–10 ms overhead). At 0.1 Hz default
sampling this is immaterial.

## 2. Binary lives at `~/.cortexos/bin/cortexos-vision`, not in `$PATH`

Reasons:

- User home keeps the install self-contained — `rm -rf ~/.cortexos` cleans it
  all, matching the existing audit-log / screens-dir layout.
- Avoids polluting `/usr/local/bin` which requires sudo.
- The bridge exports `defaultBinaryPath()` so it's one override point for
  tests and packaging.

## 3. CaptureScheduler is an injected interface

Tests need deterministic ticks without real timers. A tiny
`{ start(ms, cb), stop() }` contract lets tests drive the loop synchronously
(`manualScheduler` in `tests/screen-capture.test.ts`). Production uses
`setInterval` with `.unref()` so a forgotten `start()` doesn't keep Node
alive.

## 4. Private-app skip raises `PrivateAppSkippedError` instead of returning `null`

Callers of `captureNow()` need to distinguish "nothing interesting right
now" from "you aren't allowed to see what's on the screen right now." The
tick handler catches the error silently (no log spam); external callers see
the typed error and can decide whether to prompt the user or just drop the
request.

## 5. Ring buffer eviction unlinks PNGs synchronously per tick

Simpler than a background sweep. The buffer size is small (default 60),
eviction is bounded by the arrival rate (0.1 Hz), and `unlink` is cheap
(~<1 ms). Tests assert the disk matches the in-memory state after each tick.

## 6. `ocrImage` is a pure function, not a class

OCR has no persistent state. A function is cheaper to call from the brief
pipeline, the MCP tool, and the proactivity sensor. Caching / batching
should layer on top if needed — premature to bake it in.

## 7. `OCRUnavailableError` covers both "missing binary" and "permission
denied"

The MCP tool only cares "can I OCR this or do I need a remote fallback?"
Splitting the error surface forced every caller to handle two branches with
identical downstream behavior. The original error is preserved via `cause`
for logs.

## 8. Swift OCR bbox converted to top-left origin in pixels

Apple Vision returns normalized bottom-left coordinates. The brief pipeline,
the UI overlay, and anything that eventually wants to highlight a region on
the PNG all expect top-left pixel coordinates that match the PNG directly.
Converting once inside the helper keeps every TypeScript consumer from
having to remember the math.

## 9. Fork+exec per tick, not a long-lived Swift daemon

Simpler. No IPC protocol to design, no restart-on-crash logic. Apple Vision
loads its models in ~100 ms on first call; repeated launches pay that cost,
but at 0.1 Hz with a 15 s execFile timeout we still have 14 s+ of headroom.
If profiling shows this is the bottleneck we can add a persistent mode
later without changing the TS surface.

## 10. No network anywhere in Coder 1's lane

Grep for `fetch(`, `https://`, `URLSession`, `URLRequest` in
`src/perception/{native-bridge,screen-capture,ocr}.ts` and
`scripts/native/cortexos-vision/**` returns zero hits. All perception stays
on-device. The brief pipeline (Coder 2) is the only layer that may contact
an LLM, and only on explicit user action per plan §7.
