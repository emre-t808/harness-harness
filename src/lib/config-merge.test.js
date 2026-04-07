import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRouteConfigs, mergeProjectConfigs, mergeEffectivenessScores } from './config-merge.js';

describe('mergeRouteConfigs', () => {
  it('returns teamRoute with defaults when devRoute is null', () => {
    const team = { meta: { intent: 'coding:backend' }, budget: { route_context: 25 }, sections: {} };
    const result = mergeRouteConfigs(team, null);
    assert.equal(result.budget.route_context, 25, 'team value preserved');
    assert.equal(result.budget.identity, 15, 'default fills gap');
    assert.equal(result.meta.intent, 'coding:backend');
  });

  it('returns devRoute with defaults when teamRoute is null', () => {
    const dev = { meta: { intent: 'coding:backend' }, budget: { route_context: 40 }, sections: {} };
    const result = mergeRouteConfigs(null, dev);
    assert.equal(result.budget.route_context, 40, 'dev value preserved');
    assert.equal(result.budget.identity, 15, 'default fills gap');
    assert.equal(result.meta.intent, 'coding:backend');
  });

  it('developer budget values override team values', () => {
    const team = { meta: { intent: 'coding:backend' }, budget: { route_context: 25, reserved: 35 }, sections: {} };
    const dev = { meta: {}, budget: { route_context: 40 }, sections: {} };
    const merged = mergeRouteConfigs(team, dev);
    assert.equal(merged.budget.route_context, 40);
    assert.equal(merged.budget.reserved, 35);
  });

  it('developer sections replace team sections entirely', () => {
    const team = { meta: {}, budget: {}, sections: { 'Route Context': '### Must Load\n- API-001' } };
    const dev = { meta: {}, budget: {}, sections: { 'Route Context': '### Must Load\n- PERF-001' } };
    const merged = mergeRouteConfigs(team, dev);
    assert.ok(merged.sections['Route Context'].includes('PERF-001'));
    assert.ok(!merged.sections['Route Context'].includes('API-001'));
  });

  it('team sections preserved when dev does not override them', () => {
    const team = { meta: {}, budget: {}, sections: { 'Identity': 'Team identity', 'Route Context': 'Team rules' } };
    const dev = { meta: {}, budget: {}, sections: { 'Route Context': 'Dev rules' } };
    const merged = mergeRouteConfigs(team, dev);
    assert.equal(merged.sections['Identity'], 'Team identity');
    assert.equal(merged.sections['Route Context'], 'Dev rules');
  });

  it('developer meta overrides team meta', () => {
    const team = { meta: { intent: 'coding:backend', description: 'Team desc' }, budget: {}, sections: {} };
    const dev = { meta: { description: 'Dev desc' }, budget: {}, sections: {} };
    const merged = mergeRouteConfigs(team, dev);
    assert.equal(merged.meta.intent, 'coding:backend');
    assert.equal(merged.meta.description, 'Dev desc');
  });

  it('partial dev budget does not clobber team values (Bug 2)', () => {
    const team = {
      meta: { intent: 'coding:backend' },
      budget: { identity: 10, route_context: 30, working_memory: 15, traces: 10, reserved: 35 },
      sections: {},
    };
    const dev = {
      meta: {},
      budget: { route_context: 40 },
      sections: {},
    };
    const merged = mergeRouteConfigs(team, dev);
    assert.equal(merged.budget.identity, 10, 'team identity preserved');
    assert.equal(merged.budget.route_context, 40, 'dev route_context wins');
    assert.equal(merged.budget.reserved, 35, 'team reserved preserved');
    assert.equal(merged.budget.working_memory, 15, 'team working_memory preserved');
    assert.equal(merged.budget.traces, 10, 'team traces preserved');
  });

  it('defaults fill budget keys omitted by both team and dev', () => {
    const team = { meta: {}, budget: { identity: 10 }, sections: {} };
    const dev = { meta: {}, budget: { route_context: 40 }, sections: {} };
    const merged = mergeRouteConfigs(team, dev);
    assert.equal(merged.budget.identity, 10, 'team identity preserved');
    assert.equal(merged.budget.route_context, 40, 'dev route_context wins');
    assert.equal(merged.budget.working_memory, 15, 'default fills gap');
    assert.equal(merged.budget.traces, 10, 'default fills gap');
    assert.equal(merged.budget.reserved, 35, 'default fills gap');
  });
});

describe('mergeProjectConfigs', () => {
  it('returns teamConfig when devConfig is null', () => {
    const team = { budgetTokens: 130000 };
    assert.deepStrictEqual(mergeProjectConfigs(team, null), team);
  });

  it('developer customIntents are prepended', () => {
    const team = { customIntents: [['infra', ['terraform']]] };
    const dev = { customIntents: [['coding:python', ['pandas']]] };
    const merged = mergeProjectConfigs(team, dev);
    assert.equal(merged.customIntents[0][0], 'coding:python');
    assert.equal(merged.customIntents[1][0], 'infra');
  });

  it('developer fileToRules override per-key', () => {
    const team = { fileToRules: { 'api.md': ['API-001'], 'db.md': ['DB-001'] } };
    const dev = { fileToRules: { 'api.md': ['API-002'] } };
    const merged = mergeProjectConfigs(team, dev);
    assert.deepStrictEqual(merged.fileToRules['api.md'], ['API-002']);
    assert.deepStrictEqual(merged.fileToRules['db.md'], ['DB-001']);
  });

  it('top-level developer values override team values', () => {
    const team = { budgetTokens: 130000, version: '0.2.0' };
    const dev = { budgetTokens: 100000 };
    const merged = mergeProjectConfigs(team, dev);
    assert.equal(merged.budgetTokens, 100000);
    assert.equal(merged.version, '0.2.0');
  });
});

describe('mergeEffectivenessScores', () => {
  it('developer scores override team scores for same rule', () => {
    const team = { 'API-001': 0.8, 'FO-001': 0.3 };
    const dev = { 'API-001': 0.95 };
    const merged = mergeEffectivenessScores(team, dev);
    assert.equal(merged['API-001'], 0.95);
    assert.equal(merged['FO-001'], 0.3);
  });

  it('returns empty when both are empty', () => {
    assert.deepStrictEqual(mergeEffectivenessScores({}, {}), {});
  });
});
