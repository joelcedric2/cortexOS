/**
 * MCP tool handlers for window-manager primitives.
 *
 *   wm_move_window  — relocate / resize a window (space, display, geometry)
 *   wm_tile         — apply a tiling layout (bsp, grid, stack, …)
 *   wm_focus        — raise + activate a window by id
 *   wm_space_switch — jump to a given Mission Control space
 *   wm_list_windows — enumerate visible windows
 *
 * Inputs are validated with zod. When no WMDriver is available (neither yabai
 * nor AppleScript), every tool returns a structured `{ok:false,error:"wm-
 * unavailable"}` response so the caller can degrade gracefully instead of
 * crashing the MCP server.
 *
 * Handlers sit between scripts/mcp/serve-nchinda.mjs and Coder 3's
 * driver-factory; they own validation + error shaping, not the driver itself.
 */
import { z } from "zod";
import {
  selectDriver as defaultSelectDriver,
  WMUnavailableError,
  type WMDriver,
  type Layout as WMTileLayout,
  type Window as WMWindow,
  type Space as WMSpace,
} from "../window-manager/driver-factory.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const MoveWindowSchema = z.object({
  windowId: z.number().int().positive(),
  space: z.number().int().positive().optional(),
  display: z.number().int().positive().optional(),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
});

const TILE_LAYOUTS = [
  "full",
  "vsplit",
  "hsplit",
  "columns-3",
  "columns-4",
  "grid-2x2",
  "grid-3x2",
] as const satisfies readonly WMTileLayout[];

const TileSchema = z.object({
  layout: z.enum(TILE_LAYOUTS),
});

const FocusSchema = z.object({
  windowId: z.number().int().positive(),
});

const SpaceSwitchSchema = z.object({
  index: z.number().int().positive(),
});

const ListWindowsSchema = z.object({}).strict();

export type MoveWindowInput = z.infer<typeof MoveWindowSchema>;
export type TileInput = z.infer<typeof TileSchema>;
export type FocusInput = z.infer<typeof FocusSchema>;
export type SpaceSwitchInput = z.infer<typeof SpaceSwitchSchema>;
export type ListWindowsInput = z.infer<typeof ListWindowsSchema>;

// ─── Result envelopes ────────────────────────────────────────────────────────

export type WMResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: "wm-unavailable" | "invalid-input" | "driver-failure"; message?: string };

export interface MoveWindowResult { windowId: number }
export interface TileResult { layout: WMTileLayout }
export interface FocusResult { windowId: number }
export interface SpaceSwitchResult { index: number }
export interface ListWindowsResult { windows: WMWindow[]; spaces: WMSpace[] }

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface WmToolsDeps {
  /** Inject a pre-selected driver; otherwise the factory is called lazily. */
  driver?: WMDriver;
  /** Override the driver-factory call path (tests). */
  selectDriver?: () => Promise<WMDriver>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class WmTools {
  private readonly injectedDriver?: WMDriver;
  private readonly selectDriver: () => Promise<WMDriver>;
  private resolved?: WMDriver;

  constructor(deps: WmToolsDeps = {}) {
    this.injectedDriver = deps.driver;
    this.selectDriver = deps.selectDriver ?? defaultSelectDriver;
  }

  async moveWindow(
    raw: unknown,
  ): Promise<WMResult<MoveWindowResult>> {
    const parsed = parse(raw, MoveWindowSchema);
    if (!parsed.ok) return parsed.result;
    const { data } = parsed;
    return this.runWithDriver(async (driver) => {
      const frame: { x?: number; y?: number; w?: number; h?: number } = {};
      if (data.x !== undefined) frame.x = data.x;
      if (data.y !== undefined) frame.y = data.y;
      if (data.w !== undefined) frame.w = data.w;
      if (data.h !== undefined) frame.h = data.h;
      await driver.moveWindow(data.windowId, {
        space: data.space,
        display: data.display,
        ...(Object.keys(frame).length > 0 ? { frame } : {}),
      });
      return { ok: true as const, windowId: data.windowId };
    });
  }

  async tile(raw: unknown): Promise<WMResult<TileResult>> {
    const parsed = parse(raw, TileSchema);
    if (!parsed.ok) return parsed.result;
    const { data } = parsed;
    return this.runWithDriver(async (driver) => {
      await driver.tile(data.layout);
      return { ok: true as const, layout: data.layout };
    });
  }

  async focus(raw: unknown): Promise<WMResult<FocusResult>> {
    const parsed = parse(raw, FocusSchema);
    if (!parsed.ok) return parsed.result;
    const { data } = parsed;
    return this.runWithDriver(async (driver) => {
      await driver.focusWindow(data.windowId);
      return { ok: true as const, windowId: data.windowId };
    });
  }

  async spaceSwitch(raw: unknown): Promise<WMResult<SpaceSwitchResult>> {
    const parsed = parse(raw, SpaceSwitchSchema);
    if (!parsed.ok) return parsed.result;
    const { data } = parsed;
    return this.runWithDriver(async (driver) => {
      await driver.spaceSwitch(data.index);
      return { ok: true as const, index: data.index };
    });
  }

  async listWindows(raw: unknown = {}): Promise<WMResult<ListWindowsResult>> {
    const parsed = parse(raw, ListWindowsSchema);
    if (!parsed.ok) return parsed.result;
    return this.runWithDriver(async (driver) => {
      const [windows, spaces] = await Promise.all([
        driver.listWindows(),
        driver.listSpaces(),
      ]);
      return { ok: true as const, windows, spaces };
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async resolveDriver(): Promise<WMDriver> {
    if (this.injectedDriver) return this.injectedDriver;
    if (this.resolved) return this.resolved;
    this.resolved = await this.selectDriver();
    return this.resolved;
  }

  private async runWithDriver<T extends { ok: true }>(
    fn: (driver: WMDriver) => Promise<T>,
  ): Promise<WMResult<Omit<T, "ok">>> {
    let driver: WMDriver;
    try {
      driver = await this.resolveDriver();
    } catch (err) {
      if (err instanceof WMUnavailableError) {
        return { ok: false, error: "wm-unavailable", message: err.message };
      }
      return {
        ok: false,
        error: "driver-failure",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      return await fn(driver);
    } catch (err) {
      if (err instanceof WMUnavailableError) {
        return { ok: false, error: "wm-unavailable", message: err.message };
      }
      return {
        ok: false,
        error: "driver-failure",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── zod parse helper ────────────────────────────────────────────────────────

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; result: WMResult<never> };

function parse<T>(raw: unknown, schema: z.ZodType<T>): ParseResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    result: {
      ok: false,
      error: "invalid-input",
      message: result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    },
  };
}
