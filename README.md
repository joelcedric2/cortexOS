# cortexOS

**A full team of AI agents working for you — included in your Claude Pro/Max subscription.**

Most AI agent frameworks charge you per API token. cortexOS runs entirely on the `claude` CLI, which is already covered by your Anthropic Pro or Max plan. No API keys. No per-token bills. Your subscription IS the compute.

Give it a goal, and its resident agent **Nchinda** recruits specialists, runs them in parallel, learns from every outcome, and handles failures on its own — before it ever asks for help.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-active%20development-yellow.svg)]()

---

## Why This Matters Now

Anthropic's Agent SDK and API-based agent tools bill you per token. If you're already paying for Claude Pro ($20/mo) or Max ($100-200/mo), you're leaving compute on the table.

cortexOS taps the Claude CLI directly — the same interface that ships with your subscription. That means:

- **$0 extra** for multi-agent orchestration
- **No API key management** — just your existing `claude` login
- **No usage caps beyond your plan** — Max subscribers get unlimited agent runs
- **Works today** — while others figure out pricing, you're already shipping

## What It Does

- **Goal decomposition** — hand it a high-level objective, it breaks it into a structured plan with roles and dependencies
- **Parallel agent dispatch** — specialist `claude` CLI instances run concurrently in tmux panes, each focused on one piece of the problem
- **Persistent vector memory** — every task leaves a trace in pgvector. Successes become exemplars; recovered failures become anti-patterns plus the fix that worked
- **Autonomous recovery** — on failure, Nchinda tries: different tool, reduced scope, peer agent, memory recall, web search — only then escalates to you
- **Hypothesis-driven research** — under uncertainty, enumerates hypotheses, runs the smallest distinguishing probes in parallel, and plans from evidence
- **Sensors** — monitors system health, screen/app attention, unread email, and unsent drafts to proactively surface relevant context
- **Mission Control** — a live decision journal streamed over WebSocket so you can trust the agent without micromanaging it

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

## How It Works

1. You state a goal in natural language
2. Nchinda decomposes it into a dependency-aware task graph
3. Specialist agents are dispatched to tmux panes, running in parallel where possible
4. Results flow back through the orchestrator; failures trigger the autonomy loop
5. Outcomes are embedded and stored in vector memory for future recall
6. Mission Control streams every decision for full transparency

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

## Status

Under active development. The core orchestration, memory, and autonomy loop are functional. Surface area and polish are still evolving.

## License

All rights reserved by the author until a license is specified.
