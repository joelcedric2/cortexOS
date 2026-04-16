/**
 * Coder 3 contract stub — window-manager driver interface.
 *
 * This file is a temporary shim exposing the surface Coder 3 ships on
 * `phase11/yabai-bridge` so Coder 4 can build + test against it today.
 *
 * DELETE this file at integration time once the real
 * `src/window-manager/driver-factory.ts` lands on `main`.
 *
 * Import paths that will survive the switch:
 *   import { selectDriver, type WMDriver } from "../window-manager/driver-factory.js";
 *
 * When integrating, replace every import of this stub with the factory module
 * above (single sed). The WMDriver shape below is pinned to Coder 3's contract.
 */

export interface WMWindow {
  /** macOS window id (yabai) or synthetic id (AppleScript fallback). */
  id: number;
  app: string;
  title: string;
  space: number;
  display?: number;
  frame?: { x: number; y: number; w: number; h: number };
  focused?: boolean;
}

export interface WMSpace {
  index: number;
  label?: string;
  display?: number;
  visible?: boolean;
}

export type WMTileLayout =
  | "bsp"
  | "stack"
  | "float"
  | "grid-2x2"
  | "grid-1x2"
  | "grid-2x1";

export interface WMDriver {
  /** Resolves true when the underlying driver (yabai/applescript) is usable. */
  isAvailable(): Promise<boolean>;
  listWindows(): Promise<WMWindow[]>;
  listSpaces(): Promise<WMSpace[]>;
  focusWindow(windowId: number): Promise<void>;
  moveWindow(
    windowId: number,
    opts: {
      space?: number;
      display?: number;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
    },
  ): Promise<void>;
  tile(layout: WMTileLayout): Promise<void>;
  spaceSwitch(index: number): Promise<void>;
}

/**
 * WMUnavailableError — surfaced by the factory when neither yabai nor
 * AppleScript is usable on the current host. MCP tools convert this to a
 * structured `{ok:false, error:"wm-unavailable"}` response so the caller can
 * degrade gracefully instead of crashing.
 */
export class WMUnavailableError extends Error {
  constructor(message = "window-manager driver unavailable") {
    super(message);
    this.name = "WMUnavailableError";
  }
}

/**
 * Stub selector. In production, Coder 3's driver-factory probes yabai first
 * then AppleScript. Here we throw — tests never reach this path because they
 * inject a fake driver directly.
 */
export async function selectDriver(): Promise<WMDriver> {
  throw new WMUnavailableError(
    "_c3-stub: selectDriver not implemented. Inject a driver in tests, " +
      "or wait for phase11/yabai-bridge to merge.",
  );
}
