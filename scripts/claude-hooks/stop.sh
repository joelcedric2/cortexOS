#!/bin/sh
# Phase 1 — Agent A
# Claude Code `Stop` hook → POST to cortexOS hooks server.
#
# This file lives in scripts/claude-hooks/ because the sandbox in which it was
# authored could not write to .claude/hooks/. Install via:
#     ln -s ../../scripts/claude-hooks/stop.sh .claude/hooks/stop.sh
# or copy:
#     cp scripts/claude-hooks/stop.sh .claude/hooks/stop.sh && chmod +x .claude/hooks/stop.sh
#
# Input  (stdin from Claude Code): JSON with at least `session_id` and
#        `transcript_path`.
# Output: exit 0 always — a failing hook must not block a Stop event.

set -u

HOOKS_URL="${CORTEXOS_HOOKS_URL:-http://localhost:3102}"
ENDPOINT="${HOOKS_URL%/}/hooks/stop"

INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && INPUT='{}'

extract_field() {
    field="$1"
    printf '%s' "$INPUT" | awk -v key="\"$field\"" '
        {
            s = $0
            i = index(s, key)
            if (i == 0) next
            s = substr(s, i + length(key))
            sub(/^[[:space:]]*:[[:space:]]*/, "", s)
            if (substr(s, 1, 1) == "\"") {
                s = substr(s, 2)
                end = index(s, "\"")
                if (end > 0) print substr(s, 1, end - 1)
            } else {
                match(s, /[-0-9.]+/)
                if (RSTART > 0) print substr(s, RSTART, RLENGTH)
            }
            exit
        }
    '
}

SESSION_ID="$(extract_field session_id)"
AGENT_ID="$(extract_field agent_id)"
SLOT="$(extract_field slot)"
EXIT_REASON="$(extract_field stop_hook_active)"
TRANSCRIPT_PATH="$(extract_field transcript_path)"

TAIL=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -r "$TRANSCRIPT_PATH" ]; then
    TAIL="$(tail -n 80 "$TRANSCRIPT_PATH" 2>/dev/null | tr -d '\r' | head -c 8000)"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if command -v python3 >/dev/null 2>&1; then
    BODY="$(SESSION_ID="$SESSION_ID" AGENT_ID="$AGENT_ID" SLOT="$SLOT" \
            EXIT_REASON="$EXIT_REASON" TAIL="$TAIL" TS="$TS" python3 -c '
import json, os
slot = os.environ.get("SLOT") or None
try:
    slot = int(slot) if slot is not None else None
except Exception:
    slot = None
payload = {
    "session_id":      os.environ.get("SESSION_ID") or None,
    "agent_id":        os.environ.get("AGENT_ID") or None,
    "slot":            slot,
    "transcript_tail": os.environ.get("TAIL") or None,
    "exit_reason":     os.environ.get("EXIT_REASON") or None,
    "ts":              os.environ.get("TS"),
}
print(json.dumps({k: v for k, v in payload.items() if v is not None}))
')"
else
    clean() { printf '%s' "$1" | tr -d '"\\\n\r' | head -c 2000; }
    BODY="{\"session_id\":\"$(clean "$SESSION_ID")\",\"agent_id\":\"$(clean "$AGENT_ID")\",\"exit_reason\":\"$(clean "$EXIT_REASON")\",\"transcript_tail\":\"$(clean "$TAIL")\",\"ts\":\"$TS\"}"
fi

curl -s --max-time 2 -H 'Content-Type: application/json' \
    -X POST --data "$BODY" "$ENDPOINT" >/dev/null 2>&1 || true

exit 0
