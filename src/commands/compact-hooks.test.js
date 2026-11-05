/**
 * Tests for the PreCompact hook template (templates/hooks/pre-compact.sh).
 *
 * Why: the PreCompact `end` row in .harness/local/events.ndjson is the only
 * evidence that a compaction started, and the reliability runbook needs it
 * to show compaction plus restoration (gap #1). The template never sourced
 * the event-log helper, so once the install replaced the hand-written hook
 * (which logged) with the template render, PreCompact went silent (OI-R72)
 * while PostCompact kept logging. These tests pin the row down: exactly one
 * `end` row keyed by the raw session id, none when the identity is missing
 * or invalid (never a shared "unknown" row), and nothing at all in a
 * project the harness was never set up in.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/hooks');

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-compact-test-'));
  projectDir = path.join(tmpDir, 'project');
  const hooksLib = path.join(projectDir, '.claude', 'hooks', 'lib');
  fs.mkdirSync(hooksLib, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
  fs.copyFileSync(path.join(TEMPLATES, 'lib', 'event-log.sh'), path.join(hooksLib, 'event-log.sh'));
  // Render the client as the project-local installer does (scripts/lib/harness-install.js).
  const rendered = fs.readFileSync(path.join(TEMPLATES, 'pre-compact.sh'), 'utf8')
    .replaceAll('{{HH_CLIENT}}', 'claude');
  fs.writeFileSync(path.join(projectDir, '.claude', 'hooks', 'hh-pre-compact.sh'), rendered);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runPreCompact(payload) {
  // Isolated HOME/XDG/TMPDIR so nothing leaks into the developer's live state.
  const env = { ...process.env, HOME: tmpDir, XDG_RUNTIME_DIR: tmpDir, TMPDIR: tmpDir, CLAUDE_PROJECT_DIR: projectDir };
  delete env.HH_CLIENT;
  delete env.CLAUDE_SESSION_ID;
  const hook = path.join(projectDir, '.claude', 'hooks', 'hh-pre-compact.sh');
  execFileSync('bash', [hook], { input: JSON.stringify(payload), env, stdio: ['pipe', 'pipe', 'pipe'] });
}

function loggedEvents() {
  const file = path.join(projectDir, '.harness', 'local', 'events.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

describe('pre-compact.sh — event row', () => {
  it('writes exactly one PreCompact end row keyed by the raw session id', () => {
    runPreCompact({ session_id: 'sess-pc', trigger: 'auto' });
    const events = loggedEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].hook, 'PreCompact');
    assert.equal(events[0].handler, 'pre-compact.sh');
    assert.equal(events[0].phase, 'end');
    assert.equal(events[0].exit_code, 0);
    // The hooks' own rows keep the raw id; only storage paths carry `claude--`.
    assert.equal(events[0].session_id, 'sess-pc');
  });

  it('writes no row when the identity is missing or invalid', () => {
    runPreCompact({ trigger: 'auto' });
    runPreCompact({ session_id: '../escape', trigger: 'auto' });
    assert.deepEqual(loggedEvents(), []);
  });

  it('creates nothing in a project without .harness', () => {
    fs.rmSync(path.join(projectDir, '.harness'), { recursive: true });
    runPreCompact({ session_id: 'sess-pc', trigger: 'auto' });
    assert.equal(fs.existsSync(path.join(projectDir, '.harness')), false);
  });
});
