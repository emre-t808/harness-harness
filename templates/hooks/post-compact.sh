#!/bin/bash
# hh-post-compact.sh — PostCompact hook
#
# Re-injects essential context from the filesystem after compaction. The
# harness restores exactly what was saved and reports missing state — it
# never synthesizes objectives. Payload-first identity (PRD §5.3).
#
# Input:  JSON on stdin with { session_id, source: "manual"|"auto" }
# Output: stdout (context re-injected into the client)

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

CLIENT="${HH_CLIENT:-{{HH_CLIENT}}}"
case "$CLIENT" in
  claude|codex) STORAGE_KEY="${CLIENT}--${SESSION}" ;;
  *) CLIENT=""; STORAGE_KEY="$SESSION" ;;
esac

# Project path configuration (package defaults preserved for other consumers):
# .harness/config.json may set workStatusFile and routesDir project-relative.
CONFIG=$(python3 - "$PROJECT_DIR" <<'PYEOF'
import json, os, sys
cfg = {}
try:
    with open(os.path.join(sys.argv[1], '.harness', 'config.json'), encoding='utf-8') as f:
        cfg = json.load(f)
except Exception:
    pass
ws = cfg.get('workStatusFile') if isinstance(cfg.get('workStatusFile'), str) else ''
routes = cfg.get('routesDir') if isinstance(cfg.get('routesDir'), str) else ''
print(ws or '.harness/memory/work-status.md')
print(routes or '.harness/routes')
PYEOF
)
WORK_STATUS_REL=$(printf '%s\n' "$CONFIG" | sed -n '1p')
ROUTES_REL=$(printf '%s\n' "$CONFIG" | sed -n '2p')

# Storage-key directory wins; unprefixed legacy state is readable only when
# no other client claims the same raw id. On conflict, preserve both and say so.
SESSION_DIR="${SESSIONS_DIR}/${STORAGE_KEY}"
CONFLICT_DIR=""
if [ ! -d "$SESSION_DIR" ] && [ "$STORAGE_KEY" != "$SESSION" ] && [ -d "${SESSIONS_DIR}/${SESSION}" ]; then
  CONFLICT=""
  for other in claude codex; do
    [ "$other" = "$CLIENT" ] && continue
    [ -d "${SESSIONS_DIR}/${other}--${SESSION}" ] && CONFLICT="${SESSIONS_DIR}/${other}--${SESSION}"
  done
  if [ -z "$CONFLICT" ]; then
    SESSION_DIR="${SESSIONS_DIR}/${SESSION}"
  else
    CONFLICT_DIR="$CONFLICT"
  fi
fi

echo "<context-restored after=\"compaction\" session=\"${SESSION}\">"
echo ""

# 1. Re-inject project identity (compact version)
CLAUDE_MD="${PROJECT_DIR}/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  echo "## Project Identity"
  head -100 "$CLAUDE_MD"
  echo ""
fi

# 2. Re-inject session state (objectives, decisions, blockers)
STATE_FILE="${SESSION_DIR}/state.md"
if [ -f "$STATE_FILE" ]; then
  echo "## Session State (restored from filesystem)"
  cat "$STATE_FILE"
  echo ""
else
  echo "## Session State"
  echo "No saved session state found for ${SESSION} — the harness restores what was saved; nothing was."
  echo ""
fi
if [ -n "$CONFLICT_DIR" ]; then
  echo "## Session State Conflict"
  echo "Legacy state '${SESSIONS_DIR}/${SESSION}' is also claimed by '${CONFLICT_DIR}'."
  echo "Both are preserved unmerged; resolve ownership manually."
  echo ""
fi

# 3. Re-inject active work status (configured location)
WORK_STATUS="${PROJECT_DIR}/${WORK_STATUS_REL}"
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

# 5. Compact route hint (configured routes location)
echo "## Context System"
echo "Routes available in ${ROUTES_REL}/. The Smart Assembler will load"
echo "task-specific rules on your next message. Update session state in"
echo "${SESSION_DIR#"$PROJECT_DIR"/}/state.md if the working context has changed."

echo ""
echo "</context-restored>"

exit 0
