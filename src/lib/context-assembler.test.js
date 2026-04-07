import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteConfig, DEFAULT_BUDGET } from './context-assembler.js';

describe('parseRouteConfig', () => {
  it('returns only budget keys present in YAML (Bug 2)', () => {
    const content = '---\nintent: test\nbudget:\n  route_context: 40\n---\n## Identity\nTest';
    const result = parseRouteConfig(content);
    assert.equal(result.budget.route_context, 40);
    assert.equal(result.budget.identity, undefined, 'should not fill defaults');
    assert.equal(result.budget.reserved, undefined, 'should not fill defaults');
  });

  it('returns empty budget when no budget in YAML', () => {
    const content = '---\nintent: test\n---\n## Identity\nTest';
    const result = parseRouteConfig(content);
    assert.deepStrictEqual(result.budget, {});
  });

  it('parses all budget keys when all are specified', () => {
    const content = '---\nintent: test\nbudget:\n  identity: 10\n  route_context: 30\n  working_memory: 20\n  traces: 5\n  reserved: 35\n---\n';
    const result = parseRouteConfig(content);
    assert.equal(result.budget.identity, 10);
    assert.equal(result.budget.route_context, 30);
    assert.equal(result.budget.working_memory, 20);
    assert.equal(result.budget.traces, 5);
    assert.equal(result.budget.reserved, 35);
  });

  it('parses sections correctly', () => {
    const content = '---\nintent: test\n---\n## Identity\nProject identity\n\n## Route Context\n### Must Load\n- API-001';
    const result = parseRouteConfig(content);
    assert.ok(result.sections['Identity'].includes('Project identity'));
    assert.ok(result.sections['Route Context'].includes('API-001'));
  });
});

describe('DEFAULT_BUDGET', () => {
  it('is exported and has all expected keys', () => {
    assert.equal(DEFAULT_BUDGET.identity, 15);
    assert.equal(DEFAULT_BUDGET.route_context, 25);
    assert.equal(DEFAULT_BUDGET.working_memory, 15);
    assert.equal(DEFAULT_BUDGET.traces, 10);
    assert.equal(DEFAULT_BUDGET.reserved, 35);
  });
});

describe('loadWorkStatus regex (Bug 3)', () => {
  it('extracts Active Work when it is the last section', () => {
    // The regex previously used \\Z (Python/PCRE) instead of $ (JavaScript)
    const content = '## Active Work\n- Building feature X\n- Blocked on review\n';
    const re = /## Active Work\n([\s\S]*?)(?=\n## |\n---|$)/;
    const match = content.match(re);
    assert.ok(match, 'regex should match when Active Work is last section');
    assert.ok(match[1].includes('Building feature X'), 'should capture content');
    assert.ok(match[1].includes('Blocked on review'), 'should capture all content');
  });

  it('extracts Active Work when followed by another section', () => {
    const content = '## Active Work\n- Building feature X\n\n## History\n- Done thing';
    const re = /## Active Work\n([\s\S]*?)(?=\n## |\n---|$)/;
    const match = content.match(re);
    assert.ok(match, 'regex should match');
    assert.ok(match[1].includes('Building feature X'));
    assert.ok(!match[1].includes('Done thing'), 'should not leak into next section');
  });
});
