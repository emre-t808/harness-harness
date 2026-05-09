import { test } from 'node:test';
import assert from 'node:assert';
import { resolveSessionId } from './trace-capture-resolve.js';

test('resolveSessionId: prefers stdin payload over env', () => {
  assert.strictEqual(
    resolveSessionId({ session_id: 'session-abc' }, 'session-from-env'),
    'session-abc'
  );
});

test('resolveSessionId: falls back to env when stdin missing', () => {
  assert.strictEqual(resolveSessionId({}, 'session-from-env'), 'session-from-env');
  assert.strictEqual(resolveSessionId(null, 'session-from-env'), 'session-from-env');
});

test('resolveSessionId: returns "unknown" when both missing', () => {
  assert.strictEqual(resolveSessionId({}, undefined), 'unknown');
  assert.strictEqual(resolveSessionId({}, ''), 'unknown');
  assert.strictEqual(resolveSessionId(null, null), 'unknown');
});

test('resolveSessionId: rejects path traversal and whitespace', () => {
  assert.strictEqual(resolveSessionId({ session_id: '../etc/passwd' }, ''), 'unknown');
  assert.strictEqual(resolveSessionId({ session_id: 'has spaces' }, ''), 'unknown');
  assert.strictEqual(resolveSessionId({ session_id: 'has\nnewline' }, ''), 'unknown');
});

test('resolveSessionId: rejects empty and oversized values', () => {
  assert.strictEqual(resolveSessionId({ session_id: '' }, ''), 'unknown');
  assert.strictEqual(resolveSessionId({ session_id: 'a'.repeat(200) }, ''), 'unknown');
});

test('resolveSessionId: accepts safe alphanumeric, dash, underscore, dot', () => {
  assert.strictEqual(resolveSessionId({ session_id: 'session-1778310466583' }, ''), 'session-1778310466583');
  assert.strictEqual(resolveSessionId({ session_id: 'abc_123.def' }, ''), 'abc_123.def');
});
