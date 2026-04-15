# Phase 2.5 — Research Loop Decisions

Tracks load-bearing design decisions for Build Agent A (research loop +
`nchinda_research` MCP tool). Every Phase-2.5 TODO should cite a line
here.

## Open TODOs

_None._

## Decisions

### D1 — `maxProbes` is recorded in telemetry, not yet consumed
Plan §2.3 defines `deep` as "5 hypotheses × 2 probes × 5min budget".
Phase 2.5 only models one probe per hypothesis — the HYPOTHESIZE seed
returns a 1:1 `{h, probe}` pairing. The `maxProbes` option is threaded
through `ResearchOptions` and emitted on the `EXECUTE_PROBES` event
payload so Phase 3 can turn on multi-probe dispatch (e.g. `[probe,
verify-probe]` replays) without a schema break.

### D2 — Malformed Haiku output → fail-safe Brief, not a throw
When `callHaikuJson` can't zod-parse Haiku's response, or when the
`timeBudgetMs` AbortController fires mid-call, `runResearch` returns a
Brief with:

  - `recommended_action: 'research-failed'`
  - `confidence: 0`
  - a single synthetic hypothesis (`h = "loop failed before producing a
    brief"`, `verdict: 'inconclusive'`)
  - `open_questions: [question]`

We chose this over throwing because the `nchinda_research` MCP tool
contract promises a Brief. A throw would force every caller to guard;
a fail-safe Brief lets the consumer branch on `recommended_action`.
Every failure path runs the result through `BriefSchema.parse` so any
drift in the fallback shape becomes a typecheck failure, not a silent
contract break.

### D3 — Per-call 8s timeout + overall budget abort are layered
Each Haiku call has its own `AbortController` with a 8s timeout
(matches `src/classifier/haiku-classifier.ts`). In addition, the whole
`runResearch` run is wrapped by an outer `AbortController` tied to
`timeBudgetMs`. Per-call signals are linked to the outer signal so a
budget trip kills any in-flight call immediately.

Why both layers:
  - Per-call timeout keeps a single stuck fetch from monopolising the
    budget.
  - Overall budget caps the loop even if individual calls return in
    time but cumulative cost exceeds budget.

### D4 — Local `redactReason` helper duplicates the classifier's
`src/classifier/haiku-classifier.ts` already ships a redaction table
mapping known-safe error categories to short labels. We duplicate that
table verbatim in `research-loop.ts` rather than extracting a shared
module, to keep Phase 2.5 self-contained and avoid cross-file coupling
during parallel development. On merge to `main`, the two tables should
collapse into `src/util/redact-reason.ts`.

### D5 — Phase events use `plan_emitted` with a `phase` payload tag
We don't add a new `EventKind` for each of the four phases. Instead we
reuse `plan_emitted` with `payload: {phase: 'HYPOTHESIZE' | ...}`. This
mirrors how the Autonomy Loop labels its own phases and avoids an
event-kind explosion. Only the final Brief emission gets its own kind
(`research_brief_emitted`) because downstream consumers (Mission
Control, pgvector persistence) specifically key off the completed loop.
