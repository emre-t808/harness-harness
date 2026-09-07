#!/bin/bash
# hh-pre-compact.sh — PreCompact hook
#
# Marks and flushes saved session state before compaction. The marker is not
# a semantic checkpoint: the agent owns the CONTENT of state.md; this hook
# only preserves what was saved. Payload-first identity (PRD §5.3): an
# explicitly invalid payload identity is rejected without any write, and a
# missing identity is a visible no-op — never a shared "unknown" directory.
#
# Input:  JSON on stdin with { session_id, source: "manual"|"auto" }
# Output: NONE (side-effect only)

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
HARNESS_DIR="${PROJECT_DIR}/.harness"
SESSIONS_DIR="${HARNESS_DIR}/sessions"

if [ ! -d "$HARNESS_DIR" ]; then
  exit 0
fi

TMPFILE=""
cleanup_payload() { [ -n "$TMPFILE" ] && rm -f -- "$TMPFILE"; }
trap cleanup_payload EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! TMPFILE=$(mktemp "${TMPDIR:-/tmp}/hh-pre-compact.XXXXXX"); then
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

CLIENT="${HH_CLIENT:-{{HH_CLIENT}}}"
case "$CLIENT" in
  claude|codex) STORAGE_KEY="${CLIENT}--${SESSION}" ;;
  *) CLIENT=""; STORAGE_KEY="$SESSION" ;;
esac

# Storage-key directory wins; an unprefixed legacy directory is written only
# when no other client claims the same raw id (never merge, never guess).
SESSION_DIR="${SESSIONS_DIR}/${STORAGE_KEY}"
if [ ! -d "$SESSION_DIR" ] && [ "$STORAGE_KEY" != "$SESSION" ] && [ -d "${SESSIONS_DIR}/${SESSION}" ]; then
  CONFLICT=""
  for other in claude codex; do
    [ "$other" = "$CLIENT" ] && continue
    [ -d "${SESSIONS_DIR}/${other}--${SESSION}" ] && CONFLICT="yes"
  done
  if [ -z "$CONFLICT" ]; then
    SESSION_DIR="${SESSIONS_DIR}/${SESSION}"
  fi
fi

mkdir -p "$SESSION_DIR"
STATE_FILE="${SESSION_DIR}/state.md"
if [ -f "$STATE_FILE" ]; then
  if ! grep -q "pre-compact-snapshot" "$STATE_FILE" 2>/dev/null; then
    echo "" >> "$STATE_FILE"
    echo "<!-- pre-compact-snapshot: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->" >> "$STATE_FILE"
  fi
fi

# Flush: ensure trace JSONL is complete (append-only; safety sync).
DATE_DIR=$(date -u +%Y-%m-%d)
TRACE_FILE="${PROJECT_DIR}/.claude/traces/${DATE_DIR}/${STORAGE_KEY}.jsonl"
if [ -f "$TRACE_FILE" ]; then
  sync "$TRACE_FILE" 2>/dev/null || true
fi

echo "[hh-pre-compact] State saved for session ${SESSION}" >&2
exit 0
