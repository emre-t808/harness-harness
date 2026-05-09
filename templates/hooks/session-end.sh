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
SESSION="${CLAUDE_SESSION_ID:-unknown}"

# Source event-log helper if available (non-fatal if missing).
HH_HOOKS_LIB="${PROJECT_DIR}/.claude/hooks/lib"
[ -f "$HH_HOOKS_LIB/event-log.sh" ] && . "$HH_HOOKS_LIB/event-log.sh"
type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh start 0

# Skip if harness not initialized
if [ ! -d "$HARNESS_DIR" ]; then
  type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh skip 0
  exit 0
fi

DATE_DIR=$(date -u +%Y-%m-%d)
TRACES_DIR="${PROJECT_DIR}/.claude/traces"
TRACE_FILE="${TRACES_DIR}/${DATE_DIR}/${SESSION}.jsonl"
SUMMARY_FILE="${TRACES_DIR}/${DATE_DIR}/${SESSION}-summary.md"

# If trace file exists but summary doesn't, the Stop hook was missed.
# Run the session summary as a fallback.
if [ -f "$TRACE_FILE" ] && [ ! -f "$SUMMARY_FILE" ]; then
  SUMMARY_HOOK="${PROJECT_DIR}/.claude/hooks/hh-session-summary.js"
  if [ -f "$SUMMARY_HOOK" ]; then
    echo "{\"session_id\":\"${SESSION}\"}" | node "$SUMMARY_HOOK" 2>/dev/null || true
    type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh decision 0 '{"action":"ran-missed-summary"}'
  fi
fi

# Archive session state
SESSION_DIR="${HARNESS_DIR}/sessions/${SESSION}"
if [ -d "$SESSION_DIR" ]; then
  ARCHIVE_DIR="${HARNESS_DIR}/sessions/archive/${DATE_DIR}"
  mkdir -p "$ARCHIVE_DIR"
  if [ ! -d "${ARCHIVE_DIR}/${SESSION}" ]; then
    mv "$SESSION_DIR" "${ARCHIVE_DIR}/${SESSION}" 2>/dev/null || true
    type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh decision 0 '{"action":"archived-session"}'
  fi
fi

type hh_log_event >/dev/null 2>&1 && hh_log_event SessionEnd session-end.sh end 0
exit 0
