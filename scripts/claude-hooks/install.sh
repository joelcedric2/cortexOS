#!/bin/sh
# Install the Claude Code hooks for cortexOS.
# Creates .claude/hooks/{stop,pre-compact}.sh (symlinks) and makes them executable.
#
# Run from the repo root:
#     sh scripts/claude-hooks/install.sh

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.claude/hooks"

mkdir -p "$HOOKS_DIR"

for name in stop.sh pre-compact.sh; do
    src="$REPO_ROOT/scripts/claude-hooks/$name"
    dst="$HOOKS_DIR/$name"
    if [ -e "$dst" ] || [ -L "$dst" ]; then
        rm "$dst"
    fi
    # Prefer a symlink so future edits in scripts/ propagate; fall back to copy.
    ln -s "$src" "$dst" 2>/dev/null || cp "$src" "$dst"
    chmod +x "$src" "$dst" 2>/dev/null || true
done

echo "[install] Installed hooks in $HOOKS_DIR"
echo "[install] Merge docs/phase-1/settings-hooks-snippet.json into .claude/settings.json"
