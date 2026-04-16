/**
 * `nchinda_see()` MCP tool (Phase 8.5).
 *
 * Any agent can ask Nchinda "what's on screen right now?" and get back a
 * compact, structured VisionBrief. The tool captures ONE fresh frame
 * (rather than reading from the ring buffer) so the caller is guaranteed
 * an up-to-date snapshot.
 *
 * Validation: input is zod-parsed at the MCP boundary. The brief pipeline
 * already enforces the private-app deny-list, so this handler is a thin
 * orchestrator over capturer → brief.
 *
 * Failure modes:
 *   - capturer.captureNow() throws (permission denied, private app, kill
 *     switch active) → error propagates so the MCP transport can convert
 *     it into a JSON-RPC error frame. Never silently swallowed.
 *   - buildBrief() itself never throws (designed so the LLM fallback logic
 *     owns all the catches) — but we pass through its output verbatim.
 */
import { z } from "zod";
import type { ScreenCapturer } from "../perception/screen-capture.js";
import {
  buildBrief,
  type VisionBrief,
} from "../perception/vision-brief.js";

// ---------------------------- Schema -------------------------------------

const NchindaSeeInputSchema = z.object({
  mode: z.enum(["local-only", "llm"]).optional().default("local-only"),
});

export type NchindaSeeInput = z.infer<typeof NchindaSeeInputSchema>;

// ---------------------------- Dependencies -------------------------------

export interface NchindaSeeDeps {
  capturer: ScreenCapturer;
  /** Test seam. Production calls pass `buildBrief` from vision-brief.ts. */
  brief: typeof buildBrief;
  /** ANTHROPIC_API_KEY override. Defaults to process.env. */
  apiKey?: string;
  /** fetch override for LLM mode. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** LLM call timeout. Defaults to 8000ms. */
  timeoutMs?: number;
}

// ---------------------------- Handler ------------------------------------

/**
 * Capture one fresh frame, build a VisionBrief, return it.
 *
 * The default mode is `local-only` — no LLM call, no network. Pass
 * `{ mode: "llm" }` to opt into a Haiku polish step (see vision-brief.ts
 * for the fallback semantics).
 */
export async function nchindaSee(
  raw: unknown,
  deps: NchindaSeeDeps,
): Promise<VisionBrief> {
  const input = NchindaSeeInputSchema.parse(raw ?? {});
  const outcome = await deps.capturer.captureNow();
  if (!outcome.ok) {
    // One-shot user-facing tool — budget/duplicate outcomes surface as
    // explicit errors so the MCP transport can return a JSON-RPC error.
    if (outcome.reason === "budget-exceeded") {
      throw new Error(
        `nchinda_see: capture budget exceeded (bytes_in_window=${outcome.bytesInWindow}, budget=${outcome.budget})`,
      );
    }
    throw new Error(`nchinda_see: capture skipped (reason=${outcome.reason})`);
  }
  return deps.brief(
    outcome.frame,
    {},
    {
      mode: input.mode,
      apiKey: deps.apiKey,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
    },
  );
}
