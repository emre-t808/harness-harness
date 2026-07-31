/**
 * Tests for the apply command's override-file resolution.
 *
 * Regression guard for the analyze→apply path mismatch: `analyze` writes
 * proposals to the per-developer local file by default, but `apply` used to
 * read only the shared file, so it never saw them. apply must read the SAME
 * file analyze writes — local by default, shared with --team.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { apply } from './apply.js';
import { resolvePaths } from '../lib/paths.js';

const APPROVED_PROMOTION = [
  '## Proposed Adjustments',
  'Status: pending-review',
  '',
  '### Promotions',
  '- GA-001 → Identity layer (all routes)',
  '  Status: approved',
  '  Reviewed by: alice',
  '',
].join('\n');

const ROUTE_WITH_RULE = [
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
].join('\n');

let tmpDir;
let paths;
let logSpy;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-apply-test-'));
  paths = resolvePaths(tmpDir);
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.mkdirSync(paths.localMemoryDir, { recursive: true });
  fs.mkdirSync(paths.routesDir, { recursive: true });
  fs.writeFileSync(path.join(paths.routesDir, 'general.md'), ROUTE_WITH_RULE, 'utf8');
}

describe('apply — override file resolution (analyze→apply path mismatch)', () => {
  beforeEach(() => {
    setup();
    // Silence the command's console output during the test run.
    logSpy = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    console.log = logSpy;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default mode reads the LOCAL file analyze writes and marks it applied', async () => {
    // Proposal exists ONLY in the local file — the shared file is empty.
    fs.writeFileSync(paths.localOverridesFile, APPROVED_PROMOTION, 'utf8');
    fs.writeFileSync(paths.overridesFile, '## Route Overrides\n\nNo proposals yet.\n', 'utf8');

    await apply(tmpDir, []);

    const route = fs.readFileSync(path.join(paths.routesDir, 'general.md'), 'utf8');
    assert.ok(route.includes('- GA-001: Google → integrations/, NEVER MCP'), 'rule text survives promotion');
    const identityIdx = route.indexOf('## Identity');
    const routeCtxIdx = route.indexOf('## Route Context');
    const ruleIdx = route.indexOf('GA-001');
    assert.ok(ruleIdx > identityIdx && ruleIdx < routeCtxIdx, 'GA-001 promoted into Identity');

    const localAfter = fs.readFileSync(paths.localOverridesFile, 'utf8');
    assert.ok(localAfter.includes('Status: applied'), 'the LOCAL proposal is marked applied');

    const sharedAfter = fs.readFileSync(paths.overridesFile, 'utf8');
    assert.ok(!sharedAfter.includes('Status: applied'), 'the shared file is not touched in default mode');
  });

  it('--team mode reads the shared file', async () => {
    // Proposal exists ONLY in the shared file; local is empty.
    fs.writeFileSync(paths.overridesFile, APPROVED_PROMOTION, 'utf8');

    await apply(tmpDir, ['--team']);

    const sharedAfter = fs.readFileSync(paths.overridesFile, 'utf8');
    assert.ok(sharedAfter.includes('Status: applied'), 'the shared proposal is marked applied under --team');
  });
});
