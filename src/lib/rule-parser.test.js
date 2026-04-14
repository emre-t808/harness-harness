import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleLine, parseRulesFromSection, computeRuleHash } from './rule-parser.js';

describe('computeRuleHash', () => {
  it('produces 8-char hex', () => {
    const hash = computeRuleHash('some rule text');
    assert.equal(hash.length, 8);
    assert.match(hash, /^[a-f0-9]{8}$/);
  });

  it('is deterministic', () => {
    assert.equal(computeRuleHash('same text'), computeRuleHash('same text'));
  });

  it('normalizes whitespace and case', () => {
    assert.equal(
      computeRuleHash('  Some  Rule  TEXT  '),
      computeRuleHash('some rule text')
    );
  });

  it('different text produces different hash', () => {
    assert.notEqual(computeRuleHash('rule A'), computeRuleHash('rule B'));
  });
});

describe('parseRuleLine', () => {
  it('parses explicit-id rule with text', () => {
    const rule = parseRuleLine('- API-001: RESTful naming conventions', 'backend.md:5');
    assert.equal(rule.id, 'API-001');
    assert.equal(rule.text, 'RESTful naming conventions');
    assert.equal(rule.origin, 'explicit-id');
    assert.equal(rule.source, 'backend.md:5');
    assert.equal(rule.hash.length, 8);
  });

  it('parses explicit-id rule without text', () => {
    const rule = parseRuleLine('- DB-001', 'backend.md:6');
    assert.equal(rule.id, 'DB-001');
    assert.equal(rule.text, 'DB-001');
    assert.equal(rule.origin, 'explicit-id');
  });

  it('parses free-text rule', () => {
    const rule = parseRuleLine('- Always validate webhook signatures', 'backend.md:7');
    assert.match(rule.id, /^rule-[a-f0-9]{8}$/);
    assert.equal(rule.text, 'Always validate webhook signatures');
    assert.equal(rule.origin, 'free-text');
    assert.equal(rule.hash, rule.id.replace('rule-', ''));
  });

  it('handles 2-letter prefix', () => {
    const rule = parseRuleLine('- FD-01: No Arial fonts', 'fe.md:1');
    assert.equal(rule.id, 'FD-01');
  });

  it('handles 4-letter prefix with 4-digit number', () => {
    const rule = parseRuleLine('- TEST-0001: Always test', 'test.md:1');
    assert.equal(rule.id, 'TEST-0001');
  });

  it('returns null for empty line', () => {
    assert.equal(parseRuleLine('- ', 'x.md:1'), null);
    assert.equal(parseRuleLine('', 'x.md:1'), null);
  });

  it('does NOT match non-rule patterns like HTTP-200 embedded in text', () => {
    const rule = parseRuleLine('- Return HTTP-200 for success', 'api.md:1');
    assert.equal(rule.origin, 'free-text');
  });
});

describe('parseRulesFromSection', () => {
  it('extracts rules from Must Load section only', () => {
    const section = `## Route Context
### Must Load
- API-001: RESTful naming
- Always validate webhooks
- DB-001: Parameterized queries

### Load If Budget Allows
- docs/api.md (full)
- STYLE-001: Should NOT be extracted`;

    const rules = parseRulesFromSection(section, 'backend.md');
    assert.equal(rules.length, 3);
    assert.equal(rules[0].id, 'API-001');
    assert.equal(rules[1].origin, 'free-text');
    assert.equal(rules[2].id, 'DB-001');
  });

  it('handles multiple Must Load subsections', () => {
    const section = `## Route Context
### Must Load
- RULE-01: First

### Must Load (absorbed from some-hook.sh)
- RULE-02: Second`;

    const rules = parseRulesFromSection(section, 'route.md');
    assert.equal(rules.length, 2);
  });

  it('returns empty array for no Must Load section', () => {
    const rules = parseRulesFromSection('## Route Context\n### Skip\n- nothing', 'x.md');
    assert.equal(rules.length, 0);
  });
});
