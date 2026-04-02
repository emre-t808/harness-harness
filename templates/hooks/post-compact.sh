#!/bin/bash
# hh-post-compact.sh — PostCompact hook
#
# Fires after context compaction. Re-injects essential context from filesystem
# so Claude immediately has identity, active work, and session state.
#
# This is the killer feature: compaction becomes beneficial garbage collection
# instead of catastrophic information loss.
#
# Input:  JSON on stdin with { session_id, source: "manual"|"auto" }
# Output: stdout (context re-injected into Claude)

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
HARNESS_DIR="${PROJECT_DIR}/.harness"
SESSION="${CLAUDE_SESSION_ID:-unknown}"
SESSION_DIR="${HARNESS_DIR}/sessions/${SESSION}"

# Skip if harness not initialized
if [ ! -d "$HARNESS_DIR" ]; then
  exit 0
fi

echo "<context-restored after=\"compaction\" session=\"${SESSION}\">"
echo ""

# 1. Re-inject project identity (compact version)
CLAUDE_MD="${PROJECT_DIR}/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  echo "## Project Identity"
  # Take first 100 lines as compact identity
  head -100 "$CLAUDE_MD"
  echo ""
fi

# 2. Re-inject session state (objectives, decisions, blockers)
STATE_FILE="${SESSION_DIR}/state.md"
if [ -f "$STATE_FILE" ]; then
  echo "## Session State (restored from filesystem)"
  cat "$STATE_FILE"
  echo ""
fi

# 3. Re-inject active work status
WORK_STATUS="${HARNESS_DIR}/memory/work-status.md"
if [ -f "$WORK_STATUS" ]; then
  ACTIVE=$(sed -n '/## Active Work/,/^## /p' "$WORK_STATUS" | head -30)
  if [ -n "$ACTIVE" ]; then
    echo "## Active Work"
    echo "$ACTIVE"
    echo ""
  fi
fi

# 4. Re-inject recent decisions
DECISIONS_FILE="${SESSION_DIR}/decisions.md"
if [ -f "$DECISIONS_FILE" ]; then
  CONTENT=$(cat "$DECISIONS_FILE")
  if [ "$CONTENT" != "## Decisions Log

(no decisions yet)" ]; then
    echo "## Recent Decisions"
    tail -20 "$DECISIONS_FILE"
    echo ""
  fi
fi

# 5. Compact route hint
echo "## Context System"
echo "Routes available in .harness/routes/. The Smart Assembler will load"
echo "task-specific rules on your next message. Update session state in"
echo ".harness/sessions/${SESSION}/state.md if the working context has changed."

echo ""
echo "</context-restored>"

exit 0
