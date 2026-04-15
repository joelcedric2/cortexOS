#!/bin/sh
# Phase 1 — Agent A
# Claude Code `PreCompact` hook → POST to cortexOS hooks server.
#
# Install (same as stop.sh):
#     ln -s ../../scripts/claude-hooks/pre-compact.sh .claude/hooks/pre-compact.sh
#     chmod +x .claude/hooks/pre-compact.sh
#
# The server does the heavy lifting (chunk + embed + pgvector store). This hook
# just tells the server *where* the transcript lives.
#
# Idempotent + non-blocking: failures are swallowed, exit 0 always.

set -u

HOOKS_URL="${CORTEXOS_HOOKS_URL:-http://localhost:3102}"
ENDPOINT="${HOOKS_URL%/}/hooks/pre-compact"

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
TASK_ID="$(extract_field task_id)"
TRANSCRIPT_PATH="$(extract_field transcript_path)"

# Fallback: if the hook input didn't carry transcript_path, reconstruct the
# conventional Claude Code location:  ~/.claude/projects/<dashed-cwd>/<session>.jsonl
if [ -z "$TRANSCRIPT_PATH" ] && [ -n "$SESSION_ID" ]; then
    DASHED_CWD="$(pwd | sed 's|/|-|g')"
    CANDIDATE="$HOME/.claude/projects/${DASHED_CWD}/${SESSION_ID}.jsonl"
    if [ -r "$CANDIDATE" ]; then
        TRANSCRIPT_PATH="$CANDIDATE"
    fi
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if command -v python3 >/dev/null 2>&1; then
    BODY="$(SESSION_ID="$SESSION_ID" TASK_ID="$TASK_ID" \
            TRANSCRIPT_PATH="$TRANSCRIPT_PATH" TS="$TS" python3 -c '
import json, os
payload = {
    "session_id":      os.environ.get("SESSION_ID") or None,
    "task_id":         os.environ.get("TASK_ID") or None,
    "transcript_path": os.environ.get("TRANSCRIPT_PATH") or None,
    "ts":              os.environ.get("TS"),
}
print(json.dumps({k: v for k, v in payload.items() if v is not None}))
')"
else
    clean() { printf '%s' "$1" | tr -d '"\\\n\r' | head -c 2000; }
    BODY="{\"session_id\":\"$(clean "$SESSION_ID")\",\"task_id\":\"$(clean "$TASK_ID")\",\"transcript_path\":\"$(clean "$TRANSCRIPT_PATH")\",\"ts\":\"$TS\"}"
fi

curl -s --max-time 2 -H 'Content-Type: application/json' \
    -X POST --data "$BODY" "$ENDPOINT" >/dev/null 2>&1 || true

exit 0
