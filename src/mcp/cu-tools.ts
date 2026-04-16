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
 * transport adapter. To prevent a prompt-injected planner from
 * side-stepping the agent-loop's policy gate by speaking MCP
 * directly, `cu_type` / `cu_click` / `cu_scroll` ALSO run their
 * action description through `policy.isIrreversible(...)` at the MCP
 * boundary. When the policy flags irreversibility, the tool awaits
 * an `EscalationGate.requestConfirmation(...)` (same contract P12b
 * uses) and short-circuits to `{ok:false, reason:'user-denied'}`
 * when the user declines. The actuator is never invoked on deny.
 */
import { z } from "zod";
import type { Actuator } from "../computer-use/actuator.js";
import {
  findElement,
  type AccessibilityDeps,
  type AXElement,
} from "../computer-use/accessibility.js";
import { Policy } from "../loop/policy.js";

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

/**
 * Minimal confirmation gate — same contract as P12b's
 * {@link import("../apps/notes-driver.js").EscalationGate}. Runs at
 * the MCP boundary for any cu_* primitive whose action description
 * trips `policy.isIrreversible(...)`.
 */
export interface CuEscalationGate {
  requestConfirmation(
    question: string,
    context: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface CuToolsDeps {
  actuator: Actuator;
  /** AX lookups delegate to `findElement`; tests inject a bridge. */
  accessibilityDeps?: AccessibilityDeps;
  /**
   * Policy oracle for irreversibility checks at the MCP boundary.
   * When omitted, a default `new Policy()` is used (same rule set
   * the agent-loop applies). When {@link gate} is also omitted,
   * policy-trip falls back to throwing so no silent bypass can occur.
   */
  policy?: Policy;
  /**
   * Required when the planner can invoke `cu_*` tools directly.
   * When omitted, any policy-flagged action throws a
   * `CuEscalationRequired` error rather than silently actuating —
   * fails closed so a mis-wired deployment cannot bypass confirmation.
   */
  gate?: CuEscalationGate;
}

export type UserDenied = { ok: false; reason: "user-denied" };
const USER_DENIED: UserDenied = Object.freeze({
  ok: false,
  reason: "user-denied",
}) as UserDenied;

export class CuEscalationRequired extends Error {
  readonly code = "cu-escalation-required" as const;
  readonly description: string;
  constructor(description: string) {
    super(
      `cu_* tool blocked: action "${description}" is irreversible but no ` +
        `EscalationGate was wired. Pass { gate } to CuTools to enable ` +
        `confirmation, or route through the agent-loop.`,
    );
    this.description = description;
  }
}

// ──────────────────────── Handler class ────────────────────────────────

export class CuTools {
  private readonly policy: Policy;
  private readonly gate: CuEscalationGate | undefined;

  constructor(private readonly deps: CuToolsDeps) {
    this.policy = deps.policy ?? new Policy();
    this.gate = deps.gate;
  }

  /**
   * Escalation shim. Returns `true` when the planner may proceed,
   * `false` when the user denied. Throws `CuEscalationRequired` when
   * the policy flags irreversibility but no gate was wired — the
   * fail-closed path that stops silent bypass.
   */
  private async gateCheck(
    description: string,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.policy.isIrreversible(description)) return true;
    if (!this.gate) throw new CuEscalationRequired(description);
    return this.gate.requestConfirmation(
      `Confirm irreversible computer-use action: ${description}`,
      context,
    );
  }

  async click(
    raw: unknown,
  ): Promise<
    | { ok: true; x: number; y: number; button: "left" | "right" }
    | UserDenied
  > {
    const { x, y, button } = CuClickInput.parse(raw);
    const b = button ?? "left";
    const description = `click ${b} button at (${x},${y})`;
    const approved = await this.gateCheck(description, { x, y, button: b });
    if (!approved) return USER_DENIED;
    await this.deps.actuator.click(x, y, b);
    return { ok: true, x, y, button: b };
  }

  async type(
    raw: unknown,
  ): Promise<{ ok: true; length: number } | UserDenied> {
    const { text, delayMs } = CuTypeInput.parse(raw);
    const description = `type: ${text}`;
    const approved = await this.gateCheck(description, {
      preview: text.slice(0, 120),
    });
    if (!approved) return USER_DENIED;
    await this.deps.actuator.type(text, delayMs);
    return { ok: true, length: text.length };
  }

  async screenshot(
    raw: unknown,
  ): Promise<{ ok: true; path: string; width: number; height: number }> {
    CuScreenshotInput.parse(raw ?? {});
    // Screenshot is read-only — no policy gate.
    const shot = await this.deps.actuator.screenshot();
    return { ok: true, ...shot };
  }

  async findElement(
    raw: unknown,
  ): Promise<{ ok: true; element: AXElement | null }> {
    const query = CuFindElementInput.parse(raw);
    // Find is read-only — no policy gate.
    const element = await findElement(query, this.deps.accessibilityDeps ?? {});
    return { ok: true, element };
  }

  async scroll(
    raw: unknown,
  ): Promise<
    | { ok: true; x: number; y: number; dy: number; dx: number }
    | UserDenied
  > {
    const { x, y, dy, dx } = CuScrollInput.parse(raw);
    const dxOut = dx ?? 0;
    const description = `scroll at (${x},${y}) dy=${dy} dx=${dxOut}`;
    const approved = await this.gateCheck(description, { x, y, dy, dx: dxOut });
    if (!approved) return USER_DENIED;
    await this.deps.actuator.scroll(x, y, dy, dxOut);
    return { ok: true, x, y, dy, dx: dxOut };
  }
}

export function createCuTools(deps: CuToolsDeps): CuTools {
  return new CuTools(deps);
}
