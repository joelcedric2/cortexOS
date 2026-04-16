/**
 * Finder driver — Phase 12 (§4 app drivers).
 *
 * Drives Finder.app via `osascript`. Paths are the highest-risk surface in
 * the content-half of Phase 12 — directory traversal, NUL injection, and
 * symlink escapes can all turn an innocent-looking "rename" into
 * arbitrary-file-mutation. Mitigations:
 *
 *   • {@link sanitizePath}: reject paths containing `..`, NUL bytes,
 *     non-absolute paths, or those that `fs.realpathSync.native` resolves
 *     outside $HOME (configurable). Applied to every mutating op's inputs.
 *     `reveal` is non-mutating and only rejects NUL / non-absolute.
 *   • Irreversible mutations (`move`, `rename`, `trash`) require an
 *     {@link EscalationGate} to confirm before firing.
 *   • Every mutation is audited with the fully-resolved path so an audit
 *     reader can spot anything fishy after the fact.
 *
 * We never `exec(...)` with a shell string — AppleScript goes through
 * `execFile("osascript", [...])` and user paths are quoted with quoteAS.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, normalize, sep } from "node:path";
import type { AuditLog } from "../proactivity/audit.js";
import { quoteAS } from "./safari-driver.js";
import type { EscalationGate } from "./notes-driver.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface FinderDriver {
  /** Non-mutating: opens a Finder window with the file selected. */
  reveal(path: string): Promise<void>;
  /** Requires escalation. */
  move(from: string, to: string): Promise<void>;
  /** Requires escalation. */
  rename(path: string, newName: string): Promise<void>;
  /** Mutation but reversible — audits, no escalation required. */
  tag(path: string, tags: string[]): Promise<void>;
  listTags(path: string): Promise<string[]>;
  /** Requires escalation — macOS Trash auto-empties after 30 days by default. */
  trash(path: string): Promise<void>;
}

export interface FinderDriverDeps {
  execFileFn?: typeof execFile;
  audit?: AuditLog;
  gate?: EscalationGate;
  /** Override the directory that mutating paths must stay beneath. */
  allowedRoot?: string;
  /** Override realpath resolution (tests — lets us simulate symlinks). */
  realpathFn?: (p: string) => string;
}

/* ------------------------------------------------------------------ */
/*  Path sanitisation                                                  */
/* ------------------------------------------------------------------ */

export class PathSecurityError extends Error {
  constructor(reason: string, path: string) {
    super(`path-security: ${reason} (path=${path})`);
    this.name = "PathSecurityError";
  }
}

export interface SanitizeOptions {
  allowedRoot?: string;
  /** When true, skip realpath (symlink) resolution — used for reveal(). */
  skipResolve?: boolean;
  realpathFn?: (p: string) => string;
}

/**
 * Validate a user-supplied path. Throws {@link PathSecurityError} on any
 * of: NUL byte, non-absolute, `..` traversal, or (when `skipResolve` is
 * false) realpath lying outside `allowedRoot`.
 *
 * Returns the resolved absolute path (with symlinks resolved unless
 * `skipResolve=true`).
 */
export function sanitizePath(
  input: string,
  opts: SanitizeOptions = {},
): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathSecurityError("empty-path", input);
  }
  if (input.includes("\0")) {
    throw new PathSecurityError("nul-byte", input);
  }
  if (!isAbsolute(input)) {
    throw new PathSecurityError("not-absolute", input);
  }
  // Check BOTH the raw input AND the normalised form — this catches the
  // `/Users/a/../../etc/passwd` attack (normalize() collapses it but the
  // original still carries the intent signal the user wrote). We always
  // reject any literal `..` segment in the raw input.
  const segments = input.split(sep);
  if (segments.some((s) => s === "..")) {
    throw new PathSecurityError("dotdot-segment", input);
  }
  const normalised = normalize(input);
  if (normalised !== resolve(normalised)) {
    // Extremely defensive — should already be caught by the dotdot check.
    throw new PathSecurityError("non-canonical", input);
  }

  if (opts.skipResolve) {
    return normalised;
  }

  const allowedRoot = opts.allowedRoot ?? homedir();
  const rp = opts.realpathFn ?? realpathSync;
  let resolved: string;
  try {
    resolved = rp(normalised);
  } catch (err) {
    // Might not exist yet (e.g. rename destination). Fall back to the
    // normalised path — still containment-checked below.
    resolved = normalised;
    void err;
  }
  const rootResolved = (() => {
    try {
      return rp(allowedRoot);
    } catch {
      return allowedRoot;
    }
  })();

  if (!isUnder(resolved, rootResolved)) {
    throw new PathSecurityError("escapes-allowed-root", input);
  }
  return resolved;
}

function isUnder(candidate: string, root: string): boolean {
  const normCand = normalize(candidate);
  const normRoot = normalize(root);
  if (normCand === normRoot) return true;
  const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
  return normCand.startsWith(prefix);
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

export class MacFinderDriver implements FinderDriver {
  private readonly execFileFn: typeof execFile;
  private readonly audit: AuditLog | undefined;
  private readonly gate: EscalationGate | undefined;
  private readonly allowedRoot: string;
  private readonly realpathFn: ((p: string) => string) | undefined;

  constructor(deps: FinderDriverDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.audit = deps.audit;
    this.gate = deps.gate;
    this.allowedRoot = deps.allowedRoot ?? homedir();
    this.realpathFn = deps.realpathFn;
  }

  async reveal(path: string): Promise<void> {
    // reveal() is non-mutating so we only block NUL + non-absolute.
    this.checkLightweight(path);
    const script =
      `tell application "Finder"\n` +
      `  reveal POSIX file ${quoteAS(path)}\n` +
      `  activate\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
  }

  async move(from: string, to: string): Promise<void> {
    const safeFrom = this.sanitize(from);
    const safeTo = this.sanitize(to);
    await this.gateOrThrow(`Move ${safeFrom} → ${safeTo}?`, {
      op: "finder.move",
      from: safeFrom,
      to: safeTo,
    });
    const script =
      `tell application "Finder"\n` +
      `  move POSIX file ${quoteAS(safeFrom)} to POSIX file ${quoteAS(safeTo)}\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("finder.move", { from: safeFrom, to: safeTo });
  }

  async rename(path: string, newName: string): Promise<void> {
    const safe = this.sanitize(path);
    if (!newName || newName.includes("/") || newName.includes("\0")) {
      throw new PathSecurityError("invalid-new-name", newName);
    }
    await this.gateOrThrow(`Rename ${safe} → ${newName}?`, {
      op: "finder.rename",
      path: safe,
      newName,
    });
    const script =
      `tell application "Finder"\n` +
      `  set name of (POSIX file ${quoteAS(safe)} as alias) to ${quoteAS(newName)}\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("finder.rename", { path: safe, newName });
  }

  async tag(path: string, tags: string[]): Promise<void> {
    const safe = this.sanitize(path);
    if (!Array.isArray(tags)) {
      throw new Error("finder.tag: tags must be an array");
    }
    const cleanTags = tags.map((t) => {
      if (typeof t !== "string" || t.includes("\0")) {
        throw new PathSecurityError("bad-tag", String(t));
      }
      return t;
    });
    const listLiteral = `{${cleanTags.map(quoteAS).join(", ")}}`;
    const script =
      `tell application "Finder"\n` +
      `  set the_tags to ${listLiteral}\n` +
      `  tell (POSIX file ${quoteAS(safe)} as alias) to set its tags to the_tags\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("finder.tag", { path: safe, tags: cleanTags });
  }

  async listTags(path: string): Promise<string[]> {
    // listTags is read-only but we still containment-check — we don't want
    // to shell out to an arbitrary symlink target even to read.
    const safe = this.sanitize(path);
    const script =
      `tell application "Finder"\n` +
      `  set tlist to tags of (POSIX file ${quoteAS(safe)} as alias)\n` +
      `  set out to ""\n` +
      `  repeat with t in tlist\n` +
      `    set out to out & (t as text) & \"\\n\"\n` +
      `  end repeat\n` +
      `  return out\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    return String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async trash(path: string): Promise<void> {
    const safe = this.sanitize(path);
    await this.gateOrThrow(`Move ${safe} to Trash?`, {
      op: "finder.trash",
      path: safe,
    });
    const script =
      `tell application "Finder"\n` +
      `  delete (POSIX file ${quoteAS(safe)} as alias)\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("finder.trash", { path: safe });
  }

  // ------------------------------------------------------------------
  //  Internals
  // ------------------------------------------------------------------

  private sanitize(path: string): string {
    const opts: SanitizeOptions = { allowedRoot: this.allowedRoot };
    if (this.realpathFn) opts.realpathFn = this.realpathFn;
    return sanitizePath(path, opts);
  }

  private checkLightweight(path: string): void {
    if (typeof path !== "string" || path.length === 0) {
      throw new PathSecurityError("empty-path", path);
    }
    if (path.includes("\0")) {
      throw new PathSecurityError("nul-byte", path);
    }
    if (!isAbsolute(path)) {
      throw new PathSecurityError("not-absolute", path);
    }
  }

  private async gateOrThrow(
    question: string,
    ctx: Record<string, unknown>,
  ): Promise<void> {
    const gate = this.gate;
    if (!gate) {
      throw new Error(
        `${String(ctx.op ?? "finder")}: escalation gate required for irreversible op`,
      );
    }
    const approved = await gate.requestConfirmation(question, ctx);
    if (!approved) {
      throw new Error(
        `${String(ctx.op ?? "finder")}: user declined escalation`,
      );
    }
  }

  private auditMut(op: string, detail: Record<string, unknown>): void {
    if (!this.audit) return;
    this.audit.append({
      action: "app_mutation",
      sensorName: "finder",
      detail: JSON.stringify({ op, ...detail }),
      ts: new Date(),
    });
  }
}
