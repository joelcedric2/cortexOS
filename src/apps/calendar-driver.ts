/**
 * Calendar.app driver — Phase 12a Native App Drivers (§4).
 *
 * Drives the macOS Calendar app via AppleScript (`osascript -e`). The
 * {@link CalendarDriver#findGap} helper queries busy periods from
 * Calendar.app, parses them locally, and computes free gaps of at least
 * the requested duration — this keeps the planner deterministic regardless
 * of how Calendar paginates its results.
 *
 * Mutations (createEvent, decline) are audited. Irreversible mutations —
 * createEvent with attendees — are gated at the MCP layer by an explicit
 * nchinda_escalate confirmation before firing.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { quoteAS } from "./mail-driver.js";
import type { AuditLog } from "../proactivity/audit.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface CalendarCreateOpts {
  title: string;
  start: Date;
  end: Date;
  calendar?: string;
  location?: string;
  notes?: string;
  attendees?: string[];
}

export interface CalendarGap {
  start: Date;
  end: Date;
}

export interface CalendarUpcoming {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  attendees?: string[];
}

export interface CalendarDriver {
  createEvent(opts: CalendarCreateOpts): Promise<{ eventId: string }>;
  findGap(opts: {
    from: Date;
    to: Date;
    durationMin: number;
  }): Promise<CalendarGap[]>;
  decline(eventId: string, reason?: string): Promise<void>;
  listUpcoming(withinMin?: number): Promise<CalendarUpcoming[]>;
}

export interface CalendarDriverDeps {
  audit?: AuditLog;
  /** Test hook — overrides the promisified execFile. */
  execFileFn?: typeof execFile;
}

/* ------------------------------------------------------------------ */
/*  Driver implementation                                              */
/* ------------------------------------------------------------------ */

class CalendarDriverImpl implements CalendarDriver {
  private readonly exec: typeof execFile;
  private readonly audit: AuditLog | undefined;

  constructor(deps?: CalendarDriverDeps) {
    this.exec = deps?.execFileFn ?? execFile;
    this.audit = deps?.audit;
  }

  async createEvent(
    opts: CalendarCreateOpts,
  ): Promise<{ eventId: string }> {
    if (opts.end.getTime() <= opts.start.getTime()) {
      throw new Error("calendar.createEvent: end must be after start");
    }
    const calName = opts.calendar ?? "Calendar";
    const lines: string[] = [
      `tell application "Calendar"`,
      `  set targetCal to first calendar whose name is "${quoteAS(calName)}"`,
      `  tell targetCal`,
      `    set newEvent to make new event at end with properties ` +
        `{summary:"${quoteAS(opts.title)}", start date:(my asDate("${isoNoTZ(opts.start)}")), end date:(my asDate("${isoNoTZ(opts.end)}"))}`,
    ];
    if (opts.location) {
      lines.push(`    set location of newEvent to "${quoteAS(opts.location)}"`);
    }
    if (opts.notes) {
      lines.push(`    set description of newEvent to "${quoteAS(opts.notes)}"`);
    }
    for (const a of opts.attendees ?? []) {
      lines.push(
        `    make new attendee at end of attendees of newEvent with properties {email:"${quoteAS(a)}"}`,
      );
    }
    lines.push(
      `    return uid of newEvent as string`,
      `  end tell`,
      `end tell`,
      // Helper: turn ISO yyyy-mm-ddTHH:MM:SS string into AppleScript date
      `on asDate(s)`,
      `  set theDate to current date`,
      `  set year of theDate to (text 1 thru 4 of s) as integer`,
      `  set month of theDate to (text 6 thru 7 of s) as integer`,
      `  set day of theDate to (text 9 thru 10 of s) as integer`,
      `  set hours of theDate to (text 12 thru 13 of s) as integer`,
      `  set minutes of theDate to (text 15 thru 16 of s) as integer`,
      `  set seconds of theDate to (text 18 thru 19 of s) as integer`,
      `  return theDate`,
      `end asDate`,
    );

    const { stdout } = await this.exec("osascript", ["-e", lines.join("\n")]);
    const eventId = stdout.trim() || `local-${Date.now()}`;
    this.logAudit(
      `calendar.createEvent title="${opts.title}" start=${opts.start.toISOString()} ` +
        `end=${opts.end.toISOString()} attendees=${opts.attendees?.length ?? 0} eventId=${eventId}`,
    );
    return { eventId };
  }

  async findGap(opts: {
    from: Date;
    to: Date;
    durationMin: number;
  }): Promise<CalendarGap[]> {
    if (opts.to.getTime() <= opts.from.getTime()) return [];
    if (opts.durationMin <= 0) return [];

    const script = [
      `tell application "Calendar"`,
      `  set fromDate to my asDate("${isoNoTZ(opts.from)}")`,
      `  set toDate to my asDate("${isoNoTZ(opts.to)}")`,
      `  set busy to {}`,
      `  repeat with c in calendars`,
      `    try`,
      `      set evs to (every event of c whose (start date is greater than or equal to fromDate) and (start date is less than toDate))`,
      `      repeat with e in evs`,
      `        set s to start date of e`,
      `        set en to end date of e`,
      `        set end of busy to ((s as «class isot» as string) & tab & (en as «class isot» as string))`,
      `      end repeat`,
      `    end try`,
      `  end repeat`,
      `end tell`,
      `set AppleScript's text item delimiters to linefeed`,
      `return busy as string`,
      // helper
      `on asDate(s)`,
      `  set theDate to current date`,
      `  set year of theDate to (text 1 thru 4 of s) as integer`,
      `  set month of theDate to (text 6 thru 7 of s) as integer`,
      `  set day of theDate to (text 9 thru 10 of s) as integer`,
      `  set hours of theDate to (text 12 thru 13 of s) as integer`,
      `  set minutes of theDate to (text 15 thru 16 of s) as integer`,
      `  set seconds of theDate to (text 18 thru 19 of s) as integer`,
      `  return theDate`,
      `end asDate`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    const busy = parseBusyPairs(stdout);
    return computeGaps(opts.from, opts.to, busy, opts.durationMin);
  }

  async decline(eventId: string, reason?: string): Promise<void> {
    const script = [
      `tell application "Calendar"`,
      `  set target to first event whose uid is "${quoteAS(eventId)}"`,
      `  set status of target to cancelled`,
      `end tell`,
    ].join("\n");

    await this.exec("osascript", ["-e", script]);
    this.logAudit(
      `calendar.decline eventId=${eventId}${reason ? ` reason="${reason}"` : ""}`,
    );
  }

  async listUpcoming(withinMin = 60 * 24): Promise<CalendarUpcoming[]> {
    const from = new Date();
    const to = new Date(from.getTime() + withinMin * 60_000);
    const script = [
      `tell application "Calendar"`,
      `  set fromDate to my asDate("${isoNoTZ(from)}")`,
      `  set toDate to my asDate("${isoNoTZ(to)}")`,
      `  set rows to {}`,
      `  repeat with c in calendars`,
      `    try`,
      `      set evs to (every event of c whose (start date is greater than or equal to fromDate) and (start date is less than toDate))`,
      `      repeat with e in evs`,
      `        set uu to uid of e as string`,
      `        set ss to (start date of e as «class isot» as string)`,
      `        set en to (end date of e as «class isot» as string)`,
      `        set tt to summary of e as string`,
      `        set loc to ""`,
      `        try`,
      `          set loc to location of e as string`,
      `        end try`,
      `        set end of rows to (uu & tab & tt & tab & ss & tab & en & tab & loc)`,
      `      end repeat`,
      `    end try`,
      `  end repeat`,
      `end tell`,
      `set AppleScript's text item delimiters to linefeed`,
      `return rows as string`,
      `on asDate(s)`,
      `  set theDate to current date`,
      `  set year of theDate to (text 1 thru 4 of s) as integer`,
      `  set month of theDate to (text 6 thru 7 of s) as integer`,
      `  set day of theDate to (text 9 thru 10 of s) as integer`,
      `  set hours of theDate to (text 12 thru 13 of s) as integer`,
      `  set minutes of theDate to (text 15 thru 16 of s) as integer`,
      `  set seconds of theDate to (text 18 thru 19 of s) as integer`,
      `  return theDate`,
      `end asDate`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    return parseUpcoming(stdout);
  }

  private logAudit(detail: string): void {
    this.audit?.append({
      action: "act_on",
      sensorName: "calendar",
      detail,
      ts: new Date(),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Format a Date as `yyyy-MM-ddTHH:mm:ss` (no timezone suffix) — the shape
 * our AppleScript `asDate()` helper consumes.
 */
export function isoNoTZ(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function parseBusyPairs(
  stdout: string,
): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [a, b] = line.split("\t");
    if (!a || !b) continue;
    const s = new Date(a);
    const e = new Date(b);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) continue;
    if (e.getTime() <= s.getTime()) continue;
    out.push({ start: s, end: e });
  }
  return out;
}

function parseUpcoming(stdout: string): CalendarUpcoming[] {
  const rows: CalendarUpcoming[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const start = new Date(parts[2]!);
    const end = new Date(parts[3]!);
    if (!Number.isFinite(start.getTime())) continue;
    if (!Number.isFinite(end.getTime())) continue;
    rows.push({
      id: parts[0] ?? "",
      title: parts[1] ?? "",
      start,
      end,
      ...(parts[4] ? { location: parts[4] } : {}),
    });
  }
  return rows;
}

/**
 * Merge overlapping busy periods and return free gaps within [from, to]
 * that are at least `durationMin` minutes long.
 *
 * Exported for unit tests — the math is the load-bearing piece of the
 * driver and deserves isolated coverage.
 */
export function computeGaps(
  from: Date,
  to: Date,
  busy: Array<{ start: Date; end: Date }>,
  durationMin: number,
): CalendarGap[] {
  if (to.getTime() <= from.getTime()) return [];
  if (durationMin <= 0) return [];

  const durMs = durationMin * 60_000;

  // Clip busy periods to [from, to]
  const clipped = busy
    .map((b) => ({
      start: new Date(Math.max(b.start.getTime(), from.getTime())),
      end: new Date(Math.min(b.end.getTime(), to.getTime())),
    }))
    .filter((b) => b.end.getTime() > b.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  // Merge overlaps
  const merged: Array<{ start: Date; end: Date }> = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.start.getTime() <= last.end.getTime()) {
      if (b.end.getTime() > last.end.getTime()) last.end = b.end;
    } else {
      merged.push({ start: b.start, end: b.end });
    }
  }

  // Walk gaps
  const gaps: CalendarGap[] = [];
  let cursor = from.getTime();
  for (const b of merged) {
    if (b.start.getTime() - cursor >= durMs) {
      gaps.push({ start: new Date(cursor), end: b.start });
    }
    cursor = Math.max(cursor, b.end.getTime());
  }
  if (to.getTime() - cursor >= durMs) {
    gaps.push({ start: new Date(cursor), end: to });
  }
  return gaps;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createCalendarDriver(
  deps?: CalendarDriverDeps,
): CalendarDriver {
  return new CalendarDriverImpl(deps);
}
