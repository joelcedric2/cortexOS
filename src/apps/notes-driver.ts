/**
 * Notes driver — Phase 12 (§4 app drivers).
 *
 * Reaches Notes.app via `osascript` (AppleScript). All AppleScript goes
 * through `execFile("osascript", [...])` with argv (never shell). User
 * strings are escaped with {@link quoteAS}. Mutations (`append`, `create`,
 * `delete`) append to the injected {@link AuditLog}. `delete` additionally
 * requires an escalation to be raised first (irreversible-ish in the user's
 * mental model — a deleted note drops to the Recently Deleted folder which
 * auto-empties).
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AuditLog } from "../proactivity/audit.js";
import { quoteAS } from "./safari-driver.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface AppendOptions { folder?: string }
export interface CreateOptions { folder?: string }

export interface AppendResult { noteId: string }
export interface CreateResult { noteId: string }

export interface NoteHit {
  id: string;
  title: string;
  snippet: string;
  modifiedAt: Date;
}

export interface NotesDriver {
  append(noteTitle: string, text: string, opts?: AppendOptions): Promise<AppendResult>;
  create(title: string, body: string, opts?: CreateOptions): Promise<CreateResult>;
  search(query: string, limit?: number): Promise<NoteHit[]>;
  /** Always requires escalation-confirmed. */
  delete(noteId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

export interface EscalationGate {
  /** Raise an escalation; resolves once the user has confirmed. */
  requestConfirmation(question: string, context: Record<string, unknown>): Promise<boolean>;
}

export interface NotesDriverDeps {
  execFileFn?: typeof execFile;
  audit?: AuditLog;
  /** Gate for irreversible mutations (delete). */
  gate?: EscalationGate;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

export class MacNotesDriver implements NotesDriver {
  private readonly execFileFn: typeof execFile;
  private readonly audit: AuditLog | undefined;
  private readonly gate: EscalationGate | undefined;

  constructor(deps: NotesDriverDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.audit = deps.audit;
    this.gate = deps.gate;
  }

  async append(
    noteTitle: string,
    text: string,
    opts: AppendOptions = {},
  ): Promise<AppendResult> {
    if (!noteTitle || noteTitle.length === 0) {
      throw new Error("notes.append: title required");
    }
    const folder = opts.folder ?? "";
    const script =
      `tell application "Notes"\n` +
      (folder
        ? `  set theFolder to folder ${quoteAS(folder)}\n`
        : `  set theFolder to default folder\n`) +
      `  set matches to notes of theFolder whose name is ${quoteAS(noteTitle)}\n` +
      `  if (count of matches) is 0 then\n` +
      `    set n to make new note at theFolder with properties {name:${quoteAS(noteTitle)}, body:${quoteAS(text)}}\n` +
      `  else\n` +
      `    set n to item 1 of matches\n` +
      `    set body of n to ((body of n) & "\\n" & ${quoteAS(text)})\n` +
      `  end if\n` +
      `  return id of n as text\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    const noteId = String(stdout).trim();
    this.auditMut("notes.append", { title: noteTitle, folder });
    return { noteId };
  }

  async create(
    title: string,
    body: string,
    opts: CreateOptions = {},
  ): Promise<CreateResult> {
    if (!title) throw new Error("notes.create: title required");
    const folder = opts.folder ?? "";
    const script =
      `tell application "Notes"\n` +
      (folder
        ? `  set theFolder to folder ${quoteAS(folder)}\n`
        : `  set theFolder to default folder\n`) +
      `  set n to make new note at theFolder with properties {name:${quoteAS(title)}, body:${quoteAS(body)}}\n` +
      `  return id of n as text\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    const noteId = String(stdout).trim();
    this.auditMut("notes.create", { title, folder });
    return { noteId };
  }

  async search(query: string, limit = 20): Promise<NoteHit[]> {
    const clamped = Math.min(Math.max(1, Math.floor(limit)), 200);
    const script =
      `tell application "Notes"\n` +
      `  set out to ""\n` +
      `  set ctr to 0\n` +
      `  repeat with n in notes\n` +
      `    if ctr is greater than or equal to ${clamped} then exit repeat\n` +
      `    set tt to name of n as text\n` +
      `    set bb to plaintext of n as text\n` +
      `    if (tt contains ${quoteAS(query)}) or (bb contains ${quoteAS(query)}) then\n` +
      `      set snip to bb\n` +
      `      if length of snip > 140 then set snip to text 1 thru 140 of snip\n` +
      `      set mt to (modification date of n as «class isot» as string)\n` +
      `      set out to out & (id of n as text) & \"\\t\" & tt & \"\\t\" & snip & \"\\t\" & mt & \"\\n\"\n` +
      `      set ctr to ctr + 1\n` +
      `    end if\n` +
      `  end repeat\n` +
      `  return out\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    return String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((line) => {
        const [id = "", title = "", snippet = "", mod = ""] = line.split("\t");
        const ts = new Date(mod);
        return {
          id,
          title,
          snippet,
          modifiedAt: Number.isNaN(ts.getTime()) ? new Date(0) : ts,
        };
      });
  }

  async delete(noteId: string): Promise<void> {
    if (!noteId) throw new Error("notes.delete: noteId required");
    const gate = this.gate;
    if (!gate) {
      throw new Error("notes.delete: escalation gate required for irreversible op");
    }
    const approved = await gate.requestConfirmation(
      `Delete note ${noteId}?`,
      { op: "notes.delete", noteId },
    );
    if (!approved) {
      throw new Error("notes.delete: user declined escalation");
    }
    const script =
      `tell application "Notes"\n` +
      `  repeat with n in notes\n` +
      `    if (id of n as text) is equal to ${quoteAS(noteId)} then\n` +
      `      delete n\n` +
      `      return "ok"\n` +
      `    end if\n` +
      `  end repeat\n` +
      `  return "not-found"\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("notes.delete", { noteId });
  }

  private auditMut(op: string, detail: Record<string, unknown>): void {
    if (!this.audit) return;
    this.audit.append({
      action: "app_mutation",
      sensorName: "notes",
      detail: JSON.stringify({ op, ...detail }),
      ts: new Date(),
    });
  }
}
