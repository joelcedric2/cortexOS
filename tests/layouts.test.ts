import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeLayout,
  layoutCapacity,
  type Layout,
  type Viewport,
} from "../src/window-manager/layouts.js";

// A convenient reference viewport — 1600x1000 at origin. Avoid 1920x1080
// because integer division by 3/4 leaves dust; 1600 and 1000 are cleanly
// divisible by 2/4/5 which makes the assertions easier to read.
const V: Viewport = { x: 0, y: 0, w: 1600, h: 1000 };

function assertCoversViewport(slots: { x: number; y: number; w: number; h: number }[], v: Viewport) {
  // The union of slots should exactly cover the viewport. Easiest cheap
  // check: sum of areas equals viewport area AND every slot is inside v.
  const vArea = v.w * v.h;
  let sum = 0;
  for (const s of slots) {
    assert.ok(s.x >= v.x && s.y >= v.y, `slot inside viewport origin: ${JSON.stringify(s)}`);
    assert.ok(s.x + s.w <= v.x + v.w, `slot within right edge: ${JSON.stringify(s)}`);
    assert.ok(s.y + s.h <= v.y + v.h, `slot within bottom edge: ${JSON.stringify(s)}`);
    sum += s.w * s.h;
  }
  assert.equal(sum, vArea, `slots should cover viewport area exactly (sum=${sum}, vArea=${vArea})`);
}

describe("computeLayout — edge cases", () => {
  test("n=0 returns empty array for every layout", () => {
    const layouts: Layout[] = [
      "full",
      "vsplit",
      "hsplit",
      "columns-3",
      "columns-4",
      "grid-2x2",
      "grid-3x2",
    ];
    for (const l of layouts) {
      assert.deepEqual(computeLayout(l, V, 0), []);
    }
  });

  test("n=negative throws RangeError", () => {
    assert.throws(() => computeLayout("full", V, -1), RangeError);
  });

  test("n=non-integer throws RangeError", () => {
    assert.throws(() => computeLayout("full", V, 1.5), RangeError);
  });

  test("zero-size viewport still returns n entries", () => {
    const zero: Viewport = { x: 100, y: 100, w: 0, h: 0 };
    const slots = computeLayout("grid-2x2", zero, 4);
    assert.equal(slots.length, 4);
    for (const s of slots) {
      assert.equal(s.w, 0);
      assert.equal(s.h, 0);
    }
  });
});

describe("computeLayout — full", () => {
  test("full + 1 = single viewport-sized slot", () => {
    const slots = computeLayout("full", V, 1);
    assert.deepEqual(slots, [{ x: 0, y: 0, w: 1600, h: 1000 }]);
  });

  test("full is clamped at capacity 1 — extra windows stack on top", () => {
    assert.equal(layoutCapacity("full"), 1);
    const slots = computeLayout("full", V, 3);
    assert.equal(slots.length, 3);
    for (const s of slots) {
      assert.deepEqual(s, { x: 0, y: 0, w: 1600, h: 1000 });
    }
  });
});

describe("computeLayout — vsplit / hsplit", () => {
  test("vsplit + 2 = [left, right] equal halves", () => {
    const slots = computeLayout("vsplit", V, 2);
    assert.deepEqual(slots, [
      { x: 0, y: 0, w: 800, h: 1000 },
      { x: 800, y: 0, w: 800, h: 1000 },
    ]);
    assertCoversViewport(slots, V);
  });

  test("hsplit + 2 = [top, bottom] equal halves", () => {
    const slots = computeLayout("hsplit", V, 2);
    assert.deepEqual(slots, [
      { x: 0, y: 0, w: 1600, h: 500 },
      { x: 0, y: 500, w: 1600, h: 500 },
    ]);
    assertCoversViewport(slots, V);
  });
});

describe("computeLayout — column presets", () => {
  test("columns-3 + 3 = three equal columns covering viewport", () => {
    const slots = computeLayout("columns-3", V, 3);
    assert.equal(slots.length, 3);
    // With w=1600 and floor(1600/3)=533, last column absorbs the remainder.
    assert.deepEqual(slots[0], { x: 0, y: 0, w: 533, h: 1000 });
    assert.deepEqual(slots[1], { x: 533, y: 0, w: 533, h: 1000 });
    assert.deepEqual(slots[2], { x: 1066, y: 0, w: 534, h: 1000 });
    assertCoversViewport(slots, V);
  });

  test("columns-4 + 4 = four columns of 400", () => {
    const slots = computeLayout("columns-4", V, 4);
    assert.equal(slots.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(slots[i], { x: i * 400, y: 0, w: 400, h: 1000 });
    }
    assertCoversViewport(slots, V);
  });
});

describe("computeLayout — grid presets", () => {
  test("grid-2x2 + 4 = four equal quadrants [TL, TR, BL, BR]", () => {
    const slots = computeLayout("grid-2x2", V, 4);
    assert.deepEqual(slots, [
      { x: 0, y: 0, w: 800, h: 500 }, // top-left
      { x: 800, y: 0, w: 800, h: 500 }, // top-right
      { x: 0, y: 500, w: 800, h: 500 }, // bottom-left
      { x: 800, y: 500, w: 800, h: 500 }, // bottom-right
    ]);
    assertCoversViewport(slots, V);
  });

  test("grid-3x2 + 6 = 3 columns x 2 rows covering viewport", () => {
    const slots = computeLayout("grid-3x2", V, 6);
    assert.equal(slots.length, 6);
    assertCoversViewport(slots, V);
    // Row-major reading order: top-left is slot[0], top-right is slot[2].
    assert.equal(slots[0].y, 0);
    assert.equal(slots[0].x, 0);
    assert.equal(slots[2].y, 0);
    // Bottom row starts at y=500.
    assert.equal(slots[3].y, 500);
    assert.equal(slots[3].x, 0);
  });

  test("viewport offset is honoured", () => {
    const offset: Viewport = { x: 100, y: 50, w: 800, h: 600 };
    const slots = computeLayout("grid-2x2", offset, 4);
    // Top-left slot must start at the viewport origin, not at (0,0).
    assert.equal(slots[0].x, 100);
    assert.equal(slots[0].y, 50);
    assertCoversViewport(slots, offset);
  });
});

describe("computeLayout — over-capacity clamp", () => {
  test("grid-2x2 + 6 returns 6 slots cycling through 4 quadrants", () => {
    const slots = computeLayout("grid-2x2", V, 6);
    assert.equal(slots.length, 6);
    // slots[4] must equal slots[0] (TL), slots[5] must equal slots[1] (TR).
    assert.deepEqual(slots[4], slots[0]);
    assert.deepEqual(slots[5], slots[1]);
  });

  test("vsplit + 5 returns 5 slots cycling through 2 halves", () => {
    const slots = computeLayout("vsplit", V, 5);
    assert.equal(slots.length, 5);
    assert.deepEqual(slots[2], slots[0]);
    assert.deepEqual(slots[3], slots[1]);
    assert.deepEqual(slots[4], slots[0]);
  });

  test("returned slots are independent clones (mutating one does not affect another)", () => {
    const slots = computeLayout("grid-2x2", V, 6);
    slots[0].x = 9999;
    assert.notEqual(slots[4].x, 9999, "slots[4] should be a clone of slots[0]");
  });
});

describe("layoutCapacity", () => {
  test("reports the expected capacities", () => {
    assert.equal(layoutCapacity("full"), 1);
    assert.equal(layoutCapacity("vsplit"), 2);
    assert.equal(layoutCapacity("hsplit"), 2);
    assert.equal(layoutCapacity("columns-3"), 3);
    assert.equal(layoutCapacity("columns-4"), 4);
    assert.equal(layoutCapacity("grid-2x2"), 4);
    assert.equal(layoutCapacity("grid-3x2"), 6);
  });
});
