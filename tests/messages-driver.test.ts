/**
 * Tests for src/apps/messages-driver.ts — Phase 12a.
 *
 * Injects a fake `execFileFn` so we assert AppleScript contents without
 * touching Messages.app. Audit entries for every mutation are asserted
 * against an on-disk NDJSON log in a tempdir.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessagesDriver,
  type MessagesDriver,
} from "../src/apps/messages-driver.js";
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
  driver: MessagesDriver;
  calls: ExecCall[];
  logPath: string;
  tmpDir: string;
}

function buildHarness(responder: (s: string) => string = () => ""): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "cortex-msg-"));
  const logPath = join(tmpDir, "audit.ndjson");
  const audit = new AuditLog(logPath);
  const { calls, fn } = makeFakeExec(responder);
  const driver = createMessagesDriver({
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
    .filter((r) => r.action === "act_on" && r.sensorName === "messages")
    .map((r) => r.detail);
}

/* ------------------------------------------------------------------ */
/*  send                                                               */
/* ------------------------------------------------------------------ */

describe("MessagesDriver.send", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("emits the expected iMessage send AppleScript", async () => {
    await h.driver.send("+15551234567", "hi");
    assert.equal(h.calls.length, 1);
    const s = h.calls[0].args[1];
    assert.match(s, /tell application "Messages"/);
    assert.match(s, /1st service whose service type = iMessage/);
    assert.match(s, /buddy "\+15551234567"/);
    assert.match(s, /send "hi" to targetBuddy/);
  });

  it("escapes quotes, backslashes, and newlines in body", async () => {
    await h.driver.send("joel@apple.com", `"hey"\nline2\\slash`);
    const s = h.calls[0].args[1];
    assert.match(s, /send "\\"hey\\" line2\\\\slash" to targetBuddy/);
  });

  it("appends attachments as POSIX file sends", async () => {
    await h.driver.send("+1555", "pic!", {
      attachments: ["/tmp/a.png", "/tmp/b.pdf"],
    });
    const s = h.calls[0].args[1];
    assert.match(s, /send \(POSIX file "\/tmp\/a\.png"\) to targetBuddy/);
    assert.match(s, /send \(POSIX file "\/tmp\/b\.pdf"\) to targetBuddy/);
  });

  it("audits with attachment count", async () => {
    await h.driver.send("+1", "yo", { attachments: ["/tmp/x.png"] });
    assert.deepEqual(
      readAuditDetails(h.logPath),
      ["messages.send to=+1 body-len=2 attachments=1"],
    );
  });

  it("audits without attachments when absent", async () => {
    await h.driver.send("bob@x.com", "hello");
    assert.deepEqual(
      readAuditDetails(h.logPath),
      ["messages.send to=bob@x.com body-len=5"],
    );
  });
});

/* ------------------------------------------------------------------ */
/*  sendGroup                                                          */
/* ------------------------------------------------------------------ */

describe("MessagesDriver.sendGroup", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("targets chat id and audits", async () => {
    await h.driver.sendGroup("iMessage;+;chat12345", "team ping");
    const s = h.calls[0].args[1];
    assert.match(s, /set targetChat to chat id "iMessage;\+;chat12345"/);
    assert.match(s, /send "team ping" to targetChat/);
    assert.deepEqual(
      readAuditDetails(h.logPath),
      ["messages.sendGroup chatId=iMessage;+;chat12345 body-len=9"],
    );
  });

  it("escapes quotes in body", async () => {
    await h.driver.sendGroup("c1", `say "hi"`);
    const s = h.calls[0].args[1];
    assert.match(s, /send "say \\"hi\\"" to targetChat/);
  });
});

/* ------------------------------------------------------------------ */
/*  react                                                              */
/* ------------------------------------------------------------------ */

describe("MessagesDriver.react", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("audits the reaction intent", async () => {
    await h.driver.react("msg-1", "❤️");
    assert.deepEqual(
      readAuditDetails(h.logPath),
      ["messages.react messageId=msg-1 emoji=❤️"],
    );
  });
});

/* ------------------------------------------------------------------ */
/*  listRecent                                                         */
/* ------------------------------------------------------------------ */

describe("MessagesDriver.listRecent", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("parses tab-separated rows", async () => {
    const out = "m1\tchatA\tAlice\thi\t2026-04-15\nm2\tchatB\tBob\tyo\t2026-04-14\n";
    rmSync(h.tmpDir, { recursive: true, force: true });
    h = buildHarness(() => out);
    const rows = await h.driver.listRecent();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "m1");
    assert.equal(rows[0].chat, "chatA");
    assert.equal(rows[0].from, "Alice");
    assert.equal(rows[0].body, "hi");
    assert.equal(rows[0].ts, "2026-04-15");
  });

  it("clamps limit and does not audit", async () => {
    await h.driver.listRecent(5000);
    const s = h.calls[0].args[1];
    assert.match(s, /set n to 200/);
    assert.equal(readAuditDetails(h.logPath).length, 0);
  });

  it("returns [] when stdout is empty", async () => {
    const rows = await h.driver.listRecent();
    assert.deepEqual(rows, []);
  });
});

/* ------------------------------------------------------------------ */
/*  unreadCount                                                        */
/* ------------------------------------------------------------------ */

describe("MessagesDriver.unreadCount", () => {
  it("parses an integer", async () => {
    const h = buildHarness(() => "7");
    assert.equal(await h.driver.unreadCount(), 7);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("returns 0 on garbage output", async () => {
    const h = buildHarness(() => "nope");
    assert.equal(await h.driver.unreadCount(), 0);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("queries chats with unread_count > 0", async () => {
    const h = buildHarness(() => "0");
    await h.driver.unreadCount();
    const s = h.calls[0].args[1];
    assert.match(s, /count of \(chats whose unread count > 0\)/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});
