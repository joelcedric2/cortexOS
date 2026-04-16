/**
 * Phase 10 — accessibility bridge.
 *
 * Thin TS wrapper over the Swift `cortexos-vision ax find/findAll`
 * subcommand. Shells via execFile (arg-array) and parses the resulting
 * JSON envelope:
 *
 *   find    → `{role, label, bbox, pid}` or `{match: 'none'}`
 *   findAll → `{matches: [ ... ]}`
 *
 * Both helpers resolve to a typed `AXElement | AXElement[]` with a null
 * return for the empty-match case on `findElement`. AX permission failures
 * bubble up as an `AXPermissionDeniedError` so callers can prompt the
 * user to trust the helper under Privacy & Security → Accessibility.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { NativeBridge } from "./actuator.js";

/** Hard-coded knobs. Exposed as a named const per DoD. */
export const ACCESSIBILITY_DEFAULTS = {
  timeoutMs: 15_000,
} as const;

// ──────────────────────────── Types ─────────────────────────────────────

export interface AXBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AXElement {
  role: string;
  label: string;
  bbox: AXBBox;
  pid: number;
}

export interface AXQuery {
  /** Required: AX role (e.g. "AXButton", "AXTextField"). */
  role: string;
  /** Optional label substring filter (case-insensitive on the Swift side). */
  label?: string;
  /** Optional bundle id to scope the walk (e.g. "com.apple.Safari"). */
  app?: string;
}

export interface AccessibilityDeps {
  bridge?: NativeBridge;
  binaryPath?: string;
  timeoutMs?: number;
}

// ──────────────────────────── Errors ────────────────────────────────────

/** Helper reports the process is not trusted under System Settings. */
export class AXPermissionDeniedError extends Error {
  constructor() {
    super(
      "Accessibility permission denied. Trust the cortexos-vision helper under System Settings → Privacy & Security → Accessibility.",
    );
    this.name = "AXPermissionDeniedError";
  }
}

/** Generic failure from the helper. Stderr is preserved for debugging. */
export class AccessibilityError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "AccessibilityError";
  }
}

// ──────────────────────────── Bridge wiring ─────────────────────────────

function defaultBinaryPath(): string {
  return join(homedir(), ".cortexos", "bin", "cortexos-vision");
}

function createExecBridge(binary: string, timeoutMs: number): NativeBridge {
  return {
    run(args: string[]): Promise<string> {
      return new Promise((resolve, reject) => {
        execFile(
          binary,
          args,
          { timeout: timeoutMs, encoding: "utf8" },
          (err, stdout, stderr) => {
            const stderrStr = stderr ?? "";
            if (err) {
              if (stderrStr.includes("permission-denied")) {
                reject(new AXPermissionDeniedError());
                return;
              }
              reject(new AccessibilityError(err.message, stderrStr.trim()));
              return;
            }
            resolve(stdout ?? "");
          },
        );
      });
    },
  };
}

function resolveBridge(deps: AccessibilityDeps): NativeBridge {
  if (deps.bridge) return deps.bridge;
  const binary = deps.binaryPath ?? defaultBinaryPath();
  const timeoutMs = deps.timeoutMs ?? ACCESSIBILITY_DEFAULTS.timeoutMs;
  return createExecBridge(binary, timeoutMs);
}

// ──────────────────────────── Args builder ──────────────────────────────

function buildArgs(op: "find" | "findAll", query: AXQuery): string[] {
  if (!query.role || typeof query.role !== "string") {
    throw new AccessibilityError("AXQuery.role is required", "");
  }
  const args = ["ax", op, "--role", query.role];
  if (query.label !== undefined) {
    args.push("--label", query.label);
  }
  if (query.app !== undefined) {
    args.push("--app", query.app);
  }
  return args;
}

// ──────────────────────────── Parsing ───────────────────────────────────

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AccessibilityError(`ax: invalid JSON from helper: ${msg}`, "");
  }
}

function isAXElement(v: unknown): v is AXElement {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.role !== "string") return false;
  if (typeof rec.label !== "string") return false;
  if (typeof rec.pid !== "number") return false;
  const b = rec.bbox;
  if (!b || typeof b !== "object") return false;
  const bb = b as Record<string, unknown>;
  return (
    typeof bb.x === "number" &&
    typeof bb.y === "number" &&
    typeof bb.w === "number" &&
    typeof bb.h === "number"
  );
}

// ──────────────────────────── Public API ────────────────────────────────

/**
 * Find the first AX element matching `query`. Returns `null` when the
 * helper reports `{match: 'none'}`.
 */
export async function findElement(
  query: AXQuery,
  deps: AccessibilityDeps = {},
): Promise<AXElement | null> {
  const bridge = resolveBridge(deps);
  const stdout = await bridge.run(buildArgs("find", query));
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== "object") {
    throw new AccessibilityError("ax find: non-object JSON from helper", "");
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.match === "none") return null;
  if (!isAXElement(parsed)) {
    throw new AccessibilityError("ax find: helper returned malformed element", "");
  }
  return parsed;
}

/**
 * Find all AX elements matching `query`. Returns `[]` on empty results.
 * Note: the Swift side filters by role only — label is ignored on findAll
 * because the caller typically wants a broader enumeration.
 */
export async function findAll(
  query: AXQuery,
  deps: AccessibilityDeps = {},
): Promise<AXElement[]> {
  const bridge = resolveBridge(deps);
  const stdout = await bridge.run(buildArgs("findAll", query));
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== "object") {
    throw new AccessibilityError("ax findAll: non-object JSON from helper", "");
  }
  const rec = parsed as Record<string, unknown>;
  const raw = rec.matches;
  if (!Array.isArray(raw)) {
    throw new AccessibilityError("ax findAll: `matches` is not an array", "");
  }
  const out: AXElement[] = [];
  for (const item of raw) {
    if (!isAXElement(item)) {
      throw new AccessibilityError("ax findAll: malformed element in matches", "");
    }
    out.push(item);
  }
  return out;
}
