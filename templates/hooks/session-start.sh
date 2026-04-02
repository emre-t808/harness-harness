#!/bin/bash
# hh-session-start.sh — SessionStart hook
#
# Fires when a Claude Code session begins or resumes.
# Creates session directory and injects initial context.
#
# Input:  JSON on stdin with { session_id, source: "startup"|"resume"|"clear"|"compact" }
# Output: stdout (context injected into Claude)

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
HARNESS_DIR="${PROJECT_DIR}/.harness"
SESSIONS_DIR="${HARNESS_DIR}/sessions"
SESSION="${CLAUDE_SESSION_ID:-unknown}"

# Skip if harness not initialized
if [ ! -d "$HARNESS_DIR" ]; then
  exit 0
fi

# Read source from stdin
SOURCE="startup"
TMPFILE=$(mktemp /tmp/hh-session-start-XXXXXX.json)
cat > "$TMPFILE"
if command -v python3 &>/dev/null; then
  SOURCE=$(python3 -c "import json,sys; d=json.load(open('$TMPFILE')); print(d.get('source','startup'))" 2>/dev/null || echo "startup")
fi
rm -f "$TMPFILE"

# Create session directory if it doesn't exist
SESSION_DIR="${SESSIONS_DIR}/${SESSION}"
if [ ! -d "$SESSION_DIR" ]; then
  mkdir -p "$SESSION_DIR"
  cat > "${SESSION_DIR}/state.md" <<STATEEOF
---
session: ${SESSION}
started: $(date -u +%Y-%m-%dT%H:%M:%SZ)
intent: general
branch: $(cd "$PROJECT_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
---

## Current Objective
(not set)

## Working Context
(none yet)

## Active Decisions
(none yet)

## Blockers
(none)
STATEEOF
  cat > "${SESSION_DIR}/decisions.md" <<DECEOF
## Decisions Log

(no decisions yet)
DECEOF
fi

# Inject session restoration context
echo "<session-start source=\"${SOURCE}\" session=\"${SESSION}\">"

# Git context
BRANCH=$(cd "$PROJECT_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
echo "Branch: ${BRANCH}"

UNCOMMITTED=$(cd "$PROJECT_DIR" && git status --porcelain 2>/dev/null | head -5)
if [ -n "$UNCOMMITTED" ]; then
  COUNT=$(cd "$PROJECT_DIR" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  echo "Uncommitted changes: ${COUNT} files"
  echo "$UNCOMMITTED"
fi

RECENT_COMMITS=$(cd "$PROJECT_DIR" && git log --oneline -3 2>/dev/null)
if [ -n "$RECENT_COMMITS" ]; then
  echo "Recent commits:"
  echo "$RECENT_COMMITS"
fi

# Restore session state if resuming
if [ "$SOURCE" = "resume" ] || [ "$SOURCE" = "compact" ]; then
  STATE_FILE="${SESSION_DIR}/state.md"
  if [ -f "$STATE_FILE" ]; then
    echo ""
    echo "Restored session state:"
    cat "$STATE_FILE"
  fi
fi

# Active work status
WORK_STATUS="${HARNESS_DIR}/memory/work-status.md"
if [ -f "$WORK_STATUS" ]; then
  ACTIVE=$(sed -n '/## Active Work/,/^## /p' "$WORK_STATUS" | head -20)
  if [ -n "$ACTIVE" ]; then
    echo ""
    echo "$ACTIVE"
  fi
fi

echo "</session-start>"

exit 0
