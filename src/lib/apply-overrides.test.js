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

  // OI-R64: route names carry colons (coding:meta). The old lazy '(.+?):' split
  // at the first colon, so 4 of the 7 owner-approved budget changes looked up
  // coding.md / writing.md, found nothing and were skipped without a word.
  // Both fixtures are lines from the live route-overrides.md (2026-11-12).
  function budgetBlock(entry) {
    return ['### Budget Rebalancing', entry, '  Status: approved', '  Reviewed by: owner', ''].join('\n');
  }

  it('keeps the whole colon route name in a budget change (coding:meta)', () => {
    const { budgetChanges } = parseOverrides(budgetBlock('- coding:meta: utilization 37% → decrease route_context by 5%'));
    assert.equal(budgetChanges.length, 1);
    assert.equal(budgetChanges[0].route, 'coding:meta');
    assert.equal(budgetChanges[0].description, 'utilization 37% → decrease route_context by 5%');
  });

  it('still parses a plain route name in a budget change (analyzing)', () => {
    const { budgetChanges } = parseOverrides(budgetBlock('- analyzing: utilization 26% → decrease route_context by 5%'));
    assert.equal(budgetChanges.length, 1);
    assert.equal(budgetChanges[0].route, 'analyzing');
    assert.equal(budgetChanges[0].description, 'utilization 26% → decrease route_context by 5%');
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

// OI-R65: a route with no line for the promoted rule used to get a bare
// "- SEC-001 <!-- promoted … -->": the model saw an ID and no rule. The line
// must be the catalogue form RID-002 checks, or the promotion is refused.
describe('applyPromotion — a route with no line gets the rule text, or nothing', () => {
  function project({ catalogue = true, otherRouteLine = null } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-promote-cat-'));
    const routesDir = path.join(root, 'routes');
    fs.mkdirSync(routesDir);
    const route = (extra) => ['## Identity', 'Project identity.', '', '## Route Context', '### Must Load', ...extra, '', '## Working Memory', ''].join('\n');
    fs.writeFileSync(path.join(routesDir, 'general.md'), route(['- FO-009: Files in Root — never root']));
    fs.writeFileSync(path.join(routesDir, 'coding-meta.md'), route(otherRouteLine ? [otherRouteLine] : []));
    let rulesCatalogDir = null;
    if (catalogue) {
      rulesCatalogDir = path.join(root, 'anti-patterns');
      fs.mkdirSync(rulesCatalogDir);
      fs.writeFileSync(path.join(rulesCatalogDir, 'security.md'), [
        '# Security', '', '## SEC-001: Skipping Security Audit After Integration', '',
        '**Source:** Learning', '', '**Anti-pattern:** Adding a new API without running a security audit.', '',
        '## SEC-002: Other', '', '**Anti-pattern:** Not this one.', '',
      ].join('\n'));
    }
    return { routesDir, rulesCatalogDir };
  }
  const read = (paths, f) => fs.readFileSync(path.join(paths.routesDir, f), 'utf8');

  it('inserts "- <ID>: <title> — <summary>" from the catalogue, never a bare ID', () => {
    const paths = project();
    const result = applyPromotion('SEC-001', paths, false);
    assert.equal(result.changed, true);
    const out = read(paths, 'general.md');
    assert.match(out, /^- SEC-001: Skipping Security Audit After Integration — Adding a new API without running a security audit\. <!-- promoted /m);
    assert.doesNotMatch(out, /^- SEC-001 <!--/m, 'a bare ID line is the bug');
  });

  it("prefers another route's guidance for the summary, and moves an existing line as before", () => {
    const paths = project({ otherRouteLine: '- SEC-001: Skipping Security Audit After Integration — run /security-audit after any new integration' });
    applyPromotion('SEC-001', paths, false);
    assert.match(read(paths, 'general.md'), /^- SEC-001: Skipping Security Audit After Integration — run \/security-audit after any new integration <!-- promoted /m);
    const meta = read(paths, 'coding-meta.md');
    assert.equal((meta.match(/SEC-001/g) || []).length, 1, 'moved, not duplicated');
    assert.ok(meta.indexOf('SEC-001') < meta.indexOf('## Route Context'));
  });

  it('refuses the whole promotion with a reason when the catalogue is out of reach', () => {
    const paths = project({ catalogue: false, otherRouteLine: '- SEC-001: Skipping Security Audit After Integration — guidance' });
    const before = [read(paths, 'general.md'), read(paths, 'coding-meta.md')];
    const result = applyPromotion('SEC-001', paths, false);
    assert.equal(result.changed, false);
    assert.match(result.refused, /rulesCatalogDir/);
    assert.match(result.descriptions[0], /^refused SEC-001: /);
    assert.deepEqual([read(paths, 'general.md'), read(paths, 'coding-meta.md')], before, 'nothing is written, not even the routes that could move a line');
  });

  it('refuses when the catalogue has the rule but no summary exists anywhere', () => {
    const paths = project();
    fs.writeFileSync(path.join(paths.rulesCatalogDir, 'security.md'), '## SEC-001: Title Only\n\n**The Mistake:**\n');
    const result = applyPromotion('SEC-001', paths, false);
    assert.equal(result.changed, false);
    assert.match(result.refused, /no one-line summary/);
  });
});
