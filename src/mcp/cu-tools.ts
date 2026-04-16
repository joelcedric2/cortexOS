/**
 * Phase 10 — MCP tool handlers for computer-use.
 *
 * Exposes 5 tools over the Nchinda MCP server:
 *   cu_click         — click at (x, y)
 *   cu_type          — type a string
 *   cu_screenshot    — take a fresh shot
 *   cu_find_element  — AX find by role + optional label/app
 *   cu_scroll        — scroll at (x, y) by dy/dx
 *
 * All inputs are zod-parsed at the MCP boundary. The Actuator handles
 * bounds clamping / length caps / audit itself; this layer is the
 * transport adapter. Policy escalation lives in `agent-loop.ts` — the
 * raw MCP tools are unmediated so a planner can compose them as it
 * wishes (typically inside the loop).
 */
import { z } from "zod";
import type { Actuator } from "../computer-use/actuator.js";
import {
  findElement,
  type AccessibilityDeps,
  type AXElement,
} from "../computer-use/accessibility.js";

// ──────────────────────── Input schemas ────────────────────────────────

const CoordSchema = z
  .number()
  .int()
  .min(0)
  .max(10_000);

const CuClickInput = z.object({
  x: CoordSchema,
  y: CoordSchema,
  button: z.enum(["left", "right"]).optional(),
});

const CuTypeInput = z.object({
  text: z.string().min(1).max(10_000),
  delayMs: z.number().int().min(0).max(5_000).optional(),
});

const CuScreenshotInput = z.object({}).optional();

const CuFindElementInput = z.object({
  role: z.string().min(1),
  label: z.string().min(1).optional(),
  app: z.string().min(1).optional(),
});

const CuScrollInput = z.object({
  x: CoordSchema,
  y: CoordSchema,
  dy: z.number().int(),
  dx: z.number().int().optional(),
});

// ──────────────────────── Deps ─────────────────────────────────────────

export interface CuToolsDeps {
  actuator: Actuator;
  /** AX lookups delegate to `findElement`; tests inject a bridge. */
  accessibilityDeps?: AccessibilityDeps;
}

// ──────────────────────── Handler class ────────────────────────────────

export class CuTools {
  constructor(private readonly deps: CuToolsDeps) {}

  async click(raw: unknown): Promise<{ ok: true; x: number; y: number; button: "left" | "right" }> {
    const { x, y, button } = CuClickInput.parse(raw);
    const b = button ?? "left";
    await this.deps.actuator.click(x, y, b);
    return { ok: true, x, y, button: b };
  }

  async type(raw: unknown): Promise<{ ok: true; length: number }> {
    const { text, delayMs } = CuTypeInput.parse(raw);
    await this.deps.actuator.type(text, delayMs);
    return { ok: true, length: text.length };
  }

  async screenshot(
    raw: unknown,
  ): Promise<{ ok: true; path: string; width: number; height: number }> {
    CuScreenshotInput.parse(raw ?? {});
    const shot = await this.deps.actuator.screenshot();
    return { ok: true, ...shot };
  }

  async findElement(
    raw: unknown,
  ): Promise<{ ok: true; element: AXElement | null }> {
    const query = CuFindElementInput.parse(raw);
    const element = await findElement(query, this.deps.accessibilityDeps ?? {});
    return { ok: true, element };
  }

  async scroll(
    raw: unknown,
  ): Promise<{ ok: true; x: number; y: number; dy: number; dx: number }> {
    const { x, y, dy, dx } = CuScrollInput.parse(raw);
    const dxOut = dx ?? 0;
    await this.deps.actuator.scroll(x, y, dy, dxOut);
    return { ok: true, x, y, dy, dx: dxOut };
  }
}

export function createCuTools(deps: CuToolsDeps): CuTools {
  return new CuTools(deps);
}
