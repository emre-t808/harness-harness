import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Override HOME before importing the module so global config dir is isolated.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-fedidx-'));
process.env.HOME = TMP_ROOT;

const {
  globalConfigDir,
  traceIndexPath,
  reposFilePath,
  readTraceIndex,
  writeTraceIndex,
  updateFederatedIndex,
} = await import('./federated-index.js');

after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readTraceIndex / writeTraceIndex', () => {
  it('returns empty array for missing file', () => {
    try { fs.unlinkSync(traceIndexPath()); } catch { /* ignore */ }
    assert.deepStrictEqual(readTraceIndex(), []);
  });

  it('round-trips a single repo', () => {
    writeTraceIndex([
      { name: 'alpha', path: '/tmp/alpha', sessions_7d: 5, avg_effectiveness: 0.8, top_intents: ['coding:backend', 'general'] },
    ]);
    const repos = readTraceIndex();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'alpha');
    assert.equal(repos[0].sessions_7d, 5);
    assert.equal(repos[0].avg_effectiveness, 0.8);
    assert.deepStrictEqual(repos[0].top_intents, ['coding:backend', 'general']);
  });

  it('round-trips multiple repos', () => {
    writeTraceIndex([
      { name: 'alpha', path: '/tmp/alpha', sessions_7d: 1 },
      { name: 'beta', path: '/tmp/beta', sessions_7d: 2 },
    ]);
    const repos = readTraceIndex();
    assert.equal(repos.length, 2);
    assert.equal(repos[1].name, 'beta');
  });
});

describe('updateFederatedIndex', () => {
  function makeRepo(name) {
    const repoDir = fs.mkdtempSync(path.join(TMP_ROOT, `repo-${name}-`));
    const harness = path.join(repoDir, '.harness');
    const memory = path.join(harness, 'memory');
    const traces = path.join(repoDir, '.claude', 'traces');
    fs.mkdirSync(memory, { recursive: true });
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(path.join(harness, 'config.json'), JSON.stringify({ projectName: name }));
    return {
      projectDir: repoDir,
      harnessDir: harness,
      configFile: path.join(harness, 'config.json'),
      tracesDir: traces,
      effectivenessFile: path.join(memory, 'harness-effectiveness.md'),
      localEffectivenessFile: null,
      tracePatternsFile: path.join(memory, 'trace-patterns.md'),
    };
  }

  it('skips unregistered repo', async () => {
    try { fs.unlinkSync(reposFilePath()); } catch { /* ignore */ }
    const paths = makeRepo('solo');
    await updateFederatedIndex(paths); // no-op
    // still no index
    try { fs.unlinkSync(traceIndexPath()); } catch { /* ignore */ }
  });

  it('adds new entry for registered repo', async () => {
    const paths = makeRepo('billing');
    fs.mkdirSync(globalConfigDir(), { recursive: true });
    fs.writeFileSync(reposFilePath(),
      `repos:\n  - name: billing\n    path: ${paths.projectDir}\n    registered: 2026-04-08\n`);
    // seed effectiveness file
    fs.writeFileSync(paths.effectivenessFile,
      '## Harness Effectiveness Scores\n\n| Rule | Sessions | Referenced | Avg Score | Top Route |\n|---|---|---|---|---|\n| API-001 | 5 | 3 | 0.75 | coding:backend |\n| DB-002 | 4 | 1 | 0.25 | coding:backend |\n');
    // seed a trace date dir
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(paths.tracesDir, today);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess1-summary.md'), '## s1');

    await updateFederatedIndex(paths);

    const repos = readTraceIndex();
    const entry = repos.find(r => r.path === paths.projectDir);
    assert.ok(entry, 'entry should exist');
    assert.equal(entry.name, 'billing');
    assert.equal(entry.sessions_7d, 1);
    assert.equal(entry.rule_count, 2);
    assert.equal(entry.avg_effectiveness, 0.5);
  });

  it('updates existing entry (dedup by path)', async () => {
    const repos1 = readTraceIndex();
    const billing = repos1.find(r => r.name === 'billing');
    await updateFederatedIndex({
      projectDir: billing.path,
      harnessDir: path.join(billing.path, '.harness'),
      configFile: path.join(billing.path, '.harness', 'config.json'),
      tracesDir: path.join(billing.path, '.claude', 'traces'),
      effectivenessFile: path.join(billing.path, '.harness', 'memory', 'harness-effectiveness.md'),
      localEffectivenessFile: null,
      tracePatternsFile: path.join(billing.path, '.harness', 'memory', 'trace-patterns.md'),
    });
    const repos2 = readTraceIndex();
    const matches = repos2.filter(r => r.name === 'billing');
    assert.equal(matches.length, 1, 'should not duplicate');
  });
});
