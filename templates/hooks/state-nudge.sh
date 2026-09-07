#!/bin/bash
# hh-state-nudge.sh — PostToolUse hook (Edit|Write)
#
# Nudges the agent to update session state when making edits. Payload-first
# identity (PRD §5.3): an invalid explicit identity emits nothing; a missing
# identity is a visible no-op.
#
# Input:  JSON on stdin with { session_id, tool_name }
# Output: JSON with additionalContext field

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
SESSIONS_DIR="${PROJECT_DIR}/.harness/sessions"

TMPFILE=""
cleanup_payload() { [ -n "$TMPFILE" ] && rm -f -- "$TMPFILE"; }
trap cleanup_payload EXIT
if ! TMPFILE=$(mktemp "${TMPDIR:-/tmp}/hh-state-nudge.XXXXXX"); then
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
trap - EXIT

CLIENT="${HH_CLIENT:-{{HH_CLIENT}}}"
case "$CLIENT" in
  claude|codex) STORAGE_KEY="${CLIENT}--${SESSION}" ;;
  *) CLIENT=""; STORAGE_KEY="$SESSION" ;;
esac

STATE_DIR="${SESSIONS_DIR}/${STORAGE_KEY}"
if [ ! -d "$STATE_DIR" ] && [ "$STORAGE_KEY" != "$SESSION" ] && [ -d "${SESSIONS_DIR}/${SESSION}" ]; then
  CONFLICT=""
  for other in claude codex; do
    [ "$other" = "$CLIENT" ] && continue
    [ -d "${SESSIONS_DIR}/${other}--${SESSION}" ] && CONFLICT="yes"
  done
  [ -z "$CONFLICT" ] && STATE_DIR="${SESSIONS_DIR}/${SESSION}"
fi

STATE_REL="${STATE_DIR#"$PROJECT_DIR"/}/state.md"
if [ -f "${STATE_DIR}/state.md" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"If working context changed, update %s."}}' "$STATE_REL"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Create %s with current objective and working context."}}' "$STATE_REL"
fi

exit 0
