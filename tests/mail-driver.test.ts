/**
 * Tests for src/apps/mail-driver.ts — Phase 12a.
 *
 * The real driver shells out to `osascript`. Every test here injects a fake
 * `execFileFn` so we can assert the script bodies without touching Mail.app,
 * and so suites run in CI / linux.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMailDriver,
  quoteAS,
  type MailDriver,
} from "../src/apps/mail-driver.js";
import { AuditLog } from "../src/proactivity/audit.js";

/* ------------------------------------------------------------------ */
/*  Fake execFile                                                      */
/* ------------------------------------------------------------------ */

interface ExecCall {
  file: string;
  args: readonly string[];
}

type FakeExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

function makeFakeExec(
  responder: (script: string) => { stdout?: string; stderr?: string } | string,
): { calls: ExecCall[]; fn: FakeExecFn } {
  const calls: ExecCall[] = [];
  const fn: FakeExecFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    const script = args[1] ?? "";
    const out = responder(script);
    if (typeof out === "string") return { stdout: out, stderr: "" };
    return { stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };
  return { calls, fn };
}

/* ------------------------------------------------------------------ */
/*  quoteAS                                                            */
/* ------------------------------------------------------------------ */

describe("quoteAS", () => {
  it("doubles embedded double-quotes (AppleScript escape)", () => {
    assert.equal(quoteAS(`hi "bob"`), `hi \\"bob\\"`);
  });

  it("escapes backslashes", () => {
    assert.equal(quoteAS(`path\\to\\file`), `path\\\\to\\\\file`);
  });

  it("strips newlines and carriage returns (flattens to space)", () => {
    assert.equal(quoteAS("line1\nline2"), "line1 line2");
    assert.equal(quoteAS("line1\r\nline2"), "line1 line2");
    assert.equal(quoteAS("a\n\n\nb"), "a b");
  });

  it("combines all escapes together", () => {
    assert.equal(
      quoteAS(`say "hi"\nand\\stuff`),
      `say \\"hi\\" and\\\\stuff`,
    );
  });

  it("returns empty for empty input", () => {
    assert.equal(quoteAS(""), "");
  });

  it("leaves plain ASCII alone", () => {
    assert.equal(quoteAS("Hello, Joel!"), "Hello, Joel!");
  });
});

/* ------------------------------------------------------------------ */
/*  Driver harness                                                     */
/* ------------------------------------------------------------------ */

interface Harness {
  driver: MailDriver;
  calls: ExecCall[];
  audit: AuditLog;
  logPath: string;
  tmpDir: string;
}

function buildHarness(
  responder: (script: string) => string = () => "draft-42",
): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "cortex-mail-"));
  const logPath = join(tmpDir, "audit.ndjson");
  const audit = new AuditLog(logPath);
  const { calls, fn } = makeFakeExec(responder);
  const driver = createMailDriver({
    audit,
    // FakeExecFn matches the shape expected by the driver's
    // `execFileFn` — a promisified `execFile` returning {stdout,stderr}.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execFileFn: fn as any,
  });
  return { driver, calls, audit, logPath, tmpDir };
}

function readAuditDetails(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { detail: string; action: string; sensorName?: string })
    .filter((r) => r.action === "act_on" && r.sensorName === "mail")
    .map((r) => r.detail);
}

/* ------------------------------------------------------------------ */
/*  compose                                                            */
/* ------------------------------------------------------------------ */

describe("MailDriver.compose", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness(() => "new-draft-id-1");
  });

  it("emits an AppleScript that creates an outgoing message with subject + body + recipients", async () => {
    const { draftId } = await h.driver.compose({
      to: "bob@example.com",
      subject: "Hi",
      body: "hello",
    });
    assert.equal(draftId, "new-draft-id-1");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].file, "osascript");
    assert.equal(h.calls[0].args[0], "-e");
    const script = h.calls[0].args[1];
    assert.match(script, /tell application "Mail"/);
    assert.match(script, /make new outgoing message with properties/);
    assert.match(script, /subject:"Hi"/);
    assert.match(script, /content:"hello"/);
    assert.match(script, /address:"bob@example.com"/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("handles multiple to / cc / bcc recipients", async () => {
    await h.driver.compose({
      to: ["a@x.com", "b@x.com"],
      subject: "Team",
      body: "body",
      cc: ["c@x.com"],
      bcc: ["d@x.com"],
    });
    const s = h.calls[0].args[1];
    assert.match(s, /address:"a@x\.com"/);
    assert.match(s, /address:"b@x\.com"/);
    assert.match(s, /cc recipients with properties \{address:"c@x\.com"\}/);
    assert.match(s, /bcc recipients with properties \{address:"d@x\.com"\}/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("escapes user-supplied strings in subject/body (injection safety)", async () => {
    await h.driver.compose({
      to: "v@x.com",
      subject: `"quoted" subject`,
      body: `line1\nline2\\slash`,
    });
    const s = h.calls[0].args[1];
    // quoted subject should have been doubled via quoteAS
    assert.match(s, /subject:"\\"quoted\\" subject"/);
    // newline flattened and backslash doubled
    assert.match(s, /content:"line1 line2\\\\slash"/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("appends an audit entry on successful compose", async () => {
    await h.driver.compose({
      to: "b@x.com",
      subject: "Hello",
      body: "World",
    });
    const details = readAuditDetails(h.logPath);
    assert.equal(details.length, 1);
    assert.match(details[0], /mail\.compose/);
    assert.match(details[0], /to=b@x\.com/);
    assert.match(details[0], /subject="Hello"/);
    assert.match(details[0], /draftId=new-draft-id-1/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/*  send                                                               */
/* ------------------------------------------------------------------ */

describe("MailDriver.send", () => {
  it("emits `send target` and audits with draftId", async () => {
    const h = buildHarness(() => "");
    await h.driver.send("draft-77");
    const s = h.calls[0].args[1];
    assert.match(s, /tell application "Mail"/);
    assert.match(s, /set target to first outgoing message whose id is "draft-77"/);
    assert.match(s, /send target/);
    const details = readAuditDetails(h.logPath);
    assert.equal(details.length, 1);
    assert.match(details[0], /mail\.send draftId=draft-77/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("returns messageId when osascript prints one", async () => {
    const h = buildHarness(() => "msg-id-xyz");
    const res = await h.driver.send("d1");
    assert.deepEqual(res, { messageId: "msg-id-xyz" });
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when stdout is empty", async () => {
    const h = buildHarness(() => "");
    const res = await h.driver.send("d1");
    assert.deepEqual(res, {});
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/*  reply                                                              */
/* ------------------------------------------------------------------ */

describe("MailDriver.reply", () => {
  it("calls `reply` on the original message and returns draftId", async () => {
    const h = buildHarness(() => "reply-draft-1");
    const { draftId } = await h.driver.reply("orig-id", "thanks!");
    assert.equal(draftId, "reply-draft-1");
    const s = h.calls[0].args[1];
    assert.match(s, /set origMsg to first message of inbox whose message id is "orig-id"/);
    assert.match(s, /set replyMsg to reply origMsg opening window no/);
    assert.match(s, /set content of replyMsg to "thanks!"/);

    const details = readAuditDetails(h.logPath);
    assert.equal(details.length, 1);
    assert.match(details[0], /mail\.reply to-messageId=orig-id draftId=reply-draft-1/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("escapes user-supplied reply body", async () => {
    const h = buildHarness(() => "r1");
    await h.driver.reply("m1", `"quoted"\nnewline`);
    const s = h.calls[0].args[1];
    assert.match(s, /set content of replyMsg to "\\"quoted\\" newline"/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/*  search                                                             */
/* ------------------------------------------------------------------ */

describe("MailDriver.search", () => {
  it("parses tab-separated rows from stdout into hits", async () => {
    const canned =
      "id1\tAlice\tRe: ping\t2026-04-15\tsome snippet\n" +
      "id2\tBob\tHello\t2026-04-14\tbody\n";
    const h = buildHarness(() => canned);
    const hits = await h.driver.search("q");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].id, "id1");
    assert.equal(hits[0].from, "Alice");
    assert.equal(hits[0].subject, "Re: ping");
    assert.equal(hits[0].ts, "2026-04-15");
    assert.equal(hits[0].snippet, "some snippet");
    assert.equal(hits[1].id, "id2");
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("clamps limit to [1,200] and escapes query", async () => {
    const h = buildHarness(() => "");
    await h.driver.search(`evil"quote`, 9999);
    const s = h.calls[0].args[1];
    // Clamped to 200
    assert.match(s, /if n > 200 then set n to 200/);
    // Escaped quote survives as a doubled quote
    assert.match(s, /contains "evil\\"quote"/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("uses default limit=20 when omitted", async () => {
    const h = buildHarness(() => "");
    await h.driver.search("x");
    const s = h.calls[0].args[1];
    assert.match(s, /if n > 20 then set n to 20/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("does NOT log an audit entry for read-only search", async () => {
    const h = buildHarness(() => "");
    await h.driver.search("hello");
    assert.equal(readAuditDetails(h.logPath).length, 0);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/*  unreadCount                                                        */
/* ------------------------------------------------------------------ */

describe("MailDriver.unreadCount", () => {
  it("parses an integer", async () => {
    const h = buildHarness(() => "42");
    assert.equal(await h.driver.unreadCount(), 42);
    const s = h.calls[0].args[1];
    assert.match(s, /unread count of inbox as integer/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("returns 0 on non-numeric output", async () => {
    const h = buildHarness(() => "not a number");
    assert.equal(await h.driver.unreadCount(), 0);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/*  archive / flag                                                     */
/* ------------------------------------------------------------------ */

describe("MailDriver.archive", () => {
  it("moves message into Archive mailbox and audits", async () => {
    const h = buildHarness(() => "");
    await h.driver.archive("mid-1");
    const s = h.calls[0].args[1];
    assert.match(s, /first message of inbox whose message id is "mid-1"/);
    assert.match(s, /first mailbox whose name is "Archive"/);
    assert.match(s, /move m to mbox/);
    const details = readAuditDetails(h.logPath);
    assert.deepEqual(details, ["mail.archive messageId=mid-1"]);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});

describe("MailDriver.flag", () => {
  it("sets flagged status=true when on", async () => {
    const h = buildHarness(() => "");
    await h.driver.flag("mid-7", true);
    const s = h.calls[0].args[1];
    assert.match(s, /set flagged status of m to true/);
    assert.match(s, /set flag index of m to 1/);
    const details = readAuditDetails(h.logPath);
    assert.deepEqual(details, ["mail.flag messageId=mid-7 on=true"]);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("sets flagged status=false when off", async () => {
    const h = buildHarness(() => "");
    await h.driver.flag("mid-7", false);
    const s = h.calls[0].args[1];
    assert.match(s, /set flagged status of m to false/);
    assert.match(s, /set flag index of m to 0/);
    rmSync(h.tmpDir, { recursive: true, force: true });
  });
});
