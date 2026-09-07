#!/bin/bash
# hh-session-end.sh — SessionEnd hook
#
# Fires when the session actually terminates (user exits, clears, etc.).
# Ensures summary is written even if Stop hook was skipped.
#
# Input:  JSON on stdin with { session_id, source: "clear"|"resume"|"logout"|"prompt_input_exit"|... }
# Output: NONE (side-effect only)

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
HARNESS_DIR="${PROJECT_DIR}/.harness"

# Source event-log helper if available (non-fatal if missing).
HH_HOOKS_LIB="${PROJECT_DIR}/.claude/hooks/lib"
[ -f "$HH_HOOKS_LIB/event-log.sh" ] && . "$HH_HOOKS_LIB/event-log.sh"
type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh start 0

# Skip if harness not initialized
if [ ! -d "$HARNESS_DIR" ]; then
  type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh skip 0
  exit 0
fi

# Payload-first identity (PRD §5.3): invalid explicit identity → no writes.
TMPFILE=""
cleanup_payload() { [ -n "$TMPFILE" ] && rm -f -- "$TMPFILE"; }
trap cleanup_payload EXIT
if ! TMPFILE=$(mktemp "${TMPDIR:-/tmp}/hh-session-end.XXXXXX"); then
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
HOOKS_DIR="{{HH_HOOKS_DIR}}"
case "$HOOKS_DIR" in *"{{"*) HOOKS_DIR=".claude/hooks" ;; esac

DATE_DIR=$(date -u +%Y-%m-%d)
TRACES_DIR="${PROJECT_DIR}/.claude/traces"
TRACE_FILE="${TRACES_DIR}/${DATE_DIR}/${STORAGE_KEY}.jsonl"
[ -f "$TRACE_FILE" ] || TRACE_FILE="${TRACES_DIR}/${DATE_DIR}/${SESSION}.jsonl"
SUMMARY_FILE="${TRACES_DIR}/${DATE_DIR}/${STORAGE_KEY}-summary.md"

# If trace file exists but summary doesn't, the Stop hook was missed.
# Run the session summary as a fallback.
if [ -f "$TRACE_FILE" ] && [ ! -f "$SUMMARY_FILE" ]; then
  SUMMARY_HOOK="${PROJECT_DIR}/${HOOKS_DIR}/hh-session-summary.js"
  if [ -f "$SUMMARY_HOOK" ]; then
    echo "{\"session_id\":\"${SESSION}\"}" | node "$SUMMARY_HOOK" 2>/dev/null || true
    type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh decision 0 '{"action":"ran-missed-summary"}'
  fi
fi

# Archive session state (storage-key directory; legacy dirs stay untouched)
SESSION_DIR="${HARNESS_DIR}/sessions/${STORAGE_KEY}"
if [ -d "$SESSION_DIR" ]; then
  ARCHIVE_DIR="${HARNESS_DIR}/sessions/archive/${DATE_DIR}"
  mkdir -p "$ARCHIVE_DIR"
  if [ ! -d "${ARCHIVE_DIR}/${STORAGE_KEY}" ]; then
    mv "$SESSION_DIR" "${ARCHIVE_DIR}/${STORAGE_KEY}" 2>/dev/null || true
    type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh decision 0 '{"action":"archived-session"}'
  fi
fi

type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh end 0
exit 0
