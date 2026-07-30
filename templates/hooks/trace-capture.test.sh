#!/usr/bin/env bash
# Smoke test for templates/hooks/trace-capture.sh — verifies the
# stdin-first session_id resolution and the session-{id}.jsonl naming.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRACE_CAPTURE="$SCRIPT_DIR/trace-capture.sh"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1" >&2; exit 1; }

run_case() {
  local name="$1" payload="$2" env_state="$3" env_session="$4" expected_filename="$5"
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "$tmpdir/runtime"
  if [ "$env_state" = "unset" ]; then
    env -u CLAUDE_SESSION_ID CLAUDE_PROJECT_DIR="$tmpdir" TMPDIR="$tmpdir" \
      XDG_RUNTIME_DIR="$tmpdir/runtime" \
      bash "$TRACE_CAPTURE" <<<"$payload"
  else
    CLAUDE_PROJECT_DIR="$tmpdir" CLAUDE_SESSION_ID="$env_session" TMPDIR="$tmpdir" \
      XDG_RUNTIME_DIR="$tmpdir/runtime" \
      bash "$TRACE_CAPTURE" <<<"$payload"
  fi
  local today
  today=$(date -u +%Y-%m-%d)
  local trace_dir="$tmpdir/.claude/traces/$today"
  local actual="$trace_dir/$expected_filename"
  if [ "$expected_filename" = "none" ] && [ -d "$trace_dir" ]; then
    fail "$name — invalid identity constructed a trace directory"
  elif [ "$expected_filename" != "none" ] && [ ! -f "$actual" ]; then
    echo "    [debug] dir contents:" >&2
    ls -la "$trace_dir/" >&2 2>/dev/null || true
    fail "$name — expected file not found: $actual"
  fi
  if find "$tmpdir" -name 'hh-trace-capture.*' -print -quit | grep -q .; then
    fail "$name — captured payload temporary file was not removed"
  fi
  pass "$name"
  rm -rf -- "$tmpdir"
}

echo "Testing trace-capture.sh session-id resolution..."

run_case "stdin session_id wins over env" \
  '{"session_id":"session-from-stdin","tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'set' \
  'session-from-env' \
  'session-from-stdin.jsonl'

run_case "env CLAUDE_SESSION_ID used when stdin lacks session_id" \
  '{"tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'set' \
  'session-from-env' \
  'session-from-env.jsonl'

run_case "falls back to unknown when both missing" \
  '{"tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'unset' \
  '' \
  'unknown.jsonl'

run_case "rejects path traversal in stdin session_id" \
  '{"session_id":"../etc/passwd","tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'set' \
  'safe-environment-must-not-win' \
  'none'

run_case "rejects explicitly empty environment identity" \
  '{"tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'set' \
  '' \
  'none'

run_case "joins with manifest when real session_id used" \
  '{"session_id":"session-1778310466583","tool_name":"Bash","tool_input":{},"tool_response":""}' \
  'unset' \
  '' \
  'session-1778310466583.jsonl'

echo "All trace-capture.sh tests passed."
