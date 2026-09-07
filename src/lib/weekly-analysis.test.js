import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySummaryArtifact, findSummaryArtifacts, generateProposals } from './weekly-analysis.js';

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

describe('generateProposals — demotion guardrails', () => {
  it('requires per-route session evidence: no demotion for a route with 1 session', () => {
    const aggregated = {
      perRule: {
        TARGET: {
          totalWeightedScore: 0, totalWeight: 11,
          sessionsInjected: 11, timesReferenced: 0,
          routeScores: {
            'route-a': { totalWeightedScore: 0, totalWeight: 10, sessions: 10 },
            'route-b': { totalWeightedScore: 0, totalWeight: 1, sessions: 1 },
          },
          hasPrevented: false, hasBehavioralCompliance: false,
        },
      },
      perRoute: {},
    };
    const result = generateProposals(aggregated, []);
    assert.ok(result.demotions.some(d => d.rule === 'TARGET' && d.route === 'route-a'));
    assert.ok(!result.demotions.some(d => d.route === 'route-b'),
      'route with a single injected session must not receive a demotion proposal');
  });

  it('reports per-route session counts on demotions, not the cross-route total', () => {
    const aggregated = {
      perRule: {
        TARGET: {
          totalWeightedScore: 0, totalWeight: 20,
          sessionsInjected: 20, timesReferenced: 0,
          routeScores: {
            'route-a': { totalWeightedScore: 0, totalWeight: 4, sessions: 4 },
          },
          hasPrevented: false, hasBehavioralCompliance: false,
        },
      },
      perRoute: {},
    };
    const result = generateProposals(aggregated, []);
    const d = result.demotions.find(x => x.rule === 'TARGET');
    assert.equal(d.sessions, 4);
  });

  it('withholds demotions for protected rules and reports them separately', () => {
    const aggregated = {
      perRule: {
        'FO-009': {
          totalWeightedScore: 0, totalWeight: 10,
          sessionsInjected: 10, timesReferenced: 0,
          routeScores: {
            'coding:meta': { totalWeightedScore: 0, totalWeight: 10, sessions: 10 },
          },
          hasPrevented: false, hasBehavioralCompliance: false,
        },
      },
      perRoute: {},
    };
    const result = generateProposals(aggregated, [], {}, null, { protectedRules: ['FO-009'] });
    assert.equal(result.demotions.length, 0);
    assert.ok(result.protectedSkipped.some(p => p.rule === 'FO-009' && p.route === 'coding:meta'));
  });

  it('protection also blocks Elo-path demotions', () => {
    const aggregated = {
      perRule: { TARGET: makeRuleAggregate(0.5) },
      perRoute: {},
    };
    const ratingState = richRatingState({ targetRating: 1200, targetSessions: 20 });
    const result = generateProposals(aggregated, [], {}, ratingState, { protectedRules: ['TARGET'] });
    assert.equal(result.usedEloThresholds, true);
    assert.ok(!result.demotions.some(d => d.rule === 'TARGET'));
    assert.ok(result.protectedSkipped.some(p => p.rule === 'TARGET'));
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

describe('summary artifact classification (T2)', () => {
  const NOW = new Date('2026-09-07T12:00:00Z');

  function tempTraces() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-artifacts-'));
    fs.mkdirSync(path.join(dir, '2026-09-06'), { recursive: true });
    return dir;
  }

  it('prefers the JSON sidecar and never double-counts its markdown companion', () => {
    const tracesDir = tempTraces();
    const md = path.join(tracesDir, '2026-09-06', 'claude--s1-summary.md');
    fs.writeFileSync(md, '**Route:** general\n\n### Effectiveness Scores\n\n| Context | Score | Evidence |\n|---|---|---|\n| TR-001 | 1.0 | referenced |\n');
    fs.writeFileSync(path.join(tracesDir, '2026-09-06', 'claude--s1-summary.json'), JSON.stringify({
      schemaVersion: 2, client: 'claude', sessionId: 's1', storageKey: 'claude--s1',
      startedAt: '2026-09-06T10:00:00Z', lastEventAt: '2026-09-06T11:00:00Z',
      route: 'general', scorerVersion: 'behavioral-v2',
      signalsHash: 'x'.repeat(64), sourceHash: 'y'.repeat(64),
      measurementStatus: 'valid', degradedReasons: [],
      scores: [{ rule: 'TR-001', score: 0.5, evidence: 'behavioral-compliance' }],
    }));

    const artifacts = findSummaryArtifacts(7, { tracesDir });
    assert.equal(artifacts.length, 1);
    const classified = classifySummaryArtifact(artifacts[0], { now: NOW });
    assert.equal(classified.kind, 'v2');
    assert.equal(classified.record.scores[0].evidence, 'behavioral-compliance');
    fs.rmSync(tracesDir, { recursive: true, force: true });
  });

  it('classifies legacy markdown separately and invalid sidecars as invalid-v2', () => {
    const tracesDir = tempTraces();
    fs.writeFileSync(path.join(tracesDir, '2026-09-06', 'old-summary.md'),
      '**Route:** general\n\n### Effectiveness Scores\n\n| Context | Score | Evidence |\n|---|---|---|\n| TR-001 | 1.0 | referenced |\n');
    fs.writeFileSync(path.join(tracesDir, '2026-09-06', 'bad-summary.md'), 'no table');
    fs.writeFileSync(path.join(tracesDir, '2026-09-06', 'bad-summary.json'), '{not-json');

    const artifacts = findSummaryArtifacts(7, { tracesDir });
    const byKey = Object.fromEntries(artifacts.map((a) => [path.basename(a.key), classifySummaryArtifact(a, { now: NOW })]));
    assert.equal(byKey.old.kind, 'legacy');
    assert.equal(byKey.old.parsed.route, 'general');
    assert.equal(byKey.bad.kind, 'invalid-v2');
    fs.rmSync(tracesDir, { recursive: true, force: true });
  });
});
