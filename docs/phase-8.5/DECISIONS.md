# Phase 8.5 — Encode / Hash / Adaptive-capture: non-obvious decisions (Coder 2)

Scope: `src/perception/phash.ts`, `src/perception/webp-encoder.ts`, rate-
control + daily-budget edits in `src/perception/screen-capture.ts`.

## 1. WebP encode has a pluggable bridge + `sharp` fallback

The spec requires shelling to the Swift helper
(`cortexos-vision encode-webp --in <png> --out <webp> --quality <N>
 --max-width <px>`) but acknowledges the helper may not have landed on
all branches at the moment Phase 8.5 runs.

**Primary path** — `cortexos-vision` Swift helper. Cheapest, uses Apple's
native libwebp bindings, no JS memory pressure.

**Fallback** — dynamic `import("sharp")`. Sharp is already a transitive
dep via `@huggingface/transformers` (0.34.5, verified in `node_modules`).
Because it is transitive we do not add it to `package.json`; if sharp ever
drops out of the tree, `encodeWebP` throws `WebPEncodeError` with a clear
"install sharp or build cortexos-vision" message instead of silently
corrupting frames.

**Tests never exercise either path.** All tests inject a `WebPEncoderBridge`
stub. This keeps CI deterministic on Linux runners that have neither
Swift nor a native webp encoder.

## 2. pHash algorithm is aHash (8×8 mean split), not pHash-DCT

The classic pHash uses a 32×32 DCT and keeps the top-left 8×8 coefficients.
That pushes us into a 1024-sample FFT per frame on the capture hot path.

aHash:
  1. Resize to 8×8 grayscale (one `sharp.resize` call or one Swift helper
     shot).
  2. Compute the mean pixel value.
  3. Bit i = 1 if pixel_i > mean else 0 → 64-bit unsigned integer.

aHash is enough for "same window, same frame, clock-tick difference" —
which is all we need for dedup at 1–2 fps. Moving to pHash-DCT later is a
drop-in (same 64-bit output shape, Hamming distance stays the semantic).

**Threshold**: `maxHamming=4` by default. Empirically a blinking cursor or
a one-second clock tick produces 1–2 bit differences; a scroll or app
switch is 20–60.

## 3. Bit ordering: MSB-first (pixel[0] is bit 63)

Either choice works, but we lock MSB-first so that cross-process comparisons
(e.g. A1's SQLite `phash` column, which stores a signed int64) are byte-
identical regardless of encoder. The unit test `"bit ordering: MSB is
pixel[0], LSB is pixel[63]"` pins this.

## 4. Adaptive rate + daily budget live in `screen-capture.ts`, not a wrapper

We considered wrapping `ScreenCapturer` in a new `AdaptiveScreenCapturer`
class. Rejected because:

- The ring-buffer eviction + private-app allowlist already live in
  `ScreenCapturer`; a wrapper would have to re-implement them or expose
  internals.
- A new type means two public APIs to keep in sync; callers would have to
  pick. One class, one contract.
- All new numeric defaults are gathered in a `CAPTURE_DEFAULTS` object at
  the top of the file so policy tuning stays in one place (plan §7.0 "not
  hardcoded").

## 5. Budget violations always surface

When a frame would push `bytesInWindow(last 24h)` over the daily budget we:

1. Emit `{kind: 'error', payload: {where: 'capture.budget', bytes_in_window,
   budget}}` on the EventBus.
2. Push a Pending Surface observation ("Nchinda hit its screen-capture
   budget for today. Raise the limit or clear old frames?").
3. Return `{ok: false, reason: 'budget-exceeded'}` from the capture path.

We deliberately do NOT silently drop frames — the whole point of a 400 MB
default budget is that the user finds out when they blow past it.

## 6. `ScreenMemoriesDB` seam — small interface, integration-time swap

A1 owns `src/perception/screen-memories-db.ts`. We accept any object that
satisfies `{ insert(row), bytesInWindow(since) }`. If A1 lands after us,
wiring swaps in a single `new ScreenMemoriesDB()` at the integration point.
No changes needed inside `ScreenCapturer`.
