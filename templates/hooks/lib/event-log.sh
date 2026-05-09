#!/bin/sh
# event-log.sh — POSIX-shell helper for emitting events to .harness/local/events.ndjson.
#
# Sourced by bash hook scripts. Mirror of src/lib/event-log.js semantics.
# Non-fatal: if anything goes wrong, the calling hook MUST still succeed.
#
# Usage:
#   . "${CLAUDE_PROJECT_DIR}/.claude/hooks/lib/event-log.sh"
#   hh_log_event <hook> <handler> <phase> [exit_code] [extra_json]
#
# Phases: start | end | error | skip | decision

hh_log_event() {
  local hook="${1:-}" handler="${2:-}" phase="${3:-}" exit_code="${4:-0}" extra="${5:-}"
  # Note: cannot use ${5:-{}} default — POSIX parameter expansion treats the
  # closing `}` after the value as the end of the substitution, leaving a stray
  # literal `}` and producing malformed JSON.
  [ -z "$extra" ] && extra='{}'
  local events_file="${CLAUDE_PROJECT_DIR}/.harness/local/events.ndjson"
  local ts evt_id
  # Always emit ISO-8601 with millisecond precision so timestamps sort
  # correctly alongside Node's Date.toISOString() output. BSD date doesn't
  # support %3N, so we synthesize the ms portion.
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null)
  case "$ts" in
    *3NZ) ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z) ;;
  esac
  evt_id="evt_$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [ -z "$evt_id" ] && evt_id="evt_$(date -u +%s)$$"

  mkdir -p "$(dirname "$events_file")" 2>/dev/null || return 0
  printf '{"ts":"%s","event_id":"%s","hook":"%s","handler":"%s","phase":"%s","exit_code":%s,"session_id":"%s","extra":%s}\n' \
    "$ts" "$evt_id" "$hook" "$handler" "$phase" "$exit_code" "${SESSION:-unknown}" "$extra" \
    >> "$events_file" 2>/dev/null || true
  return 0
}
