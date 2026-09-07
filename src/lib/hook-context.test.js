// T5: payload-first identity resolution and session-directory ownership.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHookContext, resolveSessionDirectory } from './hook-context.js';

const ENV = { CLAUDE_PROJECT_DIR: '/proj' };

describe('resolveHookContext', () => {
  it('payload identity wins over a conflicting environment identity', () => {
    const result = resolveHookContext(
      { session_id: 'payload-session' },
      { ...ENV, CLAUDE_SESSION_ID: 'environment-session' },
      'claude',
    );
    assert.deepEqual(result, {
      ok: true, projectDir: '/proj', client: 'claude',
      sessionId: 'payload-session', storageKey: 'claude--payload-session',
    });
  });

  it('an explicitly invalid payload identity never falls back', () => {
    for (const bad of ['', '.', '..', '../escape', 42, 'a'.repeat(129)]) {
      const result = resolveHookContext(
        { session_id: bad },
        { ...ENV, CLAUDE_SESSION_ID: 'safe-env' },
        'claude',
      );
      assert.equal(result.ok, false);
      assert.match(result.diagnostic, /invalid-payload-session-id/);
    }
  });

  it('uses the documented environment fallback only when the payload field is absent', () => {
    const absent = resolveHookContext({}, { ...ENV, CLAUDE_SESSION_ID: 'env-1' }, 'codex');
    assert.equal(absent.ok, true);
    assert.equal(absent.storageKey, 'codex--env-1');

    const nullish = resolveHookContext({ session_id: null }, { ...ENV, CLAUDE_SESSION_ID: 'env-2' }, 'codex');
    assert.equal(nullish.ok, true);
    assert.equal(nullish.sessionId, 'env-2');
  });

  it('missing identity, project dir, or client is a visible skip', () => {
    assert.match(resolveHookContext({}, ENV, 'claude').diagnostic, /no-session-identity/);
    assert.match(resolveHookContext({ session_id: 's' }, {}, 'claude').diagnostic, /missing-project-dir/);
    assert.match(resolveHookContext({ session_id: 's' }, ENV, 'gemini').diagnostic, /unknown-client/);
    assert.match(
      resolveHookContext({}, { ...ENV, CLAUDE_SESSION_ID: '../up' }, 'claude').diagnostic,
      /invalid-environment-session-id/,
    );
  });
});

describe('resolveSessionDirectory', () => {
  function sessionsFixture(dirs) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-context-'));
    for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
    return root;
  }

  it('prefers the storage-key directory', () => {
    const root = sessionsFixture(['claude--s1', 's1']);
    try {
      const result = resolveSessionDirectory(root, 'claude', 's1');
      assert.equal(result.mode, 'storage-key');
      assert.ok(result.dir.endsWith('claude--s1'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reads an unprefixed legacy directory only when ownership is unambiguous', () => {
    const root = sessionsFixture(['s1']);
    try {
      const result = resolveSessionDirectory(root, 'claude', 's1');
      assert.equal(result.mode, 'legacy');
      assert.ok(result.dir.endsWith('/s1'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a conflict instead of guessing when another client claims the raw id', () => {
    const root = sessionsFixture(['s1', 'codex--s1']);
    try {
      const result = resolveSessionDirectory(root, 'claude', 's1');
      assert.equal(result.mode, 'conflict');
      assert.ok(result.conflictWith.endsWith('codex--s1'));
      assert.ok(result.dir.endsWith('claude--s1'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
