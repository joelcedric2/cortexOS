/**
 * Natural-language time-range parser for Phase 15 "rewind" queries.
 *
 * Pure, deterministic, no LLM, no network. Given an utterance like
 * "40 minutes ago" or "yesterday afternoon", returns a `{from, to}` window
 * anchored to a reference `now` (defaults to the current clock). Returns
 * `null` when no supported phrase matches — callers decide whether to fall
 * back to a broad window or bail out.
 *
 * Design notes:
 *   - Target coverage: ~15 common phrasings (see tests/time-parse.test.ts).
 *   - We prefer rejecting (returning `null`) over guessing — unsupported
 *     phrases should never throw, so the voice pipeline can quietly skip
 *     the filter and still produce results.
 *   - "Afternoon"/"morning"/"evening"/"night" map to broad, fixed local
 *     windows (see LOCAL_WINDOWS). We use the reference date's local
 *     year/month/day via the host `Date` to keep DST handling simple —
 *     consumers on oddball timezones can still pass an explicit
 *     `timeRange` directly to `rewindSearch` and bypass this parser.
 */

/** Inclusive-on-`from`, exclusive-on-`to` window. */
export interface TimeRange {
  from: Date;
  to: Date;
}

/** Day-of-week words that map to numeric weekday indices (Sun = 0). */
const DOW: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  weds: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Local-clock windows for "morning"/"afternoon"/"evening"/"night".
 * Endpoints are half-open on the right (consistent with the interface).
 */
const LOCAL_WINDOWS: Record<string, { startH: number; endH: number }> = {
  morning: { startH: 5, endH: 12 },
  afternoon: { startH: 12, endH: 17 },
  evening: { startH: 17, endH: 21 },
  night: { startH: 21, endH: 29 }, // wraps past midnight — see build()
};

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function localDayStart(ref: Date): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function buildLocalWindow(
  dayAnchor: Date,
  window: { startH: number; endH: number },
): TimeRange {
  const from = new Date(dayAnchor);
  from.setHours(window.startH, 0, 0, 0);
  const to = new Date(dayAnchor);
  // endH may exceed 24 (e.g. "night" = 21..29 = 9pm..5am next day).
  to.setHours(0, 0, 0, 0);
  to.setHours(window.endH, 0, 0, 0);
  return { from, to };
}

/**
 * Parse a natural-language time phrase into a `{from, to}` window.
 *
 * @param phrase The utterance to parse (case-insensitive, whitespace flexible).
 * @param now    Reference "now" (defaults to `new Date()`).
 * @returns A `TimeRange` or `null` when the phrase is unsupported/ambiguous.
 */
export function parseTimePhrase(
  phrase: string,
  now: Date = new Date(),
): TimeRange | null {
  if (typeof phrase !== "string") return null;
  const p = normalize(phrase);
  if (p.length === 0) return null;

  // ── 1. "N <unit> ago" / "N <unit>s ago" ────────────────────────────────
  const agoMatch = p.match(
    /^(\d+)\s+(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\s+ago$/,
  );
  if (agoMatch) {
    const n = Number(agoMatch[1]);
    const unit = agoMatch[2]!;
    const deltaMs = n * UNIT_MS[unit]!;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
    // 10% tolerance window centered on the estimated timestamp, min 60s.
    const pad = Math.max(60_000, Math.floor(deltaMs * 0.1));
    const center = now.getTime() - deltaMs;
    return { from: new Date(center - pad), to: new Date(center + pad) };
  }

  // ── 2. "last <unit>" (singular — "last hour", "last week", …) ──────────
  const lastUnitMatch = p.match(/^last\s+(hour|day|week|month)$/);
  if (lastUnitMatch) {
    const unit = lastUnitMatch[1]!;
    if (unit === "month") {
      const from = new Date(now);
      from.setMonth(from.getMonth() - 1);
      return { from, to: new Date(now) };
    }
    const deltaMs = UNIT_MS[unit]!;
    return { from: new Date(now.getTime() - deltaMs), to: new Date(now) };
  }

  // ── 3. "last <weekday>" ────────────────────────────────────────────────
  const lastDow = p.match(/^last\s+([a-z]+)$/);
  if (lastDow && lastDow[1]! in DOW) {
    const target = DOW[lastDow[1]!]!;
    const today = localDayStart(now);
    const currentDow = today.getDay();
    // Always step back into the previous week — "last tuesday" on a Tuesday
    // means the prior week's Tuesday, not today.
    const offsetDays = ((currentDow - target + 7) % 7) || 7;
    const day = addDays(today, -offsetDays);
    return { from: day, to: addDays(day, 1) };
  }

  // ── 4. "today" / "yesterday" / "this morning" / "yesterday afternoon" ──
  if (p === "today") {
    const day = localDayStart(now);
    return { from: day, to: addDays(day, 1) };
  }
  if (p === "yesterday") {
    const day = addDays(localDayStart(now), -1);
    return { from: day, to: addDays(day, 1) };
  }

  const dayPart = p.match(/^(this|yesterday|today)\s+(morning|afternoon|evening|night)$/);
  if (dayPart) {
    const which = dayPart[1]!;
    const part = dayPart[2]!;
    const anchor =
      which === "yesterday"
        ? addDays(localDayStart(now), -1)
        : localDayStart(now);
    const win = LOCAL_WINDOWS[part]!;
    return buildLocalWindow(anchor, win);
  }

  // ── 5. Bare period-of-day: "this morning" handled above; "morning"
  //      alone is intentionally ambiguous → null.

  // ── 6. "earlier today" ─────────────────────────────────────────────────
  if (p === "earlier today" || p === "earlier") {
    const start = localDayStart(now);
    return { from: start, to: new Date(now) };
  }

  // ── 7. "just now" / "a moment ago" → last 2 minutes ────────────────────
  if (p === "just now" || p === "a moment ago" || p === "a sec ago") {
    return { from: new Date(now.getTime() - 120_000), to: new Date(now) };
  }

  // ── 8. "a few minutes ago" / "a couple minutes ago" → last 5 min ───────
  if (
    p === "a few minutes ago" ||
    p === "a couple minutes ago" ||
    p === "a couple of minutes ago" ||
    p === "few minutes ago"
  ) {
    return { from: new Date(now.getTime() - 300_000), to: new Date(now) };
  }

  // ── 9. "an hour ago" / "a day ago" ─────────────────────────────────────
  const anAgo = p.match(/^an?\s+(hour|day|week)\s+ago$/);
  if (anAgo) {
    const unit = anAgo[1]!;
    const deltaMs = UNIT_MS[unit]!;
    const pad = Math.max(60_000, Math.floor(deltaMs * 0.1));
    const center = now.getTime() - deltaMs;
    return { from: new Date(center - pad), to: new Date(center + pad) };
  }

  // Unsupported — caller decides what to do.
  return null;
}
