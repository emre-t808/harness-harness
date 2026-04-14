#!/bin/bash
# hh-trace-capture.sh — PostToolUse hook: appends one JSONL line per tool event
#
# Input:  JSON on stdin with: tool_name, tool_input, tool_response, session_id
# Output: NONE (must not inject context into Claude)
# Side effect: appends to .claude/traces/{YYYY-MM-DD}/{session}.jsonl

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
DATE_DIR=$(date -u +%Y-%m-%d)
SESSION="${CLAUDE_SESSION_ID:-unknown}"

TRACE_DIR="${PROJECT_DIR}/.claude/traces/${DATE_DIR}"
TRACE_FILE="${TRACE_DIR}/${SESSION}.jsonl"

mkdir -p "$TRACE_DIR"

TMPFILE=$(mktemp /tmp/hh-trace-capture-XXXXXX.json)
cat > "$TMPFILE"

python3 - "$TMPFILE" "$SESSION" "$PROJECT_DIR" >> "$TRACE_FILE" 2>/dev/null <<'PYEOF'
import base64, json, os, re, sys, datetime

stdin_file = sys.argv[1] if len(sys.argv) > 1 else None
env_session = sys.argv[2] if len(sys.argv) > 2 else None
base_dir = (sys.argv[3] + "/") if len(sys.argv) > 3 else ""

# Phase 8: response_snippet config (default: enabled)
SNIPPET_CAP_BYTES = 2048
def snippet_enabled():
    try:
        cfg_path = os.path.join(base_dir.rstrip('/'), '.harness', 'config.json')
        if not os.path.exists(cfg_path):
            return True
        with open(cfg_path, 'r') as f:
            cfg = json.loads(f.read() or '{}')
        return bool(cfg.get('trace', {}).get('captureResponseSnippets', True))
    except Exception:
        return True

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

def extract_referenced_rules(text, known_rule_ids):
    """Check which known rule IDs appear in tool output. No regex."""
    if not text or not known_rule_ids:
        return []
    return [rid for rid in known_rule_ids if rid in text]

def load_known_rule_ids():
    """Read rule IDs from the current session manifest."""
    cache_dir = os.environ.get('XDG_RUNTIME_DIR') or os.path.join(
        os.environ.get('HOME', '/tmp'), '.cache', 'harness-harness')
    manifest_pointer = os.path.join(cache_dir, 'current-manifest-path')
    try:
        with open(manifest_pointer, 'r') as f:
            manifest_path = f.read().strip()
        with open(manifest_path, 'r') as f:
            manifest = json.loads(f.read())
        rules = manifest.get('rules_injected', [])
        if rules and isinstance(rules[0], dict):
            return [r['id'] for r in rules]
        return list(rules)
    except Exception:
        return []

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
    "referenced_context": extract_referenced_rules(tool_response, load_known_rule_ids()),
    "files_touched": files_touched,
    "outcome": bash_outcome(tool_response) if tool_name == "Bash" else None,
}

# Phase 8: response_snippet for Edit/Write (first 2KB, base64-encoded)
if tool_name in ("Edit", "Write") and snippet_enabled():
    if tool_name == "Edit":
        content_field = tool_input.get("new_string") or ""
    else:
        content_field = tool_input.get("content") or ""
    if not isinstance(content_field, str):
        content_field = str(content_field)
    snippet_bytes = content_field.encode('utf-8', errors='replace')[:SNIPPET_CAP_BYTES]
    event["response_snippet"] = base64.b64encode(snippet_bytes).decode('ascii')

print(json.dumps(event))
PYEOF

rm -f "$TMPFILE"
exit 0
