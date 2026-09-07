// T3b: migrate-evidence — dry-run inventories without writes; apply backs up
// byte-preserving, starts a fresh epoch, never resets an existing one, and
// fails hard on corrupt existing schema.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateEvidence } from './migrate-evidence.js';
import { resolvePaths } from '../lib/paths.js';

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-evidence-'));
  const projectDir = path.join(root, 'project');
  const paths = resolvePaths(projectDir);
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.writeFileSync(paths.ratingStateFile, JSON.stringify({ rules: { OLD: { rating: 1600 } } }));
  fs.writeFileSync(paths.propagationStateFile, JSON.stringify({ rules: { OLD: { weeks_above_threshold: 2 } } }));
  const traceDir = path.join(paths.tracesDir, '2026-09-01');
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, 'old-summary.md'), '**Route:** general\n');
  return { root, projectDir, paths };
}

function run(projectDir, flags = []) {
  const lines = [];
  return migrateEvidence(projectDir, flags, (line) => lines.push(line))
    .then((result) => ({ result, output: lines.join('\n') }));
}

describe('migrate-evidence', () => {
  it('dry run inventories legacy state and writes nothing', async () => {
    const { root, projectDir, paths } = createProject();
    try {
      const { result, output } = await run(projectDir);
      assert.equal(result.applied, false);
      assert.ok(result.proposedEpoch);
      assert.match(output, /rating-state\.json/);
      assert.match(output, /1 markdown, 0 v2 sidecars/);
      assert.equal(fs.existsSync(paths.evidenceStateFile), false);
      assert.equal(fs.existsSync(path.join(paths.localDir, 'reliability-backups')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('apply backs up legacy state byte-preserving and initializes a fresh epoch', async () => {
    const { root, projectDir, paths } = createProject();
    try {
      const legacyBytes = fs.readFileSync(paths.ratingStateFile);
      const { result } = await run(projectDir, ['--apply']);
      assert.equal(result.applied, true);

      const store = JSON.parse(fs.readFileSync(paths.evidenceStateFile, 'utf8'));
      assert.equal(store.schemaVersion, 2);
      assert.deepEqual(store.observations, {});
      assert.equal(store.migration.backups.length, 2);
      const backup = store.migration.backups.find((b) => b.endsWith('rating-state.json'));
      assert.deepEqual(fs.readFileSync(backup), legacyBytes);

      // Legacy files stay in place — historical data only, nothing deleted.
      assert.ok(fs.existsSync(paths.ratingStateFile));
      assert.ok(fs.existsSync(path.join(paths.tracesDir, '2026-09-01', 'old-summary.md')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-running apply preserves the existing epoch', async () => {
    const { root, projectDir, paths } = createProject();
    try {
      const first = await run(projectDir, ['--apply']);
      const before = fs.readFileSync(paths.evidenceStateFile, 'utf8');
      const second = await run(projectDir, ['--apply']);
      assert.equal(second.result.alreadyMigrated, true);
      assert.equal(second.result.epoch, first.result.epoch);
      assert.equal(fs.readFileSync(paths.evidenceStateFile, 'utf8'), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('corrupt or unknown existing schema is a failure, not an empty reset', async () => {
    const { root, projectDir, paths } = createProject();
    try {
      fs.writeFileSync(paths.evidenceStateFile, '{corrupt');
      await assert.rejects(run(projectDir, ['--apply']), /Refusing an empty reset/);
      assert.equal(fs.readFileSync(paths.evidenceStateFile, 'utf8'), '{corrupt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
