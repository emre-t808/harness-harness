import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadGovernance, loadCooldownQueue, appendCooldownEntry,
  processCooldownQueue, vetoCooldownEntry, appendChangelog,
  writeNotification, DEFAULT_GOVERNANCE,
} from './daily-check.js';

function makeTmpPaths() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-gov-test-'));
  const harnessDir = path.join(tmpDir, '.harness');
  const memoryDir = path.join(harnessDir, 'memory');
  const localDir = path.join(harnessDir, 'local');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(localDir, 'memory'), { recursive: true });
  return {
    harnessDir,
    configFile: path.join(harnessDir, 'config.json'),
    localConfigFile: path.join(localDir, 'config.json'),
    cooldownFile: path.join(memoryDir, 'cooldown-queue.json'),
    changelogFile: path.join(memoryDir, 'changelog.md'),
    notificationsFile: path.join(memoryDir, 'notifications.md'),
    localNotificationsFile: path.join(localDir, 'memory', 'notifications.md'),
    routesDir: path.join(harnessDir, 'routes'),
    _tmpDir: tmpDir,
  };
}

function cleanup(paths) {
  fs.rmSync(paths._tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Governance config loading
// ---------------------------------------------------------------------------

describe('loadGovernance', () => {
  it('returns defaults when no config exists', () => {
    const paths = makeTmpPaths();
    const gov = loadGovernance(paths);
    assert.equal(gov.mode, 'auto');
    assert.equal(gov.cooldownHours, 48);
    assert.equal(gov.minSessions.demote, 5);
    assert.equal(gov.protectPrevented, true);
    cleanup(paths);
  });

  it('reads team config', () => {
    const paths = makeTmpPaths();
    fs.writeFileSync(paths.configFile, JSON.stringify({
      governance: { mode: 'propose', cooldownHours: 72 },
    }));
    const gov = loadGovernance(paths);
    assert.equal(gov.mode, 'propose');
    assert.equal(gov.cooldownHours, 72);
    assert.equal(gov.minSessions.demote, 5, 'defaults preserved for unspecified keys');
    cleanup(paths);
  });

  it('developer local config overrides team config', () => {
    const paths = makeTmpPaths();
    fs.writeFileSync(paths.configFile, JSON.stringify({
      governance: { mode: 'auto', cooldownHours: 48 },
    }));
    fs.writeFileSync(paths.localConfigFile, JSON.stringify({
      governance: { mode: 'propose' },
    }));
    const gov = loadGovernance(paths);
    assert.equal(gov.mode, 'propose', 'developer override wins');
    assert.equal(gov.cooldownHours, 48, 'team value preserved for non-overridden key');
    cleanup(paths);
  });

  it('merges minSessions partially', () => {
    const paths = makeTmpPaths();
    fs.writeFileSync(paths.configFile, JSON.stringify({
      governance: { minSessions: { demote: 10 } },
    }));
    const gov = loadGovernance(paths);
    assert.equal(gov.minSessions.demote, 10, 'team override applied');
    assert.equal(gov.minSessions.promoteIdentity, 10, 'default preserved');
    cleanup(paths);
  });
});

// ---------------------------------------------------------------------------
// Cooldown queue
// ---------------------------------------------------------------------------

describe('cooldown queue', () => {
  it('starts empty', () => {
    const paths = makeTmpPaths();
    assert.deepStrictEqual(loadCooldownQueue(paths), []);
    cleanup(paths);
  });

  it('appends entries and prevents duplicates', () => {
    const paths = makeTmpPaths();
    const proposal = { rule: 'SEC-001', avgScore: 1.72, sessions: 64, routes: 'backend' };
    appendCooldownEntry(paths, proposal, 48);
    appendCooldownEntry(paths, proposal, 48); // duplicate
    const queue = loadCooldownQueue(paths);
    assert.equal(queue.length, 1, 'no duplicates');
    assert.equal(queue[0].rule, 'SEC-001');
    assert.ok(queue[0].appliesAt, 'has appliesAt timestamp');
    cleanup(paths);
  });

  it('processes matured entries', () => {
    const paths = makeTmpPaths();
    // Insert an entry that already expired
    const queue = [{
      rule: 'SEC-001',
      avgScore: 1.72,
      sessions: 64,
      routes: 'backend',
      proposedAt: new Date(Date.now() - 100000).toISOString(),
      appliesAt: new Date(Date.now() - 1000).toISOString(), // already past
    }, {
      rule: 'A11Y-001',
      avgScore: 1.85,
      sessions: 40,
      routes: 'frontend',
      proposedAt: new Date().toISOString(),
      appliesAt: new Date(Date.now() + 86400000).toISOString(), // future
    }];
    fs.writeFileSync(paths.cooldownFile, JSON.stringify(queue));

    const matured = processCooldownQueue(paths);
    assert.equal(matured.length, 1);
    assert.equal(matured[0].rule, 'SEC-001');

    const remaining = loadCooldownQueue(paths);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].rule, 'A11Y-001');
    cleanup(paths);
  });

  it('veto removes entry', () => {
    const paths = makeTmpPaths();
    appendCooldownEntry(paths, { rule: 'SEC-001', avgScore: 1.5, sessions: 20, routes: 'all' }, 48);
    appendCooldownEntry(paths, { rule: 'A11Y-001', avgScore: 1.8, sessions: 30, routes: 'fe' }, 48);

    const removed = vetoCooldownEntry(paths, 'SEC-001');
    assert.ok(removed, 'should return true');
    const queue = loadCooldownQueue(paths);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].rule, 'A11Y-001');
    cleanup(paths);
  });

  it('veto returns false for non-existent rule', () => {
    const paths = makeTmpPaths();
    const removed = vetoCooldownEntry(paths, 'FAKE-001');
    assert.equal(removed, false);
    cleanup(paths);
  });
});

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

describe('appendChangelog', () => {
  it('creates changelog from scratch', () => {
    const paths = makeTmpPaths();
    appendChangelog(paths.changelogFile, [
      { action: 'demote', rule: 'LOG-001', route: 'coding:backend', reason: '0.03 avg across 38 sessions' },
    ]);
    const content = fs.readFileSync(paths.changelogFile, 'utf8');
    assert.ok(content.includes('demote: LOG-001'));
    assert.ok(content.includes('coding:backend'));
    assert.ok(content.includes('Harness Changelog'));
    cleanup(paths);
  });

  it('appends to existing changelog', () => {
    const paths = makeTmpPaths();
    fs.writeFileSync(paths.changelogFile, '## Harness Changelog\n\n- [2026-01-01] existing entry\n');
    appendChangelog(paths.changelogFile, [
      { action: 'promote-identity', rule: 'SEC-001', route: 'all routes', reason: '1.72 avg' },
    ]);
    const content = fs.readFileSync(paths.changelogFile, 'utf8');
    assert.ok(content.includes('existing entry'), 'preserves existing');
    assert.ok(content.includes('promote-identity: SEC-001'), 'appends new');
    cleanup(paths);
  });
});

// ---------------------------------------------------------------------------
// Notifications with auto-applied digest
// ---------------------------------------------------------------------------

describe('writeNotification with autoApplied', () => {
  it('includes auto-applied change digest', () => {
    const paths = makeTmpPaths();
    writeNotification(paths.notificationsFile, 0, 12, [
      { action: 'demote', rule: 'LOG-001', reason: '0.03 avg across 38 sessions' },
      { action: 'budget-rebalance', rule: 'coding:backend', reason: 'utilization 78%' },
    ], 1);
    const content = fs.readFileSync(paths.notificationsFile, 'utf8');
    assert.ok(content.includes('Auto-applied 2 change(s)'));
    assert.ok(content.includes('demote: LOG-001'));
    assert.ok(content.includes('1 promotion(s) in cooldown'));
    cleanup(paths);
  });

  it('shows thresholds message when nothing happened', () => {
    const paths = makeTmpPaths();
    writeNotification(paths.notificationsFile, 0, 5, [], 0);
    const content = fs.readFileSync(paths.notificationsFile, 'utf8');
    assert.ok(content.includes('all scores within thresholds'));
    cleanup(paths);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_GOVERNANCE export
// ---------------------------------------------------------------------------

describe('DEFAULT_GOVERNANCE', () => {
  it('is exported with expected shape', () => {
    assert.equal(DEFAULT_GOVERNANCE.mode, 'auto');
    assert.equal(DEFAULT_GOVERNANCE.cooldownHours, 48);
    assert.equal(DEFAULT_GOVERNANCE.minSessions.demote, 5);
    assert.equal(DEFAULT_GOVERNANCE.minSessions.promoteIdentity, 10);
    assert.equal(DEFAULT_GOVERNANCE.protectPrevented, true);
  });
});
