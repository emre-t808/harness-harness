#!/bin/bash
# state-nudge.sh — PostToolUse hook (Edit, Write)
#
# Nudges Claude to update session state when making edits.
# Performance target: <20ms (file existence check only).

PROJECT_DIR="{{PROJECT_DIR}}"
SESSION="${CLAUDE_SESSION_ID:-unknown}"
STATE_FILE="${PROJECT_DIR}/.harness/sessions/${SESSION}/state.md"

if [ "$SESSION" = "unknown" ] || [ -z "$SESSION" ]; then
  exit 0
fi

if [ -f "$STATE_FILE" ]; then
  printf '{"additionalContext":"If working context changed, update .harness/sessions/%s/state.md."}' "$SESSION"
else
  printf '{"additionalContext":"Create .harness/sessions/%s/state.md with current objective and working context."}' "$SESSION"
fi

exit 0
