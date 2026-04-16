/**
 * MCP tool handlers for the Social Operator Layer.
 *
 *   social_send(platform, target, message) — wraps socialSend dispatch
 *   social_post(platform, content)         — stub (Phase 5)
 *
 * Input validation via zod. Handlers sit between the MCP transport
 * (scripts/mcp/serve-nchinda.mjs) and the dispatch layer.
 */
import { z } from "zod";
import {
  socialSend,
  type SocialSendResult,
  type SocialDispatchDeps,
} from "../social/dispatch.js";
import type { SocialPlatform } from "../social/driver.js";

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const VALID_PLATFORMS: SocialPlatform[] = [
  "ig", "x", "linkedin", "reddit", "tiktok",
  "discord", "telegram", "whatsapp", "imessage",
];

const SocialSendInputSchema = z.object({
  platform: z.enum(VALID_PLATFORMS as [SocialPlatform, ...SocialPlatform[]]),
  target: z.string().min(1).max(256),
  message: z.string().min(1).max(4000),
});

const SocialPostInputSchema = z.object({
  platform: z.enum(VALID_PLATFORMS as [SocialPlatform, ...SocialPlatform[]]),
  content: z.string().min(1).max(10_000),
});

export type SocialSendInput = z.infer<typeof SocialSendInputSchema>;
export type SocialPostInput = z.infer<typeof SocialPostInputSchema>;

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

export class SocialTools {
  constructor(private readonly deps: SocialDispatchDeps) {}

  async send(raw: unknown): Promise<SocialSendResult> {
    const input = SocialSendInputSchema.parse(raw);
    return socialSend(
      {
        platform: input.platform,
        target: input.target,
        message: input.message,
      },
      this.deps,
    );
  }

  post(raw: unknown): never {
    // Validate input even though we throw — gives a good error message
    SocialPostInputSchema.parse(raw);
    throw new Error(
      "social_post is not yet implemented. Publishing to platforms ships in Phase 5.",
    );
  }
}
