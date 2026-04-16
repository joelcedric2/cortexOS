# Phase 9.5 Decisions

## ADR-P9.5-001: Keyframe-only retention (no camera_memories DB in v1)

**Status:** Accepted  
**Date:** 2026-04-15

### Context

Phase 8.5 stores screen captures in a `screen_memories` SQLite table with embeddings, OCR text, and a 7-day retention downgrader. Phase 9.5 introduces camera keyframes that are conceptually similar but semantically distinct (cameras are not screens).

The spec considered a sibling `camera_memories` table with a `source='clip'|'still'` discriminator. However:

1. Camera queries are on-demand (not periodic like screen capture), so the volume is 10-100x lower.
2. Embedding + OCR for every keyframe adds latency to an already ~10s recording pipeline.
3. The user has not expressed a "recall what I saw 3 days ago via camera" need yet.

### Decision

Store keyframes as **ephemeral files only** in `~/.cortexos/camera-clips/<uuid>-frames/`. Extend the existing retention worker to unlink keyframe directories older than 7 days via a filesystem age check. No SQLite table, no embeddings, no OCR-at-write.

### Consequences

- Simpler pipeline, lower latency, smaller storage footprint.
- Users cannot search past camera observations by semantic query (yet).
- If demand arises, Phase 9.5-v2 adds `camera_memories` table + embedding pipeline. The keyframe file paths and extraction logic are already in place, so the migration is purely additive.

## ADR-P9.5-002: Default mode changed from still to clip

**Status:** Accepted  
**Date:** 2026-04-15

### Context

Phase 9 defaulted `nchinda_look()` to a single still frame. Phase 9.5 adds clip mode (10s recording, N keyframes, multi-image Sonnet prompt).

### Decision

Default mode is now `clip`. Callers that need the lightweight one-shot path pass `mode: 'still'` explicitly. The voice-orchestrator routing is unchanged: it still calls `nchindaLook()` with no opts, which now automatically gets the richer context.

### Consequences

- Zero breaking change at the call site (voice-orchestrator, MCP dispatch).
- Existing tests that inject a `capture` dep now specify `mode: 'still'`.
- Slightly higher latency (~10s recording + ffmpeg extraction vs. ~0.5s still).
- Significantly richer descriptions from the LLM due to temporal context.
