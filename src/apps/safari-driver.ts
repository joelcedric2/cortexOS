/**
 * Safari driver — Phase 12 (§4 app drivers).
 *
 * Reaches Safari.app via `osascript` (AppleScript) + a read-only SQLite
 * handle on `~/Library/Safari/History.db`. No CDP — Safari doesn't expose
 * one on stock macOS.
 *
 * All AppleScript goes through `execFile("osascript", [...])` with an argv
 * array (never a shell string). User-provided strings that land inside an
 * AppleScript literal are escaped via {@link quoteAS}. Mutations append to
 * the injected {@link AuditLog}; `closeTab` is treated as a mutation but
 * does NOT require escalation (easy to re-open). `readCurrentTab` +
 * `listTabs` + `listBookmarks` + `searchHistory` are read-only.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AuditLog } from "../proactivity/audit.js";

const execFile = promisify(execFileCb);

/** Escape a string for safe interpolation inside an AppleScript double-quoted literal. */
export function quoteAS(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface OpenTabResult { tabId: string }

export interface CurrentTab {
  url: string;
  title: string;
  readerText?: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  window: number;
}

export interface BookmarkEntry {
  url: string;
  title: string;
  folder?: string;
}

export interface HistoryHit {
  url: string;
  title: string;
  ts: Date;
}

export interface SafariDriver {
  openTab(url: string): Promise<OpenTabResult>;
  readCurrentTab(): Promise<CurrentTab>;
  listTabs(): Promise<TabInfo[]>;
  closeTab(tabId: string): Promise<void>;
  listBookmarks(): Promise<BookmarkEntry[]>;
  searchHistory(query: string, limit?: number): Promise<HistoryHit[]>;
}

/* ------------------------------------------------------------------ */
/*  Deps (DI for tests)                                                */
/* ------------------------------------------------------------------ */

/** Read-only SQLite query fn; args are `(dbPath, sql, params)`. */
export type SqliteQueryFn = (
  dbPath: string,
  sql: string,
  params: ReadonlyArray<string | number>,
) => Promise<Array<Record<string, unknown>>>;

export interface SafariDriverDeps {
  execFileFn?: typeof execFile;
  /** Optional SQLite query fn; when absent, {@link searchHistory} returns []. */
  sqliteQuery?: SqliteQueryFn;
  /** Override the on-disk History.db path (tests). */
  historyDbPath?: string;
  /** Append-only audit log. */
  audit?: AuditLog;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_HISTORY_DB = join(
  homedir(),
  "Library",
  "Safari",
  "History.db",
);

export class MacSafariDriver implements SafariDriver {
  private readonly execFileFn: typeof execFile;
  private readonly sqliteQuery: SqliteQueryFn | undefined;
  private readonly historyDbPath: string;
  private readonly audit: AuditLog | undefined;

  constructor(deps: SafariDriverDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.sqliteQuery = deps.sqliteQuery;
    this.historyDbPath = deps.historyDbPath ?? DEFAULT_HISTORY_DB;
    this.audit = deps.audit;
  }

  async openTab(url: string): Promise<OpenTabResult> {
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
      throw new Error(`safari.openTab: unsupported url scheme`);
    }
    const script =
      `tell application "Safari"\n` +
      `  activate\n` +
      `  set newDoc to make new document with properties {URL:${quoteAS(url)}}\n` +
      `  return id of (current tab of front window) as text\n` +
      `end tell`;
    const stdout = await this.run(script);
    this.auditMut("safari.openTab", { url });
    return { tabId: stdout.trim() || "tab-0" };
  }

  async readCurrentTab(): Promise<CurrentTab> {
    const script =
      `tell application "Safari"\n` +
      `  set u to URL of current tab of front window\n` +
      `  set t to name of current tab of front window\n` +
      `  set rt to ""\n` +
      `  try\n` +
      `    set rt to (do JavaScript "document.body.innerText" in current tab of front window)\n` +
      `  end try\n` +
      `  return u & "\t" & t & "\t" & rt\n` +
      `end tell`;
    const stdout = await this.run(script);
    const [url = "", title = "", readerText = ""] = stdout
      .replace(/\n+$/, "")
      .split("\t");
    const result: CurrentTab = { url, title };
    const trimmed = readerText.trim();
    if (trimmed.length > 0) result.readerText = readerText;
    return result;
  }

  async listTabs(): Promise<TabInfo[]> {
    const script =
      `tell application "Safari"\n` +
      `  set out to ""\n` +
      `  set winIdx to 0\n` +
      `  repeat with w in windows\n` +
      `    set winIdx to winIdx + 1\n` +
      `    repeat with t in tabs of w\n` +
      `      set out to out & (id of t as text) & \"\\t\" & (URL of t) & \"\\t\" & (name of t) & \"\\t\" & winIdx & \"\\n\"\n` +
      `    end repeat\n` +
      `  end repeat\n` +
      `  return out\n` +
      `end tell`;
    const stdout = await this.run(script);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id = "", url = "", title = "", winStr = "1"] = line.split("\t");
        return {
          id,
          url,
          title,
          window: Number.parseInt(winStr, 10) || 1,
        };
      });
  }

  async closeTab(tabId: string): Promise<void> {
    if (!/^[-\w.]{1,128}$/.test(tabId)) {
      throw new Error(`safari.closeTab: invalid tabId`);
    }
    const script =
      `tell application "Safari"\n` +
      `  repeat with w in windows\n` +
      `    repeat with t in tabs of w\n` +
      `      if (id of t as text) is equal to ${quoteAS(tabId)} then\n` +
      `        close t\n` +
      `        return "ok"\n` +
      `      end if\n` +
      `    end repeat\n` +
      `  end repeat\n` +
      `  return "not-found"\n` +
      `end tell`;
    await this.run(script);
    this.auditMut("safari.closeTab", { tabId });
  }

  async listBookmarks(): Promise<BookmarkEntry[]> {
    const script =
      `tell application "Safari"\n` +
      `  set out to ""\n` +
      `  try\n` +
      `    repeat with f in bookmark folders\n` +
      `      set folderName to name of f\n` +
      `      repeat with b in bookmarks of f\n` +
      `        set out to out & (URL of b) & \"\\t\" & (name of b) & \"\\t\" & folderName & \"\\n\"\n` +
      `      end repeat\n` +
      `    end repeat\n` +
      `  end try\n` +
      `  return out\n` +
      `end tell`;
    const stdout = await this.run(script);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [url = "", title = "", folder = ""] = line.split("\t");
        const entry: BookmarkEntry = { url, title };
        if (folder) entry.folder = folder;
        return entry;
      });
  }

  async searchHistory(query: string, limit = 20): Promise<HistoryHit[]> {
    if (!this.sqliteQuery) return [];
    if (!existsSync(this.historyDbPath)) return [];
    const clamped = Math.min(Math.max(1, Math.floor(limit)), 200);
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const sql =
      "SELECT i.url AS url, v.title AS title, v.visit_time AS visit_time " +
      "FROM history_items i JOIN history_visits v ON v.history_item = i.id " +
      "WHERE i.url LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\' " +
      "ORDER BY v.visit_time DESC LIMIT ?";
    const rows = await this.sqliteQuery(this.historyDbPath, sql, [
      like,
      like,
      clamped,
    ]);
    return rows.map((r) => {
      // Safari stores visit_time as seconds since 2001-01-01 UTC
      const visitSec = typeof r.visit_time === "number" ? r.visit_time : 0;
      const epochMs = (visitSec + 978307200) * 1000;
      return {
        url: String(r.url ?? ""),
        title: String(r.title ?? ""),
        ts: new Date(epochMs),
      };
    });
  }

  private async run(script: string): Promise<string> {
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    return typeof stdout === "string"
      ? stdout
      : (stdout as Buffer).toString("utf8");
  }

  private auditMut(op: string, detail: Record<string, unknown>): void {
    if (!this.audit) return;
    this.audit.append({
      action: "app_mutation",
      sensorName: "safari",
      detail: JSON.stringify({ op, ...detail }),
      ts: new Date(),
    });
  }
}
