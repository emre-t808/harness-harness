import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectFormats } from './format-detect.js';

describe('detectFormats', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-detect-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects CLAUDE.md in project root', () => {
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Test');

    const formats = detectFormats(projDir);
    const claudeMd = formats.find(f => f.format === 'claude-md');
    assert.ok(claudeMd);
    assert.equal(claudeMd.paths.length, 1);
  });

  it('detects multiple CLAUDE.md files in subdirectories', () => {
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Root');
    fs.mkdirSync(path.join(projDir, 'src'));
    fs.writeFileSync(path.join(projDir, 'src', 'CLAUDE.md'), '# Src');

    const formats = detectFormats(projDir);
    const claudeMd = formats.find(f => f.format === 'claude-md');
    assert.equal(claudeMd.paths.length, 2);
  });

  it('detects .cursorrules', () => {
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.writeFileSync(path.join(projDir, '.cursorrules'), '- rule');

    const formats = detectFormats(projDir);
    assert.ok(formats.find(f => f.format === 'cursorrules'));
  });

  it('detects .gsd/context/', () => {
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.mkdirSync(path.join(projDir, '.gsd', 'context'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.gsd', 'context', 'api.md'), '## API');

    const formats = detectFormats(projDir);
    const gsd = formats.find(f => f.format === 'gsd');
    assert.ok(gsd);
    assert.equal(gsd.paths.length, 1);
  });

  it('detects native .harness/routes/', () => {
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.mkdirSync(path.join(projDir, '.harness', 'routes'), { recursive: true });

    const formats = detectFormats(projDir);
    assert.ok(formats.find(f => f.format === 'native'));
  });

  it('skips node_modules', () => {
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.mkdirSync(path.join(projDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'node_modules', 'pkg', 'CLAUDE.md'), '# nope');

    const formats = detectFormats(projDir);
    const claudeMd = formats.find(f => f.format === 'claude-md');
    assert.ok(!claudeMd || claudeMd.paths.length === 0);
  });
});
