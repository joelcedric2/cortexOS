/**
 * Tests for src/apps/calendar-driver.ts — Phase 12a.
 *
 * Key coverage is the computeGaps math (3 busy periods → correct gaps),
 * escape behavior for titles/locations, and audit entries for mutations.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCalendarDriver,
  computeGaps,
  isoNoTZ,
  type CalendarDriver,
} from "../src/apps/calendar-driver.js";
import { AuditLog } from "../src/proactivity/audit.js";

interface ExecCall {
  file: string;
  args: readonly string[];
}
type FakeExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

function makeFakeExec(
  responder: (script: string) => string = () => "",
): { calls: ExecCall[]; fn: FakeExecFn } {
  const calls: ExecCall[] = [];
  const fn: FakeExecFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    return { stdout: responder(args[1] ?? ""), stderr: "" };
  };
  return { calls, fn };
}

interface Harness {
  driver: CalendarDriver;
  calls: ExecCall[];
  logPath: string;
  tmpDir: string;
}

function buildHarness(responder: (s: string) => string = () => ""): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "cortex-cal-"));
  const logPath = join(tmpDir, "audit.ndjson");
  const audit = new AuditLog(logPath);
  const { calls, fn } = makeFakeExec(responder);
  const driver = createCalendarDriver({
    audit,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execFileFn: fn as any,
  });
  return { driver, calls, logPath, tmpDir };
}

function readAuditDetails(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { action: string; sensorName?: string; detail: string })
    .filter((r) => r.action === "act_on" && r.sensorName === "calendar")
    .map((r) => r.detail);
}

/* ------------------------------------------------------------------ */
/*  isoNoTZ                                                            */
/* ------------------------------------------------------------------ */

describe("isoNoTZ", () => {
  it("formats local-wall time without a timezone suffix", () => {
    const d = new Date(2026, 3, 15, 9, 30, 15); // Apr is 3 (0-based)
    assert.equal(isoNoTZ(d), "2026-04-15T09:30:15");
  });

  it("pads single-digit fields", () => {
    const d = new Date(2026, 0, 2, 1, 2, 3);
    assert.equal(isoNoTZ(d), "2026-01-02T01:02:03");
  });
});

/* ------------------------------------------------------------------ */
/*  computeGaps — the math                                             */
/* ------------------------------------------------------------------ */

describe("computeGaps", () => {
  const d = (h: number, m = 0) => new Date(2026, 3, 15, h, m, 0);

  it("returns full window when no busy periods", () => {
    const gaps = computeGaps(d(9), d(17), [], 30);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].start.getTime(), d(9).getTime());
    assert.equal(gaps[0].end.getTime(), d(17).getTime());
  });

  it("returns 3 gaps with 3 busy periods", () => {
    // busy 10-11, 12-13, 15-16 inside 9-17 window
    const gaps = computeGaps(
      d(9),
      d(17),
      [
        { start: d(10), end: d(11) },
        { start: d(12), end: d(13) },
        { start: d(15), end: d(16) },
      ],
      30,
    );
    assert.equal(gaps.length, 4);
    assert.equal(gaps[0].start.getTime(), d(9).getTime());
    assert.equal(gaps[0].end.getTime(), d(10).getTime());
    assert.equal(gaps[1].start.getTime(), d(11).getTime());
    assert.equal(gaps[1].end.getTime(), d(12).getTime());
    assert.equal(gaps[2].start.getTime(), d(13).getTime());
    assert.equal(gaps[2].end.getTime(), d(15).getTime());
    assert.equal(gaps[3].start.getTime(), d(16).getTime());
    assert.equal(gaps[3].end.getTime(), d(17).getTime());
  });

  it("filters out gaps shorter than durationMin", () => {
    // Leave only 30 min gaps; duration 60
    const gaps = computeGaps(
      d(9),
      d(17),
      [
        { start: d(9, 30), end: d(10) },
        { start: d(11), end: d(13) },
      ],
      60,
    );
    // Candidate gaps: [9-9:30]=30min → drop, [10-11]=60min → keep,
    // [13-17]=240min → keep.
    assert.equal(gaps.length, 2);
    assert.equal(gaps[0].start.getTime(), d(10).getTime());
    assert.equal(gaps[0].end.getTime(), d(11).getTime());
    assert.equal(gaps[1].start.getTime(), d(13).getTime());
    assert.equal(gaps[1].end.getTime(), d(17).getTime());
  });

  it("merges overlapping busy periods", () => {
    const gaps = computeGaps(
      d(9),
      d(17),
      [
        { start: d(10), end: d(12) },
        { start: d(11), end: d(13) }, // overlaps previous
        { start: d(12, 30), end: d(14) }, // overlaps merge so far
      ],
      30,
    );
    // After merging: one busy 10-14 → gaps 9-10 + 14-17
    assert.equal(gaps.length, 2);
    assert.equal(gaps[0].start.getTime(), d(9).getTime());
    assert.equal(gaps[0].end.getTime(), d(10).getTime());
    assert.equal(gaps[1].start.getTime(), d(14).getTime());
    assert.equal(gaps[1].end.getTime(), d(17).getTime());
  });

  it("clips busy events that extend outside the window", () => {
    const gaps = computeGaps(
      d(9),
      d(17),
      [
        { start: d(8), end: d(10) }, // starts before window
        { start: d(16), end: d(18) }, // ends after window
      ],
      30,
    );
    // After clipping: busy 9-10 + 16-17 → gap 10-16 only
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].start.getTime(), d(10).getTime());
    assert.equal(gaps[0].end.getTime(), d(16).getTime());
  });

  it("returns [] for invalid window or duration", () => {
    assert.deepEqual(computeGaps(d(10), d(9), [], 30), []);
    assert.deepEqual(computeGaps(d(9), d(10), [], 0), []);
    assert.deepEqual(computeGaps(d(9), d(10), [], -5), []);
  });
});

/* ------------------------------------------------------------------ */
/*  createEvent                                                        */
/* ------------------------------------------------------------------ */

describe("CalendarDriver.createEvent", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(() => "uid-xyz"); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("creates an event, captures uid, and audits", async () => {
    const { eventId } = await h.driver.createEvent({
      title: "Standup",
      start: new Date(2026, 3, 15, 9, 0, 0),
      end: new Date(2026, 3, 15, 9, 30, 0),
    });
    assert.equal(eventId, "uid-xyz");
    const s = h.calls[0].args[1];
    assert.match(s, /tell application "Calendar"/);
    assert.match(s, /first calendar whose name is "Calendar"/);
    assert.match(s, /summary:"Standup"/);
    const details = readAuditDetails(h.logPath);
    assert.equal(details.length, 1);
    assert.match(details[0], /calendar\.createEvent/);
    assert.match(details[0], /title="Standup"/);
    assert.match(details[0], /eventId=uid-xyz/);
  });

  it("respects custom calendar / location / notes / attendees", async () => {
    await h.driver.createEvent({
      title: "Sync",
      calendar: "Work",
      start: new Date(2026, 3, 15, 14, 0, 0),
      end: new Date(2026, 3, 15, 15, 0, 0),
      location: "Room A",
      notes: "bring laptop",
      attendees: ["a@x.com", "b@x.com"],
    });
    const s = h.calls[0].args[1];
    assert.match(s, /first calendar whose name is "Work"/);
    assert.match(s, /set location of newEvent to "Room A"/);
    assert.match(s, /set description of newEvent to "bring laptop"/);
    assert.match(s, /attendees of newEvent with properties \{email:"a@x\.com"\}/);
    assert.match(s, /attendees of newEvent with properties \{email:"b@x\.com"\}/);
    const details = readAuditDetails(h.logPath);
    assert.match(details[0], /attendees=2/);
  });

  it("escapes quotes/backslashes/newlines in title and location", async () => {
    await h.driver.createEvent({
      title: `Say "hi"`,
      start: new Date(2026, 3, 15, 9, 0, 0),
      end: new Date(2026, 3, 15, 10, 0, 0),
      location: `Room\nB\\1`,
    });
    const s = h.calls[0].args[1];
    assert.match(s, /summary:"Say \\"hi\\""/);
    assert.match(s, /set location of newEvent to "Room B\\\\1"/);
  });

  it("rejects end <= start", async () => {
    await assert.rejects(
      () =>
        h.driver.createEvent({
          title: "bad",
          start: new Date(2026, 3, 15, 10),
          end: new Date(2026, 3, 15, 9),
        }),
      /end must be after start/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  findGap                                                            */
/* ------------------------------------------------------------------ */

describe("CalendarDriver.findGap (integration)", () => {
  let h: Harness;
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("parses osascript busy output and returns computed gaps", async () => {
    // Two busy events in the day; compute 60-min gaps
    const busyOut =
      "2026-04-15T10:00:00\t2026-04-15T11:00:00\n" +
      "2026-04-15T13:00:00\t2026-04-15T14:00:00\n";
    h = buildHarness(() => busyOut);
    const gaps = await h.driver.findGap({
      from: new Date("2026-04-15T09:00:00"),
      to: new Date("2026-04-15T17:00:00"),
      durationMin: 60,
    });
    // Gaps: 9-10, 11-13, 14-17
    assert.equal(gaps.length, 3);
    assert.equal(gaps[0].end.toISOString(), new Date("2026-04-15T10:00:00").toISOString());
    assert.equal(gaps[1].start.toISOString(), new Date("2026-04-15T11:00:00").toISOString());
    assert.equal(gaps[1].end.toISOString(), new Date("2026-04-15T13:00:00").toISOString());
    assert.equal(gaps[2].start.toISOString(), new Date("2026-04-15T14:00:00").toISOString());
  });

  it("returns [] on invalid window", async () => {
    h = buildHarness(() => "");
    const gaps = await h.driver.findGap({
      from: new Date("2026-04-15T10:00:00"),
      to: new Date("2026-04-15T09:00:00"),
      durationMin: 30,
    });
    assert.deepEqual(gaps, []);
  });

  it("skips malformed busy lines", async () => {
    h = buildHarness(() => "garbage-line\n2026-04-15T10:00:00\t2026-04-15T11:00:00\n");
    const gaps = await h.driver.findGap({
      from: new Date("2026-04-15T09:00:00"),
      to: new Date("2026-04-15T12:00:00"),
      durationMin: 30,
    });
    // Good row = 10-11; gaps 9-10 and 11-12
    assert.equal(gaps.length, 2);
  });
});

/* ------------------------------------------------------------------ */
/*  decline                                                            */
/* ------------------------------------------------------------------ */

describe("CalendarDriver.decline", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("sets status to cancelled and audits", async () => {
    await h.driver.decline("evt-1", "conflict");
    const s = h.calls[0].args[1];
    assert.match(s, /first event whose uid is "evt-1"/);
    assert.match(s, /set status of target to cancelled/);
    const details = readAuditDetails(h.logPath);
    assert.deepEqual(details, [
      'calendar.decline eventId=evt-1 reason="conflict"',
    ]);
  });

  it("omits reason from audit when unspecified", async () => {
    await h.driver.decline("evt-2");
    assert.deepEqual(readAuditDetails(h.logPath), [
      "calendar.decline eventId=evt-2",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  listUpcoming                                                       */
/* ------------------------------------------------------------------ */

describe("CalendarDriver.listUpcoming", () => {
  let h: Harness;
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("parses tab-separated rows", async () => {
    h = buildHarness(
      () =>
        "id1\tStandup\t2026-04-15T09:00:00\t2026-04-15T09:30:00\tRoom A\n" +
        "id2\tLunch\t2026-04-15T12:00:00\t2026-04-15T13:00:00\t\n",
    );
    const rows = await h.driver.listUpcoming(60 * 24);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "id1");
    assert.equal(rows[0].title, "Standup");
    assert.equal(rows[0].location, "Room A");
    assert.equal(rows[1].location, undefined);
  });

  it("skips invalid dates", async () => {
    h = buildHarness(() => "id1\tbad\tnot-a-date\tnor-this\t\n");
    const rows = await h.driver.listUpcoming(60);
    assert.deepEqual(rows, []);
  });

  it("does NOT audit (read-only)", async () => {
    h = buildHarness(() => "");
    await h.driver.listUpcoming();
    assert.equal(readAuditDetails(h.logPath).length, 0);
  });
});
