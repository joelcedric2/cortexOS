# cortexOS

> Multi-AI CLI orchestrator with shared persistent memory.

cortexOS is the platform; **Nchinda** is the agent that lives inside it. Given a goal, Nchinda
plans, delegates work to specialist `claude` CLI instances running in tmux panes, coordinates
them like a team, learns from every task, and operates your Mac like a personal JARVIS.

> **Status:** Under active development. The core orchestration, memory, and autonomy loop are
> functional; surface area and polish are still evolving.

## What it does

- **Orchestration** — decomposes a goal into a plan, resolves roles, and dispatches subtasks to
  multiple specialist CLI agents in parallel (tmux-managed panes).
- **Persistent memory** — every task leaves a trace in a `pgvector` store. Successes become
  positive exemplars; recovered failures become anti-patterns plus the fix that worked.
- **Autonomy loop** — on failure, tries an alternative before asking: different tool → reduced
  scope → peer agent → memory recall → web search → only then escalates to you.
- **Hypothesis-driven research** — instead of guessing under uncertainty, it enumerates
  hypotheses, runs the smallest probes that distinguish them in parallel, and plans from evidence.
- **Sensors** — observes system health, screen/app attention, unread email, and unsent drafts to
  proactively offer help.
- **Mission Control** — a live journal of structured decision events over a WebSocket bridge, so
  you can trust the agent without micromanaging it.

## Tech stack

TypeScript (Node ≥ 20, ESM), `commander` CLI, `better-sqlite3` + PostgreSQL/`pgvector` for memory,
`@huggingface/transformers` for local embeddings, `grammy` (Telegram), `ws`, `zod`.

## Getting started

```bash
npm install
npm run build      # compile TypeScript to dist/
npm run dev        # run from source via tsx
npm test           # run the test suite
```

The CLI is exposed as `cortex` (see `bin` in `package.json`).

## Project layout

```
src/
  orchestrator/   plan → role resolution → task dispatch
  loop/           autonomy loop, fallback strategies, attempt logging
  research/       hypothesis-driven probe execution and brief storage
  sensors/        system/app/email/focus observation
  analytics/      success-rate and anti-pattern analysis
  ui/             WebSocket bridge + Mission Control API
docs/             phased implementation plans
```

## License

No license is currently specified. All rights reserved by the author until one is added.
