import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { identifyPruneCandidates, writePruneProposal, applyPruneProposal } from './prune.js';
import { computeSourceHash } from './ingestion/parsers.js';
import { serializeRulesYaml } from './rule-registry.js';

function makeRule(overrides = {}) {
  return {
    id: overrides.id,
    text: overrides.text || 'some rule text',
    severity: overrides.severity || 'should',
    origin: overrides.origin || 'claude-md',
    source: overrides.source || '',
    source_line: overrides.source_line || 1,
    source_hash: overrides.source_hash || '',
    tags: [],
    routes: [],
    hash: 'abc',
    ...overrides,
  };
}

let tmpDir;
let paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-prune-'));
  fs.mkdirSync(path.join(tmpDir, '.harness', 'memory'), { recursive: true });
  paths = {
    projectDir: tmpDir,
    harnessDir: path.join(tmpDir, '.harness'),
    rulesFile: path.join(tmpDir, '.harness', 'rules.yaml'),
    localDir: path.join(tmpDir, '.harness', 'local'),
    localRulesFile: path.join(tmpDir, '.harness', 'local', 'rules.yaml'),
    ratingStateFile: path.join(tmpDir, '.harness', 'memory', 'rating-state.json'),
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('identifyPruneCandidates', () => {
  it('flags ingested rules with rating below mean − σ as underrated', () => {
    const claudeMd = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '## Rules\n- underrated rule text\n- good rule text\n');
    const hash = computeSourceHash(claudeMd);

    const registry = new Map();
    registry.set('cmd-0000-aaaa', makeRule({
      id: 'cmd-0000-aaaa',
      text: 'underrated rule text',
      source: claudeMd,
      source_line: 2,
      source_hash: hash,
    }));
    registry.set('cmd-0000-bbbb', makeRule({
      id: 'cmd-0000-bbbb',
      text: 'good rule text',
      source: claudeMd,
      source_line: 3,
      source_hash: hash,
    }));

    // Rating state: 10+ rules, spread ratings; the target at bottom
    const rules = { 'cmd-0000-aaaa': { rating: 1200, sessions_injected: 10 } };
    for (let i = 0; i < 12; i++) {
      rules['FILLER-' + i] = { rating: 1500 + i * 10, sessions_injected: 5 };
    }
    rules['cmd-0000-bbbb'] = { rating: 1700, sessions_injected: 10 };
    const ratingState = { rules };

    const candidates = identifyPruneCandidates(paths, { registry, ratingState });
    const underratedIds = candidates.underrated.map(u => u.rule.id);
    assert.ok(underratedIds.includes('cmd-0000-aaaa'));
    assert.ok(!underratedIds.includes('cmd-0000-bbbb'));
  });

  it('excludes rules with severity=must from pruning', () => {
    const registry = new Map();
    registry.set('cmd-0000-mmmm', makeRule({
      id: 'cmd-0000-mmmm',
      text: 'never commit secrets',
      severity: 'must',
    }));
    const rules = { 'cmd-0000-mmmm': { rating: 1000, sessions_injected: 20 } };
    for (let i = 0; i < 11; i++) rules['F-' + i] = { rating: 1500, sessions_injected: 5 };
    const ratingState = { rules };

    const candidates = identifyPruneCandidates(paths, { registry, ratingState });
    assert.equal(candidates.underrated.length, 0);
    assert.equal(candidates.excluded.length, 1);
    assert.equal(candidates.excluded[0].reason, 'severity-must');
  });

  it('skips underrated detection when population < 10 rated rules', () => {
    const registry = new Map();
    registry.set('cmd-0000-xxxx', makeRule({
      id: 'cmd-0000-xxxx',
      text: 'some text',
    }));
    const ratingState = {
      rules: { 'cmd-0000-xxxx': { rating: 1000, sessions_injected: 20 } },
    };
    const candidates = identifyPruneCandidates(paths, { registry, ratingState });
    assert.equal(candidates.underrated.length, 0);
  });

  it('detects ghost rules whose source bullet was removed', () => {
    const claudeMd = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '## Rules\n- different bullet now\n');

    const registry = new Map();
    registry.set('cmd-0000-gggg', makeRule({
      id: 'cmd-0000-gggg',
      text: 'original text that is gone',
      source: claudeMd,
      source_hash: 'oldhash',
    }));
    const ratingState = { rules: {} };

    const candidates = identifyPruneCandidates(paths, { registry, ratingState });
    assert.equal(candidates.ghosts.length, 1);
    assert.equal(candidates.ghosts[0].reason, 'source-bullet-removed');
  });

  it('excludes prevented-mistake rules', () => {
    const registry = new Map();
    registry.set('cmd-0000-pppp', makeRule({
      id: 'cmd-0000-pppp',
      text: 'safety rule',
    }));
    const rules = { 'cmd-0000-pppp': { rating: 1000, sessions_injected: 20, has_prevented: true } };
    for (let i = 0; i < 11; i++) rules['F-' + i] = { rating: 1500, sessions_injected: 5 };
    const ratingState = { rules };
    const candidates = identifyPruneCandidates(paths, { registry, ratingState });
    assert.equal(candidates.excluded.find(e => e.reason === 'prevented-mistake')?.rule.id, 'cmd-0000-pppp');
  });
});

describe('writePruneProposal + applyPruneProposal', () => {
  it('writes a proposal file that can be parsed back by apply', () => {
    const claudeMd = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '## Rules\n- bad rule here\n- keeper rule\n');
    const hash = computeSourceHash(claudeMd);

    const registry = new Map();
    registry.set('cmd-0000-bad', makeRule({
      id: 'cmd-0000-bad',
      text: 'bad rule here',
      source: claudeMd,
      source_line: 2,
      source_hash: hash,
    }));
    registry.set('cmd-0000-keep', makeRule({
      id: 'cmd-0000-keep',
      text: 'keeper rule',
      source: claudeMd,
      source_line: 3,
      source_hash: hash,
    }));
    fs.writeFileSync(paths.rulesFile, serializeRulesYaml(registry), 'utf8');

    const candidates = {
      underrated: [{ rule: registry.get('cmd-0000-bad'), rating: 1200, threshold: 1400, sessions: 10 }],
      ghosts: [],
      excluded: [],
      popStats: { mean: 1500, std_dev: 100, count: 15 },
    };
    writePruneProposal(paths, candidates);

    const result = applyPruneProposal(paths);
    assert.equal(result.removed, 1);
    assert.equal(result.modified, 1);
    assert.equal(result.backups.length, 1);

    const updatedSource = fs.readFileSync(claudeMd, 'utf8');
    assert.ok(!updatedSource.includes('bad rule here'));
    assert.ok(updatedSource.includes('keeper rule'));

    const updatedYaml = fs.readFileSync(paths.rulesFile, 'utf8');
    assert.ok(!updatedYaml.includes('cmd-0000-bad'));
    assert.ok(updatedYaml.includes('cmd-0000-keep'));

    // Backup exists and contains the original content
    const backup = fs.readFileSync(result.backups[0].backup, 'utf8');
    assert.ok(backup.includes('bad rule here'));
  });

  it('throws when apply is called without a proposal', () => {
    assert.throws(() => applyPruneProposal(paths), /No prune proposal found/);
  });
});
