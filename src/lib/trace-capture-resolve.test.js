import { test } from 'node:test';
import assert from 'node:assert';
import { resolveSessionId } from './trace-capture-resolve.js';

test('resolveSessionId: prefers stdin payload over env', () => {
  assert.deepStrictEqual(
    resolveSessionId(
      { session_id: 'session-abc' },
      { CLAUDE_SESSION_ID: 'session-from-env' },
    ),
    { sessionId: 'session-abc', useLegacyPointer: false },
  );
});

test('resolveSessionId: falls back to env when stdin missing', () => {
  const environment = { CLAUDE_SESSION_ID: 'session-from-env' };
  const expected = { sessionId: 'session-from-env', useLegacyPointer: false };
  assert.deepStrictEqual(resolveSessionId({}, environment), expected);
  assert.deepStrictEqual(resolveSessionId(null, environment), expected);
  assert.deepStrictEqual(resolveSessionId({ session_id: null }, environment), expected);
});

test('resolveSessionId: marks unknown as legacy only when both identities are absent', () => {
  const expected = { sessionId: 'unknown', useLegacyPointer: true };
  assert.deepStrictEqual(resolveSessionId({}, {}), expected);
  assert.deepStrictEqual(resolveSessionId(null, {}), expected);
  assert.deepStrictEqual(resolveSessionId({ session_id: null }, {}), expected);
});

test('resolveSessionId: treats explicitly supplied unknown as a known session', () => {
  const expected = { sessionId: 'unknown', useLegacyPointer: false };
  assert.deepStrictEqual(
    resolveSessionId(
      { session_id: 'unknown' },
      { CLAUDE_SESSION_ID: 'environment-session' },
    ),
    expected,
  );
  assert.deepStrictEqual(
    resolveSessionId({ session_id: null }, { CLAUDE_SESSION_ID: 'unknown' }),
    expected,
  );
});

test('resolveSessionId: invalid supplied payload fails closed without env fallback', () => {
  const environment = { CLAUDE_SESSION_ID: 'safe-environment' };
  for (const value of [
    '',
    '.',
    '..',
    '../etc/passwd',
    'has spaces',
    'has\nnewline',
    'séance',
    'a'.repeat(129),
    42,
  ]) {
    assert.strictEqual(resolveSessionId({ session_id: value }, environment), null);
  }
});

test('resolveSessionId: invalid supplied environment identity fails closed', () => {
  for (const value of ['', '.', '..', '../escape', 'séance', 'a'.repeat(129)]) {
    assert.strictEqual(
      resolveSessionId({ session_id: null }, { CLAUDE_SESSION_ID: value }),
      null,
    );
  }
});

test('resolveSessionId: accepts safe alphanumeric, dash, underscore, dot', () => {
  assert.deepStrictEqual(
    resolveSessionId({ session_id: 'session-1778310466583' }, {}),
    { sessionId: 'session-1778310466583', useLegacyPointer: false },
  );
  assert.deepStrictEqual(
    resolveSessionId({ session_id: 'abc_123.def' }, {}),
    { sessionId: 'abc_123.def', useLegacyPointer: false },
  );
});
