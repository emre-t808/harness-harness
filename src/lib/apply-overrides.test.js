import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { markApplied, parseOverrides, applyDemotion, applyPromotion } from './apply-overrides.js';

describe('markApplied (Bug 4)', () => {
  it('includes developer name in applied status', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-'));
    const overridesFile = path.join(tmpDir, 'route-overrides.md');
    fs.writeFileSync(overridesFile, [
      '### Promotions',
      '- API-001 → Identity layer (all routes)',
      '  Status: approved',
      '  Reviewed by: alice',
    ].join('\n'));

    const paths = { overridesFile };
    markApplied([1], paths, false, 'testdev');

    const result = fs.readFileSync(overridesFile, 'utf8');
    assert.ok(result.includes('testdev'), 'developer name should be in status line');
    assert.ok(result.includes('applied'), 'should be marked as applied');
    assert.ok(result.includes('by testdev'), 'should use "by developer" format');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('uses "unknown" when no developer specified', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-'));
    const overridesFile = path.join(tmpDir, 'route-overrides.md');
    fs.writeFileSync(overridesFile, [
      '### Promotions',
      '- API-001 → Identity layer (all routes)',
      '  Status: approved',
      '  Reviewed by: alice',
    ].join('\n'));

    const paths = { overridesFile };
    markApplied([1], paths, false);

    const result = fs.readFileSync(overridesFile, 'utf8');
    assert.ok(result.includes('by unknown'), 'should default to unknown');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('does nothing in dry-run mode', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-'));
    const overridesFile = path.join(tmpDir, 'route-overrides.md');
    const original = '### Promotions\n- API-001\n  Status: approved\n';
    fs.writeFileSync(overridesFile, original);

    const paths = { overridesFile };
    markApplied([1], paths, true, 'testdev');

    const result = fs.readFileSync(overridesFile, 'utf8');
    assert.equal(result, original, 'file should be unchanged in dry-run');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('parseOverrides', () => {
  it('requires Reviewed by field unless forceMode (Bug 4)', () => {
    const content = [
      '### Promotions',
      '- API-001 → Identity layer (all routes)',
      '  Status: approved',
      '',
    ].join('\n');

    // Without force: no reviewer = skip
    const result = parseOverrides(content, false);
    assert.equal(result.promotions.length, 0, 'should skip without reviewer');

    // With force: no reviewer = include
    const forced = parseOverrides(content, true);
    assert.equal(forced.promotions.length, 1, 'should include with --force');
  });

  it('includes promotions with Reviewed by field', () => {
    const content = [
      '### Promotions',
      '- API-001 → Identity layer (all routes)',
      '  Status: approved',
      '  Reviewed by: alice',
      '',
    ].join('\n');

    const result = parseOverrides(content, false);
    assert.equal(result.promotions.length, 1);
    assert.equal(result.promotions[0].rule, 'API-001');
  });
});

// ---------------------------------------------------------------------------
// A rule must survive its own promotion/demotion.
//
// Both apply paths used to OVERWRITE the rule's line with a note about the move:
//   "- GA-001: Google → integrations/, NEVER MCP"
//     demote  -> "- GA-001 (score: 0.00, demoted 2026-07-15)"
//     promote -> "- GA-001: promoted to Identity layer (high effectiveness…)"
// That deletes the rule the model is supposed to obey. Worse, it is self-sealing:
// a rule whose text is gone can never be followed, so it never scores, so it stays
// demoted forever. Route configs are content, not scoreboards.
// ---------------------------------------------------------------------------

describe('applyDemotion — preserves the rule it demotes', () => {
  const ROUTE = [
    '## Identity',
    'Project identity.',
    '',
    '## Route Context',
    '### Must Load',
    '- GA-001: Google → integrations/, NEVER MCP',
    '- CS-001: Functions under 40 lines',
    '',
    '### Skip (low effectiveness for this route)',
    '',
    '## Working Memory',
    '- state.md',
    '',
  ].join('\n');

  function routeFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-demote-'));
    const file = path.join(dir, 'coding-backend.md');
    fs.writeFileSync(file, ROUTE);
    return file;
  }

  it('moves the rule line into Skip with its text intact', () => {
    const file = routeFile();
    const result = applyDemotion(file, 'GA-001', false);
    const out = fs.readFileSync(file, 'utf8');

    assert.equal(result.changed, true);
    assert.ok(
      out.includes('- GA-001: Google → integrations/, NEVER MCP'),
      'the rule TEXT must survive demotion — otherwise the rule is destroyed, not demoted'
    );
    assert.ok(out.includes('demoted'), 'provenance of the move should be recorded');

    const skipIdx = out.indexOf('### Skip');
    assert.ok(out.indexOf('GA-001') > skipIdx, 'GA-001 should now sit under Skip');
    assert.ok(out.includes('- CS-001: Functions under 40 lines'), 'other rules untouched');
  });

  it('is a no-op when the rule is already skipped', () => {
    const file = routeFile();
    applyDemotion(file, 'GA-001', false);
    const second = applyDemotion(file, 'GA-001', false);
    assert.equal(second.changed, false);
  });
});

describe('applyPromotion — preserves the rule it promotes', () => {
  function routeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-promote-'));
    fs.writeFileSync(path.join(dir, 'general.md'), [
      '## Identity',
      'Project identity.',
      '',
      '## Route Context',
      '### Must Load',
      '- GA-001: Google → integrations/, NEVER MCP',
      '',
      '## Working Memory',
      '- state.md',
      '',
    ].join('\n'));
    return dir;
  }

  it('moves the rule into Identity with its text intact, and out of Route Context', () => {
    const dir = routeDir();
    const result = applyPromotion('GA-001', { routesDir: dir }, false);
    const out = fs.readFileSync(path.join(dir, 'general.md'), 'utf8');

    assert.equal(result.changed, true);
    assert.ok(
      out.includes('- GA-001: Google → integrations/, NEVER MCP'),
      'the rule TEXT must survive promotion'
    );
    assert.ok(!out.includes('promoted to Identity layer (high effectiveness'),
      'the rule must not be replaced by a note about itself');

    // It is a MOVE, not a duplication: exactly one GA-001 line, and it is in Identity.
    const occurrences = (out.match(/GA-001/g) || []).length;
    assert.equal(occurrences, 1, 'GA-001 should appear once — moved, not duplicated');

    const identityIdx = out.indexOf('## Identity');
    const routeCtxIdx = out.indexOf('## Route Context');
    const ruleIdx = out.indexOf('GA-001');
    assert.ok(ruleIdx > identityIdx && ruleIdx < routeCtxIdx, 'GA-001 should sit in Identity');
  });
});
