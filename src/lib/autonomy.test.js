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
    { mode: 'on', now: NOW, autoDemote: true }
  );
  assert.strictEqual(r.apply, true);
});

test('demote: blocked when sessions < 5', () => {
  const r = shouldAutoApply(
    { kind: 'demote', rule: 'XX-999', route: 'general', avgScore: 0, sessions: 4 },
    { rules: {} },
    {},
    { mode: 'on', now: NOW, autoDemote: true }
  );
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /sessions/);
});

test('demote: blocked when avgScore > 0', () => {
  const r = shouldAutoApply(
    { kind: 'demote', rule: 'XX-999', route: 'general', avgScore: 0.3, sessions: 10 },
    { rules: {} },
    {},
    { mode: 'on', now: NOW, autoDemote: true }
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

// ---------------------------------------------------------------------------
// Gate 4 — direction. Auto-demote fires on avgScore <= 0, i.e. on the ABSENCE of
// evidence. A rule only scores when its ID surfaces in a tool response, so a rule
// the model quietly obeys scores 0.00 forever. In the project this was found in,
// enabling auto-demote against the live routes would have stripped FD-001/002/003
// (the frontend design rules) out of the FRONTEND route's Must Load — because
// nobody happened to do frontend work that week.
// ---------------------------------------------------------------------------
const DEMOTION = { kind: 'demote', rule: 'FD-001', route: 'coding-frontend', sessions: 17, avgScore: 0 };

test('gate 4: does NOT auto-demote by default, even when every other gate passes', () => {
  const r = shouldAutoApply(DEMOTION, { rules: {} }, {}, { mode: 'on', now: NOW });
  assert.strictEqual(r.apply, false);
  assert.match(r.reason, /absence of evidence/);
});

test('gate 4: auto-demotes only when explicitly opted in', () => {
  const r = shouldAutoApply(DEMOTION, { rules: {} }, {}, { mode: 'on', now: NOW, autoDemote: true });
  assert.strictEqual(r.apply, true);
});

test('gate 4: still auto-promotes on positive evidence — promotion is not gated by this', () => {
  const ratingState = { rules: { 'GA-001': { sessions_injected: 8, weeks_above_threshold: 3 } } };
  const r = shouldAutoApply({ kind: 'promote', rule: 'GA-001' }, ratingState, {}, { mode: 'on', now: NOW });
  assert.strictEqual(r.apply, true, 'promotion runs on evidence the rule WAS used');
});
