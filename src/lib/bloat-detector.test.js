import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBloatScore, bloatStatus, bloatRecommendation } from './bloat-detector.js';

describe('computeBloatScore', () => {
  it('returns 0 for empty repo', () => {
    assert.equal(computeBloatScore({ total_rules: 0 }), 0);
  });

  it('healthy small repo', () => {
    const score = computeBloatScore({
      total_rules: 10,
      underperforming_rules: 0,
      avg_rule_age_days: 10,
      min_coverage_ratio: 0.1,
      rating_std_dev: 100,
    });
    assert.ok(score < 0.3);
  });

  it('downweights bloat for low coverage', () => {
    const heavy = computeBloatScore({
      total_rules: 50,
      underperforming_rules: 20,
      avg_rule_age_days: 100,
      min_coverage_ratio: 0.5,
      rating_std_dev: 100,
    });
    const lowCov = computeBloatScore({
      total_rules: 50,
      underperforming_rules: 20,
      avg_rule_age_days: 100,
      min_coverage_ratio: 0.01,
      rating_std_dev: 100,
    });
    assert.ok(heavy > lowCov);
  });

  it('downweights for narrow distribution', () => {
    const wide = computeBloatScore({
      total_rules: 50,
      underperforming_rules: 20,
      avg_rule_age_days: 100,
      min_coverage_ratio: 0.5,
      rating_std_dev: 100,
    });
    const narrow = computeBloatScore({
      total_rules: 50,
      underperforming_rules: 20,
      avg_rule_age_days: 100,
      min_coverage_ratio: 0.5,
      rating_std_dev: 10,
    });
    assert.ok(wide > narrow);
  });
});

describe('bloatStatus', () => {
  it('healthy', () => assert.equal(bloatStatus(0.1), '[HEALTHY]'));
  it('watch', () => assert.equal(bloatStatus(0.4), '[WATCH]'));
  it('bloated', () => assert.equal(bloatStatus(0.6), '[BLOATED]'));
  it('critical', () => assert.equal(bloatStatus(0.9), '[CRITICAL]'));
});

describe('bloatRecommendation', () => {
  it('returns null for healthy score', () => {
    assert.equal(bloatRecommendation({ total_rules: 10 }, 0.2), null);
  });
  it('returns reason string for high score', () => {
    const rec = bloatRecommendation({
      total_rules: 50,
      underperforming_rules: 10,
      avg_rule_age_days: 100,
      min_coverage_ratio: 0.5,
      rating_std_dev: 100,
    }, 0.7);
    assert.ok(rec.includes('Bloat detected'));
  });
});
