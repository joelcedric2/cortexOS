/**
 * Tests for MacFinderDriver (src/apps/finder-driver.ts) + sanitizePath.
 *
 * Covers:
 *   • Directory-traversal rejection (..)
 *   • NUL-byte rejection
 *   • Non-absolute path rejection
 *   • Symlink-escape rejection (simulated via realpathFn)
 *   • Escalation gating on move/rename/trash
 *   • Audit entries on mutations
 *   • Tag input validation
 *   • AppleScript content + quoteAS escaping
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/proactivity/audit.js";
import {
  MacFinderDriver,
  PathSecurityError,
  sanitizePath,
} from "../src/apps/finder-driver.js";
import type { EscalationGate } from "../src/apps/notes-driver.js";

function makeMockExec(out: string | ((args: readonly string[]) => string) = "") {
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

let tmpHome: string;
let auditPath: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "finder-home-"));
  auditPath = join(tmpHome, "audit.ndjson");
});

// ─── sanitizePath ────────────────────────────────────────────────────────

describe("sanitizePath", () => {
  test("rejects empty", () => {
    assert.throws(() => sanitizePath("", { allowedRoot: tmpHome }),
      PathSecurityError);
  });

  test("rejects NUL byte", () => {
    assert.throws(
      () => sanitizePath(`${tmpHome}/a\0b`, { allowedRoot: tmpHome }),
      PathSecurityError,
    );
  });

  test("rejects non-absolute", () => {
    assert.throws(
      () => sanitizePath("relative/path", { allowedRoot: tmpHome }),
      PathSecurityError,
    );
  });

  test("rejects .. segment", () => {
    assert.throws(
      () => sanitizePath(`${tmpHome}/../../etc/passwd`, { allowedRoot: tmpHome }),
      PathSecurityError,
    );
    // also when .. sits deeper in the path
    assert.throws(
      () => sanitizePath(`${tmpHome}/a/b/../../../etc/passwd`, { allowedRoot: tmpHome }),
      PathSecurityError,
    );
  });

  test("rejects realpath outside allowedRoot (symlink escape)", () => {
    const link = join(tmpHome, "escape-link");
    const fakeRealpath = (p: string): string => {
      if (p === link) return "/etc/passwd";
      return p;
    };
    assert.throws(
      () =>
        sanitizePath(link, {
          allowedRoot: tmpHome,
          realpathFn: fakeRealpath,
        }),
      PathSecurityError,
    );
  });

  test("accepts legit path inside allowedRoot", () => {
    const f = join(tmpHome, "ok.txt");
    writeFileSync(f, "x");
    const resolved = sanitizePath(f, {
      allowedRoot: tmpHome,
      realpathFn: (p) => p,
    });
    assert.equal(resolved, f);
  });

  test("skipResolve=true allows any path as long as it's safe", () => {
    const p = join(tmpHome, "maybe-missing", "x.txt");
    const resolved = sanitizePath(p, {
      allowedRoot: tmpHome,
      skipResolve: true,
    });
    assert.equal(resolved, p);
  });
});

// ─── FinderDriver.reveal ───────────────────────────────────────────────

describe("MacFinderDriver.reveal", () => {
  test("rejects NUL + relative", async () => {
    const { fn } = makeMockExec();
    const driver = new MacFinderDriver({ execFileFn: fn, allowedRoot: tmpHome });
    await assert.rejects(() => driver.reveal("relative/x"));
    await assert.rejects(() => driver.reveal(`${tmpHome}/a\0b`));
  });

  test("allows a path outside allowedRoot (read-only op)", async () => {
    const { fn, calls } = makeMockExec();
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
    });
    await driver.reveal("/Applications/Music.app");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /reveal POSIX file "\/Applications\/Music\.app"/);
  });
});

// ─── FinderDriver.move ──────────────────────────────────────────────────

describe("MacFinderDriver.move", () => {
  test("rejects when path escapes root (symlink)", async () => {
    const { fn } = makeMockExec();
    const realpathFn = (p: string): string =>
      p === join(tmpHome, "bad") ? "/etc/passwd" : p;
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      gate: fakeGate(true),
      realpathFn,
    });
    await assert.rejects(
      () => driver.move(join(tmpHome, "bad"), join(tmpHome, "dst")),
      PathSecurityError,
    );
  });

  test("rejects without gate", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn } = makeMockExec();
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      realpathFn: (p) => p,
    });
    await assert.rejects(
      () => driver.move(join(tmpHome, "a"), join(tmpHome, "b")),
      /escalation gate/,
    );
  });

  test("honors user decline on escalation", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn } = makeMockExec();
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      gate: fakeGate(false),
      realpathFn: (p) => p,
    });
    await assert.rejects(
      () => driver.move(join(tmpHome, "a"), join(tmpHome, "b")),
      /declined/,
    );
  });

  test("audits on success", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn, calls } = makeMockExec();
    const audit = new AuditLog(auditPath);
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      gate: fakeGate(true),
      audit,
      realpathFn: (p) => p,
    });
    await driver.move(join(tmpHome, "a"), join(tmpHome, "b"));
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /move POSIX file/);
    const body = readFileSync(auditPath, "utf-8");
    assert.match(body, /finder\.move/);
  });
});

// ─── FinderDriver.rename ────────────────────────────────────────────────

describe("MacFinderDriver.rename", () => {
  test("rejects newName with slash or NUL", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn } = makeMockExec();
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      gate: fakeGate(true),
      realpathFn: (p) => p,
    });
    await assert.rejects(() => driver.rename(join(tmpHome, "a"), "a/b"));
    await assert.rejects(() => driver.rename(join(tmpHome, "a"), "a\0b"));
    await assert.rejects(() => driver.rename(join(tmpHome, "a"), ""));
  });

  test("succeeds, emits correct AppleScript, audits", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn, calls } = makeMockExec();
    const audit = new AuditLog(auditPath);
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      gate: fakeGate(true),
      audit,
      realpathFn: (p) => p,
    });
    await driver.rename(join(tmpHome, "a"), `renamed "z".txt`);
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /set name of/);
    assert.match(script, /"renamed \\"z\\"\.txt"/);
    assert.match(readFileSync(auditPath, "utf-8"), /finder\.rename/);
  });
});

// ─── FinderDriver.tag + listTags ────────────────────────────────────────

describe("MacFinderDriver.tag / listTags", () => {
  test("tag rejects bad inputs", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn } = makeMockExec();
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      realpathFn: (p) => p,
    });
    await assert.rejects(
      // @ts-expect-error deliberate bad type
      () => driver.tag(join(tmpHome, "a"), "not-array"),
      /array/,
    );
    await assert.rejects(
      () => driver.tag(join(tmpHome, "a"), ["ok", "bad\0tag"]),
      PathSecurityError,
    );
  });

  test("tag emits AppleScript list and audits", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn, calls } = makeMockExec();
    const audit = new AuditLog(auditPath);
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      audit,
      realpathFn: (p) => p,
    });
    await driver.tag(join(tmpHome, "a"), ["Work", "Urgent"]);
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /\{"Work", "Urgent"\}/);
    assert.match(readFileSync(auditPath, "utf-8"), /finder\.tag/);
  });

  test("listTags parses newline-separated output", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn } = makeMockExec("Work\nUrgent\n");
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      realpathFn: (p) => p,
    });
    const tags = await driver.listTags(join(tmpHome, "a"));
    assert.deepEqual(tags, ["Work", "Urgent"]);
  });
});

// ─── FinderDriver.trash ─────────────────────────────────────────────────

describe("MacFinderDriver.trash", () => {
  test("requires gate + audits on success", async () => {
    writeFileSync(join(tmpHome, "a"), "1");
    const { fn } = makeMockExec();
    const driverNoGate = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      realpathFn: (p) => p,
    });
    await assert.rejects(
      () => driverNoGate.trash(join(tmpHome, "a")),
      /escalation gate/,
    );

    const audit = new AuditLog(auditPath);
    const driver = new MacFinderDriver({
      execFileFn: fn,
      allowedRoot: tmpHome,
      gate: fakeGate(true),
      audit,
      realpathFn: (p) => p,
    });
    await driver.trash(join(tmpHome, "a"));
    assert.match(readFileSync(auditPath, "utf-8"), /finder\.trash/);
  });
});

process.on("exit", () => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});
