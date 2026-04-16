# Phase 13-15 — Reviewer 2 (READ-ONLY)

Scope: Phase 13 (writing-coach), Phase 14 (conv-intent), Phase 15 (rewind).
Reviewer 1 covers P9/10/12.
Spec: `docs/phase-8/VISION.md` §4 Phase 13, 14, 15.

## Verdict

**ship-with-fixes** — all three branches are unusually tight for a v1 surface. P13 (writing coach) enforces the spec's hard privacy invariants: default-off allow-list, Haiku timeout + reason redaction, 10-minute dedup, AXWatch reconnect with exponential backoff. P14 (conv-intent) proves the cardinal rule ("stated-intent NEVER auto-executes") by construction — the surface only drafts, it never sends, and drafter-less autonomous mode still just surfaces a "Confirm send" prompt. P15 (rewind) bounds work correctly (`limit × 3` decompression budget, clamp to 1–50, inclusive time filter). Integration (T2 at `cde310c`) merges all three into a clean voice-orchestrator with correctly-ordered control branches (kill → rewind → conv-intent side-channel + onTask). Blockers are minor but real: (1) a subtle `lastRouted.set` placement bug in P13 that dedups whispers-that-fell-through-to-surface incorrectly, (2) P15 uses `zstdDecompressSync` which on a malicious blob has no max-output-size cap (zstd-bomb), and (3) some prompt-injection hardening gaps (raw user transcript appears inside the Haiku user message without fenced delimiters). None require rewrite — all five top patches below are 10-line edits.

## Scorecard (1–5)

| Branch | Correctness | Security | TS rigor | Test quality | Design | Spec adherence |
|---|---|---|---|---|---|---|
| phase13/writing-coach | 4 | 4 | 5 | 4 | 5 | 5 |
| phase14/conv-intent | 5 | 4 | 5 | 5 | 5 | 5 |
| phase15/rewind | 4 | 3 | 5 | 4 | 4 | 5 |
| phase13-15/integration (T2) | 4 | 4 | 5 | 4 | 5 | 5 |

## Per-branch spec-drift vs VISION.md §4

TBD

## Per-branch findings

### P13 writing-coach
TBD

### P14 conv-intent
TBD

### P15 rewind
TBD

## Security pass

TBD

## Voice-orchestrator multi-intent sanity

TBD

## Test quality

TBD

## Top 5 patches before main

TBD

## Follow-ups

TBD
