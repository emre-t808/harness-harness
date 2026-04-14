import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { aggregateFileActivity, writeFileActivity, readFileActivity } from './activity.js';

describe('aggregateFileActivity', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-activity-'));
    const today = new Date().toISOString().slice(0, 10);
    const dateDir = path.join(tmpDir, today);
    fs.mkdirSync(dateDir, { recursive: true });

    const events = [
      { tool: 'Read', files_touched: ['src/auth.ts'], output_size: 100 },
      { tool: 'Read', files_touched: ['src/auth.ts'], output_size: 100 },
      { tool: 'Edit', files_touched: ['src/auth.ts'], output_size: 50 },
      { tool: 'Read', files_touched: ['src/utils.ts'], output_size: 80 },
      { tool: 'Write', files_touched: ['src/new-file.ts'], output_size: 200 },
    ];
    fs.writeFileSync(
      path.join(dateDir, 'session1.jsonl'),
      events.map(e => JSON.stringify(e)).join('\n') + '\n'
    );
  });

  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('counts reads and edits per file', () => {
    const result = aggregateFileActivity(tmpDir, 7);
    const auth = result.find(f => f.path === 'src/auth.ts');
    assert.ok(auth);
    assert.equal(auth.reads, 2);
    assert.equal(auth.edits, 1);
  });

  it('sorts by total access descending', () => {
    const result = aggregateFileActivity(tmpDir, 7);
    assert.equal(result[0].path, 'src/auth.ts');
    assert.ok(result[0].total >= result[1].total);
  });

  it('returns empty for missing directory', () => {
    assert.equal(aggregateFileActivity('/nonexistent', 7).length, 0);
  });
});

describe('writeFileActivity + readFileActivity round-trip', () => {
  let tmpFile;
  let cleanupDir;

  before(() => {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-act-'));
    tmpFile = path.join(cleanupDir, 'file-activity.yaml');
  });

  after(() => { fs.rmSync(cleanupDir, { recursive: true, force: true }); });

  it('round-trips correctly', () => {
    const activity = [
      { path: 'src/auth.ts', reads: 10, edits: 3, total: 13 },
      { path: 'src/utils.ts', reads: 5, edits: 1, total: 6 },
    ];
    writeFileActivity(tmpFile, activity, 7);
    const result = readFileActivity(tmpFile);
    assert.equal(result.length, 2);
    assert.equal(result[0].path, 'src/auth.ts');
    assert.equal(result[0].reads, 10);
    assert.equal(result[0].edits, 3);
  });
});
