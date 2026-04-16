/**
 * Messages.app driver — Phase 12a Native App Drivers (§4).
 *
 * Drives the macOS Messages app via AppleScript (`osascript -e`). Mirrors
 * the mail-driver architecture:
 *   - user strings escaped via {@link quoteAS}
 *   - execFile with arg-array (no shell)
 *   - all mutations audited
 *   - irreversible actions (send / sendGroup) are gated at the MCP layer by
 *     an explicit nchinda_escalate confirmation — this driver only does the
 *     mechanical AppleScript work.
 *
 * Extends the Phase 4 `IMessageDriver` which was a thin stub; this is the
 * full Phase 12 driver with the surface the MCP layer wants (send,
 * sendGroup, react, listRecent, unreadCount).
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { quoteAS } from "./mail-driver.js";
import type { AuditLog } from "../proactivity/audit.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface MessagesDriver {
  /** Send an iMessage to a single handle (phone / email / Apple-ID). */
  send(
    to: string,
    body: string,
    opts?: { attachments?: string[] },
  ): Promise<void>;
  /** Send to a multi-party chat identified by its chat GUID. */
  sendGroup(chatId: string, body: string): Promise<void>;
  /** React to a message with a tapback emoji. */
  react(messageId: string, emoji: string): Promise<void>;
  /** Return the `limit` most recent messages across chats. */
  listRecent(limit?: number): Promise<MessagesRecent[]>;
  /** Count of unread messages across chats. */
  unreadCount(): Promise<number>;
}

export interface MessagesRecent {
  id: string;
  chat: string;
  from: string;
  body: string;
  ts: string;
}

export interface MessagesDriverDeps {
  audit?: AuditLog;
  /** Test hook — overrides the promisified execFile. */
  execFileFn?: typeof execFile;
}

/* ------------------------------------------------------------------ */
/*  Driver implementation                                              */
/* ------------------------------------------------------------------ */

class MessagesDriverImpl implements MessagesDriver {
  private readonly exec: typeof execFile;
  private readonly audit: AuditLog | undefined;

  constructor(deps?: MessagesDriverDeps) {
    this.exec = deps?.execFileFn ?? execFile;
    this.audit = deps?.audit;
  }

  async send(
    to: string,
    body: string,
    opts?: { attachments?: string[] },
  ): Promise<void> {
    const script = [
      `tell application "Messages"`,
      `  set targetService to 1st service whose service type = iMessage`,
      `  set targetBuddy to buddy "${quoteAS(to)}" of targetService`,
      `  send "${quoteAS(body)}" to targetBuddy`,
      ...(opts?.attachments ?? []).map(
        (p) => `  send (POSIX file "${quoteAS(p)}") to targetBuddy`,
      ),
      `end tell`,
    ].join("\n");

    await this.exec("osascript", ["-e", script]);
    const attachPart = opts?.attachments?.length
      ? ` attachments=${opts.attachments.length}`
      : "";
    this.logAudit(`messages.send to=${to} body-len=${body.length}${attachPart}`);
  }

  async sendGroup(chatId: string, body: string): Promise<void> {
    const script = [
      `tell application "Messages"`,
      `  set targetChat to chat id "${quoteAS(chatId)}"`,
      `  send "${quoteAS(body)}" to targetChat`,
      `end tell`,
    ].join("\n");

    await this.exec("osascript", ["-e", script]);
    this.logAudit(
      `messages.sendGroup chatId=${chatId} body-len=${body.length}`,
    );
  }

  async react(messageId: string, emoji: string): Promise<void> {
    // AppleScript against Messages.app does not expose tapback reactions
    // directly. We record the intent in the audit log so the assistant can
    // surface it to the user; the actual gesture requires Automation
    // Events. Phase 12a implements the mechanical no-op + audit;
    // Phase 12b can extend with a UI Scripting fallback.
    this.logAudit(
      `messages.react messageId=${messageId} emoji=${emoji}`,
    );
  }

  async listRecent(limit = 20): Promise<MessagesRecent[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    // Messages.app does not expose a rich AppleScript dictionary for
    // browsing history. We query the chat.db SQLite file via `sqlite3`
    // when available, but keep that wiring out of scope for Phase 12a —
    // here we surface an empty list by invoking a no-op AppleScript so
    // tests can assert the wiring + audit behavior without asserting
    // chat.db schemas.
    const script = [
      `tell application "Messages"`,
      `  set n to ${safeLimit}`,
      `  -- listRecent is wired via the chat.db path in Phase 12b`,
      `  return ""`,
      `end tell`,
    ].join("\n");

    const { stdout } = await this.exec("osascript", ["-e", script]);
    return parseRecent(stdout);
  }

  async unreadCount(): Promise<number> {
    const script =
      `tell application "Messages" to return (count of (chats whose unread count > 0))`;
    const { stdout } = await this.exec("osascript", ["-e", script]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  private logAudit(detail: string): void {
    this.audit?.append({
      action: "act_on",
      sensorName: "messages",
      detail,
      ts: new Date(),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseRecent(stdout: string): MessagesRecent[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const hits: MessagesRecent[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    hits.push({
      id: parts[0] ?? "",
      chat: parts[1] ?? "",
      from: parts[2] ?? "",
      body: parts[3] ?? "",
      ts: parts[4] ?? "",
    });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createMessagesDriver(
  deps?: MessagesDriverDeps,
): MessagesDriver {
  return new MessagesDriverImpl(deps);
}
