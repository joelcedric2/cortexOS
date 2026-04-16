/**
 * Tests for MacNotesDriver (src/apps/notes-driver.ts).
 *
 * Mocks execFile(osascript, …) to:
 *   • assert AppleScript contents + user-string escaping,
 *   • verify mutations are audited,
 *   • verify `delete` refuses without an escalation gate and is blocked
 *     when the user declines the gate.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/proactivity/audit.js";
import {
  MacNotesDriver,
  type EscalationGate,
} from "../src/apps/notes-driver.js";

function makeMockExec(out: string | ((args: readonly string[]) => string)) {
  const calls: { args: readonly string[] }[] = [];
  const fn = async (_f: string, args: readonly string[]) => {
    const stdout = typeof out === "function" ? out(args) : out;
    calls.push({ args });
    return { stdout, stderr: "" };
  };
  return { fn: fn as unknown as (typeof import("node:child_process"))["execFile"], calls };
}

function fakeGate(accept: boolean): EscalationGate {
  return {
    async requestConfirmation() {
      return accept;
    },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "notes-audit-"));
});

describe("MacNotesDriver.append", () => {
  test("creates-or-updates and audits", async () => {
    const { fn, calls } = makeMockExec("ICNT-abc\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacNotesDriver({ execFileFn: fn, audit });

    const res = await driver.append("My Note", 'line with "quotes"', {
      folder: "Personal",
    });
    assert.equal(res.noteId, "ICNT-abc");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /tell application "Notes"/);
    assert.match(script, /"Personal"/);
    // user-provided double-quote in body must be escaped
    assert.match(script, /line with \\\"quotes\\\"/);

    const body = readFileSync(auditPath, "utf-8");
    assert.match(body, /"app_mutation"/);
    assert.match(body, /notes\.append/);
  });

  test("uses default folder when none provided", async () => {
    const { fn, calls } = makeMockExec("ICNT-z\n");
    const driver = new MacNotesDriver({ execFileFn: fn });
    await driver.append("T", "B");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /default folder/);
  });
});

describe("MacNotesDriver.create", () => {
  test("runs AppleScript with escaped title and body", async () => {
    const { fn, calls } = makeMockExec("ICNT-1\n");
    const driver = new MacNotesDriver({ execFileFn: fn });
    const res = await driver.create(`tit "x"`, `body \\ok`);
    assert.equal(res.noteId, "ICNT-1");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /"tit \\"x\\""/);
    assert.match(script, /"body \\\\ok"/);
  });
});

describe("MacNotesDriver.search", () => {
  test("parses id/title/snippet/mod-date rows", async () => {
    const mod = new Date("2025-04-01T12:00:00Z").toISOString();
    const out = `N1\tFoo\tsnippet here\t${mod}\nN2\tBar\tother\t${mod}\n`;
    const { fn } = makeMockExec(out);
    const driver = new MacNotesDriver({ execFileFn: fn });
    const hits = await driver.search("x", 10);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.id, "N1");
    assert.equal(hits[0]?.title, "Foo");
    assert.equal(hits[0]?.snippet, "snippet here");
  });
});

describe("MacNotesDriver.delete", () => {
  test("rejects without gate", async () => {
    const { fn } = makeMockExec("ok\n");
    const driver = new MacNotesDriver({ execFileFn: fn });
    await assert.rejects(() => driver.delete("N1"), /escalation gate required/);
  });

  test("rejects when user declines escalation", async () => {
    const { fn } = makeMockExec("ok\n");
    const driver = new MacNotesDriver({ execFileFn: fn, gate: fakeGate(false) });
    await assert.rejects(() => driver.delete("N1"), /declined/);
  });

  test("proceeds + audits when gate approves", async () => {
    const { fn, calls } = makeMockExec("ok\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacNotesDriver({
      execFileFn: fn,
      audit,
      gate: fakeGate(true),
    });
    await driver.delete("N1");
    assert.equal(calls.length, 1);
    const body = readFileSync(auditPath, "utf-8");
    assert.match(body, /notes\.delete/);
  });
});

process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});
