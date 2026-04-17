/**
 * Hook point for brain context integration.
 *
 * Agent 3 (brain-context) should import this and call
 * `getVoiceContextSection()` when building the CLAUDE.md for a brain session.
 *
 * This module is the bridge between voice-memory (Agent 6) and
 * brain-context (Agent 3). It is intentionally minimal — a single function
 * that returns a markdown section or empty string.
 */

import type { VoiceMemory } from "./voice-memory.js";

/**
 * Retrieve formatted recent voice interactions for CLAUDE.md injection.
 *
 * @param voiceMemory - The VoiceMemory instance (or undefined if not wired)
 * @param topK - Number of interactions to recall (default 5)
 * @returns Markdown section string, or empty string if no memories
 *
 * @example
 * // In brain-context.ts (Agent 3):
 * const voiceSection = await getVoiceContextSection(voiceMemory, 5);
 * claudeMd += voiceSection;
 */
export async function getVoiceContextSection(
  voiceMemory: VoiceMemory | undefined,
  topK?: number,
): Promise<string> {
  if (!voiceMemory) return "";

  try {
    return await voiceMemory.recallRecentInteractions(topK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[VoiceMemoryHook] Failed to recall interactions:", msg);
    return "";
  }
}
