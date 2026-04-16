/**
 * Phase 10 — low-level synthetic input actuator.
 *
 * Shells out to the Swift `cortexos-vision input <op>` helper (one
 * invocation per action, arg-array via `execFile` — never a shell string)
 * to synthesize mouse + keyboard events via CoreGraphics. The TS side owns:
 *
 *   - **Bounds clamping**: reject any (x, y) outside the hard-coded
 *     `{0,0..10000,10000}` envelope via `OutOfBoundsError`. Nothing in
 *     macOS has a screen that large; anything else is a bug in the caller
 *     (e.g. a brief placing a coord at -1 or NaN) and must not be silently
 *     clamped into a valid-looking click.
 *   - **Text length cap**: `type(text)` rejects any string longer than
 *     `ACTUATOR_DEFAULTS.maxTypeLength` (10 k chars) so a runaway LLM
 *     can't dump an entire transcript into the keyboard buffer.
 *   - **Audit trail**: when an `AuditLog` is provided, every successful
 *     primitive appends an NDJSON line `{action: 'cu_action', detail}`.
 *
 * Policy gating (irreversible actions, escalation prompts) lives one layer
 * up in `agent-loop.ts`. The actuator itself is "dumb hands": it executes
 * what it's told as long as the inputs are well-formed.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditLog } from "../proactivity/audit.js";

/** Hard-coded tunables. All defaults exported as named consts per DoD. */
export const ACTUATOR_DEFAULTS = {
  /** Inclusive lower bound for x / y. */
  minCoord: 0,
  /** Exclusive-ish upper bound for x / y. No real screen is this big. */
  maxCoord: 10_000,
  /** Hard cap on `type(text)` length. */
  maxTypeLength: 10_000,
  /** Per-child execFile timeout. */
  timeoutMs: 15_000,
} as const;

// ──────────────────────────── Errors ────────────────────────────────────

/** Coordinates fell outside `[0, maxCoord]`. Never clamped — surfaced. */
export class OutOfBoundsError extends Error {
  constructor(public readonly axis: "x" | "y", public readonly value: number) {
    super(
      `Actuator: ${axis}=${value} is outside the allowed range [${ACTUATOR_DEFAULTS.minCoord}, ${ACTUATOR_DEFAULTS.maxCoord}].`,
    );
    this.name = "OutOfBoundsError";
  }
}

/** Text to type exceeded `maxTypeLength`. */
export class TextTooLongError extends Error {
  constructor(public readonly length: number) {
    super(
      `Actuator: type(text) length=${length} exceeds maxTypeLength=${ACTUATOR_DEFAULTS.maxTypeLength}.`,
    );
    this.name = "TextTooLongError";
  }
}

/** Generic failure from the Swift helper — stderr is preserved for debugging. */
export class ActuatorError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "ActuatorError";
  }
}

// ──────────────────────────── Public types ──────────────────────────────

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
}

/** Public contract — what agent-loop / MCP tools consume. */
export interface Actuator {
  click(x: number, y: number, button?: "left" | "right"): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  moveTo(x: number, y: number): Promise<void>;
  type(text: string, delayMs?: number): Promise<void>;
  scroll(x: number, y: number, dy: number, dx?: number): Promise<void>;
  screenshot(): Promise<ScreenshotResult>;
}

/** Injection surface — tests pass a fake bridge. */
export interface NativeBridge {
  run(args: string[]): Promise<string>;
}

export interface CreateActuatorDeps {
  /** Test seam. Production callers let us build one from `binaryPath`. */
  bridge?: NativeBridge;
  /** Optional audit sink. Every action append `{action: 'cu_action', detail}`. */
  audit?: AuditLog;
  /** Override the helper binary path. Default: `~/.cortexos/bin/cortexos-vision`. */
  binaryPath?: string;
  /** Override per-call timeout. Default: 15 s. */
  timeoutMs?: number;
}

// ──────────────────────────── Defaults ──────────────────────────────────

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
              reject(new ActuatorError(err.message, stderrStr.trim()));
              return;
            }
            resolve(stdout ?? "");
          },
        );
      });
    },
  };
}

// ──────────────────────────── Validation ────────────────────────────────

function checkCoord(axis: "x" | "y", v: number): void {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new OutOfBoundsError(axis, v);
  }
  if (v < ACTUATOR_DEFAULTS.minCoord || v > ACTUATOR_DEFAULTS.maxCoord) {
    throw new OutOfBoundsError(axis, v);
  }
}

function checkXY(x: number, y: number): void {
  checkCoord("x", x);
  checkCoord("y", y);
}

// ──────────────────────────── Factory ───────────────────────────────────

/**
 * Build an Actuator. Tests inject a fake `bridge`; production leaves it
 * undefined and we wire a real `execFile` spawner to the Swift helper.
 */
export function createActuator(deps: CreateActuatorDeps = {}): Actuator {
  const binary = deps.binaryPath ?? defaultBinaryPath();
  const timeoutMs = deps.timeoutMs ?? ACTUATOR_DEFAULTS.timeoutMs;
  const bridge = deps.bridge ?? createExecBridge(binary, timeoutMs);
  const audit = deps.audit;

  function recordAudit(detail: string): void {
    if (!audit) return;
    try {
      audit.append({ action: "cu_action", detail, ts: new Date() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Audit is best-effort. A broken sink must not break actuation.
      // We surface the warning but never rethrow.
      console.warn(`[actuator] audit append failed: ${msg}`);
    }
  }

  return {
    async click(x, y, button = "left"): Promise<void> {
      checkXY(x, y);
      if (button !== "left" && button !== "right") {
        throw new ActuatorError(
          `Actuator.click: button must be 'left' or 'right' (got ${String(button)})`,
          "",
        );
      }
      await bridge.run([
        "input",
        "click",
        "--x",
        String(x),
        "--y",
        String(y),
        "--button",
        button,
      ]);
      recordAudit(`click x=${x} y=${y} button=${button}`);
    },

    async doubleClick(x, y): Promise<void> {
      checkXY(x, y);
      await bridge.run([
        "input",
        "double-click",
        "--x",
        String(x),
        "--y",
        String(y),
      ]);
      recordAudit(`double-click x=${x} y=${y}`);
    },

    async moveTo(x, y): Promise<void> {
      checkXY(x, y);
      await bridge.run(["input", "move", "--x", String(x), "--y", String(y)]);
      recordAudit(`move x=${x} y=${y}`);
    },

    async type(text, delayMs): Promise<void> {
      if (typeof text !== "string") {
        throw new ActuatorError(
          `Actuator.type: text must be a string (got ${typeof text})`,
          "",
        );
      }
      if (text.length > ACTUATOR_DEFAULTS.maxTypeLength) {
        throw new TextTooLongError(text.length);
      }
      const args = ["input", "type", "--text", text];
      if (delayMs !== undefined) {
        if (!Number.isInteger(delayMs) || delayMs < 0) {
          throw new ActuatorError(
            `Actuator.type: delayMs must be a non-negative integer (got ${delayMs})`,
            "",
          );
        }
        args.push("--delay-ms", String(delayMs));
      }
      await bridge.run(args);
      recordAudit(`type length=${text.length}`);
    },

    async scroll(x, y, dy, dx = 0): Promise<void> {
      checkXY(x, y);
      if (!Number.isInteger(dy) || !Number.isInteger(dx)) {
        throw new ActuatorError(
          `Actuator.scroll: dy and dx must be integers (got dy=${dy}, dx=${dx})`,
          "",
        );
      }
      await bridge.run([
        "input",
        "scroll",
        "--x",
        String(x),
        "--y",
        String(y),
        "--dy",
        String(dy),
        "--dx",
        String(dx),
      ]);
      recordAudit(`scroll x=${x} y=${y} dy=${dy} dx=${dx}`);
    },

    async screenshot(): Promise<ScreenshotResult> {
      const stdout = await bridge.run(["input", "screenshot"]);
      const raw = parseScreenshotJson(stdout);
      recordAudit(`screenshot path=${raw.path}`);
      return raw;
    },
  };
}

function parseScreenshotJson(stdout: string): ScreenshotResult {
  let obj: unknown;
  try {
    obj = JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ActuatorError(`Actuator.screenshot: invalid JSON from helper: ${msg}`, "");
  }
  if (!obj || typeof obj !== "object") {
    throw new ActuatorError("Actuator.screenshot: helper returned non-object JSON", "");
  }
  const rec = obj as Record<string, unknown>;
  // The Swift CaptureCommand emits `{png_path, width, height, ...}`. We
  // normalise to the TS-ergonomic `path` field the Actuator contract wants.
  const pathRaw = rec.path ?? rec.png_path;
  const width = rec.width;
  const height = rec.height;
  if (typeof pathRaw !== "string" || typeof width !== "number" || typeof height !== "number") {
    throw new ActuatorError(
      "Actuator.screenshot: helper JSON missing path|width|height",
      "",
    );
  }
  return { path: pathRaw, width, height };
}
