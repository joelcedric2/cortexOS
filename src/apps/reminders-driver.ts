/**
 * Reminders driver — Phase 12 (§4 app drivers).
 *
 * Reaches Reminders.app via `osascript` (AppleScript). All AppleScript
 * goes through `execFile("osascript", [...])` with argv (never shell).
 * User strings are escaped with {@link quoteAS}. `add`, `complete` are
 * mutations that audit. `remove` is irreversible-ish (moves to a per-list
 * deleted bucket that auto-empties) and therefore requires the injected
 * {@link EscalationGate} to confirm before proceeding.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AuditLog } from "../proactivity/audit.js";
import { quoteAS } from "./safari-driver.js";
import type { EscalationGate } from "./notes-driver.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export type ReminderPriority = 0 | 1 | 5 | 9;

export interface AddReminderOptions {
  title: string;
  dueAt?: Date;
  list?: string;
  notes?: string;
  priority?: ReminderPriority;
}

export interface AddReminderResult { reminderId: string }

export interface ReminderHit {
  id: string;
  title: string;
  dueAt?: Date;
  completed: boolean;
  priority: ReminderPriority;
}

export interface RemindersDriver {
  add(opts: AddReminderOptions): Promise<AddReminderResult>;
  complete(reminderId: string): Promise<void>;
  list(listName?: string): Promise<ReminderHit[]>;
  /** Irreversible — requires escalation gate. */
  remove(reminderId: string): Promise<void>;
}

export interface RemindersDriverDeps {
  execFileFn?: typeof execFile;
  audit?: AuditLog;
  gate?: EscalationGate;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Encode a Date as an AppleScript `date "..."` literal. */
function dateLiteral(d: Date): string {
  // AppleScript tolerates the ISO-ish form `"Monday, April 15, 2026 at 5:00:00 PM"`
  // but also accepts locale-independent "YYYY-MM-DD HH:MM:SS". We use the latter.
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const s =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `(current date) + 0 -- will be replaced by remote_date\n  set remote_date to date ${quoteAS(s)}`;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

export class MacRemindersDriver implements RemindersDriver {
  private readonly execFileFn: typeof execFile;
  private readonly audit: AuditLog | undefined;
  private readonly gate: EscalationGate | undefined;

  constructor(deps: RemindersDriverDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.audit = deps.audit;
    this.gate = deps.gate;
  }

  async add(opts: AddReminderOptions): Promise<AddReminderResult> {
    if (!opts.title) throw new Error("reminders.add: title required");
    const list = opts.list ?? "";
    const priority: ReminderPriority = opts.priority ?? 0;

    const props: string[] = [`name:${quoteAS(opts.title)}`];
    if (opts.notes) props.push(`body:${quoteAS(opts.notes)}`);
    props.push(`priority:${priority}`);
    if (opts.dueAt) {
      // we'll set remote_date inline in the script; body references it
      props.push(`due date:remote_date`);
    }

    const script =
      `tell application "Reminders"\n` +
      (opts.dueAt ? `  ${dateLiteral(opts.dueAt)}\n` : ``) +
      (list
        ? `  set theList to list ${quoteAS(list)}\n`
        : `  set theList to default list\n`) +
      `  set r to make new reminder at theList with properties {${props.join(", ")}}\n` +
      `  return id of r as text\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    const reminderId = String(stdout).trim();
    this.auditMut("reminders.add", {
      title: opts.title,
      list,
      priority,
      hasDue: Boolean(opts.dueAt),
    });
    return { reminderId };
  }

  async complete(reminderId: string): Promise<void> {
    if (!reminderId) throw new Error("reminders.complete: id required");
    const script =
      `tell application "Reminders"\n` +
      `  repeat with r in reminders\n` +
      `    if (id of r as text) is equal to ${quoteAS(reminderId)} then\n` +
      `      set completed of r to true\n` +
      `      return "ok"\n` +
      `    end if\n` +
      `  end repeat\n` +
      `  return "not-found"\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("reminders.complete", { reminderId });
  }

  async list(listName?: string): Promise<ReminderHit[]> {
    const script =
      `tell application "Reminders"\n` +
      (listName
        ? `  set src to reminders of list ${quoteAS(listName)}\n`
        : `  set src to reminders\n`) +
      `  set out to ""\n` +
      `  repeat with r in src\n` +
      `    set tt to name of r as text\n` +
      `    set cc to completed of r\n` +
      `    set pp to priority of r as text\n` +
      `    set dd to ""\n` +
      `    try\n` +
      `      set dd to (due date of r as «class isot» as string)\n` +
      `    end try\n` +
      `    set out to out & (id of r as text) & \"\\t\" & tt & \"\\t\" & dd & \"\\t\" & cc & \"\\t\" & pp & \"\\n\"\n` +
      `  end repeat\n` +
      `  return out\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    return String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((line) => {
        const [id = "", title = "", due = "", completed = "false", pp = "0"] =
          line.split("\t");
        const priority = (Number.parseInt(pp, 10) as ReminderPriority) || 0;
        const hit: ReminderHit = {
          id,
          title,
          completed: completed === "true",
          priority: [0, 1, 5, 9].includes(priority) ? priority : 0,
        };
        if (due) {
          const ts = new Date(due);
          if (!Number.isNaN(ts.getTime())) hit.dueAt = ts;
        }
        return hit;
      });
  }

  async remove(reminderId: string): Promise<void> {
    if (!reminderId) throw new Error("reminders.remove: id required");
    const gate = this.gate;
    if (!gate) {
      throw new Error(
        "reminders.remove: escalation gate required for irreversible op",
      );
    }
    const approved = await gate.requestConfirmation(
      `Delete reminder ${reminderId}?`,
      { op: "reminders.remove", reminderId },
    );
    if (!approved) {
      throw new Error("reminders.remove: user declined escalation");
    }
    const script =
      `tell application "Reminders"\n` +
      `  repeat with r in reminders\n` +
      `    if (id of r as text) is equal to ${quoteAS(reminderId)} then\n` +
      `      delete r\n` +
      `      return "ok"\n` +
      `    end if\n` +
      `  end repeat\n` +
      `  return "not-found"\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("reminders.remove", { reminderId });
  }

  private auditMut(op: string, detail: Record<string, unknown>): void {
    if (!this.audit) return;
    this.audit.append({
      action: "app_mutation",
      sensorName: "reminders",
      detail: JSON.stringify({ op, ...detail }),
      ts: new Date(),
    });
  }
}
