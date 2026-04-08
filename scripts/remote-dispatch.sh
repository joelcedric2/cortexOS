#!/usr/bin/env bash
# CortexOS Remote Dispatch
# Usage: remote-dispatch.sh <task description>
# Called by Claude Code's /remote-control slash command to forward tasks
# to CortexOS for multi-agent orchestration.

set -euo pipefail

CORTEX_DIR="/Users/joelc/Documents/Github/cortexOS"
CORTEX_BIN="npx tsx ${CORTEX_DIR}/src/index.ts"
SOCKET_PATH="/tmp/cortexos.sock"
STARTUP_TIMEOUT=15

# ── Collect task from arguments ──────────────────────────────────────
TASK="$*"

# Strip known prefixes so callers can pass the raw prompt
TASK="${TASK#/remote-control }"
TASK="${TASK#/remote }"

# Trim leading/trailing whitespace
TASK="$(echo "$TASK" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

if [ -z "$TASK" ]; then
  echo "[CortexOS] Error: No task provided."
  echo "Usage: remote-dispatch.sh <task description>"
  exit 1
fi

# ── Helper: check if the IPC socket exists and is a socket ───────────
is_running() {
  [ -S "$SOCKET_PATH" ]
}

# ── If already running, forward immediately ──────────────────────────
if is_running; then
  echo "[CortexOS] Controller already running. Forwarding task..."
  cd "$CORTEX_DIR" && $CORTEX_BIN run "$TASK"
  exit $?
fi

# ── Not running — start in background ────────────────────────────────
echo "[CortexOS] Starting controller..."
cd "$CORTEX_DIR" && $CORTEX_BIN start &
CORTEX_PID=$!

# Verify the process is still alive after a moment
sleep 1
if ! kill -0 "$CORTEX_PID" 2>/dev/null; then
  echo "[CortexOS] Error: Controller process exited immediately."
  exit 1
fi

# Wait for the IPC socket to appear
elapsed=0
while [ "$elapsed" -lt "$STARTUP_TIMEOUT" ]; do
  if is_running; then
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if ! is_running; then
  echo "[CortexOS] Error: Controller failed to start within ${STARTUP_TIMEOUT}s."
  kill "$CORTEX_PID" 2>/dev/null || true
  exit 1
fi

echo "[CortexOS] Controller started (PID ${CORTEX_PID}). Forwarding task..."
cd "$CORTEX_DIR" && $CORTEX_BIN run "$TASK"
