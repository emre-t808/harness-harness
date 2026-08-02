#!/bin/bash
# hh-assembler-fallback.sh — UserPromptSubmit fallback
#
# Checks if the Smart Assembler produced output. If not, injects minimal context.
#
# Session identity comes from the hook's stdin JSON payload (session_id), the
# same source trace-capture.sh uses. CLAUDE_SESSION_ID is only a fallback: it
# is not exported to hook processes, so relying on it collapsed every session
# into one shared "default" state file — and because the skip path stores the
# marker mtime it just credited, the first prompt of each NEW session then saw
# marker == stored and fired a spurious banner.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

HOOK_INPUT=$(cat 2>/dev/null || true)
SESSION_ID=$(printf '%s' "$HOOK_INPUT" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("session_id") or "")
except Exception:
    print("")
' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_SESSION_ID:-default}"

# Source event-log helper if available (non-fatal if missing).
HH_HOOKS_LIB="${PROJECT_DIR}/.claude/hooks/lib"
[ -f "$HH_HOOKS_LIB/event-log.sh" ] && . "$HH_HOOKS_LIB/event-log.sh"
SESSION="$SESSION_ID"

MARKER_DIR="${HOME}/.cache/harness-harness"
mkdir -p "$MARKER_DIR"
MARKER_FILE="${MARKER_DIR}/assembler-success"
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
The Smart Assembler did not produce output since the last prompt (its success
marker in ~/.cache/harness-harness/ is stale). Showing defaults.
Check the route configs your assembler actually loads (routesDir in
.harness/config.json) and run: harness-harness health
</rules-reminder>
EOF
