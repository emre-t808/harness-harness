#!/bin/bash
# hh-assembler-fallback.sh — UserPromptSubmit fallback
#
# Checks if the Smart Assembler produced output. If not, injects minimal context.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Source event-log helper if available (non-fatal if missing).
HH_HOOKS_LIB="${PROJECT_DIR}/.claude/hooks/lib"
[ -f "$HH_HOOKS_LIB/event-log.sh" ] && . "$HH_HOOKS_LIB/event-log.sh"
SESSION="${CLAUDE_SESSION_ID:-unknown}"

MARKER_DIR="${HOME}/.cache/harness-harness"
mkdir -p "$MARKER_DIR"
MARKER_FILE="${MARKER_DIR}/assembler-success"
SESSION_ID="${CLAUDE_SESSION_ID:-default}"
MARKER_SESSION_FILE="${MARKER_DIR}/assembler-check-${SESSION_ID}"

if [ -f "$MARKER_FILE" ]; then
    MARKER_TIME=$(stat -f %m "$MARKER_FILE" 2>/dev/null || stat -c %Y "$MARKER_FILE" 2>/dev/null || echo "0")
    LAST_CHECK=$(cat "$MARKER_SESSION_FILE" 2>/dev/null || echo "0")

    if [ "$MARKER_TIME" -gt "$LAST_CHECK" ]; then
        echo "$MARKER_TIME" > "$MARKER_SESSION_FILE"
        type hh_log_event >/dev/null 2>&1 && hh_log_event UserPromptSubmit assembler-fallback.sh skip 0 '{"reason":"assembler succeeded"}'
        exit 0
    fi
fi

type hh_log_event >/dev/null 2>&1 && hh_log_event UserPromptSubmit assembler-fallback.sh end 0 '{"reason":"assembler missing or stale; injecting fallback"}'

cat << 'EOF'
<rules-reminder>
The Smart Assembler did not produce output. Showing defaults.
Check your route configs in .harness/routes/ and run: harness-harness health
</rules-reminder>
EOF
