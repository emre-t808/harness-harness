import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logEvent, readEvents } from './event-log.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evtlog-')), 'events.ndjson');
}

test('logEvent: appends valid NDJSON line with required fields', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'Stop', handler: 'session-summary.js', phase: 'end', exit_code: 0 });
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.strictEqual(obj.hook, 'Stop');
  assert.strictEqual(obj.handler, 'session-summary.js');
  assert.strictEqual(obj.exit_code, 0);
  assert.match(obj.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(obj.event_id, /^evt_[a-f0-9]{16}$/);
});

test('logEvent: creates parent directory if missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtlog-'));
  const f = path.join(dir, 'deep', 'sub', 'events.ndjson');
  logEvent(f, { hook: 'Test' });
  assert.ok(fs.existsSync(f));
});

test('logEvent: appends multiple lines without overwrite', async () => {
  const f = tmpFile();
  for (let i = 0; i < 50; i++) {
    logEvent(f, { hook: 'PostToolUse', seq: i });
  }
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 50);
  for (const ln of lines) JSON.parse(ln); // every line is valid JSON
});

test('readEvents: returns [] when file missing', () => {
  assert.deepStrictEqual(readEvents('/nonexistent/path.ndjson'), []);
});

test('readEvents: parses NDJSON and applies filter', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'Stop', session_id: 'A' });
  logEvent(f, { hook: 'Stop', session_id: 'B' });
  logEvent(f, { hook: 'Start', session_id: 'A' });
  const aOnly = readEvents(f, { session_id: 'A' });
  assert.strictEqual(aOnly.length, 2);
  const stopOnly = readEvents(f, { hook: 'Stop' });
  assert.strictEqual(stopOnly.length, 2);
});

test('readEvents: tolerates malformed lines', () => {
  const f = tmpFile();
  logEvent(f, { hook: 'Stop' });
  fs.appendFileSync(f, 'not-json\n');
  fs.appendFileSync(f, '{"partial":\n');
  logEvent(f, { hook: 'Start' });
  const all = readEvents(f);
  assert.strictEqual(all.length, 2, `expected 2 valid, got ${all.length}`);
});

test('logEvent: rotates when file exceeds maxBytes', () => {
  const f = tmpFile();
  for (let i = 0; i < 10; i++) {
    logEvent(f, { hook: 'PostToolUse', payload: 'x'.repeat(500) }, { maxBytes: 1000 });
  }
  assert.ok(fs.existsSync(f + '.1'), 'rotated file should exist');
});

test('logEvent: includes provided fields verbatim', () => {
  const f = tmpFile();
  logEvent(f, {
    hook: 'Stop',
    handler: 'daily-check.js',
    phase: 'decision',
    decision: { action: 'auto-promote', rule: 'CS-001', reason: '3w stable' },
  });
  const obj = JSON.parse(fs.readFileSync(f, 'utf8').trim());
  assert.strictEqual(obj.decision.action, 'auto-promote');
  assert.strictEqual(obj.decision.rule, 'CS-001');
});
