import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { markApplied, parseOverrides } from './apply-overrides.js';

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
