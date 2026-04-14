import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceToMatchScore,
  expectedScore,
  updateRating,
  processSession,
  computePopulationStats,
} from './rule-rating.js';

describe('evidenceToMatchScore', () => {
  it('maps referenced to 1.0', () => {
    assert.equal(evidenceToMatchScore('referenced'), 1.0);
    assert.equal(evidenceToMatchScore('prevented-mistake'), 1.0);
    assert.equal(evidenceToMatchScore('verified-compliance'), 1.0);
  });

  it('maps behavioral-compliance to 0.5', () => {
    assert.equal(evidenceToMatchScore('behavioral-compliance'), 0.5);
    assert.equal(evidenceToMatchScore('implicit'), 0.5);
  });

  it('maps ignored to 0.0', () => {
    assert.equal(evidenceToMatchScore('ignored'), 0.0);
  });
});

describe('expectedScore', () => {
  it('returns 0.5 for equal ratings', () => {
    assert.equal(expectedScore(1500, 1500), 0.5);
  });

  it('returns > 0.5 when self is stronger', () => {
    assert.ok(expectedScore(1600, 1500) > 0.5);
  });

  it('returns < 0.5 when self is weaker', () => {
    assert.ok(expectedScore(1400, 1500) < 0.5);
  });
});

describe('updateRating', () => {
  it('increases rating on win against stronger pool', () => {
    const entry = { rating: 1400, sessions_injected: 20 };
    const updated = updateRating(entry, 1.0, 1500);
    assert.ok(updated.rating > 1400);
    assert.equal(updated.sessions_injected, 21);
  });

  it('decreases rating on loss against weaker pool', () => {
    const entry = { rating: 1600, sessions_injected: 20 };
    const updated = updateRating(entry, 0.0, 1500);
    assert.ok(updated.rating < 1600);
  });

  it('uses cold-start K factor for new rules', () => {
    const newEntry = { rating: 1500, sessions_injected: 0 };
    const stableEntry = { rating: 1500, sessions_injected: 50 };

    const newUpdate = updateRating(newEntry, 1.0, 1500);
    const stableUpdate = updateRating(stableEntry, 1.0, 1500);

    assert.ok((newUpdate.rating - 1500) > (stableUpdate.rating - 1500));
  });

  it('starts a brand new rule at 1500', () => {
    const updated = updateRating(null, 0.5, 1500);
    assert.equal(updated.rating, 1500);
    assert.equal(updated.sessions_injected, 1);
  });
});

describe('processSession', () => {
  it('updates all rules in session with shared pool mean', () => {
    const state = { rules: {} };
    const sessionScores = [
      { ruleId: 'A', evidence: 'referenced' },
      { ruleId: 'B', evidence: 'ignored' },
      { ruleId: 'C', evidence: 'behavioral-compliance' },
    ];

    const updated = processSession(state, sessionScores);

    assert.ok(updated.rules.A.rating > 1500);
    assert.ok(updated.rules.B.rating < 1500);
    assert.equal(updated.rules.C.rating, 1500);
  });

  it('rating converges upward across multiple wins', () => {
    let state = { rules: {} };
    for (let i = 0; i < 5; i++) {
      state = processSession(state, [
        { ruleId: 'winner', evidence: 'referenced' },
        { ruleId: 'loser', evidence: 'ignored' },
      ]);
    }
    assert.ok(state.rules.winner.rating > 1550);
    assert.ok(state.rules.loser.rating < 1450);
  });
});

describe('computePopulationStats', () => {
  it('returns starting rating for empty state', () => {
    const stats = computePopulationStats({ rules: {} });
    assert.equal(stats.mean, 1500);
    assert.equal(stats.count, 0);
  });

  it('excludes rules with <3 sessions from population stats', () => {
    const state = {
      rules: {
        newish: { rating: 1800, sessions_injected: 1 },
        established1: { rating: 1500, sessions_injected: 20 },
        established2: { rating: 1600, sessions_injected: 20 },
      },
    };
    const stats = computePopulationStats(state);
    assert.equal(stats.count, 2);
    assert.equal(stats.mean, 1550);
  });
});
