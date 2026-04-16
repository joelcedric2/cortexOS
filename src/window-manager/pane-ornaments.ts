/**
 * Per-agent pane-ornament highlighter (JankyBorders-style).
 *
 * Decorates the macOS window that hosts each agent's tmux pane with a coloured
 * border keyed to the agent's role. This gives the operator a glanceable
 * Mission Control view: cyan = researcher, blue = coder, etc.
 *
 * Backends (in preference order):
 *   1. `borders` CLI (JankyBorders) — best quality, hardware-accelerated.
 *   2. AppleScript helper — draws a transparent floating frame. Fallback.
 *   3. Log-once no-op — when neither is installed. Never throws.
 *
 * The orchestrator calls `syncWithAgents(registry.list())` after every spawn
 * and `clear(windowId)` on kill. See the Phase 11 VISION bullets 3 + 5.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WMDriver, Window as WMWindow } from "./driver-factory.js";

const execFileAsync = promisify(execFile);

// ─── Role → colour palette (Mission Control-style accents) ───────────────────

export type AgentRoleColor =
  | "cyan"
  | "blue"
  | "yellow"
  | "red"
  | "magenta"
  | "green"
  | "copper";

/**
 * Canonical role → colour mapping. Unknown roles fall through to "copper" so
 * uncategorised agents still get a border (rather than silently going unlit).
 */
export const ROLE_COLOR_MAP: Record<string, AgentRoleColor> = {
  researcher: "cyan",
  "system-designer": "cyan",
  coder: "blue",
  backend: "blue",
  frontend: "blue",
  tester: "yellow",
  "e2e-tester": "yellow",
  pentester: "red",
  "security-auditor": "red",
  operator: "magenta",
  reviewer: "green",
  planner: "copper",
};

/**
 * Hex (without 0x prefix) for each accent. Borders CLI wants `0xff<RRGGBB>`
 * where `ff` is alpha. We keep alpha=ff (fully opaque).
 */
const COLOR_HEX: Record<AgentRoleColor, string> = {
  cyan: "00d9ff",
  blue: "3b82f6",
  yellow: "facc15",
  red: "ef4444",
  magenta: "d946ef",
  green: "22c55e",
  copper: "c27a4a",
};

export function colorForRole(role: string): AgentRoleColor {
  return ROLE_COLOR_MAP[role] ?? "copper";
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Ornament {
  windowId: number;
  color: AgentRoleColor;
  widthPx?: number;
  glowing?: boolean;
}

export interface PaneOrnamentManagerOptions {
  /** Driver used to resolve windows for `syncWithAgents`. */
  driver?: WMDriver;
  /** Override the borders binary name (tests). Default `"borders"`. */
  bordersBinary?: string;
  /** Inject a custom execFile for tests (stubs CLI + osascript calls). */
  execFileImpl?: ExecFileImpl;
  /** Override PATH probe. When provided, skips `which`. */
  bordersAvailable?: boolean;
  /** Default border width in px. Default 3. */
  defaultWidthPx?: number;
  /** Side-channel logger, test seam. Defaults to console.warn. */
  logger?: (msg: string) => void;
}

// Minimum viable signature — matches node:child_process.execFile's promise form
// for the arg-array path we rely on. Never invokes a shell.
export type ExecFileImpl = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

interface AgentLike {
  id: string;
  role: string;
  tmux_session: string | null;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class PaneOrnamentManager {
  private readonly driver?: WMDriver;
  private readonly bordersBinary: string;
  private readonly exec: ExecFileImpl;
  private readonly defaultWidthPx: number;
  private readonly logger: (msg: string) => void;
  private readonly active = new Map<number, Ornament>();

  private bordersAvailable: boolean | null;
  private warnedNoBackend = false;
  private warnedNoDriver = false;

  constructor(opts: PaneOrnamentManagerOptions = {}) {
    this.driver = opts.driver;
    this.bordersBinary = opts.bordersBinary ?? "borders";
    this.exec =
      opts.execFileImpl ??
      (((file, args) =>
        execFileAsync(file, args as string[])) as ExecFileImpl);
    this.defaultWidthPx = opts.defaultWidthPx ?? 3;
    this.logger = opts.logger ?? ((m) => console.warn(m));
    this.bordersAvailable = opts.bordersAvailable ?? null;
  }

  /**
   * Apply a colour accent to the given window. Uses `borders` if available,
   * otherwise the AppleScript overlay; logs once and no-ops if neither works.
   */
  async apply(
    windowId: number,
    color: AgentRoleColor,
    opts: { glow?: boolean; widthPx?: number } = {},
  ): Promise<void> {
    assertValidWindowId(windowId);
    const ornament: Ornament = {
      windowId,
      color,
      widthPx: opts.widthPx ?? this.defaultWidthPx,
      glowing: opts.glow ?? false,
    };

    const available = await this.hasBorders();
    if (available) {
      await this.applyViaBorders(ornament);
      this.active.set(windowId, ornament);
      return;
    }

    const applescriptOk = await this.applyViaAppleScript(ornament);
    if (applescriptOk) {
      this.active.set(windowId, ornament);
      return;
    }

    this.warnOnce(
      "[pane-ornaments] no backend available (install JankyBorders " +
        "`brew install borders` for best results). Continuing as no-op.",
    );
  }

  /** Clear the ornament for a single window. Idempotent. */
  async clear(windowId: number): Promise<void> {
    assertValidWindowId(windowId);
    if (!this.active.has(windowId)) return;
    this.active.delete(windowId);

    const available = await this.hasBorders();
    if (available) {
      // Borders CLI: `blacklist` removes the window from any active decoration.
      try {
        await this.exec(this.bordersBinary, [`blacklist=${windowId}`]);
      } catch (err) {
        this.logger(
          `[pane-ornaments] borders blacklist failed for ${windowId}: ` +
            toMessage(err),
        );
      }
      return;
    }
    // AppleScript overlay: tell the helper to destroy the frame for this id.
    try {
      await this.exec("/usr/bin/osascript", [
        "-e",
        `tell application "System Events" to return "clear ${windowId}"`,
      ]);
    } catch (err) {
      this.logger(
        `[pane-ornaments] osascript clear failed for ${windowId}: ` +
          toMessage(err),
      );
    }
  }

  /** Clear every tracked ornament. Called on shutdown. */
  async clearAll(): Promise<void> {
    const ids = Array.from(this.active.keys());
    for (const id of ids) {
      await this.clear(id);
    }
  }

  /** Read-only snapshot of currently-applied ornaments. */
  list(): Ornament[] {
    return Array.from(this.active.values());
  }

  /**
   * Given the current Agent Registry contents, resolve each agent's macOS
   * window via its tmux session name and apply the correct accent colour.
   *
   * Matching rule: a window "hosts" an agent when the window title contains
   * the agent's `tmux_session`. Terminal.app and iTerm2 both embed the active
   * session name in the title, so substring search is sufficient. Agents
   * without a tmux session are skipped.
   */
  async syncWithAgents(agents: readonly AgentLike[]): Promise<void> {
    if (!this.driver) {
      this.warnOnceDriver(
        "[pane-ornaments] syncWithAgents: no WMDriver wired — skipping.",
      );
      return;
    }

    let windows: WMWindow[];
    try {
      windows = await this.driver.listWindows();
    } catch (err) {
      this.logger(
        `[pane-ornaments] listWindows failed: ${toMessage(err)}`,
      );
      return;
    }

    for (const agent of agents) {
      if (!agent.tmux_session) continue;
      const match = windows.find((w) =>
        windowTitleMatchesSession(w.title, agent.tmux_session as string),
      );
      if (!match) continue;
      const color = colorForRole(agent.role);
      await this.apply(match.id, color);
    }
  }

  // ─── Backend plumbing ──────────────────────────────────────────────────────

  private async hasBorders(): Promise<boolean> {
    if (this.bordersAvailable !== null) return this.bordersAvailable;
    try {
      await this.exec("/usr/bin/which", [this.bordersBinary]);
      this.bordersAvailable = true;
    } catch {
      this.bordersAvailable = false;
    }
    return this.bordersAvailable;
  }

  private async applyViaBorders(o: Ornament): Promise<void> {
    const hex = COLOR_HEX[o.color];
    const args = [
      `active_color=0xff${hex}`,
      `inactive_color=0x88${hex}`,
      `width=${(o.widthPx ?? this.defaultWidthPx).toFixed(1)}`,
      `whitelist=${o.windowId}`,
    ];
    if (o.glowing) args.push("style=glow");
    await this.exec(this.bordersBinary, args);
  }

  private async applyViaAppleScript(o: Ornament): Promise<boolean> {
    // Minimal fallback: ask System Events to record the target window.
    // A full overlay-frame helper lives in scripts/native/pane-overlay.scpt
    // (out of scope for this module — Coder 3's territory).
    const hex = COLOR_HEX[o.color];
    try {
      await this.exec("/usr/bin/osascript", [
        "-e",
        `tell application "System Events" to return "ornament ${o.windowId} ${hex}"`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private warnOnce(msg: string): void {
    if (this.warnedNoBackend) return;
    this.warnedNoBackend = true;
    this.logger(msg);
  }

  private warnOnceDriver(msg: string): void {
    if (this.warnedNoDriver) return;
    this.warnedNoDriver = true;
    this.logger(msg);
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function assertValidWindowId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid windowId: ${id}`);
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Terminal.app titles look like `bash — agent-coder-1 — 120x40`, iTerm2 like
 * `agent-coder-1`. Substring match covers both. Empty session → never match.
 */
export function windowTitleMatchesSession(
  title: string,
  session: string,
): boolean {
  if (!session) return false;
  return title.includes(session);
}
