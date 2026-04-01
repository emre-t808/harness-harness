#!/bin/bash
# trace-capture.sh — PostToolUse hook: appends one JSONL line per tool event
#
# Input:  JSON on stdin with: tool_name, tool_input, tool_response, session_id
# Output: NONE (must not inject context into Claude)
# Side effect: appends to .claude/traces/{YYYY-MM-DD}/{session}.jsonl

PROJECT_DIR="{{PROJECT_DIR}}"
DATE_DIR=$(date -u +%Y-%m-%d)
SESSION="${CLAUDE_SESSION_ID:-unknown}"

TRACE_DIR="${PROJECT_DIR}/.claude/traces/${DATE_DIR}"
TRACE_FILE="${TRACE_DIR}/${SESSION}.jsonl"

mkdir -p "$TRACE_DIR"

TMPFILE=$(mktemp /tmp/hh-trace-capture-XXXXXX.json)
cat > "$TMPFILE"

python3 - "$TMPFILE" "$SESSION" "$PROJECT_DIR" >> "$TRACE_FILE" 2>/dev/null <<'PYEOF'
import json, re, sys, datetime

stdin_file = sys.argv[1] if len(sys.argv) > 1 else None
env_session = sys.argv[2] if len(sys.argv) > 2 else None
base_dir = (sys.argv[3] + "/") if len(sys.argv) > 3 else ""

try:
    with open(stdin_file, 'r', encoding='utf-8') as f:
        data = json.loads(f.read())
except Exception:
    data = {}

tool_name = data.get("tool_name") or data.get("tool") or None
tool_input = data.get("tool_input") or {}
tool_response = data.get("tool_response") or data.get("tool_result") or ""
session_id = env_session or data.get("session_id") or "unknown"

if not isinstance(tool_response, str):
    tool_response = json.dumps(tool_response)

def strip_base(path):
    if path and base_dir and path.startswith(base_dir):
        return path[len(base_dir):]
    return path or ""

def build_input_summary(name, inp):
    if not inp: return ""
    if name in ("Read", "Write", "Edit"):
        return strip_base(inp.get("file_path", ""))
    if name == "Bash":
        return (inp.get("command") or "")[:80]
    if name == "Grep":
        return f'grep "{inp.get("pattern", "")}" in {strip_base(inp.get("path", ""))}'
    if name == "Glob":
        return f'glob "{inp.get("pattern", "")}" in {strip_base(inp.get("path", ""))}'
    if name == "Agent":
        return (inp.get("description") or inp.get("prompt") or "")[:80]
    return json.dumps(inp)[:80]

def bash_outcome(response):
    lower = response.lower()
    if (re.search(r'\bfail\b', lower) or
            re.search(r'(?<!0 )failed\b', lower) or
            'error:' in lower or 'fatal:' in lower):
        return "fail"
    if re.search(r'\bpass\b', lower) or re.search(r'\bsuccess\b', lower):
        return "pass"
    return None

def extract_rule_ids(text):
    if not text: return []
    seen = []
    for m in re.findall(r'\b([A-Z]{2,4}-\d{2,4})\b', text):
        if m not in seen: seen.append(m)
    return seen

file_path = tool_input.get("file_path") if tool_input else None
files_touched = [strip_base(file_path)] if file_path else []

event = {
    "ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "session": session_id,
    "turn": None,
    "tool": tool_name,
    "input_summary": build_input_summary(tool_name, tool_input),
    "output_size": len(tool_response),
    "duration_ms": None,
    "referenced_context": extract_rule_ids(tool_response),
    "files_touched": files_touched,
    "outcome": bash_outcome(tool_response) if tool_name == "Bash" else None,
}

print(json.dumps(event))
PYEOF

rm -f "$TMPFILE"
exit 0
