#!/usr/bin/env bash
# Smoke test for templates/hooks/trace-capture.sh — verifies the
# stdin-first session_id resolution and the session-{id}.jsonl naming.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRACE_CAPTURE="$SCRIPT_DIR/trace-capture.sh"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1" >&2; exit 1; }

run_case() {
  local name="$1" payload="$2" env_session="$3" expected_filename="$4"
  local tmpdir
  tmpdir=$(mktemp -d)
  CLAUDE_PROJECT_DIR="$tmpdir" CLAUDE_SESSION_ID="$env_session" \
    bash "$TRACE_CAPTURE" <<<"$payload"
  local today
  today=$(date -u +%Y-%m-%d)
  local actual="$tmpdir/.claude/traces/$today/$expected_filename"
  if [ ! -f "$actual" ]; then
    echo "    [debug] dir contents:" >&2
    ls -la "$tmpdir/.claude/traces/$today/" >&2 2>/dev/null || true
    fail "$name — expected file not found: $actual"
  fi
  pass "$name"
  rm -rf "$tmpdir"
}

echo "Testing trace-capture.sh session-id resolution..."

run_case "stdin session_id wins over env" \
  '{"session_id":"session-from-stdin","tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'session-from-env' \
  'session-from-stdin.jsonl'

run_case "env CLAUDE_SESSION_ID used when stdin lacks session_id" \
  '{"tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'session-from-env' \
  'session-from-env.jsonl'

run_case "falls back to unknown when both missing" \
  '{"tool_name":"Bash","tool_input":{},"tool_response":""}' \
  '' \
  'unknown.jsonl'

run_case "rejects path traversal in stdin session_id" \
  '{"session_id":"../etc/passwd","tool_name":"Bash","tool_input":{},"tool_response":""}' \
  '' \
  'unknown.jsonl'

run_case "joins with manifest when real session_id used" \
  '{"session_id":"session-1778310466583","tool_name":"Bash","tool_input":{},"tool_response":""}' \
  '' \
  'session-1778310466583.jsonl'

echo "All trace-capture.sh tests passed."
