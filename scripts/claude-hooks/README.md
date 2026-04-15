# cortexOS Claude Code Hooks

Shell hooks that bridge Claude Code lifecycle events into the cortexOS hooks server
(`POST http://localhost:3102/hooks/*`). Part of Phase 1 (Agent A).

## Files

| File | Trigger | What it does |
|------|---------|--------------|
| `stop.sh` | Claude Code `Stop` event | POSTs `{session_id, agent_id?, slot?, transcript_tail, exit_reason, ts}` to `/hooks/stop`. Server writes row to `agent_events` + emits `done` on the EventBus. |
| `pre-compact.sh` | Claude Code `PreCompact` event (manual or auto) | POSTs `{session_id, transcript_path, task_id?, ts}` to `/hooks/pre-compact`. Server chunks + embeds + stashes the transcript into `memories` with tags `['compact', session_id]` and fires a `compact` EventBus event. |

Both scripts are **non-blocking**: they use `curl --max-time 2` and swallow all errors
(`|| true`, `exit 0`), so an unavailable server never prevents a session from stopping
or compacting.

## Install

Because the authoring sandbox could not write directly under `.claude/`, the scripts
live in `scripts/claude-hooks/`. To wire them up:

```bash
sh scripts/claude-hooks/install.sh
```

This symlinks (or copies) `stop.sh` and `pre-compact.sh` into `.claude/hooks/` and
`chmod +x`es them. You also need to register them in `.claude/settings.json` under
the `hooks` key — merge the snippet at `docs/phase-1/settings-hooks-snippet.json`.

## End-to-end flow

```
  Claude Code  ── Stop event ──▶  .claude/hooks/stop.sh
                                     │
                                     │  curl POST
                                     ▼
                         http://localhost:3102/hooks/stop
                                     │
                                     ├─▶ agent_events  (~/.cortexos/events.db)
                                     └─▶ EventBus.emit({kind:'done', …})
                                              │
                                              ▼
                                   Orchestrator (Agent B)
                                   subscribes + advances
                                   its state machine
```

For `PreCompact`, same shape plus a background worker that chunks the transcript
JSONL, runs each chunk through `Embedder` (MiniLM, 384-dim) and writes to the
`memories` pgvector table — all off the HTTP response path so the hook returns
`202 Accepted` in <10ms.

## Manual test

```bash
# 1. Start the hooks server (via controller or ad-hoc script)
node -e "import('./dist/ipc/server.js').then(async m => { \
  const { createEventBus } = await import('./dist/ipc/event-bus.js'); \
  const { openEventsDB }  = await import('./dist/ipc/events-db.js'); \
  const bus = createEventBus(); const db = await openEventsDB(); \
  await m.startHooksServer({ bus, db }); \
  bus.subscribe({}, e => console.log('event:', e)); \
});"

# 2. Probe health
curl -s http://localhost:3102/health | jq
# {"ok":true,"uptime_s":1,"events_seen":0}

# 3. Simulate a Stop event
echo '{"session_id":"test-123","transcript_path":"/tmp/nope"}' | \
    sh scripts/claude-hooks/stop.sh

# 4. Verify it landed
sqlite3 ~/.cortexos/events.db 'SELECT * FROM agent_events'
```

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `CORTEXOS_HOOKS_URL` | `http://localhost:3102` | Override hooks server base URL (e.g. in tests) |
