import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseRulesYaml, serializeRulesYaml, filterRules,
  resolveRule, addRuleToFile, loadRuleRegistry, normalizedSimilarity,
} from './rule-registry.js';

describe('parseRulesYaml — behavioral_signals', () => {
  it('parses nested behavioral_signals block', () => {
    const yaml = `rules:
  TEST-001:
    text: Unit tests for business logic
    severity: should
    behavioral_signals:
      - trigger:
          file_glob: src/**/*.ts
          tool: [Write, Edit]
        expect:
          sibling_file_touched: *.test.ts
`;
    const rules = parseRulesYaml(yaml);
    const r = rules.get('TEST-001');
    assert.ok(r);
    assert.equal(r.behavioral_signals.length, 1);
    assert.equal(r.behavioral_signals[0].trigger.file_glob, 'src/**/*.ts');
    assert.deepStrictEqual(r.behavioral_signals[0].trigger.tool, ['Write', 'Edit']);
    assert.equal(r.behavioral_signals[0].expect.sibling_file_touched, '*.test.ts');
  });

  it('roundtrips behavioral signals through serialize/parse', () => {
    const rules = new Map();
    rules.set('X-001', {
      id: 'X-001',
      text: 'A rule',
      severity: 'should',
      tags: [],
      routes: [],
      related: [],
      hash: 'abcd1234',
      behavioral_signals: [
        {
          trigger: { file_glob: 'src/**/*.ts', tool: ['Write'] },
          expect: { sibling_file_touched: '*.test.ts' }
        }
      ],
    });

    const yaml = serializeRulesYaml(rules);
    const parsed = parseRulesYaml(yaml);
    const r = parsed.get('X-001');
    assert.ok(r);
    assert.equal(r.behavioral_signals.length, 1);
    assert.equal(r.behavioral_signals[0].trigger.file_glob, 'src/**/*.ts');
  });
});

describe('normalizedSimilarity', () => {
  it('returns 1.0 for identical text', () => {
    assert.ok(normalizedSimilarity('use bcrypt for hashing', 'use bcrypt for hashing') > 0.9);
  });
  it('returns > 0.5 for near-identical text', () => {
    assert.ok(normalizedSimilarity('always use parameterized queries', 'use parameterized queries') >= 0.5);
  });
  it('returns 0 for empty', () => {
    assert.equal(normalizedSimilarity('', 'the and for'), 0);
  });
});

describe('parseRulesYaml', () => {
  it('parses a well-formed rules file', () => {
    const yaml = `rules:
  API-001:
    text: RESTful naming conventions
    severity: must
    tags: [api, naming]
    hash: a1b2c3d4
  DB-001:
    text: Use parameterized queries
    severity: must
    author: emre
    created: 2026-04-01
    tags: [database, security]`;

    const rules = parseRulesYaml(yaml);
    assert.equal(rules.size, 2);

    const api = rules.get('API-001');
    assert.equal(api.text, 'RESTful naming conventions');
    assert.equal(api.severity, 'must');
    assert.deepStrictEqual(api.tags, ['api', 'naming']);
    assert.equal(api.hash, 'a1b2c3d4');
    assert.equal(api.id, 'API-001');

    const db = rules.get('DB-001');
    assert.equal(db.author, 'emre');
    assert.equal(db.created, '2026-04-01');
  });

  it('computes hash if missing', () => {
    const yaml = `rules:
  MY-001:
    text: some rule text`;
    const rules = parseRulesYaml(yaml);
    assert.equal(rules.get('MY-001').hash.length, 8);
  });

  it('returns empty map for empty input', () => {
    assert.equal(parseRulesYaml('').size, 0);
    assert.equal(parseRulesYaml(null).size, 0);
  });

  it('handles free-text rule IDs with dashes', () => {
    const yaml = `rules:
  webhook-validation:
    text: Always validate webhook signatures
    tags: [security]`;
    const rules = parseRulesYaml(yaml);
    assert.ok(rules.has('webhook-validation'));
  });

  it('skips comment lines', () => {
    const yaml = `# This is a comment
rules:
  # Another comment
  X-01:
    text: rule text`;
    const rules = parseRulesYaml(yaml);
    assert.equal(rules.size, 1);
  });

  it('handles quoted strings with colons', () => {
    const yaml = `rules:
  R-01:
    text: "Use format: YYYY-MM-DD"`;
    const rules = parseRulesYaml(yaml);
    assert.equal(rules.get('R-01').text, 'Use format: YYYY-MM-DD');
  });
});

describe('serializeRulesYaml', () => {
  it('round-trips correctly', () => {
    const original = new Map();
    original.set('API-001', {
      id: 'API-001', text: 'RESTful naming', severity: 'must',
      tags: ['api'], routes: ['coding-backend'], hash: 'abcd1234',
      author: 'emre', created: '2026-04-01', description: '', related: [],
    });

    const serialized = serializeRulesYaml(original);
    const parsed = parseRulesYaml(serialized);

    assert.equal(parsed.size, 1);
    assert.equal(parsed.get('API-001').text, 'RESTful naming');
    assert.deepStrictEqual(parsed.get('API-001').tags, ['api']);
    assert.equal(parsed.get('API-001').severity, 'must');
  });
});

describe('filterRules', () => {
  const registry = new Map();
  registry.set('A-01', { id: 'A-01', text: 'Auth rule', tags: ['security', 'auth'], routes: ['coding-backend'], severity: 'must' });
  registry.set('B-01', { id: 'B-01', text: 'UI rule', tags: ['frontend'], routes: ['coding-frontend'], severity: 'should' });
  registry.set('C-01', { id: 'C-01', text: 'Security headers', tags: ['security'], routes: ['coding-backend'], severity: 'must' });

  it('filters by tag', () => {
    const results = filterRules(registry, { tag: 'security' });
    assert.equal(results.length, 2);
  });

  it('filters by route', () => {
    const results = filterRules(registry, { route: 'coding-frontend' });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'B-01');
  });

  it('filters by query (full-text)', () => {
    const results = filterRules(registry, { query: 'headers' });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'C-01');
  });

  it('returns all when no filter', () => {
    assert.equal(filterRules(registry).length, 3);
  });
});

describe('resolveRule', () => {
  const registry = new Map();
  registry.set('API-001', { id: 'API-001', text: 'RESTful', hash: 'abcd1234' });

  it('resolves by ID', () => {
    assert.equal(resolveRule('API-001', registry).text, 'RESTful');
  });

  it('resolves free-text hash', () => {
    assert.equal(resolveRule('rule-abcd1234', registry).text, 'RESTful');
  });

  it('returns null for unknown ID', () => {
    assert.equal(resolveRule('UNKNOWN-999', registry), null);
  });
});

describe('addRuleToFile + loadRuleRegistry', () => {
  it('writes and reads back a rule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-reg-'));
    try {
      const harnessDir = path.join(dir, '.harness');
      const localDir = path.join(harnessDir, 'local');
      fs.mkdirSync(localDir, { recursive: true });
      const paths = {
        harnessDir,
        localDir,
        rulesFile: path.join(harnessDir, 'rules.yaml'),
        localRulesFile: path.join(localDir, 'rules.yaml'),
      };

      addRuleToFile({
        id: 'TEST-001',
        text: 'Test rule',
        severity: 'must',
        tags: ['t1', 't2'],
      }, paths.rulesFile);

      const registry = loadRuleRegistry(paths);
      assert.equal(registry.size, 1);
      assert.equal(registry.get('TEST-001').text, 'Test rule');
      assert.equal(registry.get('TEST-001').severity, 'must');
      assert.deepStrictEqual(registry.get('TEST-001').tags, ['t1', 't2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local registry overrides team registry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-reg-'));
    try {
      const harnessDir = path.join(dir, '.harness');
      const localDir = path.join(harnessDir, 'local');
      fs.mkdirSync(localDir, { recursive: true });
      const paths = {
        harnessDir,
        localDir,
        rulesFile: path.join(harnessDir, 'rules.yaml'),
        localRulesFile: path.join(localDir, 'rules.yaml'),
      };

      addRuleToFile({ id: 'X-01', text: 'Team', severity: 'should' }, paths.rulesFile);
      addRuleToFile({ id: 'X-01', text: 'Dev', severity: 'must' }, paths.localRulesFile);
      addRuleToFile({ id: 'Y-01', text: 'Team only' }, paths.rulesFile);

      const registry = loadRuleRegistry(paths);
      assert.equal(registry.get('X-01').text, 'Dev');
      assert.equal(registry.get('X-01').severity, 'must');
      assert.equal(registry.get('Y-01').text, 'Team only');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
