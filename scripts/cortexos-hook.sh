#!/usr/bin/env bash
# CortexOS UserPromptSubmit Hook
# Intercepts user prompts and routes them to CortexOS when active.
#
# Flow:
#   1. User types "activate cortexos" → starts CortexOS, enters routing mode
#   2. All subsequent prompts → forwarded to CortexOS via `cortex run`
#   3. User types "exit cortexos" → leaves routing mode, back to normal Claude
#
# Hook contract:
#   - Receives JSON on stdin with { "prompt": "..." }
#   - Exit 0 with no stdout → allow prompt through to Claude normally
#   - Exit 0 with JSON stdout → allow with additionalContext
#   - Exit 2 with stderr → block prompt, show stderr to user

set -uo pipefail

CORTEX_DIR="/Users/joelc/Documents/Github/cortexOS"
STATE_FILE="/tmp/cortexos-active.session"
SOCKET_PATH="/tmp/cortexos.sock"
STARTUP_TIMEOUT=15

# Read the hook input from stdin
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null)

if [ -z "$PROMPT" ]; then
  # No prompt or parse failure — let Claude handle it
  exit 0
fi

PROMPT_LOWER=$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

# ── "activate cortexos" — start CortexOS and enter routing mode ─────
if [ "$PROMPT_LOWER" = "activate cortexos" ]; then
  # Start CortexOS if not already running
  if [ ! -S "$SOCKET_PATH" ]; then
    cd "$CORTEX_DIR" && npx tsx src/index.ts start &>/tmp/cortexos-startup.log &
    CORTEX_PID=$!

    elapsed=0
    while [ "$elapsed" -lt "$STARTUP_TIMEOUT" ]; do
      if [ -S "$SOCKET_PATH" ]; then
        break
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done

    if [ ! -S "$SOCKET_PATH" ]; then
      echo "[CortexOS] Failed to start within ${STARTUP_TIMEOUT}s. Check /tmp/cortexos-startup.log" >&2
      exit 2
    fi
  fi

  # Mark session as active
  echo "$$" > "$STATE_FILE"

  # Block the prompt — CortexOS is now handling things
  echo '{"decision":"block","reason":"[CortexOS] Activated. All messages will be routed to CortexOS. Type \"exit cortexos\" to return to normal Claude mode."}'
  exit 0
fi

# ── "exit cortexos" — leave routing mode ─────────────────────────────
if [ "$PROMPT_LOWER" = "exit cortexos" ]; then
  rm -f "$STATE_FILE"
  echo '{"decision":"block","reason":"[CortexOS] Deactivated. You are back in normal Claude mode."}'
  exit 0
fi

# ── If CortexOS is not active, let Claude handle normally ────────────
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# ── CortexOS is active — route the prompt ────────────────────────────
if [ ! -S "$SOCKET_PATH" ]; then
  rm -f "$STATE_FILE"
  echo "[CortexOS] Controller is not running. Session deactivated. Type \"activate cortexos\" to restart." >&2
  exit 2
fi

# Forward to CortexOS orchestrator
cd "$CORTEX_DIR" && npx tsx src/index.ts run "$PROMPT" &>/tmp/cortexos-last-task.log &

echo '{"decision":"block","reason":"[CortexOS] Task dispatched. CortexOS is orchestrating agents in separate terminals. Check your terminal windows for progress."}'
exit 0
