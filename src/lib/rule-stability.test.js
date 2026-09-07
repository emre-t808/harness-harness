// T4: calendar-week stability — completed UTC Monday–Sunday weeks, streak
// semantics, dispersion requirements, event-time recomputation, and the
// threshold-review policy signal (acceptance A07/A09/A21 building blocks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { completedWeeks, evaluateStability, weekStartOf } from './rule-stability.js';
import { createEvidenceStore, upsertObservation } from './evidence-state.js';

const EPOCH_MONDAY = '2026-08-03T00:00:00Z'; // a Monday 00:00 UTC
const NOW = new Date('2026-09-02T12:00:00Z'); // Wednesday in the week of Aug 31

let hashCounter = 0;

function observation(sessionId, lastEventAt, scores) {
  hashCounter += 1;
  return {
    schemaVersion: 2,
    client: 'claude',
    sessionId,
    storageKey: `claude--${sessionId}`,
    startedAt: lastEventAt,
    lastEventAt,
    route: 'general',
    scorerVersion: 'behavioral-v2',
    signalsHash: 'a'.repeat(64),
    sourceHash: `${hashCounter}`.padStart(64, '0'),
    measurementStatus: 'valid',
    degradedReasons: [],
    scores,
  };
}

const CONTRAST_SCORES = [
  { rule: 'TR-001', score: 1.0, evidence: 'referenced' },
  { rule: 'TR-002', score: 0.0, evidence: 'ignored' },
  { rule: 'TR-003', score: 0.0, evidence: 'ignored' },
];
const EQUAL_SCORES = [
  { rule: 'TR-001', score: 1.0, evidence: 'referenced' },
  { rule: 'TR-002', score: 1.0, evidence: 'referenced' },
  { rule: 'TR-003', score: 1.0, evidence: 'referenced' },
];

/** Seed `sessionsPerWeek` observations into each of the given week offsets. */
function seedStore(scores, weekOffsets, sessionsPerWeek = 3, epoch = EPOCH_MONDAY) {
  let store = createEvidenceStore(epoch);
  for (const week of weekOffsets) {
    for (let i = 0; i < sessionsPerWeek; i += 1) {
      const day = 2 + i; // Wednesday, Thursday, Friday of that week
      const ts = new Date(Date.parse(epoch) + week * 7 * 86400000 + day * 86400000).toISOString();
      const result = upsertObservation(store, observation(`w${week}s${i}`, ts, scores), { now: NOW });
      assert.equal(result.outcome, 'accepted', result.reason);
      store = result.store;
    }
  }
  return store;
}

describe('week boundaries', () => {
  it('weekStartOf finds the UTC Monday', () => {
    assert.equal(new Date(weekStartOf(Date.parse('2026-09-02T12:00:00Z'))).toISOString(), '2026-08-31T00:00:00.000Z');
    assert.equal(new Date(weekStartOf(Date.parse('2026-08-31T00:00:00Z'))).toISOString(), '2026-08-31T00:00:00.000Z');
  });

  it('counts only completed weeks; the current week never counts', () => {
    const weeks = completedWeeks(EPOCH_MONDAY, NOW);
    assert.equal(weeks.length, 4); // Aug 3, 10, 17, 24 — Aug 31 week is incomplete
    assert.equal(new Date(weeks.at(-1).end).toISOString(), '2026-08-31T00:00:00.000Z');
  });

  it('a partial first epoch week does not count unless the epoch starts Monday 00:00', () => {
    const midWeekEpoch = '2026-08-05T09:00:00Z';
    const weeks = completedWeeks(midWeekEpoch, NOW);
    assert.equal(new Date(weeks[0].start).toISOString(), '2026-08-10T00:00:00.000Z');
  });
});

describe('evaluateStability', () => {
  it('a rule above threshold with evidence in three consecutive weeks reaches streak 3', () => {
    const store = seedStore(CONTRAST_SCORES, [0, 1, 2, 3]);
    const stability = evaluateStability(store, { now: NOW });
    assert.equal(stability.rules['TR-001'].consecutiveQualifiedWeeks, 4);
    assert.equal(stability.rules['TR-001'].latestReason, 'qualified');
    assert.equal(stability.rules['TR-002'].consecutiveQualifiedWeeks, 0);
    assert.equal(stability.rules['TR-002'].latestReason, 'below-threshold');
    assert.equal(stability.throughWeek, '2026-08-31T00:00:00.000Z');
  });

  it('A07: repeated evaluations within one week cannot increase stability', () => {
    const store = seedStore(CONTRAST_SCORES, [0, 1, 2, 3]);
    const first = evaluateStability(store, { now: NOW });
    const laterSameWeek = evaluateStability(store, { now: new Date('2026-09-05T23:00:00Z') });
    assert.deepEqual(laterSameWeek.rules, first.rules);
    assert.equal(laterSameWeek.throughWeek, first.throughWeek);
  });

  it('a no-evidence week breaks the consecutive streak', () => {
    const store = seedStore(CONTRAST_SCORES, [0, 1, 3]); // week 2 empty
    const stability = evaluateStability(store, { now: NOW });
    assert.equal(stability.rules['TR-001'].consecutiveQualifiedWeeks, 1);
  });

  it('A21: an equal-rating population is withheld as zero-dispersion, not promoted', () => {
    const store = seedStore(EQUAL_SCORES, [0, 1, 2, 3]);
    const stability = evaluateStability(store, { now: NOW });
    for (const rule of ['TR-001', 'TR-002', 'TR-003']) {
      assert.equal(stability.rules[rule].consecutiveQualifiedWeeks, 0);
      assert.equal(stability.rules[rule].latestReason, 'zero-dispersion');
    }
    assert.equal(stability.thresholdReview.recommended, true);
    assert.ok(stability.thresholdReview.population.count >= 3);
  });

  it('a qualifying population does not raise the threshold-review signal', () => {
    const store = seedStore(CONTRAST_SCORES, [0, 1, 2, 3]);
    const stability = evaluateStability(store, { now: NOW });
    assert.equal(stability.thresholdReview.recommended, false);
  });

  it('A09: a late arrival for a prior week recomputes that week retroactively', () => {
    let store = seedStore(CONTRAST_SCORES, [0, 1, 3]); // week 2 empty → streak 1
    assert.equal(evaluateStability(store, { now: NOW }).rules['TR-001'].consecutiveQualifiedWeeks, 1);

    // A session that ENDED in week 2 arrives late (ingested "Tuesday").
    for (let i = 0; i < 3; i += 1) {
      const ts = new Date(Date.parse(EPOCH_MONDAY) + 2 * 7 * 86400000 + (2 + i) * 86400000).toISOString();
      store = upsertObservation(store, observation(`late${i}`, ts, CONTRAST_SCORES), { now: NOW }).store;
    }
    assert.equal(evaluateStability(store, { now: NOW }).rules['TR-001'].consecutiveQualifiedWeeks, 4);
  });

  it('insufficient evidence in the latest week is reported distinctly', () => {
    const store = seedStore(CONTRAST_SCORES, [0, 1, 2]); // nothing in week 3
    const stability = evaluateStability(store, { now: NOW });
    assert.equal(stability.rules['TR-001'].latestReason, 'insufficient-evidence');
    assert.equal(stability.rules['TR-001'].consecutiveQualifiedWeeks, 0);
  });
});
