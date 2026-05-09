import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logEvent } from './event-log.js';
import { explainSession } from './explain.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explain-')), 'events.ndjson');
}

test('explainSession: pairs start/end into a single timeline entry with duration', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'SessionStart', handler: 'session-start.sh', phase: 'start', session_id: 'S1' });
  logEvent(f, { hook: 'SessionStart', handler: 'session-start.sh', phase: 'end', session_id: 'S1', exit_code: 0 });
  logEvent(f, { hook: 'PostToolUse', handler: 'trace-capture.sh', phase: 'end', session_id: 'S1' });
  logEvent(f, { hook: 'PostToolUse', handler: 'trace-capture.sh', phase: 'end', session_id: 'S2' });

  const r = explainSession(f, 'S1');
  assert.strictEqual(r.session_id, 'S1');
  assert.strictEqual(r.timeline.length, 2, 'two entries: paired SessionStart + standalone PostToolUse');
  assert.strictEqual(r.timeline[0].hook, 'SessionStart');
  assert.strictEqual(r.timeline[0].status, 'ok');
  assert.ok(typeof r.timeline[0].duration_ms === 'number');
  assert.strictEqual(r.timeline[1].hook, 'PostToolUse');
});

test('explainSession: surfaces orphan starts (Stop hook crashed before end)', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'Stop', handler: 'session-summary.js', phase: 'start', session_id: 'S3' });
  // No matching end record
  const r = explainSession(f, 'S3');
  assert.strictEqual(r.timeline.length, 1);
  assert.strictEqual(r.timeline[0].status, 'orphan');
});

test('explainSession: includes error events as separate timeline entries', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'Stop', handler: 'daily-check.js', phase: 'start', session_id: 'S4' });
  logEvent(f, { hook: 'Stop', handler: 'daily-check.js', phase: 'error', step: 'rating-state', error: 'EACCES', session_id: 'S4' });
  logEvent(f, { hook: 'Stop', handler: 'daily-check.js', phase: 'end', session_id: 'S4' });

  const r = explainSession(f, 'S4');
  assert.strictEqual(r.timeline.length, 2, 'one paired Stop entry + one error entry');
  const errorEntry = r.timeline.find(e => e.status === 'error');
  assert.ok(errorEntry);
  assert.strictEqual(errorEntry.step, 'rating-state');
  assert.strictEqual(errorEntry.error, 'EACCES');
});

test('explainSession: returns empty timeline for unknown session', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'Stop', phase: 'start', session_id: 'A' });
  const r = explainSession(f, 'NONEXISTENT');
  assert.deepStrictEqual(r.timeline, []);
  assert.strictEqual(r.event_count, 0);
});

test('explainSession: timeline is ordered by ts ascending', async () => {
  const f = tmpFile();
  logEvent(f, { hook: 'A', handler: 'h', phase: 'end', session_id: 'S' });
  await new Promise(r => setTimeout(r, 5));
  logEvent(f, { hook: 'B', handler: 'h', phase: 'end', session_id: 'S' });
  await new Promise(r => setTimeout(r, 5));
  logEvent(f, { hook: 'C', handler: 'h', phase: 'end', session_id: 'S' });

  const r = explainSession(f, 'S');
  assert.deepStrictEqual(r.timeline.map(t => t.hook), ['A', 'B', 'C']);
});
