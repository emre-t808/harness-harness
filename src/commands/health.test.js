/**
 * Tests for the health command's pending-proposal count.
 *
 * Regression guard for the analyze→health path mismatch: `analyze` (and the
 * daily tuner) write proposals to the per-developer LOCAL file, but `health`
 * used to count the shared file, so it printed "No pending proposals." while
 * 784 sat in .harness/local/memory/route-overrides.md. health must read the
 * SAME file apply reads — local by default, shared with --team — and must not
 * count the block header "Status: pending-review" as a proposal.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { health } from './health.js';
import { resolvePaths } from '../lib/paths.js';

const TWO_PENDING = [
  '## Proposed Adjustments',
  'Status: pending-review',
  '',
  '### Demotions',
  '- CM-010 → Skip in coding:meta',
  '  Evidence: 0.10 avg across 13 sessions',
  '  Status: pending',
  '  Proposed by: alice (2026-10-22)',
  '- ZK-005 → Skip in coding:meta',
  '  Evidence: 0.20 avg across 13 sessions',
  '  Status: pending',
  '  Proposed by: alice (2026-10-22)',
  '',
].join('\n');

const EMPTY_SHARED = '## Route Overrides\n\nNo proposals yet.\n';

let tmpDir;
let paths;
let logSpy;
let output;

describe('health — pending proposals read the file analyze writes', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-health-test-'));
    paths = resolvePaths(tmpDir);
    fs.mkdirSync(paths.memoryDir, { recursive: true });
    fs.mkdirSync(paths.localMemoryDir, { recursive: true });
    output = [];
    logSpy = console.log;
    console.log = (...args) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = logSpy;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default mode counts the LOCAL file and ignores the pending-review header', async () => {
    fs.writeFileSync(paths.localOverridesFile, TWO_PENDING, 'utf8');
    fs.writeFileSync(paths.overridesFile, EMPTY_SHARED, 'utf8');

    await health(tmpDir, []);

    const joined = output.join('\n');
    assert.ok(joined.includes('Pending proposals: 2'), `expected 2 pending, got:\n${joined}`);
    assert.ok(joined.includes(`Review: cat ${paths.localOverridesFile}`), 'review path points at the local file');
    assert.ok(!joined.includes('No pending proposals.'));
  });

  it('--team mode counts the shared file', async () => {
    fs.writeFileSync(paths.localOverridesFile, TWO_PENDING, 'utf8');
    fs.writeFileSync(paths.overridesFile, EMPTY_SHARED, 'utf8');

    await health(tmpDir, ['--team']);

    const joined = output.join('\n');
    assert.ok(joined.includes('No pending proposals.'), `expected the empty shared file, got:\n${joined}`);
  });
});
