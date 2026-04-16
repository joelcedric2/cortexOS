/**
 * `nchinda_rewind()` MCP tool (Phase 15).
 *
 * Thin MCP-facing wrapper over `rewindSearch`. Validates the input shape
 * via zod (consistent with the rest of the Nchinda MCP surface) and
 * returns the plain `RewindResult[]` array verbatim. The MCP transport at
 * `scripts/mcp/serve-nchinda.mjs` JSON-serializes the payload for the
 * caller.
 *
 * No silent catches: a bad schema or a failing embedder throws and the
 * MCP server converts the error into a JSON-RPC error frame.
 */
import { z } from "zod";
import {
  rewindSearch,
  type RewindEmbedder,
  type RewindResult,
} from "../rewind/rewind-query.js";
import type { ScreenMemoriesDB } from "../perception/screen-memories-db.js";

// ---------------------------- Schema -------------------------------------

const TimeRangeSchema = z.object({
  from: z.union([z.string(), z.date()]),
  to: z.union([z.string(), z.date()]),
});

const NchindaRewindInputSchema = z.object({
  text: z.string().min(1),
  timeRange: TimeRangeSchema.optional(),
  app: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type NchindaRewindInput = z.infer<typeof NchindaRewindInputSchema>;

// ---------------------------- Dependencies -------------------------------

export interface NchindaRewindDeps {
  db: ScreenMemoriesDB;
  embedder: RewindEmbedder;
}

// ---------------------------- Handler ------------------------------------

function toDate(v: string | Date): Date {
  if (v instanceof Date) return v;
  const parsed = new Date(v);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`nchinda_rewind: invalid date "${v}"`);
  }
  return parsed;
}

export async function nchindaRewind(
  raw: unknown,
  deps: NchindaRewindDeps,
): Promise<RewindResult[]> {
  const input = NchindaRewindInputSchema.parse(raw ?? {});
  const timeRange = input.timeRange
    ? { from: toDate(input.timeRange.from), to: toDate(input.timeRange.to) }
    : undefined;
  return rewindSearch(
    {
      text: input.text,
      ...(timeRange ? { timeRange } : {}),
      ...(input.app ? { app: input.app } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    { db: deps.db, embedder: deps.embedder },
  );
}
