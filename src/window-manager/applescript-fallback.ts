/**
 * AppleScript fallback driver for Phase 11 window management.
 *
 * Implements the same {@link WMDriver} contract as {@link createYabaiDriver}
 * but reaches macOS via `osascript` + System Events / Accessibility API.
 * This is the portable option — no yabai install, no scripting-addition —
 * at the cost of a narrower feature set:
 *
 *   - No space switching on modern macOS without yabai/private APIs; we
 *     throw `WMUnavailableError` from `spaceSwitch` and document it.
 *   - Space/display info is approximate; we report space=1, display=1
 *     since Accessibility doesn't expose multi-space mapping reliably.
 *   - `tile()` lays windows out via Accessibility `position`/`size`,
 *     driven by the same pure {@link computeLayout} slot math.
 *
 * All osascript invocations go through `execFile("osascript", [...])` —
 * shell interpolation is structurally impossible. Any user-controlled
 * strings that land in AppleScript source are escaped by {@link quoteAS}.
 */

import { execFile } from "node:child_process";
import type {
  MoveTarget,
  Space,
  WMDriver,
  Window,
} from "./yabai-bridge.js";
import { WMUnavailableError } from "./yabai-bridge.js";
import type { Layout } from "./layouts.js";
import { computeLayout } from "./layouts.js";

// --------------------------- Execution types -----------------------------

/** Signature for a function that runs `osascript` and returns stdout. */
export type OsascriptExec = (args: readonly string[]) => Promise<string>;

// --------------------------- Default exec wrapper ------------------------

const DEFAULT_TIMEOUT_MS = 10_000; // AppleScript is slower than yabai
const STDOUT_CAP_BYTES = 512 * 1024;

function defaultExec(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "osascript",
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
          reject(
            new Error(
              `osascript ${args.join(" ")} exited ${exitCode}: ${stderrStr.trim() || "(no stderr)"}`,
            ),
          );
          return;
        }
        resolve(stdoutStr);
      },
    );
  });
}

// --------------------------- AppleScript quoting -------------------------

/**
 * Escape a string for safe interpolation inside an AppleScript double-quoted
 * literal. Only backslash and double-quote need escaping — and since we pass
 * the entire script to osascript via argv (not shell), we never have to worry
 * about shell metacharacters.
 */
export function quoteAS(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// --------------------------- AppleScript snippets ------------------------

/**
 * List every AX-visible window belonging to any running application.
 * We emit a tab-separated line per window:
 *   <id>\t<app>\t<title>\t<x>\t<y>\t<w>\t<h>
 * Lines whose position/size are missing are skipped (e.g. some system
 * utilities deny AX queries — we don't want to crash on them).
 */
export const LIST_WINDOWS_SCRIPT = [
  "set output to {}",
  "set counter to 0",
  'tell application "System Events"',
  "  repeat with p in (every application process whose visible is true)",
  "    try",
  "      set appName to name of p",
  "      repeat with w in (every window of p)",
  "        try",
  "          set counter to counter + 1",
  "          set wTitle to name of w",
  "          if wTitle is missing value then set wTitle to \"\"",
  "          set posList to position of w",
  "          set sizeList to size of w",
  "          set end of output to (counter as text) & tab & appName & tab & wTitle & tab & (item 1 of posList as text) & tab & (item 2 of posList as text) & tab & (item 1 of sizeList as text) & tab & (item 2 of sizeList as text)",
  "        end try",
  "      end repeat",
  "    end try",
  "  end repeat",
  "end tell",
  'set AppleScript\'s text item delimiters to linefeed',
  "return output as text",
].join("\n");

/**
 * Build a `set position/size of window` script for a single window. We locate
 * the window by `(appName, windowTitle)` because Accessibility doesn't expose
 * stable numeric ids — the id we return from {@link parseWindowList} is a
 * synthetic per-query counter.
 */
export function buildMoveScript(
  app: string,
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  return [
    'tell application "System Events"',
    `  tell process ${quoteAS(app)}`,
    `    set w to first window whose name is ${quoteAS(title)}`,
    `    set position of w to {${Math.round(x)}, ${Math.round(y)}}`,
    `    set size of w to {${Math.round(w)}, ${Math.round(h)}}`,
    "  end tell",
    "end tell",
  ].join("\n");
}

/** Focus a window by (app, title). Best-effort — some apps deny raise. */
export function buildFocusScript(app: string, title: string): string {
  return [
    'tell application "System Events"',
    `  tell process ${quoteAS(app)}`,
    "    set frontmost to true",
    `    perform action "AXRaise" of (first window whose name is ${quoteAS(title)})`,
    "  end tell",
    "end tell",
  ].join("\n");
}

// --------------------------- Parsers --------------------------------------

interface RawWindowRow {
  id: number;
  app: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parse the tab-separated output of {@link LIST_WINDOWS_SCRIPT}. Invalid
 * rows (wrong column count, non-numeric coords) are skipped rather than
 * thrown — AppleScript's error handling is best-effort.
 */
export function parseWindowList(raw: string): RawWindowRow[] {
  const rows: RawWindowRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length !== 7) continue;
    const [idS, app, title, xS, yS, wS, hS] = parts;
    const id = Number(idS);
    const x = Number(xS);
    const y = Number(yS);
    const w = Number(wS);
    const h = Number(hS);
    if (
      !Number.isFinite(id) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h)
    ) {
      continue;
    }
    rows.push({ id, app, title, x, y, w, h });
  }
  return rows;
}

// --------------------------- Factory --------------------------------------

/**
 * Build a {@link WMDriver} that drives macOS windows through osascript.
 * Pass a fake `exec` in tests; default runs `osascript -e <script>`.
 */
export function createAppleScriptDriver(exec: OsascriptExec = defaultExec): WMDriver {
  return new AppleScriptDriver(exec);
}

class AppleScriptDriver implements WMDriver {
  /**
   * Cache the last listWindows() result so follow-up operations
   * (focus/move) can resolve synthetic ids → (app, title) without
   * re-querying System Events every time.
   */
  private lastWindows: RawWindowRow[] = [];

  constructor(private readonly exec: OsascriptExec) {}

  async isAvailable(): Promise<boolean> {
    try {
      // Minimal, non-invasive probe: evaluate `1 + 1`. If osascript is
      // missing or disabled we'll fail here before doing anything useful.
      await this.exec(["-e", "return 1 + 1"]);
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(): Promise<Window[]> {
    const raw = await this.exec(["-e", LIST_WINDOWS_SCRIPT]);
    const rows = parseWindowList(raw);
    this.lastWindows = rows;
    return rows.map((r) => ({
      id: r.id,
      app: r.app,
      title: r.title,
      space: 1, // AX doesn't expose space mapping
      display: 1,
      frame: { x: r.x, y: r.y, w: r.w, h: r.h },
      focused: false, // AX doesn't expose focus uniformly; best-effort.
    }));
  }

  async listSpaces(): Promise<Space[]> {
    // AppleScript cannot enumerate Mission Control spaces reliably on
    // modern macOS. We return a single synthetic space so callers that
    // iterate don't crash.
    return [{ index: 1, display: 1, type: "float" }];
  }

  async focusWindow(id: number): Promise<void> {
    const target = this.resolve(id);
    await this.exec(["-e", buildFocusScript(target.app, target.title)]);
  }

  async moveWindow(id: number, to: MoveTarget): Promise<void> {
    if (to.space !== undefined || to.display !== undefined) {
      // We can't move between spaces/displays without yabai.
      throw new WMUnavailableError(
        "AppleScript driver cannot move windows across spaces or displays",
      );
    }
    if (!to.frame) return;
    const { x, y, w, h } = to.frame;
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      throw new Error("AppleScript moveWindow: frame must include x, y, w, h");
    }
    const target = this.resolve(id);
    await this.exec(["-e", buildMoveScript(target.app, target.title, x, y, w, h)]);
  }

  async tile(layout: Layout): Promise<void> {
    // Refresh the window list so we tile current state, not stale cache.
    const windows = await this.listWindows();
    if (windows.length === 0) return;
    const viewport = unionViewport(windows.map((w) => w.frame));
    const slots = computeLayout(layout, viewport, windows.length);
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const s = slots[i];
      await this.exec([
        "-e",
        buildMoveScript(w.app, w.title, s.x, s.y, s.w, s.h),
      ]);
    }
  }

  async spaceSwitch(_index: number): Promise<void> {
    // Documented limitation: modern macOS reserves space switching for
    // yabai's scripting-addition or private CGS calls. Callers receive
    // WMUnavailableError so the MCP layer can surface a clean error.
    throw new WMUnavailableError(
      "AppleScript driver cannot switch spaces — install yabai for Mission Control control",
    );
  }

  /** Map a synthetic id from the last listWindows() call → (app, title). */
  private resolve(id: number): RawWindowRow {
    const hit = this.lastWindows.find((w) => w.id === id);
    if (!hit) {
      throw new Error(
        `AppleScript driver: window id ${id} unknown — call listWindows() first`,
      );
    }
    return hit;
  }
}

function unionViewport(frames: { x: number; y: number; w: number; h: number }[]): {
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
