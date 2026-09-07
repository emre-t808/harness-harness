/**
 * hook-context.js — shared validated payload-first hook identity resolution
 * (harness-reliability PRD §5.3).
 *
 * Payload identity wins; an explicitly invalid payload identity never falls
 * back to the environment or to another session. Missing identity is a
 * visible skip — never a writable shared "unknown" directory. The bash
 * lifecycle templates mirror this contract; this module is the tested
 * canonical form for JS callers.
 */

import fs from 'fs';
import path from 'path';
import { KNOWN_CLIENTS, isSafeSessionId, resolveStorageKey } from './session-summary.js';

/**
 * @param {object|null} payload - parsed hook stdin JSON (or null if unparseable)
 * @param {object} env - process environment
 * @param {string} client - adapter-provided client name
 * @returns {{ ok: true, projectDir, client, sessionId, storageKey }
 *         | { ok: false, diagnostic: string }}
 */
export function resolveHookContext(payload, env = {}, client) {
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    return { ok: false, diagnostic: 'missing-project-dir: CLAUDE_PROJECT_DIR is not set' };
  }
  if (!KNOWN_CLIENTS.includes(client)) {
    return { ok: false, diagnostic: `unknown-client: ${JSON.stringify(client)}` };
  }

  let sessionId;
  const payloadSupplied = payload && typeof payload === 'object'
    && 'session_id' in payload && payload.session_id !== null;
  if (payloadSupplied) {
    if (!isSafeSessionId(payload.session_id)) {
      return { ok: false, diagnostic: 'invalid-payload-session-id: explicit identity rejected, no fallback' };
    }
    sessionId = payload.session_id;
  } else if ('CLAUDE_SESSION_ID' in env) {
    if (!isSafeSessionId(env.CLAUDE_SESSION_ID)) {
      return { ok: false, diagnostic: 'invalid-environment-session-id' };
    }
    sessionId = env.CLAUDE_SESSION_ID;
  } else {
    return { ok: false, diagnostic: 'no-session-identity: neither payload nor environment supplied one' };
  }

  return { ok: true, projectDir, client, sessionId, storageKey: resolveStorageKey(client, sessionId) };
}

/**
 * Resolve the state directory for a session. Storage-key directories win; an
 * unprefixed legacy directory is readable only when no other client claims
 * the same raw id — otherwise both are preserved and a conflict is reported.
 * @returns {{ dir: string, mode: 'storage-key'|'legacy'|'new'|'conflict', conflictWith?: string }}
 */
export function resolveSessionDirectory(sessionsDir, client, sessionId) {
  const storageKey = resolveStorageKey(client, sessionId);
  const keyed = path.join(sessionsDir, storageKey);
  if (fs.existsSync(keyed)) return { dir: keyed, mode: 'storage-key' };

  const legacy = path.join(sessionsDir, sessionId);
  if (fs.existsSync(legacy)) {
    const otherOwner = KNOWN_CLIENTS
      .filter((c) => c !== client)
      .find((c) => fs.existsSync(path.join(sessionsDir, `${c}--${sessionId}`)));
    if (otherOwner) {
      return { dir: keyed, mode: 'conflict', conflictWith: path.join(sessionsDir, `${otherOwner}--${sessionId}`) };
    }
    return { dir: legacy, mode: 'legacy' };
  }
  return { dir: keyed, mode: 'new' };
}
