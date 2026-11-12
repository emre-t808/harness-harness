import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePaths } from './paths.js';

function project(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-paths-'));
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, '.harness', 'config.json'), config);
  }
  return dir;
}

// The tuner reads and WRITES paths.routesDir. If that points somewhere the project's
// assembler never reads, every analyze/apply/route command silently operates on a dead
// directory — which is exactly what happened here for months.
describe('resolvePaths — routesDir', () => {
  it('defaults to .harness/routes when no config exists', () => {
    const dir = project(undefined);
    assert.equal(resolvePaths(dir).routesDir, path.join(dir, '.harness', 'routes'));
  });

  it('defaults to .harness/routes when config omits routesDir (back-compat)', () => {
    const dir = project(JSON.stringify({ version: '0.5.0' }));
    assert.equal(resolvePaths(dir).routesDir, path.join(dir, '.harness', 'routes'));
  });

  it('honors a relative routesDir from config, resolved against the project root', () => {
    const dir = project(JSON.stringify({ routesDir: 'context/routes' }));
    assert.equal(resolvePaths(dir).routesDir, path.join(dir, 'context', 'routes'));
  });

  it('honors an absolute routesDir', () => {
    const dir = project(JSON.stringify({ routesDir: '/tmp/elsewhere/routes' }));
    assert.equal(resolvePaths(dir).routesDir, '/tmp/elsewhere/routes');
  });

  it('falls back to the default on malformed config rather than throwing', () => {
    const dir = project('{ this is not json');
    assert.equal(resolvePaths(dir).routesDir, path.join(dir, '.harness', 'routes'));
  });

  it('ignores an empty routesDir', () => {
    const dir = project(JSON.stringify({ routesDir: '   ' }));
    assert.equal(resolvePaths(dir).routesDir, path.join(dir, '.harness', 'routes'));
  });
});

// OI-R65: a promotion must carry the rule's text, which lives in the project's
// catalogue. Unset means unknown, and apply refuses rather than guess.
describe('resolvePaths — rulesCatalogDir', () => {
  it('is null when config does not name a catalogue', () => {
    assert.equal(resolvePaths(project(JSON.stringify({ routesDir: 'context/routes' }))).rulesCatalogDir, null);
  });

  it('honors a relative rulesCatalogDir, resolved against the project root', () => {
    const dir = project(JSON.stringify({ rulesCatalogDir: 'context/anti-patterns' }));
    assert.equal(resolvePaths(dir).rulesCatalogDir, path.join(dir, 'context', 'anti-patterns'));
  });
});
