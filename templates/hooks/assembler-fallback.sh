#!/bin/bash
# assembler-fallback.sh — Fallback when Smart Assembler fails
#
# Checks if assembler produced output. If not, injects minimal rules.

MARKER_FILE="/tmp/harness-harness-assembler-success"
SESSION_ID="${CLAUDE_SESSION_ID:-default}"
MARKER_SESSION_FILE="/tmp/hh-assembler-check-${SESSION_ID}"

if [ -f "$MARKER_FILE" ]; then
    MARKER_TIME=$(stat -f %m "$MARKER_FILE" 2>/dev/null || stat -c %Y "$MARKER_FILE" 2>/dev/null || echo "0")
    LAST_CHECK=$(cat "$MARKER_SESSION_FILE" 2>/dev/null || echo "0")

    if [ "$MARKER_TIME" -gt "$LAST_CHECK" ]; then
        echo "$MARKER_TIME" > "$MARKER_SESSION_FILE"
        exit 0
    fi
fi

cat << 'EOF'
<rules-reminder>
The Smart Assembler did not produce output. Showing defaults.
Check your route configs in .harness/routes/ and run: harness-harness health
</rules-reminder>
EOF
