/**
 * trace-capture-resolve.js — Session ID resolution for trace-capture hooks.
 *
 * Tracks whether "unknown" came from true absence or an explicit safe value.
 * Invalid supplied identity fails closed instead of falling through.
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
  if (!payloadSupplied && !environmentSupplied) {
    return { sessionId: 'unknown', useLegacyPointer: true };
  }
  const sessionId = payloadSupplied
    ? payload.session_id
    : env.CLAUDE_SESSION_ID;
  if (!isSafeSessionId(sessionId)) return null;
  return { sessionId, useLegacyPointer: false };
}
