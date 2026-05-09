/**
 * trace-capture-resolve.js — Session ID resolution for trace-capture hooks.
 *
 * Precedence: stdin payload `session_id` > env `CLAUDE_SESSION_ID` > "unknown".
 * Validates against an allowlist regex to prevent path traversal in filenames.
 */

const SAFE_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveSessionId(stdinPayload, envValue) {
  const candidates = [stdinPayload?.session_id, envValue];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && SAFE_RE.test(c)) return c;
  }
  return 'unknown';
}
