import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProposals } from './weekly-analysis.js';

function makeRuleAggregate(score, sessionsInjected = 10) {
  return {
    totalWeightedScore: score * sessionsInjected,
    totalWeight: sessionsInjected,
    sessionsInjected,
    timesReferenced: score > 0 ? sessionsInjected : 0,
    routeScores: {
      'coding-backend': { totalWeightedScore: score * sessionsInjected, totalWeight: sessionsInjected },
    },
    hasPrevented: false,
    hasBehavioralCompliance: false,
  };
}

function richRatingState({ targetRating = 1500, targetSessions = 20, targetHasPrevented = false } = {}) {
  const rules = { TARGET: { rating: targetRating, sessions_injected: targetSessions } };
  if (targetHasPrevented) rules.TARGET.has_prevented = true;
  // Fill the rest of the population to satisfy pop >= 10 with a known distribution
  const fillerRatings = [1400, 1450, 1470, 1480, 1500, 1520, 1530, 1550, 1580, 1600, 1620];
  fillerRatings.forEach((r, i) => { rules['F-' + i] = { rating: r, sessions_injected: 10 }; });
  return { rules };
}

describe('generateProposals — Elo-unified thresholds', () => {
  it('uses Elo thresholds when population ≥ 10 rules', () => {
    const aggregated = {
      perRule: { TARGET: makeRuleAggregate(0.2) },
      perRoute: {},
    };
    const ratingState = richRatingState({ targetRating: 1800, targetSessions: 20 });
    const result = generateProposals(aggregated, [], {}, ratingState);
    assert.equal(result.usedEloThresholds, true);
    assert.ok(result.promotions.some(p => p.rule === 'TARGET'),
      'high-rating rule should be promoted despite low avg score');
  });

  it('falls back to absolute thresholds when population < 10', () => {
    const aggregated = {
      perRule: {
        HIGH: {
          ...makeRuleAggregate(0.9),
          routeScores: {
            'r1': { totalWeightedScore: 9, totalWeight: 10 },
            'r2': { totalWeightedScore: 9, totalWeight: 10 },
          },
        },
      },
      perRoute: {},
    };
    const sparseRating = {
      rules: {
        HIGH: { rating: 1500, sessions_injected: 5 },
        F1: { rating: 1500, sessions_injected: 5 },
      },
    };
    const result = generateProposals(aggregated, [], {}, sparseRating);
    assert.equal(result.usedEloThresholds, false);
    assert.ok(result.promotions.some(p => p.rule === 'HIGH'));
  });

  it('demotes low-rating rule under Elo thresholds', () => {
    const aggregated = {
      perRule: { TARGET: makeRuleAggregate(0.5) },
      perRoute: {},
    };
    const ratingState = richRatingState({ targetRating: 1200, targetSessions: 20 });
    const result = generateProposals(aggregated, [], {}, ratingState);
    assert.equal(result.usedEloThresholds, true);
    assert.ok(result.demotions.some(d => d.rule === 'TARGET'));
  });

  it('does NOT demote rule with hasPrevented even if rating is low', () => {
    const aggregated = {
      perRule: {
        TARGET: { ...makeRuleAggregate(0.5), hasPrevented: true },
      },
      perRoute: {},
    };
    const ratingState = richRatingState({ targetRating: 1200, targetSessions: 20 });
    const result = generateProposals(aggregated, [], {}, ratingState);
    assert.ok(!result.demotions.some(d => d.rule === 'TARGET'));
  });
});

describe('generateProposals — propagation state tracking', () => {
  it('increments weeks_above_threshold when rating stays above mean + σ', () => {
    const aggregated = {
      perRule: { TARGET: makeRuleAggregate(0.8, 12) },
      perRoute: {},
    };
    const ratingState = richRatingState({ targetRating: 1900, targetSessions: 15 });
    const prevState = { rules: { TARGET: { weeks_above_threshold: 1 } } };
    const result = generateProposals(aggregated, [], prevState, ratingState);
    assert.equal(result.propagationState.TARGET.weeks_above_threshold, 2);
  });

  it('decays weeks_above_threshold (does not hard-reset) on off-week', () => {
    const aggregated = {
      perRule: { TARGET: makeRuleAggregate(0.3, 12) },
      perRoute: {},
    };
    const ratingState = richRatingState({ targetRating: 1400, targetSessions: 15 });
    const prevState = { rules: { TARGET: { weeks_above_threshold: 5 } } };
    const result = generateProposals(aggregated, [], prevState, ratingState);
    assert.equal(result.propagationState.TARGET.weeks_above_threshold, 4);
  });
});
