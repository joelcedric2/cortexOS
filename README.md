# cortexOS

**Give it a goal, it builds a team of AI agents and gets it done.**

cortexOS is a multi-agent CLI orchestrator with persistent memory. Its resident agent, **Nchinda**, decomposes any objective into a coordinated plan, spins up specialist AI agents in parallel, learns from every outcome, and recovers from failures autonomously -- before it ever asks you for help.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-active%20development-yellow.svg)]()

---

## Why This Exists

Most AI tools run one prompt at a time. cortexOS treats your machine like a staffing agency: define the mission, and Nchinda recruits the right specialists, runs them in parallel, feeds results between them, and delivers a finished product.

## What It Does

- **Goal decomposition** -- hand it a high-level objective, it breaks it into a structured plan with roles and dependencies
- **Parallel agent dispatch** -- specialist `claude` CLI instances run concurrently in tmux panes, each focused on one piece of the problem
- **Persistent vector memory** -- every task leaves a trace in pgvector. Successes become exemplars; recovered failures become anti-patterns plus the fix that worked
- **Autonomous recovery** -- on failure, Nchinda tries: different tool, reduced scope, peer agent, memory recall, web search -- only then escalates to you
- **Hypothesis-driven research** -- under uncertainty, enumerates hypotheses, runs the smallest distinguishing probes in parallel, and plans from evidence
- **Sensors** -- monitors system health, screen/app attention, unread email, and unsent drafts to proactively surface relevant context
- **Mission Control** -- a live decision journal streamed over WebSocket so you can trust the agent without micromanaging it

## Quick Start

```bash
git clone https://github.com/joelcedric2/cortexOS.git
cd cortexOS
npm install
npm run build
```

The CLI is exposed as `cortex` (see `bin` in `package.json`).

```bash
# Run from source
npm run dev

# Run tests
npm test
```

## Architecture

```
src/
  orchestrator/   plan -> role resolution -> task dispatch
  loop/           autonomy loop, fallback strategies, attempt logging
  research/       hypothesis-driven probe execution and brief storage
  sensors/        system/app/email/focus observation
  analytics/      success-rate and anti-pattern analysis
  ui/             WebSocket bridge + Mission Control API
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node 20+, ESM, TypeScript |
| CLI | commander |
| Memory | better-sqlite3 + PostgreSQL/pgvector |
| Embeddings | @huggingface/transformers (local) |
| Messaging | grammy (Telegram) |
| Realtime | ws (WebSocket) |
| Validation | zod |

## How It Works

1. You state a goal in natural language
2. Nchinda decomposes it into a dependency-aware task graph
3. Specialist agents are dispatched to tmux panes, running in parallel where possible
4. Results flow back through the orchestrator; failures trigger the autonomy loop
5. Outcomes are embedded and stored in vector memory for future recall
6. Mission Control streams every decision for full transparency

## Status

Under active development. The core orchestration, memory, and autonomy loop are functional. Surface area and polish are still evolving.

## License

All rights reserved by the author until a license is specified.
