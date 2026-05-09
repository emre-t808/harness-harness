import { test } from 'node:test';
import assert from 'node:assert';
import { shouldAutoApply } from './autonomy.js';

const NOW = new Date('2026-05-09T00:00:00Z');

// Promotion gates ──────────────────────────────────────────────────────────

test('promote: blocked when weeks_above_threshold < 3', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'CS-001' },
    { rules: { 'CS-001': { sessions_injected: 10, rating: 1600, weeks_above_threshold: 2 } } },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /weeks_above_threshold/);
});

test('promote: blocked when sessions_injected < 5', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'CS-001' },
    { rules: { 'CS-001': { sessions_injected: 4, rating: 1600, weeks_above_threshold: 5 } } },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /sessions_injected/);
});

test('promote: blocked when rule moved within 7-day cool-down', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'CS-001' },
    { rules: { 'CS-001': { sessions_injected: 10, rating: 1600, weeks_above_threshold: 5 } } },
    { 'CS-001': { last_applied: '2026-05-04T00:00:00Z' } },
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /cool-down/);
});

test('promote: applies when all gates met', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'CS-001' },
    { rules: { 'CS-001': { sessions_injected: 10, rating: 1600, weeks_above_threshold: 3 } } },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, true);
});

test('promote: rule with no rating data does not apply', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'NEW-RULE' },
    { rules: {} },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
});

// Demotion gates ────────────────────────────────────────────────────────────

test('demote: applies when score=0 across 5+ sessions on same route', () => {
  const r = shouldAutoApply(
    { kind: 'demote', rule: 'XX-999', route: 'general', avgScore: 0, sessions: 5 },
    { rules: {} },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, true);
});

test('demote: blocked when sessions < 5', () => {
  const r = shouldAutoApply(
    { kind: 'demote', rule: 'XX-999', route: 'general', avgScore: 0, sessions: 4 },
    { rules: {} },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /sessions/);
});

test('demote: blocked when avgScore > 0', () => {
  const r = shouldAutoApply(
    { kind: 'demote', rule: 'XX-999', route: 'general', avgScore: 0.3, sessions: 10 },
    { rules: {} },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /avgScore/);
});

// Mode flag ─────────────────────────────────────────────────────────────────

test('mode "off": never applies', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'CS-001' },
    { rules: { 'CS-001': { sessions_injected: 10, rating: 1600, weeks_above_threshold: 5 } } },
    {},
    { mode: 'off', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /disabled/);
});

test('cool-down: passes when more than 7 days have elapsed', () => {
  const r = shouldAutoApply(
    { kind: 'promote', rule: 'CS-001' },
    { rules: { 'CS-001': { sessions_injected: 10, rating: 1600, weeks_above_threshold: 5 } } },
    { 'CS-001': { last_applied: '2026-04-30T00:00:00Z' } }, // 9 days ago
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, true);
});

test('unknown kind: returns false with explanatory reason', () => {
  const r = shouldAutoApply(
    { kind: 'banana', rule: 'X' },
    { rules: {} },
    {},
    { mode: 'on', now: NOW }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /unknown kind/);
});
