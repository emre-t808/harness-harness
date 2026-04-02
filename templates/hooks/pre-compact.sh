#!/bin/bash
# hh-pre-compact.sh — PreCompact hook
#
# Fires before context compaction. Saves working state to filesystem
# so nothing is lost when Claude's context window is compressed.
#
# Input:  JSON on stdin with { session_id, source: "manual"|"auto" }
# Output: NONE (side-effect only)

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
HARNESS_DIR="${PROJECT_DIR}/.harness"
SESSION="${CLAUDE_SESSION_ID:-unknown}"
SESSION_DIR="${HARNESS_DIR}/sessions/${SESSION}"

# Skip if harness not initialized
if [ ! -d "$HARNESS_DIR" ]; then
  exit 0
fi

# Ensure session directory exists
mkdir -p "$SESSION_DIR"

# Timestamp the state file to mark pre-compact snapshot
STATE_FILE="${SESSION_DIR}/state.md"
if [ -f "$STATE_FILE" ]; then
  # Add a pre-compact marker if not already present
  if ! grep -q "pre-compact-snapshot" "$STATE_FILE" 2>/dev/null; then
    echo "" >> "$STATE_FILE"
    echo "<!-- pre-compact-snapshot: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->" >> "$STATE_FILE"
  fi
fi

# Flush: ensure trace JSONL is complete
# (the trace file is append-only, so this is a no-op — just a safety marker)
DATE_DIR=$(date -u +%Y-%m-%d)
TRACE_FILE="${PROJECT_DIR}/.claude/traces/${DATE_DIR}/${SESSION}.jsonl"
if [ -f "$TRACE_FILE" ]; then
  sync "$TRACE_FILE" 2>/dev/null || true
fi

# Write to stderr (shown in verbose mode) for debugging
echo "[hh-pre-compact] State saved for session ${SESSION}" >&2

exit 0
