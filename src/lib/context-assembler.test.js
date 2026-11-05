import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleContext, getLastManifest, parseRouteConfig, DEFAULT_BUDGET } from './context-assembler.js';
import { resolvePaths } from './paths.js';

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

// OI-R73: session-summary orders sidecar revisions by the later of the last
// trace event and this stamp. Without it, a turn with no tool calls that
// re-routes the session leaves two hashes at one instant and the evidence
// store quarantines the session.
describe('manifest generated_at (OI-R73)', () => {
  it('stamps each manifest with the instant it was assembled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-stamp-'));
    try {
      const before = Date.now();
      assembleContext('general', { meta: { intent: 'general' }, budget: DEFAULT_BUDGET, sections: {} }, resolvePaths(dir));
      const stamp = Date.parse(getLastManifest().generated_at);
      assert.ok(stamp >= before && stamp <= Date.now(), `generated_at ${getLastManifest().generated_at}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
