import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeStaleness, generateRecommendation, daysSince } from './staleness.js';

describe('daysSince', () => {
  it('returns Infinity for null', () => {
    assert.equal(daysSince(null), Infinity);
  });
  it('returns Infinity for "never"', () => {
    assert.equal(daysSince('never'), Infinity);
  });
  it('returns positive number for past date', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const days = daysSince(yesterday);
    assert.ok(days >= 0.9 && days <= 1.5);
  });
});

describe('computeStaleness', () => {
  it('returns ~0 for just-used repo with high effectiveness', () => {
    const score = computeStaleness({
      last_trace: new Date().toISOString().slice(0, 10),
      avg_effectiveness: 1.0,
    });
    assert.ok(score < 0.05);
  });

  it('returns close to 1.0 for never-used repo', () => {
    const score = computeStaleness({
      last_trace: 'never',
      avg_effectiveness: 0,
    });
    assert.ok(score > 0.9);
  });

  it('weights effectiveness at 40%', () => {
    const today = new Date().toISOString().slice(0, 10);
    const low = computeStaleness({ last_trace: today, avg_effectiveness: 0 });
    const high = computeStaleness({ last_trace: today, avg_effectiveness: 1.0 });
    assert.ok(Math.abs((low - high) - 0.4) < 0.05);
  });

  it('caps both recency (90d) and ruleAge (180d)', () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    const veryOld = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const s1 = computeStaleness({ last_trace: old, avg_effectiveness: 0.5 });
    const s2 = computeStaleness({ last_trace: veryOld, avg_effectiveness: 0.5 });
    assert.ok(Math.abs(s1 - s2) < 0.01, `expected equal after caps, got ${s1} vs ${s2}`);
  });
});

describe('generateRecommendation', () => {
  it('returns null for healthy repo', () => {
    const rec = generateRecommendation({
      last_trace: new Date().toISOString().slice(0, 10),
      avg_effectiveness: 0.8,
      sessions_7d: 10,
      rule_count: 5,
      staleness_score: 0.1,
    });
    assert.equal(rec, null);
  });

  it('warns about stale repos', () => {
    const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rec = generateRecommendation({
      last_trace: old,
      sessions_7d: 0,
      staleness_score: 0.7,
    });
    assert.ok(rec.includes('No traces'));
  });

  it('warns about low effectiveness', () => {
    const rec = generateRecommendation({
      last_trace: new Date().toISOString().slice(0, 10),
      avg_effectiveness: 0.1,
      sessions_7d: 5,
      rule_count: 3,
      staleness_score: 0.5,
    });
    assert.ok(rec.includes('effectiveness'));
  });

  it('warns about missing rules', () => {
    const rec = generateRecommendation({
      last_trace: new Date().toISOString().slice(0, 10),
      rule_count: 0,
      staleness_score: 0.5,
    });
    assert.ok(rec.includes('No rules'));
  });
});
