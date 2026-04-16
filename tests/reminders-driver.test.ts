/**
 * Tests for MacRemindersDriver (src/apps/reminders-driver.ts).
 *
 * Mocks execFile(osascript, …) to verify:
 *   • script contents + user-string escaping
 *   • mutations hit the audit log
 *   • `remove` requires an escalation gate and honors user decline
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/proactivity/audit.js";
import { MacRemindersDriver } from "../src/apps/reminders-driver.js";
import type { EscalationGate } from "../src/apps/notes-driver.js";

function makeMockExec(out: string | ((args: readonly string[]) => string)) {
  const calls: { args: readonly string[] }[] = [];
  const fn = async (_f: string, args: readonly string[]) => {
    calls.push({ args });
    return { stdout: typeof out === "function" ? out(args) : out, stderr: "" };
  };
  return { fn: fn as unknown as (typeof import("node:child_process"))["execFile"], calls };
}

function fakeGate(accept: boolean): EscalationGate {
  return { async requestConfirmation() { return accept; } };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reminders-audit-"));
});

describe("MacRemindersDriver.add", () => {
  test("makes reminder with escaped title + default list", async () => {
    const { fn, calls } = makeMockExec("R1\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacRemindersDriver({ execFileFn: fn, audit });

    const res = await driver.add({ title: `pay "bill"`, priority: 5 });
    assert.equal(res.reminderId, "R1");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /default list/);
    assert.match(script, /name:"pay \\"bill\\""/);
    assert.match(script, /priority:5/);

    const body = readFileSync(auditPath, "utf-8");
    assert.match(body, /app_mutation/);
    assert.match(body, /reminders\.add/);
  });

  test("embeds due date + custom list", async () => {
    const { fn, calls } = makeMockExec("R2\n");
    const driver = new MacRemindersDriver({ execFileFn: fn });
    const due = new Date("2026-05-01T09:30:00Z");
    await driver.add({ title: "call", dueAt: due, list: "Work", notes: "n" });
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /list "Work"/);
    assert.match(script, /due date:remote_date/);
    assert.match(script, /2026-05-01 09:30:00/);
    assert.match(script, /body:"n"/);
  });
});

describe("MacRemindersDriver.complete", () => {
  test("sets completed true and audits", async () => {
    const { fn, calls } = makeMockExec("ok\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacRemindersDriver({ execFileFn: fn, audit });
    await driver.complete("Rxyz");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /set completed of r to true/);
    assert.match(script, /"Rxyz"/);
    const body = readFileSync(auditPath, "utf-8");
    assert.match(body, /reminders\.complete/);
  });
});

describe("MacRemindersDriver.list", () => {
  test("parses rows with due-date + completed + priority", async () => {
    const iso = "2026-05-01T09:30:00Z";
    const out = `R1\ttask a\t${iso}\tfalse\t1\nR2\ttask b\t\ttrue\t9\n`;
    const { fn } = makeMockExec(out);
    const driver = new MacRemindersDriver({ execFileFn: fn });
    const hits = await driver.list("Work");
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.priority, 1);
    assert.equal(hits[0]?.dueAt?.getUTCFullYear(), 2026);
    assert.equal(hits[1]?.completed, true);
    assert.equal(hits[1]?.dueAt, undefined);
  });
});

describe("MacRemindersDriver.remove", () => {
  test("rejects without gate", async () => {
    const { fn } = makeMockExec("ok\n");
    const driver = new MacRemindersDriver({ execFileFn: fn });
    await assert.rejects(() => driver.remove("R1"), /escalation gate/);
  });

  test("rejects when user declines escalation", async () => {
    const { fn } = makeMockExec("ok\n");
    const driver = new MacRemindersDriver({
      execFileFn: fn,
      gate: fakeGate(false),
    });
    await assert.rejects(() => driver.remove("R1"), /declined/);
  });

  test("proceeds + audits when gate approves", async () => {
    const { fn } = makeMockExec("ok\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacRemindersDriver({
      execFileFn: fn,
      audit,
      gate: fakeGate(true),
    });
    await driver.remove("R9");
    const body = readFileSync(auditPath, "utf-8");
    assert.match(body, /reminders\.remove/);
  });
});

process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});
