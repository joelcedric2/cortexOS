/**
 * Driver selection for Phase 11 window management.
 *
 * Probes yabai first (richer feature set — space switching, display
 * awareness, native BSP tiling). Falls back to the AppleScript driver
 * if yabai isn't usable on this host. If neither works we return an
 * "unavailable" driver whose every method throws `WMUnavailableError`,
 * so the MCP layer can surface a structured error instead of crashing.
 *
 * The selected driver is cached for the process lifetime — re-probing on
 * every call would be slow (each probe shells out) and pointless (yabai
 * either runs at boot or it doesn't). Tests call `resetDriverCache()`
 * to override.
 */

import type { Layout } from "./layouts.js";
import {
  createYabaiDriver,
  WMUnavailableError,
  type MoveTarget,
  type Space,
  type WMDriver,
  type Window,
} from "./yabai-bridge.js";
import { createAppleScriptDriver } from "./applescript-fallback.js";

// --------------------------- Cache ---------------------------------------

let cached: Promise<WMDriver> | null = null;

/** Clear the cached driver — useful for tests that swap probe behaviour. */
export function resetDriverCache(): void {
  cached = null;
}

// --------------------------- Probe overrides -----------------------------

/**
 * Overrides used exclusively by tests to inject stub drivers instead of
 * probing yabai / osascript. The public API for production callers is
 * {@link selectDriver} with no arguments.
 */
export interface SelectDriverOptions {
  /** Factory for the primary (yabai) driver. */
  yabaiFactory?: () => WMDriver;
  /** Factory for the fallback (AppleScript) driver. */
  appleScriptFactory?: () => WMDriver;
}

// --------------------------- Public API ----------------------------------

/**
 * Probe for a usable driver. Yabai wins if available; otherwise the
 * AppleScript driver takes over. If both probes fail, returns an
 * unavailable driver that throws `WMUnavailableError` from every method.
 *
 * Cached for the process lifetime — subsequent calls return the same
 * Promise (or its resolved value) without re-probing.
 */
export function selectDriver(options: SelectDriverOptions = {}): Promise<WMDriver> {
  if (cached) return cached;
  cached = probeAndSelect(options);
  return cached;
}

async function probeAndSelect(options: SelectDriverOptions): Promise<WMDriver> {
  const yabaiFactory = options.yabaiFactory ?? (() => createYabaiDriver());
  const appleScriptFactory =
    options.appleScriptFactory ?? (() => createAppleScriptDriver());

  const yabai = yabaiFactory();
  if (await safeProbe(yabai)) return yabai;

  const applescript = appleScriptFactory();
  if (await safeProbe(applescript)) return applescript;

  return UNAVAILABLE_DRIVER;
}

/**
 * A driver's `isAvailable()` is allowed to throw — we treat any throw as
 * "not available" so the factory never leaks raw errors to the caller.
 */
async function safeProbe(driver: WMDriver): Promise<boolean> {
  try {
    return await driver.isAvailable();
  } catch {
    return false;
  }
}

// --------------------------- Unavailable driver --------------------------

/**
 * Driver returned when neither yabai nor AppleScript is usable. Every
 * method (except isAvailable) throws WMUnavailableError so the caller can
 * distinguish "WM disabled on this host" from transient failures.
 */
const UNAVAILABLE_DRIVER: WMDriver = {
  async isAvailable(): Promise<boolean> {
    return false;
  },
  async listWindows(): Promise<Window[]> {
    throw new WMUnavailableError("no window-manager driver available");
  },
  async listSpaces(): Promise<Space[]> {
    throw new WMUnavailableError("no window-manager driver available");
  },
  async focusWindow(_id: number): Promise<void> {
    throw new WMUnavailableError("no window-manager driver available");
  },
  async moveWindow(_id: number, _to: MoveTarget): Promise<void> {
    throw new WMUnavailableError("no window-manager driver available");
  },
  async tile(_layout: Layout): Promise<void> {
    throw new WMUnavailableError("no window-manager driver available");
  },
  async spaceSwitch(_index: number): Promise<void> {
    throw new WMUnavailableError("no window-manager driver available");
  },
};

// Re-export the public surface so MCP tools can import everything from
// this single module once integration lands.
export type { MoveTarget, Space, WMDriver, Window } from "./yabai-bridge.js";
export { WMUnavailableError } from "./yabai-bridge.js";
export type { Layout, LayoutSlot, Viewport } from "./layouts.js";
export { computeLayout, layoutCapacity } from "./layouts.js";
