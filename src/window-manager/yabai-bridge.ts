/**
 * yabai driver for Phase 11 window management.
 *
 * Wraps the `yabai` CLI (https://github.com/koekeishiya/yabai) via
 * `execFile`. We NEVER shell out with a composed string — every call is
 * `execFile("yabai", [...argv])` so argument injection through app names,
 * window titles, or space labels is structurally impossible.
 *
 * Scope — the subset of yabai we expose through {@link WMDriver}:
 *   - `yabai -m query --windows` / `--spaces` (JSON output)
 *   - `yabai -m window --focus <id>`
 *   - `yabai -m window <id> --space <n>` / `--display <n>` / `--move/--resize`
 *   - `yabai -m space --layout <layout>` for tiling
 *   - `yabai -m space --focus <index>` for space switching
 *
 * Availability is probed by running `yabai -m query --spaces` — if yabai
 * isn't on PATH or the scripting-addition isn't loaded, the probe fails
 * and the factory falls back to AppleScript.
 */

import { execFile } from "node:child_process";
import type { Layout, LayoutSlot } from "./layouts.js";
import { computeLayout } from "./layouts.js";

// --------------------------- Public types --------------------------------

export interface Window {
  id: number;
  app: string;
  title: string;
  space: number;
  display: number;
  frame: { x: number; y: number; w: number; h: number };
  focused: boolean;
}

export interface Space {
  index: number;
  display: number;
  type: "bsp" | "stack" | "float";
}

export interface MoveTarget {
  space?: number;
  display?: number;
  frame?: Partial<Window["frame"]>;
}

export interface WMDriver {
  isAvailable(): Promise<boolean>;
  listWindows(): Promise<Window[]>;
  listSpaces(): Promise<Space[]>;
  focusWindow(id: number): Promise<void>;
  moveWindow(id: number, to: MoveTarget): Promise<void>;
  tile(layout: Layout): Promise<void>;
  spaceSwitch(index: number): Promise<void>;
}

// --------------------------- Errors --------------------------------------

export class WMUnavailableError extends Error {
  constructor(message = "window-manager driver unavailable") {
    super(message);
    this.name = "WMUnavailableError";
  }
}

export class YabaiCommandError extends Error {
  constructor(
    public readonly argv: readonly string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`yabai ${argv.join(" ")} exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`);
    this.name = "YabaiCommandError";
  }
}

// --------------------------- Execution types ------------------------------

/** Signature for a function that runs a yabai command and returns stdout. */
export type YabaiExec = (args: readonly string[]) => Promise<string>;

/**
 * Map yabai's `space.type` (which may be `bsp|stack|float`) onto our union.
 * Anything unexpected becomes "float" — the safest default for tests and
 * a sensible fallback for user-created custom layouts.
 */
function normaliseSpaceType(raw: unknown): Space["type"] {
  if (raw === "bsp" || raw === "stack" || raw === "float") return raw;
  return "float";
}

// --------------------------- Default exec wrapper -------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const STDOUT_CAP_BYTES = 1 * 1024 * 1024; // 1 MB — yabai JSON can be chatty

/** Run `yabai` with an argv array. No shell interpolation, ever. */
function defaultExec(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "yabai",
      args as string[],
      {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: STDOUT_CAP_BYTES,
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        const stdoutStr =
          typeof stdout === "string" ? stdout : (stdout as Buffer).toString("utf8");
        const stderrStr =
          typeof stderr === "string" ? stderr : (stderr as Buffer).toString("utf8");
        if (err) {
          const exitCode =
            typeof (err as NodeJS.ErrnoException).code === "number"
              ? ((err as unknown as { code: number }).code)
              : 1;
          reject(new YabaiCommandError(args, exitCode, stderrStr));
          return;
        }
        resolve(stdoutStr);
      },
    );
  });
}

// --------------------------- JSON parsing ---------------------------------

/**
 * Parse yabai's `query --windows` output (JSON array of window objects).
 * We validate each field — missing/wrong types throw so we never silently
 * return garbage to callers.
 */
function parseWindows(raw: string): Window[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`yabai --windows: expected JSON array, got ${typeof parsed}`);
  }
  return parsed.map((w, i) => toWindow(w, i));
}

function toWindow(obj: unknown, i: number): Window {
  if (!obj || typeof obj !== "object") {
    throw new Error(`yabai --windows[${i}]: not an object`);
  }
  const o = obj as Record<string, unknown>;
  const frame = o.frame as Record<string, unknown> | undefined;
  if (!frame || typeof frame !== "object") {
    throw new Error(`yabai --windows[${i}]: missing frame`);
  }
  return {
    id: num(o.id, `windows[${i}].id`),
    app: str(o.app, `windows[${i}].app`),
    title: typeof o.title === "string" ? o.title : "",
    space: num(o.space, `windows[${i}].space`),
    display: num(o.display, `windows[${i}].display`),
    frame: {
      x: num(frame.x, `windows[${i}].frame.x`),
      y: num(frame.y, `windows[${i}].frame.y`),
      w: num(frame.w, `windows[${i}].frame.w`),
      h: num(frame.h, `windows[${i}].frame.h`),
    },
    focused: Boolean(o.focused || o["has-focus"] || o["is-focused"]),
  };
}

function parseSpaces(raw: string): Space[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`yabai --spaces: expected JSON array, got ${typeof parsed}`);
  }
  return parsed.map((s, i) => {
    if (!s || typeof s !== "object") {
      throw new Error(`yabai --spaces[${i}]: not an object`);
    }
    const o = s as Record<string, unknown>;
    return {
      index: num(o.index, `spaces[${i}].index`),
      display: num(o.display, `spaces[${i}].display`),
      type: normaliseSpaceType(o.type),
    };
  });
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`yabai ${path}: expected finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw new Error(`yabai ${path}: expected string, got ${JSON.stringify(v)}`);
  }
  return v;
}

// --------------------------- Tile layout mapping --------------------------

/**
 * yabai ships three layouts natively: `bsp`, `stack`, `float`. For our grid
 * presets (`columns-3`, `grid-2x2`, …) we fall back to BSP and manually
 * resize windows into the slots that {@link computeLayout} computes.
 *
 * The caller passes our {@link Layout}; we decide the strategy here.
 */
function yabaiNativeLayout(layout: Layout): "bsp" | "stack" | null {
  switch (layout) {
    case "full":
      return "stack";
    case "vsplit":
    case "hsplit":
      // yabai's bsp auto-splits on insertion; we rely on that for 2 windows.
      return "bsp";
    default:
      return null;
  }
}

// --------------------------- Public factory -------------------------------

/**
 * Build a {@link WMDriver} that drives yabai. Tests inject a fake `exec`;
 * production uses the default `execFile` wrapper above.
 */
export function createYabaiDriver(exec: YabaiExec = defaultExec): WMDriver {
  return new YabaiDriver(exec);
}

class YabaiDriver implements WMDriver {
  constructor(private readonly exec: YabaiExec) {}

  async isAvailable(): Promise<boolean> {
    try {
      // `query --spaces` is cheap and fails fast if yabai isn't running or
      // the scripting-addition isn't loaded.
      await this.exec(["-m", "query", "--spaces"]);
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(): Promise<Window[]> {
    const raw = await this.exec(["-m", "query", "--windows"]);
    return parseWindows(raw);
  }

  async listSpaces(): Promise<Space[]> {
    const raw = await this.exec(["-m", "query", "--spaces"]);
    return parseSpaces(raw);
  }

  async focusWindow(id: number): Promise<void> {
    assertId(id);
    await this.exec(["-m", "window", String(id), "--focus"]);
  }

  async moveWindow(id: number, to: MoveTarget): Promise<void> {
    assertId(id);
    if (to.space !== undefined) {
      assertId(to.space);
      await this.exec(["-m", "window", String(id), "--space", String(to.space)]);
    }
    if (to.display !== undefined) {
      assertId(to.display);
      await this.exec(["-m", "window", String(id), "--display", String(to.display)]);
    }
    if (to.frame) {
      const { x, y, w, h } = to.frame;
      if (x !== undefined && y !== undefined) {
        await this.exec([
          "-m",
          "window",
          String(id),
          "--move",
          `abs:${Math.round(x)}:${Math.round(y)}`,
        ]);
      }
      if (w !== undefined && h !== undefined) {
        await this.exec([
          "-m",
          "window",
          String(id),
          "--resize",
          `abs:${Math.round(w)}:${Math.round(h)}`,
        ]);
      }
    }
  }

  async tile(layout: Layout): Promise<void> {
    const native = yabaiNativeLayout(layout);
    if (native) {
      await this.exec(["-m", "space", "--layout", native]);
      return;
    }
    // Custom grid — switch the space to bsp and manually place windows
    // into the slots computeLayout returns for the current display.
    await this.exec(["-m", "space", "--layout", "bsp"]);
    const [windows, spaces] = await Promise.all([this.listWindows(), this.listSpaces()]);
    const focused = windows.find((w) => w.focused);
    if (!focused) return; // nothing to tile
    const space = spaces.find((s) => s.index === focused.space);
    const displayWindows = windows.filter(
      (w) => w.space === focused.space && (space ? w.display === space.display : true),
    );
    if (displayWindows.length === 0) return;

    const viewport = unionOfFrames(displayWindows.map((w) => w.frame));
    const slots: LayoutSlot[] = computeLayout(layout, viewport, displayWindows.length);
    // Apply sequentially — yabai serialises window ops anyway and this
    // keeps error messages attributable to a specific window id.
    for (let i = 0; i < displayWindows.length; i++) {
      const w = displayWindows[i];
      const s = slots[i];
      await this.moveWindow(w.id, { frame: s });
    }
  }

  async spaceSwitch(index: number): Promise<void> {
    assertId(index);
    await this.exec(["-m", "space", "--focus", String(index)]);
  }
}

function assertId(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`yabai: id/index must be a non-negative integer, got ${n}`);
  }
}

/**
 * Compute the smallest rectangle that contains all given frames. Used as
 * the viewport for grid layouts when the user asks for `grid-2x2` on a
 * space without an explicit display bound.
 */
function unionOfFrames(frames: Window["frame"][]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (frames.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of frames) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.w);
    maxY = Math.max(maxY, f.y + f.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
