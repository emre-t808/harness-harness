#!/bin/bash
# hh-post-compact.sh — PostCompact hook
#
# Fires after context compaction and only records that it happened.
# PostCompact has no injection channel (hookSpecificOutput.additionalContext
# is accepted for SessionStart, UserPromptSubmit, PostToolUse, Stop and
# others, not for PostCompact), so anything printed here is dead output.
# SessionStart(source=compact) → hh-session-start.sh is the path that
# restores session state after a compaction. Payload-first identity
# (PRD §5.3): a missing or invalid identity writes nothing, never a shared
# "unknown" row.
#
# Input:  JSON on stdin with { session_id, trigger: "manual"|"auto", compact_summary }
# Output: NONE (side-effect only)
# Side effect: one PostCompact row in .harness/local/events.ndjson

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
HARNESS_DIR="${PROJECT_DIR}/.harness"

# Source event-log helper if available (non-fatal if missing).
HH_HOOKS_LIB="${PROJECT_DIR}/.claude/hooks/lib"
[ -f "$HH_HOOKS_LIB/event-log.sh" ] && . "$HH_HOOKS_LIB/event-log.sh"

if [ ! -d "$HARNESS_DIR" ]; then
  exit 0
fi

TMPFILE=""
cleanup_payload() { [ -n "$TMPFILE" ] && rm -f -- "$TMPFILE"; }
trap cleanup_payload EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! TMPFILE=$(mktemp "${TMPDIR:-/tmp}/hh-post-compact.XXXXXX"); then
  exit 0
fi
cat > "$TMPFILE"
if ! command -v python3 &>/dev/null; then
  exit 0
fi

SESSION=$(python3 - "$TMPFILE" <<'PYEOF'
import json, os, re, sys
SAFE = re.compile(r'^[A-Za-z0-9._-]{1,128}$')
def safe(v):
    return isinstance(v, str) and v not in ('.', '..') and SAFE.fullmatch(v) is not None
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        payload = json.load(f)
except Exception:
    payload = {}
if not isinstance(payload, dict):
    payload = {}
if 'session_id' in payload and payload['session_id'] is not None:
    session = payload['session_id']
elif 'CLAUDE_SESSION_ID' in os.environ:
    session = os.environ['CLAUDE_SESSION_ID']
else:
    sys.exit(2)
if not safe(session):
    sys.exit(2)
print(session)
PYEOF
) || exit 0
cleanup_payload
trap - EXIT HUP INT TERM

type hh_log_event >/dev/null 2>&1 && hh_log_event PostCompact post-compact.sh end 0
exit 0
