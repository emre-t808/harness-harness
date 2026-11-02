/**
 * trace-capture-resolve.js — Session ID resolution for trace-capture hooks.
 *
 * PRD 5.4: the payload session_id, else CLAUDE_SESSION_ID, is the only identity.
 * No identity, or an invalid supplied one, returns null: the hook writes nothing
 * and logs one error row. An explicitly supplied "unknown" is a session like any other.
 */

const SAFE_RE = /^[A-Za-z0-9._-]{1,128}$/;

function isSafeSessionId(value) {
  return (
    typeof value === 'string'
    && value !== '.'
    && value !== '..'
    && SAFE_RE.test(value)
  );
}

export function resolveSessionId(stdinPayload, environment = {}) {
  const payload = stdinPayload && typeof stdinPayload === 'object'
    ? stdinPayload
    : {};
  const env = environment && typeof environment === 'object'
    ? environment
    : {};
  const payloadSupplied = Object.hasOwn(payload, 'session_id')
    && payload.session_id !== null;
  const environmentSupplied = Object.hasOwn(env, 'CLAUDE_SESSION_ID');
  if (!payloadSupplied && !environmentSupplied) return null;
  const sessionId = payloadSupplied
    ? payload.session_id
    : env.CLAUDE_SESSION_ID;
  if (!isSafeSessionId(sessionId)) return null;
  return { sessionId };
}
