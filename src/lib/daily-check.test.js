/**
 * Tests for daily-check.js — automatic daily aggregation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getLastAggregationDate,
  writeNotification,
  runAggregation,
  runDailyCheckIfDue,
  AGGREGATION_INTERVAL_HOURS,
} from './daily-check.js';
import { resolvePaths } from './paths.js';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hh-daily-test-'));
}

function setupProject(tmpDir) {
  const harnessDir = path.join(tmpDir, '.harness');
  const memoryDir = path.join(harnessDir, 'memory');
  const localMemoryDir = path.join(harnessDir, 'local', 'memory');
  const routesDir = path.join(harnessDir, 'routes');
  const tracesDir = path.join(tmpDir, '.claude', 'traces');
  const traceIndex = path.join(tracesDir, 'index.md');

  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(localMemoryDir, { recursive: true });
  fs.mkdirSync(routesDir, { recursive: true });
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.writeFileSync(traceIndex, '# Session Trace Index\n', 'utf8');

  return { harnessDir, memoryDir, localMemoryDir, routesDir, tracesDir };
}

function writeSummary(tracesDir, date, sessionId, route, rules) {
  const dir = path.join(tracesDir, date);
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    `## Session ${sessionId} — ${date}`,
    '',
    `**Route:** ${route}`,
    '**Tools:** 10',
    '**Files:** 3',
    '',
    '### Effectiveness Scores',
    '',
    '| Context | Score | Evidence |',
    '|---------|-------|----------|',
  ];
  for (const { rule, score, evidence } of rules) {
    lines.push(`| ${rule} | ${score.toFixed(1)} | ${evidence} |`);
  }
  lines.push('');

  fs.writeFileSync(path.join(dir, `${sessionId}-summary.md`), lines.join('\n'), 'utf8');
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------------------
// getLastAggregationDate
// -------------------------------------------------------------------------

describe('getLastAggregationDate', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('returns null for missing file', () => {
    assert.equal(getLastAggregationDate(path.join(tmpDir, 'nope.md')), null);
  });

  it('returns null for file without date', () => {
    const f = path.join(tmpDir, 'eff.md');
    fs.writeFileSync(f, '## Harness Effectiveness Scores\n\nNo data yet.\n');
    assert.equal(getLastAggregationDate(f), null);
  });

  it('parses a valid date', () => {
    const f = path.join(tmpDir, 'eff.md');
    fs.writeFileSync(f, '## Harness Effectiveness Scores\nLast aggregated: 2026-04-01\nSessions analyzed: 5\n');
    const date = getLastAggregationDate(f);
    assert.ok(date instanceof Date);
    assert.equal(date.toISOString().slice(0, 10), '2026-04-01');
  });

  it('returns null for malformed date', () => {
    const f = path.join(tmpDir, 'eff.md');
    fs.writeFileSync(f, 'Last aggregated: not-a-date\n');
    assert.equal(getLastAggregationDate(f), null);
  });
});

// -------------------------------------------------------------------------
// writeNotification
// -------------------------------------------------------------------------

describe('writeNotification', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('writes notification with proposals', () => {
    const f = path.join(tmpDir, 'notifications.md');
    writeNotification(f, 3, 10);
    const content = fs.readFileSync(f, 'utf8');
    assert.ok(content.includes('3 new proposal(s)'));
    assert.ok(content.includes('10 sessions analyzed'));
    assert.ok(content.includes('harness-harness health'));
  });

  it('writes notification without proposals', () => {
    const f = path.join(tmpDir, 'notifications.md');
    writeNotification(f, 0, 5);
    const content = fs.readFileSync(f, 'utf8');
    assert.ok(content.includes('all scores within thresholds'));
    assert.ok(content.includes('5 sessions analyzed'));
  });

  it('creates parent directories', () => {
    const f = path.join(tmpDir, 'nested', 'dir', 'notifications.md');
    writeNotification(f, 1, 2);
    assert.ok(fs.existsSync(f));
  });

  it('overwrites previous notification', () => {
    const f = path.join(tmpDir, 'notifications.md');
    writeNotification(f, 1, 2);
    writeNotification(f, 5, 20);
    const content = fs.readFileSync(f, 'utf8');
    assert.ok(content.includes('5 new proposal(s)'));
    assert.ok(!content.includes('1 new proposal'));
  });
});

// -------------------------------------------------------------------------
// runAggregation
// -------------------------------------------------------------------------

describe('runAggregation', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('returns not-ran when no summaries exist', async () => {
    setupProject(tmpDir);
    const paths = resolvePaths(tmpDir);
    const result = await runAggregation(paths);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'no-summaries');
  });

  it('returns not-ran when summaries have no effectiveness data', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tracesDir, today);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc-summary.md'), '## Session abc\n\n**Route:** general\n', 'utf8');

    const paths = resolvePaths(tmpDir);
    const result = await runAggregation(paths);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'no-effectiveness-data');
  });

  it('runs full pipeline with valid summaries', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const today = new Date().toISOString().slice(0, 10);

    writeSummary(tracesDir, today, 'sess1', 'coding-backend', [
      { rule: 'CS-001', score: 1.0, evidence: 'referenced' },
      { rule: 'CS-002', score: 0.0, evidence: 'ignored' },
    ]);
    writeSummary(tracesDir, today, 'sess2', 'coding-backend', [
      { rule: 'CS-001', score: 2.0, evidence: 'prevented-mistake' },
      { rule: 'CS-003', score: 1.0, evidence: 'referenced' },
    ]);

    const paths = resolvePaths(tmpDir);
    const result = await runAggregation(paths);

    assert.equal(result.ran, true);
    assert.equal(result.sessionsAnalyzed, 2);
    assert.ok(result.routes.includes('coding-backend'));
    assert.equal(typeof result.proposals, 'number');

    // Verify files were written (now goes to local paths)
    const effFile = paths.localEffectivenessFile || paths.effectivenessFile;
    const overFile = paths.localOverridesFile || paths.overridesFile;
    const notifFile = paths.localNotificationsFile || paths.notificationsFile;
    assert.ok(fs.existsSync(effFile));
    assert.ok(fs.existsSync(overFile));
    assert.ok(fs.existsSync(notifFile));

    const effContent = fs.readFileSync(effFile, 'utf8');
    assert.ok(effContent.includes('Last aggregated:'));
    assert.ok(effContent.includes('CS-001'));
  });

  it('appends proposals to existing overrides file', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const today = new Date().toISOString().slice(0, 10);

    writeSummary(tracesDir, today, 'sess1', 'general', [
      { rule: 'FO-001', score: 1.0, evidence: 'referenced' },
    ]);

    const paths = resolvePaths(tmpDir);

    // Write existing overrides to the local path (where runAggregation now writes)
    const targetOverFile = paths.localOverridesFile || paths.overridesFile;
    fs.mkdirSync(path.dirname(targetOverFile), { recursive: true });
    fs.writeFileSync(targetOverFile, '## Existing Proposals\n\n- Some old proposal\n', 'utf8');

    await runAggregation(paths);

    const content = fs.readFileSync(targetOverFile, 'utf8');
    assert.ok(content.includes('Existing Proposals'));
    assert.ok(content.includes('Proposed Adjustments'));
  });
});

// -------------------------------------------------------------------------
// runAggregation rule-rating integration (Phase 8 audit gap)
// -------------------------------------------------------------------------

describe('runAggregation rule-rating integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('writes rating-state.json after aggregation', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const today = new Date().toISOString().slice(0, 10);
    writeSummary(tracesDir, today, 'sess1', 'coding-backend', [
      { rule: 'CS-001', score: 1.0, evidence: 'referenced' },
      { rule: 'CS-002', score: 0.0, evidence: 'ignored' },
    ]);

    const paths = resolvePaths(tmpDir);
    await runAggregation(paths);

    assert.ok(fs.existsSync(paths.ratingStateFile));
    const state = JSON.parse(fs.readFileSync(paths.ratingStateFile, 'utf8'));
    assert.ok(state.rules);
    assert.ok(state.rules['CS-001']);
    // Winner should be rated above the starting rating of 1500
    assert.ok(state.rules['CS-001'].rating > 1500);
    // Loser below
    assert.ok(state.rules['CS-002'].rating < 1500);
  });

  it('persists ratings across multiple runs', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const paths = resolvePaths(tmpDir);
    const today = new Date().toISOString().slice(0, 10);

    writeSummary(tracesDir, today, 'sess1', 'coding-backend', [
      { rule: 'CS-001', score: 1.0, evidence: 'referenced' },
      { rule: 'CS-002', score: 0.0, evidence: 'ignored' },
    ]);
    await runAggregation(paths);
    const firstState = JSON.parse(fs.readFileSync(paths.ratingStateFile, 'utf8'));
    const firstRating = firstState.rules['CS-001'].rating;
    const firstSessions = firstState.rules['CS-001'].sessions_injected;

    writeSummary(tracesDir, today, 'sess2', 'coding-backend', [
      { rule: 'CS-001', score: 1.0, evidence: 'referenced' },
      { rule: 'CS-002', score: 0.0, evidence: 'ignored' },
    ]);
    await runAggregation(paths);
    const secondState = JSON.parse(fs.readFileSync(paths.ratingStateFile, 'utf8'));
    // session count should have grown, not reset to zero
    assert.ok(secondState.rules['CS-001'].sessions_injected >= firstSessions);
    // Rating should not regress on another win
    assert.ok(secondState.rules['CS-001'].rating >= firstRating);
  });
});

// -------------------------------------------------------------------------
// runDailyCheckIfDue
// -------------------------------------------------------------------------

describe('runDailyCheckIfDue', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('returns not-initialized when .harness/ missing', async () => {
    const result = await runDailyCheckIfDue(tmpDir);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'not-initialized');
  });

  it('returns not-due when aggregated less than 24h ago', async () => {
    setupProject(tmpDir);
    const paths = resolvePaths(tmpDir);

    // Write effectiveness file with today's date
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(paths.effectivenessFile, `## Scores\nLast aggregated: ${today}\n`, 'utf8');

    const result = await runDailyCheckIfDue(tmpDir);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'not-due');
  });

  it('runs when effectiveness file does not exist', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const today = new Date().toISOString().slice(0, 10);

    writeSummary(tracesDir, today, 'sess1', 'general', [
      { rule: 'FO-001', score: 1.0, evidence: 'referenced' },
    ]);

    const result = await runDailyCheckIfDue(tmpDir);
    assert.equal(result.ran, true);
  });

  it('runs when last aggregation was >24h ago', async () => {
    const { tracesDir } = setupProject(tmpDir);
    const paths = resolvePaths(tmpDir);

    // Write effectiveness file with old date
    fs.writeFileSync(paths.effectivenessFile, `## Scores\nLast aggregated: 2025-01-01\n`, 'utf8');

    const today = new Date().toISOString().slice(0, 10);
    writeSummary(tracesDir, today, 'sess1', 'general', [
      { rule: 'FO-001', score: 1.0, evidence: 'referenced' },
    ]);

    const result = await runDailyCheckIfDue(tmpDir);
    assert.equal(result.ran, true);
    assert.equal(result.sessionsAnalyzed, 1);
  });
});
