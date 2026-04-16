/**
 * Mail.app driver — Phase 12 Native App Drivers (§4).
 *
 * Drives the macOS Mail app via AppleScript (`osascript -e`). All user-supplied
 * strings are escaped through {@link quoteAS} before being concatenated into
 * the AppleScript source; execFile is invoked with an arg array (never a
 * shell string) to eliminate shell-injection.
 *
 * Mutations (compose / send / reply / archive / flag) are written to an
 * AuditLog so the user can retroactively audit exactly what cortexOS did.
 * Irreversible actions (send) are gated at the MCP layer by an escalation —
 * this driver never unilaterally transmits a draft.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AuditLog } from "../proactivity/audit.js";
import { quoteASInner as quoteAS } from "./applescript-util.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Escape helper — re-export from shared module                       */
/* ------------------------------------------------------------------ */

export { quoteAS };

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface MailComposeOpts {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

export interface MailSearchHit {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  ts: string;
}

export interface MailDriver {
  compose(opts: MailComposeOpts): Promise<{ draftId: string }>;
  send(draftId: string): Promise<{ messageId?: string }>;
  reply(messageId: string, body: string): Promise<{ draftId: string }>;
  search(query: string, limit?: number): Promise<MailSearchHit[]>;
  unreadCount(): Promise<number>;
  archive(messageId: string): Promise<void>;
  flag(messageId: string, on: boolean): Promise<void>;
}

export interface MailDriverDeps {
  audit?: AuditLog;
  /** Test hook — overrides the promisified execFile. */
  execFileFn?: typeof execFile;
}

/* ------------------------------------------------------------------ */
/*  Driver implementation                                              */
/* ------------------------------------------------------------------ */

class MailDriverImpl implements MailDriver {
  private readonly exec: typeof execFile;
  private readonly audit: AuditLog | undefined;

  constructor(deps?: MailDriverDeps) {
    this.exec = deps?.execFileFn ?? execFile;
    this.audit = deps?.audit;
  }

  async compose(opts: MailComposeOpts): Promise<{ draftId: string }> {
    const to = Array.isArray(opts.to) ? opts.to : [opts.to];
    const cc = opts.cc ?? [];
    const bcc = opts.bcc ?? [];

    const script = [
      `tell application "Mail"`,
      `  set newMsg to make new outgoing message with properties {subject:"${quoteAS(opts.subject)}", content:"${quoteAS(opts.body)}", visible:false}`,
      `  tell newMsg`,
      ...to.map(
        (addr) =>
          `    make new to recipient at end of to recipients with properties {address:"${quoteAS(addr)}"}`,
      ),
      ...cc.map(
        (addr) =>
          `    make new cc recipient at end of cc recipients with properties {address:"${quoteAS(addr)}"}`,
      ),
      ...bcc.map(
        (addr) =>
          `    make new bcc recipient at end of bcc recipients with properties {address:"${quoteAS(addr)}"}`,
      ),
      `  end tell`,
      `  return id of newMsg as string`,
      `end tell`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    const draftId = stdout.trim();
    this.logAudit(
      `mail.compose to=${to.join(",")} subject="${opts.subject}" draftId=${draftId}`,
    );
    return { draftId };
  }

  async send(draftId: string): Promise<{ messageId?: string }> {
    const script = [
      `tell application "Mail"`,
      `  set target to first outgoing message whose id is "${quoteAS(draftId)}"`,
      `  send target`,
      `end tell`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    const messageId = stdout.trim() || undefined;
    this.logAudit(`mail.send draftId=${draftId} messageId=${messageId ?? "?"}`);
    return messageId ? { messageId } : {};
  }

  async reply(messageId: string, body: string): Promise<{ draftId: string }> {
    const script = [
      `tell application "Mail"`,
      `  set origMsg to first message of inbox whose message id is "${quoteAS(messageId)}"`,
      `  set replyMsg to reply origMsg opening window no`,
      `  set content of replyMsg to "${quoteAS(body)}"`,
      `  return id of replyMsg as string`,
      `end tell`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    const draftId = stdout.trim();
    this.logAudit(`mail.reply to-messageId=${messageId} draftId=${draftId}`);
    return { draftId };
  }

  async search(query: string, limit = 20): Promise<MailSearchHit[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const script = [
      `set results to {}`,
      `tell application "Mail"`,
      `  set inboxMsgs to (messages of inbox whose (subject contains "${quoteAS(query)}") or (content contains "${quoteAS(query)}"))`,
      `  set n to count of inboxMsgs`,
      `  if n > ${safeLimit} then set n to ${safeLimit}`,
      `  repeat with i from 1 to n`,
      `    set m to item i of inboxMsgs`,
      `    set hitId to (message id of m) as string`,
      `    set hitFrom to (sender of m) as string`,
      `    set hitSubject to (subject of m) as string`,
      `    set hitDate to (date received of m) as string`,
      `    set hitSnippet to ""`,
      `    try`,
      `      set bodyText to content of m as string`,
      `      if (length of bodyText) > 240 then`,
      `        set hitSnippet to text 1 thru 240 of bodyText`,
      `      else`,
      `        set hitSnippet to bodyText`,
      `      end if`,
      `    end try`,
      `    set end of results to hitId & tab & hitFrom & tab & hitSubject & tab & hitDate & tab & hitSnippet`,
      `  end repeat`,
      `end tell`,
      `set AppleScript's text item delimiters to linefeed`,
      `return results as string`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    return parseSearchHits(stdout);
  }

  async unreadCount(): Promise<number> {
    const script = `tell application "Mail" to return unread count of inbox as integer`;
    const { stdout } = await this.exec("osascript", ["-e", script]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  async archive(messageId: string): Promise<void> {
    const script = [
      `tell application "Mail"`,
      `  set m to first message of inbox whose message id is "${quoteAS(messageId)}"`,
      `  set mbox to first mailbox whose name is "Archive"`,
      `  move m to mbox`,
      `end tell`,
    ].join("\n");

    await this.exec("osascript", ["-e", script]);
    this.logAudit(`mail.archive messageId=${messageId}`);
  }

  async flag(messageId: string, on: boolean): Promise<void> {
    const flagIndex = on ? 1 : 0;
    const script = [
      `tell application "Mail"`,
      `  set m to first message of inbox whose message id is "${quoteAS(messageId)}"`,
      `  set flagged status of m to ${on ? "true" : "false"}`,
      `  set flag index of m to ${flagIndex}`,
      `end tell`,
    ].join("\n");

    await this.exec("osascript", ["-e", script]);
    this.logAudit(
      `mail.flag messageId=${messageId} on=${on ? "true" : "false"}`,
    );
  }

  private logAudit(detail: string): void {
    this.audit?.append({
      action: "act_on",
      sensorName: "mail",
      detail,
      ts: new Date(),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseSearchHits(stdout: string): MailSearchHit[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const hits: MailSearchHit[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    hits.push({
      id: parts[0] ?? "",
      from: parts[1] ?? "",
      subject: parts[2] ?? "",
      ts: parts[3] ?? "",
      snippet: parts[4] ?? "",
    });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createMailDriver(deps?: MailDriverDeps): MailDriver {
  return new MailDriverImpl(deps);
}
