/**
 * Phase 15 — time-parse tests.
 *
 * `now` is pinned to a Wednesday afternoon (2026-04-15T14:30:00Z) so
 * relative phrasings are reproducible across runs. We assert on the
 * resulting `{from, to}` pair — not precise millisecond math — because the
 * production parser applies 10% tolerance padding for point-in-time
 * phrases like "40 minutes ago".
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseTimePhrase, type TimeRange } from "../src/rewind/time-parse.js";

// 2026-04-15 is a Wednesday.
const NOW = new Date("2026-04-15T14:30:00.000Z");

function expectRange(r: TimeRange | null): TimeRange {
  assert.ok(r, "expected a TimeRange, got null");
  assert.ok(r!.from instanceof Date);
  assert.ok(r!.to instanceof Date);
  assert.ok(r!.from.getTime() <= r!.to.getTime(), "from must be <= to");
  return r!;
}

describe("parseTimePhrase — relative-past phrases", () => {
  test("40 minutes ago", () => {
    const r = expectRange(parseTimePhrase("40 minutes ago", NOW));
    // Center ≈ 40 minutes back; padded ±4 minutes (10% of 40 min, min 1 min).
    const center = NOW.getTime() - 40 * 60_000;
    assert.ok(Math.abs(r.from.getTime() - (center - 4 * 60_000)) < 1_000);
    assert.ok(Math.abs(r.to.getTime() - (center + 4 * 60_000)) < 1_000);
  });

  test("5 minutes ago", () => {
    const r = expectRange(parseTimePhrase("5 minutes ago", NOW));
    // Padded by minimum 60s floor.
    assert.ok(r.from.getTime() < NOW.getTime());
    assert.ok(r.to.getTime() <= NOW.getTime());
  });

  test("2 hours ago", () => {
    const r = expectRange(parseTimePhrase("2 hours ago", NOW));
    const center = NOW.getTime() - 2 * 3_600_000;
    const pad = Math.floor(2 * 3_600_000 * 0.1);
    assert.equal(r.from.getTime(), center - pad);
    assert.equal(r.to.getTime(), center + pad);
  });

  test("3 days ago", () => {
    const r = expectRange(parseTimePhrase("3 days ago", NOW));
    const center = NOW.getTime() - 3 * 86_400_000;
    assert.ok(Math.abs(r.from.getTime() - r.to.getTime()) > 0);
    assert.ok(r.from.getTime() < center);
    assert.ok(r.to.getTime() > center);
  });

  test("10 seconds ago", () => {
    const r = expectRange(parseTimePhrase("10 seconds ago", NOW));
    // Padded by min 60s floor — center at ~10s back.
    assert.ok(r.to.getTime() - r.from.getTime() >= 120_000);
  });

  test("an hour ago", () => {
    const r = expectRange(parseTimePhrase("an hour ago", NOW));
    const center = NOW.getTime() - 3_600_000;
    assert.ok(r.from.getTime() < center);
    assert.ok(r.to.getTime() > center);
  });

  test("a day ago", () => {
    const r = expectRange(parseTimePhrase("a day ago", NOW));
    const center = NOW.getTime() - 86_400_000;
    assert.ok(r.from.getTime() < center);
    assert.ok(r.to.getTime() > center);
  });
});

describe("parseTimePhrase — last-<period>", () => {
  test("last hour", () => {
    const r = expectRange(parseTimePhrase("last hour", NOW));
    assert.equal(r.to.getTime(), NOW.getTime());
    assert.equal(r.from.getTime(), NOW.getTime() - 3_600_000);
  });

  test("last day", () => {
    const r = expectRange(parseTimePhrase("last day", NOW));
    assert.equal(r.to.getTime(), NOW.getTime());
    assert.equal(r.from.getTime(), NOW.getTime() - 86_400_000);
  });

  test("last week", () => {
    const r = expectRange(parseTimePhrase("last week", NOW));
    assert.equal(r.to.getTime(), NOW.getTime());
    assert.equal(r.from.getTime(), NOW.getTime() - 7 * 86_400_000);
  });

  test("last month", () => {
    const r = expectRange(parseTimePhrase("last month", NOW));
    // One calendar month back — not exactly 30 days.
    assert.equal(r.to.getTime(), NOW.getTime());
    assert.equal(r.from.getUTCMonth(), 2); // March (0-indexed)
  });
});

describe("parseTimePhrase — last <weekday>", () => {
  test("last tuesday (from a wednesday)", () => {
    const r = expectRange(parseTimePhrase("last tuesday", NOW));
    // Wed - 1 day = Tuesday (but "last" means previous week) -> 8 days back.
    // We enforce 'prior week' on same-day match; Wed -> Tue is 1 day back.
    const days = Math.round((NOW.getTime() - r.from.getTime()) / 86_400_000);
    assert.equal(days, 1, "Tue came 1 day before the reference Wed");
    // from/to span exactly one day.
    assert.equal(r.to.getTime() - r.from.getTime(), 86_400_000);
  });

  test("last wednesday (from a wednesday → prior week)", () => {
    const r = expectRange(parseTimePhrase("last wednesday", NOW));
    const days = Math.round(
      (localMidnight(NOW).getTime() - r.from.getTime()) / 86_400_000,
    );
    assert.equal(days, 7, "same-day 'last' means the prior week");
  });

  test("last fri / last friday both resolve", () => {
    const a = expectRange(parseTimePhrase("last friday", NOW));
    const b = expectRange(parseTimePhrase("last fri", NOW));
    assert.equal(a.from.getTime(), b.from.getTime());
  });
});

describe("parseTimePhrase — day parts", () => {
  test("today", () => {
    const r = expectRange(parseTimePhrase("today", NOW));
    const midnight = localMidnight(NOW);
    assert.equal(r.from.getTime(), midnight.getTime());
    assert.equal(r.to.getTime(), midnight.getTime() + 86_400_000);
  });

  test("yesterday", () => {
    const r = expectRange(parseTimePhrase("yesterday", NOW));
    const midnight = localMidnight(NOW);
    assert.equal(r.from.getTime(), midnight.getTime() - 86_400_000);
    assert.equal(r.to.getTime(), midnight.getTime());
  });

  test("this morning", () => {
    const r = expectRange(parseTimePhrase("this morning", NOW));
    assert.equal(r.from.getHours(), 5);
    assert.equal(r.to.getHours(), 12);
  });

  test("yesterday afternoon", () => {
    const r = expectRange(parseTimePhrase("yesterday afternoon", NOW));
    assert.equal(r.from.getHours(), 12);
    assert.equal(r.to.getHours(), 17);
    // Confirm the day is yesterday (local).
    const yMidnight = localMidnight(new Date(NOW.getTime() - 86_400_000));
    assert.equal(r.from.getTime() - yMidnight.getTime(), 12 * 3_600_000);
  });

  test("this evening", () => {
    const r = expectRange(parseTimePhrase("this evening", NOW));
    assert.equal(r.from.getHours(), 17);
    assert.equal(r.to.getHours(), 21);
  });

  test("earlier today", () => {
    const r = expectRange(parseTimePhrase("earlier today", NOW));
    assert.equal(r.from.getTime(), localMidnight(NOW).getTime());
    assert.equal(r.to.getTime(), NOW.getTime());
  });
});

describe("parseTimePhrase — colloquial", () => {
  test("just now → last 2 minutes", () => {
    const r = expectRange(parseTimePhrase("just now", NOW));
    assert.equal(r.to.getTime(), NOW.getTime());
    assert.equal(r.from.getTime(), NOW.getTime() - 120_000);
  });

  test("a few minutes ago → last 5 minutes", () => {
    const r = expectRange(parseTimePhrase("a few minutes ago", NOW));
    assert.equal(r.from.getTime(), NOW.getTime() - 300_000);
  });

  test("a couple minutes ago", () => {
    const r = expectRange(parseTimePhrase("a couple minutes ago", NOW));
    assert.equal(r.from.getTime(), NOW.getTime() - 300_000);
  });
});

describe("parseTimePhrase — unsupported / ambiguous", () => {
  test("empty string → null", () => {
    assert.equal(parseTimePhrase("", NOW), null);
  });

  test("nonsense phrase → null (no throw)", () => {
    assert.equal(parseTimePhrase("the quick brown fox", NOW), null);
  });

  test("bare 'morning' is ambiguous → null", () => {
    assert.equal(parseTimePhrase("morning", NOW), null);
  });

  test("non-string input → null (no throw)", () => {
    // @ts-expect-error deliberate
    assert.equal(parseTimePhrase(42, NOW), null);
  });

  test("0 minutes ago → null (non-positive delta)", () => {
    assert.equal(parseTimePhrase("0 minutes ago", NOW), null);
  });

  test("case-insensitive + whitespace tolerant", () => {
    const a = expectRange(parseTimePhrase("  40 Minutes Ago  ", NOW));
    const b = expectRange(parseTimePhrase("40 minutes ago", NOW));
    assert.equal(a.from.getTime(), b.from.getTime());
  });
});

// ────────────────────────── helpers ────────────────────────────────────────
function localMidnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}
