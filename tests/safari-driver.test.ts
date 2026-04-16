/**
 * Tests for MacSafariDriver (src/apps/safari-driver.ts).
 *
 * Mocks execFile(osascript, …) so we can assert the driver:
 *   • wires the expected AppleScript literals (URLs, tab ids, etc.),
 *   • escapes user strings correctly,
 *   • appends audit entries for mutations,
 *   • hits the SQLite path only for searchHistory.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/proactivity/audit.js";
import {
  MacSafariDriver,
  quoteAS,
  type SqliteQueryFn,
} from "../src/apps/safari-driver.js";

interface ExecCall {
  file: string;
  args: readonly string[];
  stdout: string;
}

function makeMockExec(script: (args: readonly string[]) => string) {
  const calls: ExecCall[] = [];
  const fn = async (
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    const out = script(args);
    calls.push({ file, args, stdout: out });
    return { stdout: out, stderr: "" };
  };
  // cast: this matches the shape promisified(execFile) is expected to return
  return { fn: fn as unknown as (typeof import("node:child_process"))["execFile"], calls };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "safari-audit-"));
});

describe("quoteAS", () => {
  test("escapes backslash and quotes; wraps in double quotes", () => {
    assert.equal(quoteAS("hi"), `"hi"`);
    assert.equal(quoteAS(`say "hi"`), `"say \\"hi\\""`);
    assert.equal(quoteAS(`back\\slash`), `"back\\\\slash"`);
  });
});

describe("MacSafariDriver.openTab", () => {
  test("rejects non-http(s) urls", async () => {
    const { fn } = makeMockExec(() => "");
    const driver = new MacSafariDriver({ execFileFn: fn });
    await assert.rejects(() => driver.openTab("javascript:alert(1)"));
  });

  test("runs AppleScript containing the url, audits, returns tabId", async () => {
    const { fn, calls } = makeMockExec(() => "tab-42\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacSafariDriver({ execFileFn: fn, audit });

    const res = await driver.openTab("https://example.com/x");
    assert.equal(res.tabId, "tab-42");
    assert.equal(calls.length, 1);
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /tell application "Safari"/);
    assert.match(script, /https:\/\/example\.com\/x/);
  });
});

describe("MacSafariDriver.readCurrentTab", () => {
  test("parses url/title/reader-text tab-separated", async () => {
    const { fn } = makeMockExec(
      () => "https://ex.com\tTitle\tSome reader body text.\n",
    );
    const driver = new MacSafariDriver({ execFileFn: fn });
    const res = await driver.readCurrentTab();
    assert.equal(res.url, "https://ex.com");
    assert.equal(res.title, "Title");
    assert.equal(res.readerText, "Some reader body text.");
  });

  test("omits readerText when empty", async () => {
    const { fn } = makeMockExec(() => "https://ex.com\tT\t\n");
    const driver = new MacSafariDriver({ execFileFn: fn });
    const res = await driver.readCurrentTab();
    assert.equal(res.readerText, undefined);
  });
});

describe("MacSafariDriver.listTabs", () => {
  test("parses tab list", async () => {
    const { fn } = makeMockExec(
      () =>
        "1\thttps://a\tA\t1\n" +
        "2\thttps://b\tB\t1\n" +
        "3\thttps://c\tC\t2\n",
    );
    const driver = new MacSafariDriver({ execFileFn: fn });
    const tabs = await driver.listTabs();
    assert.equal(tabs.length, 3);
    assert.deepEqual(tabs[0], { id: "1", url: "https://a", title: "A", window: 1 });
    assert.equal(tabs[2]?.window, 2);
  });
});

describe("MacSafariDriver.closeTab", () => {
  test("rejects malformed tab id", async () => {
    const { fn } = makeMockExec(() => "");
    const driver = new MacSafariDriver({ execFileFn: fn });
    await assert.rejects(() => driver.closeTab("bad id with spaces"));
  });

  test("audits on success", async () => {
    const { fn } = makeMockExec(() => "ok\n");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacSafariDriver({ execFileFn: fn, audit });
    await driver.closeTab("tab-7");
    const body = await import("node:fs").then((m) =>
      m.readFileSync(auditPath, "utf-8"),
    );
    assert.match(body, /app_mutation/);
    assert.match(body, /safari\.closeTab/);
    assert.match(body, /tab-7/);
  });
});

describe("MacSafariDriver.listBookmarks", () => {
  test("parses bookmark list with folder", async () => {
    const { fn } = makeMockExec(
      () => "https://a\tA\tWork\nhttps://b\tB\t\n",
    );
    const driver = new MacSafariDriver({ execFileFn: fn });
    const bms = await driver.listBookmarks();
    assert.equal(bms.length, 2);
    assert.equal(bms[0]?.folder, "Work");
    assert.equal(bms[1]?.folder, undefined);
  });
});

describe("MacSafariDriver.searchHistory", () => {
  test("returns [] when no sqliteQuery injected", async () => {
    const { fn } = makeMockExec(() => "");
    const driver = new MacSafariDriver({ execFileFn: fn });
    const hits = await driver.searchHistory("claude");
    assert.deepEqual(hits, []);
  });

  test("returns [] when history db missing", async () => {
    const { fn } = makeMockExec(() => "");
    const sqliteQuery: SqliteQueryFn = async () => [{ url: "x", title: "y", visit_time: 0 }];
    const driver = new MacSafariDriver({
      execFileFn: fn,
      sqliteQuery,
      historyDbPath: join(tmp, "nope.db"),
    });
    const hits = await driver.searchHistory("claude");
    assert.deepEqual(hits, []);
  });

  test("decodes Safari CFAbsoluteTime to a Date", async () => {
    const dbPath = join(tmp, "History.db");
    writeFileSync(dbPath, "");
    let sawSql = "";
    let sawParams: ReadonlyArray<string | number> = [];
    const sqliteQuery: SqliteQueryFn = async (_p, sql, params) => {
      sawSql = sql;
      sawParams = params;
      // 2001-01-01 00:00:00 UTC → epoch 978307200
      return [{ url: "https://x", title: "X", visit_time: 1000 }];
    };
    const { fn } = makeMockExec(() => "");
    const driver = new MacSafariDriver({
      execFileFn: fn,
      sqliteQuery,
      historyDbPath: dbPath,
    });
    const hits = await driver.searchHistory("xyz", 5);
    assert.match(sawSql, /LIKE \? ESCAPE/);
    assert.equal(sawParams.length, 3);
    assert.equal(sawParams[2], 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.url, "https://x");
    // 978307200 + 1000 = 978308200 seconds
    assert.equal(hits[0]?.ts.getTime(), 978308200 * 1000);
  });
});

// Cleanup temp dirs after file completes
process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});
