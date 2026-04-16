/**
 * Preset grid math for Phase 11 window management.
 *
 * Pure functions only — given a viewport rectangle, a `Layout` name, and a
 * window count `n`, `computeLayout` returns `n` target frames that tile the
 * viewport according to the preset.
 *
 * Over-capacity behaviour: if `n` exceeds what the preset can tile without
 * overlap (e.g. `grid-2x2` with 6 windows), we clamp to the preset's
 * capacity and reuse slots cyclically so every input window still gets a
 * frame. This matches the DoD (`over-capacity fallback: clamp to capacity
 * and return N`).
 *
 * No side effects, no I/O — this file is safe to import from anywhere.
 */

// --------------------------- Public types --------------------------------

/**
 * A named layout preset. Anything else should be a type error at compile
 * time — drivers must switch exhaustively on this union.
 */
export type Layout =
  | "full"
  | "vsplit"
  | "hsplit"
  | "columns-3"
  | "columns-4"
  | "grid-2x2"
  | "grid-3x2";

/** Screen-space rectangle, pixel coords. Top-left origin. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A single tile produced by {@link computeLayout}. */
export interface LayoutSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --------------------------- Capacity table ------------------------------

/**
 * Maximum number of non-overlapping tiles the preset is designed to show.
 * Anything above this is clamped and slots are reused cyclically.
 */
const LAYOUT_CAPACITY: Record<Layout, number> = {
  full: 1,
  vsplit: 2,
  hsplit: 2,
  "columns-3": 3,
  "columns-4": 4,
  "grid-2x2": 4,
  "grid-3x2": 6,
};

/** Publicly readable snapshot of the capacity table for callers that need it. */
export function layoutCapacity(layout: Layout): number {
  return LAYOUT_CAPACITY[layout];
}

// --------------------------- Public API ----------------------------------

/**
 * Compute N frames for `n` windows under `layout` inside `viewport`.
 *
 * Guarantees:
 *   - Returns exactly `n` entries (never more, never fewer).
 *   - Every returned frame has `w > 0 && h > 0` when `viewport` is positive.
 *   - Pure: same inputs always produce the same outputs.
 *
 * Edge cases:
 *   - `n === 0` returns `[]`.
 *   - `n > capacity(layout)` clamps — slot `i` is `slots[i % capacity]`.
 *   - A zero-size viewport yields zero-size slots but still returns `n`
 *     entries (useful for tests and headless coordination).
 */
export function computeLayout(
  layout: Layout,
  viewport: Viewport,
  n: number,
): LayoutSlot[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`computeLayout: n must be a non-negative integer, got ${n}`);
  }
  if (n === 0) return [];

  const slots = buildSlots(layout, viewport);
  const out: LayoutSlot[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Clone per-index so callers may mutate safely.
    const src = slots[i % slots.length];
    out[i] = { x: src.x, y: src.y, w: src.w, h: src.h };
  }
  return out;
}

// --------------------------- Preset builders -----------------------------

/**
 * Build the canonical slot list for `layout` at the preset's full capacity.
 * The list has length `LAYOUT_CAPACITY[layout]`.
 */
function buildSlots(layout: Layout, v: Viewport): LayoutSlot[] {
  switch (layout) {
    case "full":
      return [{ x: v.x, y: v.y, w: v.w, h: v.h }];

    case "vsplit":
      // Left | Right
      return splitAxis(v, 2, "horizontal");

    case "hsplit":
      // Top / Bottom
      return splitAxis(v, 2, "vertical");

    case "columns-3":
      return splitAxis(v, 3, "horizontal");

    case "columns-4":
      return splitAxis(v, 4, "horizontal");

    case "grid-2x2":
      return buildGrid(v, 2, 2);

    case "grid-3x2":
      return buildGrid(v, 3, 2);
  }
}

/**
 * Split `v` into `count` equal slices along the given axis.
 * Last slice absorbs the integer-division remainder so the sum of widths
 * equals `v.w` exactly (no one-pixel gaps).
 */
function splitAxis(
  v: Viewport,
  count: number,
  axis: "horizontal" | "vertical",
): LayoutSlot[] {
  const slots: LayoutSlot[] = [];
  if (axis === "horizontal") {
    const base = Math.floor(v.w / count);
    let used = 0;
    for (let i = 0; i < count; i++) {
      const width = i === count - 1 ? v.w - used : base;
      slots.push({ x: v.x + used, y: v.y, w: width, h: v.h });
      used += width;
    }
  } else {
    const base = Math.floor(v.h / count);
    let used = 0;
    for (let i = 0; i < count; i++) {
      const height = i === count - 1 ? v.h - used : base;
      slots.push({ x: v.x, y: v.y + used, w: v.w, h: height });
      used += height;
    }
  }
  return slots;
}

/**
 * Build a `cols x rows` grid. Reading order is row-major left-to-right,
 * top-to-bottom — so `grid-2x2` with 4 agents is [TL, TR, BL, BR].
 */
function buildGrid(v: Viewport, cols: number, rows: number): LayoutSlot[] {
  const colBase = Math.floor(v.w / cols);
  const rowBase = Math.floor(v.h / rows);
  const slots: LayoutSlot[] = [];

  let yUsed = 0;
  for (let r = 0; r < rows; r++) {
    const height = r === rows - 1 ? v.h - yUsed : rowBase;
    let xUsed = 0;
    for (let c = 0; c < cols; c++) {
      const width = c === cols - 1 ? v.w - xUsed : colBase;
      slots.push({ x: v.x + xUsed, y: v.y + yUsed, w: width, h: height });
      xUsed += width;
    }
    yUsed += height;
  }
  return slots;
}
