/**
 * Minimal "next run" computation from a 5-field POSIX cron expression.
 *
 * Scans forward one minute at a time (up to 400 days) looking for the first
 * matching instant. Timezone-naive — interprets the expression in the
 * process-local clock's view. Good enough for Phase 1.5; a proper impl with
 * tz-aware scheduling will land alongside the node-cron dependency in
 * Phase 3.
 *
 * Throws on malformed expressions; callers should validate via
 * `isValidCronExpr()` first.
 */

type FieldMatcher = (n: number) => boolean;

function parseField(field: string, min: number, max: number): FieldMatcher {
  const parts = field.split(",");
  const matchers: FieldMatcher[] = parts.map((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step: ${stepStr}`);
    }
    let lo: number;
    let hi: number;
    if (range === "*" || range === undefined) {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (a === undefined || b === undefined) {
        throw new Error(`invalid cron range: ${range}`);
      }
      lo = a;
      hi = b;
    } else {
      const n = Number(range);
      if (!Number.isInteger(n)) throw new Error(`invalid cron value: ${range}`);
      lo = n;
      hi = n;
    }
    return (n: number) => n >= lo && n <= hi && (n - lo) % step === 0;
  });
  return (n: number) => matchers.some((m) => m(n));
}

/**
 * Compute the next moment at or after `from` that matches the 5-field cron
 * expression. Returns `null` if no match within a year window (should never
 * happen for well-formed expressions).
 */
export function nextRunFromCron(expr: string, from: Date): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron expr: ${expr}`);

  const matchMinute = parseField(fields[0]!, 0, 59);
  const matchHour = parseField(fields[1]!, 0, 23);
  const matchDom = parseField(fields[2]!, 1, 31);
  const matchMonth = parseField(fields[3]!, 1, 12);
  const matchDowRaw = parseField(fields[4]!, 0, 7);
  // Day-of-week: 0 and 7 both mean Sunday.
  const matchDow: FieldMatcher = (n) => matchDowRaw(n) || (n === 0 && matchDowRaw(7));

  // Start at the next whole minute (strict >= from).
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  if (start.getTime() <= from.getTime()) {
    start.setMinutes(start.getMinutes() + 1);
  }

  const LIMIT_MINUTES = 400 * 24 * 60; // ~400 days
  for (let i = 0; i < LIMIT_MINUTES; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (!matchMinute(t.getMinutes())) continue;
    if (!matchHour(t.getHours())) continue;
    if (!matchMonth(t.getMonth() + 1)) continue;
    // POSIX cron: when both dom and dow are restricted, match either; when
    // one is `*`, only the restricted one applies.
    const domField = fields[2]!;
    const dowField = fields[4]!;
    const domOk = matchDom(t.getDate());
    const dowOk = matchDow(t.getDay());
    if (domField === "*" && dowField !== "*") {
      if (!dowOk) continue;
    } else if (domField !== "*" && dowField === "*") {
      if (!domOk) continue;
    } else if (domField !== "*" && dowField !== "*") {
      if (!(domOk || dowOk)) continue;
    }
    return t;
  }
  return null;
}
