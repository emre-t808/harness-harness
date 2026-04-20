import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRules, statusToScore, parseRuleLines } from './behavioral-scoring.js';

// ---------------------------------------------------------------------------
// parseRuleLines
// ---------------------------------------------------------------------------

describe('parseRuleLines', () => {
  it('extracts dash-prefixed lines from markdown', () => {
    const content = '### Must Load\n- Use parameterized queries\n- Write tests for every file\n\nSome prose.';
    const rules = parseRuleLines(content);
    assert.equal(rules.length, 2);
    assert.ok(rules[0].includes('parameterized'));
    assert.ok(rules[1].includes('tests'));
  });

  it('skips Example: and Add your lines', () => {
    const content = '- Example: API-001\n- Add your rules here\n- Use strict TypeScript mode';
    const rules = parseRuleLines(content);
    assert.equal(rules.length, 1);
    assert.ok(rules[0].includes('TypeScript'));
  });

  it('skips very short lines', () => {
    const content = '- OK\n- Use parameterized queries for all database operations';
    const rules = parseRuleLines(content);
    assert.equal(rules.length, 1);
  });

  it('returns empty for null/empty input', () => {
    assert.deepStrictEqual(parseRuleLines(null), []);
    assert.deepStrictEqual(parseRuleLines(''), []);
  });
});

// ---------------------------------------------------------------------------
// scoreRules — SQL interpolation check
// ---------------------------------------------------------------------------

describe('scoreRules: no-sql-interpolation', () => {
  it('detects template literal SQL interpolation', () => {
    const rules = ['Use parameterized queries, never string interpolation in SQL'];
    // Realistic diff: backtick template literal with SQL + interpolation
    const diff = `+++ a/src/db.ts
+  const result = db.query(\`SELECT * FROM users WHERE id = \${userId}\`);`;
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'VIOLATED');
    assert.ok(results[0].evidence.includes('interpolation') || results[0].evidence.includes('SQL'));
  });

  it('detects string concatenation SQL', () => {
    const rules = ['Use parameterized queries, never string interpolation in SQL'];
    const diff = '+  const q = "SELECT * FROM users WHERE name = " + userName;';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'VIOLATED');
  });

  it('passes clean parameterized queries', () => {
    const rules = ['Use parameterized queries, never string interpolation'];
    const diff = '+  const result = db.query("SELECT * FROM users WHERE id = $1", [userId]);';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'COMPLIANT');
  });

  it('returns NOT_APPLICABLE when no SQL in diff', () => {
    const rules = ['Use parameterized queries, never string interpolation'];
    const diff = '+  console.log("hello world");';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'NOT_APPLICABLE');
  });
});

// ---------------------------------------------------------------------------
// scoreRules — test coverage check
// ---------------------------------------------------------------------------

describe('scoreRules: test-coverage', () => {
  it('detects missing test files', () => {
    const rules = ['Write a test file for every modified source file'];
    const events = [
      { tool: 'Edit', files_touched: ['src/services/payment.ts'] },
      { tool: 'Edit', files_touched: ['src/routes/api.ts'] },
    ];
    const results = scoreRules(rules, '', events);
    assert.equal(results[0].status, 'VIOLATED');
    assert.ok(results[0].evidence.includes('Missing tests'));
  });

  it('passes when test files exist for all edits', () => {
    const rules = ['Write a test file for every modified source file'];
    const events = [
      { tool: 'Edit', files_touched: ['src/services/payment.ts'] },
      { tool: 'Write', files_touched: ['tests/services/payment.spec.ts'] },
    ];
    const results = scoreRules(rules, '', events);
    assert.equal(results[0].status, 'COMPLIANT');
  });
});

// ---------------------------------------------------------------------------
// scoreRules — no console.log
// ---------------------------------------------------------------------------

describe('scoreRules: no-console-log', () => {
  it('detects console.log in added lines', () => {
    const rules = ['Do not leave console.log statements in production code'];
    const diff = '+ function handle() {\n+   console.log("debug here");\n+ }';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'VIOLATED');
  });

  it('passes when no console statements added', () => {
    const rules = ['Do not leave console.log statements in production code'];
    const diff = '+ function handle() {\n+   return result;\n+ }';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'COMPLIANT');
  });
});

// ---------------------------------------------------------------------------
// scoreRules — no any type
// ---------------------------------------------------------------------------

describe('scoreRules: no-any-type', () => {
  it('detects : any in added code', () => {
    const rules = ['Use explicit TypeScript types; avoid `any`'];
    const diff = '+++ a/src/handler.ts\n+ function process(data: any) {';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'VIOLATED');
  });

  it('passes when no any types', () => {
    const rules = ['Use explicit types, avoid any'];
    const diff = '+++ a/src/handler.ts\n+ function process(data: string) {';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'COMPLIANT');
  });
});

// ---------------------------------------------------------------------------
// scoreRules — hardcoded secrets
// ---------------------------------------------------------------------------

describe('scoreRules: no-hardcoded-secrets', () => {
  it('detects hardcoded API keys', () => {
    const rules = ['Never hardcode secrets or API keys'];
    const diff = '+ const apiKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'VIOLATED');
  });

  it('passes clean code', () => {
    const rules = ['Never hardcode secrets or credentials'];
    const diff = '+ const apiKey = process.env.API_KEY;';
    const results = scoreRules(rules, diff, []);
    assert.equal(results[0].status, 'COMPLIANT');
  });
});

// ---------------------------------------------------------------------------
// scoreRules — unverifiable rules
// ---------------------------------------------------------------------------

describe('scoreRules: unverifiable rules', () => {
  it('returns UNVERIFIABLE for rules with no matching checker', () => {
    const rules = ['Follow the team coding style guide for all new code'];
    const results = scoreRules(rules, 'some diff', []);
    assert.equal(results[0].status, 'UNVERIFIABLE');
    assert.equal(results[0].check, null);
  });

  it('returns UNVERIFIABLE when diff is null', () => {
    const rules = ['Do not leave console.log statements'];
    const results = scoreRules(rules, null, []);
    assert.equal(results[0].status, 'UNVERIFIABLE');
    assert.ok(results[0].evidence.includes('No diff'));
  });
});

// ---------------------------------------------------------------------------
// statusToScore
// ---------------------------------------------------------------------------

describe('statusToScore', () => {
  it('maps statuses to numeric scores', () => {
    assert.equal(statusToScore('COMPLIANT'), 1.0);
    assert.equal(statusToScore('VIOLATED'), -1.0);
    assert.equal(statusToScore('NOT_APPLICABLE'), 0.0);
    assert.equal(statusToScore('UNVERIFIABLE'), 0.0);
    assert.equal(statusToScore('unknown'), 0.0);
  });
});
