/**
 * Tests for the assembler wrapper init installs as .claude/hooks/hh-assembler.js.
 *
 * Regression guard for the fallback race: the fallback used to live in a
 * separate assembler-fallback.sh hook on the same UserPromptSubmit event,
 * running in parallel with the assembler and comparing marker mtimes — so it
 * raced the process it was checking and fired spurious banners. The wrapper
 * is now the single writer: these tests pin down that the banner appears
 * exactly when the wrapper's own run failed, never alongside real output.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildAssemblerWrapper } from './init.js';

const STDIN_PAYLOAD = JSON.stringify({ prompt: 'hello', session_id: 'sess-test' });

let tmpDir;
let projectDir;

function installWrapper(assemblerSrc, client = null) {
  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'hh-assembler.js');
  let wrapper = buildAssemblerWrapper(assemblerSrc);
  // A project-local installer renders the client into the wrapper; init leaves it.
  if (client) wrapper = wrapper.replaceAll("'{{HH_CLIENT}}'", `'${client}'`);
  fs.writeFileSync(hookPath, wrapper);
  return hookPath;
}

function configureDelegate(scriptSource) {
  const delegatePath = path.join(projectDir, 'delegate.js');
  fs.writeFileSync(delegatePath, scriptSource);
  fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.harness', 'config.json'),
    JSON.stringify({ assembler: { delegate: 'delegate.js' } }),
  );
}

function runWrapper(hookPath, extraEnv = {}) {
  // Isolated HOME/XDG so nothing leaks into the developer's live cache.
  const env = {
    ...process.env,
    HOME: tmpDir,
    XDG_RUNTIME_DIR: tmpDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  delete env.HH_CLIENT; // the client identity under test comes from the render or extraEnv only
  Object.assign(env, extraEnv);
  return execFileSync('node', [hookPath], { input: STDIN_PAYLOAD, env }).toString();
}

function loggedEvents() {
  const file = path.join(projectDir, '.harness', 'local', 'events.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-wrapper-test-'));
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('assembler wrapper — delegate path', () => {
  it('passes delegate output through verbatim with no fallback banner', () => {
    configureDelegate('process.stdout.write("<harness-context intent=\\"x\\">ok</harness-context>");');
    const hookPath = installWrapper('/nonexistent/assembler.js');
    const out = runWrapper(hookPath);
    assert.equal(out, '<harness-context intent="x">ok</harness-context>');
    assert.ok(!out.includes('<rules-reminder>'));
    const events = loggedEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, 'end');
    assert.equal(events[0].session_id, 'sess-test');
  });

  it('emits the fallback banner when the delegate exits non-zero', () => {
    configureDelegate('process.exit(1);');
    const hookPath = installWrapper('/nonexistent/assembler.js');
    const out = runWrapper(hookPath);
    assert.ok(out.includes('<rules-reminder>'));
    assert.ok(out.includes('delegate delegate.js failed'));
    const events = loggedEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, 'error');
    assert.equal(events[0].session_id, 'sess-test');
  });

  it('emits the fallback banner when the delegate produces no output', () => {
    configureDelegate('process.exit(0);');
    const hookPath = installWrapper('/nonexistent/assembler.js');
    const out = runWrapper(hookPath);
    assert.ok(out.includes('<rules-reminder>'));
    assert.ok(out.includes('produced no output'));
  });
});

// The rendered shell hooks key a session as <client>--<id>. If the delegate
// assembler is not told the client, it keys the same session by the raw id:
// the assembler then misses the session's state.md and the trace hook misses
// the manifest pointer, so every rule reference scores [] (OI-O30).
describe('assembler wrapper — client identity reaches the delegate', () => {
  const PRINT_CLIENT = 'process.stdout.write("client=" + (process.env.HH_CLIENT ?? "none"));';

  it('passes the rendered client to the delegate', () => {
    configureDelegate(PRINT_CLIENT);
    const hookPath = installWrapper('/nonexistent/assembler.js', 'claude');
    assert.equal(runWrapper(hookPath), 'client=claude');
  });

  it('passes no client when the placeholder is left unrendered (legacy raw-id layout)', () => {
    configureDelegate(PRINT_CLIENT);
    const hookPath = installWrapper('/nonexistent/assembler.js');
    assert.equal(runWrapper(hookPath), 'client=none');
  });

  it('lets an inherited HH_CLIENT win, as the shell hooks do', () => {
    configureDelegate(PRINT_CLIENT);
    const hookPath = installWrapper('/nonexistent/assembler.js', 'claude');
    assert.equal(runWrapper(hookPath, { HH_CLIENT: 'codex' }), 'client=codex');
  });
});

describe('assembler wrapper — native path (no delegate configured)', () => {
  it('leaves stdin for the native assembler and passes its output through', () => {
    const stub = path.join(tmpDir, 'stub-assembler.mjs');
    fs.writeFileSync(stub, [
      'export async function main(projectDir) {',
      "  const { readFileSync } = await import('fs');",
      // fd 0, not '/dev/stdin': on Linux the spawn pipe is a socket and
      // opening /dev/stdin fails with ENXIO (macOS allows it).
      "  process.stdout.write('NATIVE:' + readFileSync(0, 'utf8'));",
      '}',
    ].join('\n'));
    const hookPath = installWrapper(stub);
    const out = runWrapper(hookPath);
    assert.equal(out, `NATIVE:${STDIN_PAYLOAD}`);
    assert.ok(!out.includes('<rules-reminder>'));
  });

  it('emits the fallback banner when no assembler is importable', () => {
    const hookPath = installWrapper(path.join(tmpDir, 'does-not-exist.js'));
    const out = runWrapper(hookPath);
    assert.ok(out.includes('<rules-reminder>'));
    assert.ok(out.includes('not importable'));
    assert.equal(loggedEvents()[0].phase, 'error');
  });

  it('emits the fallback banner when the native assembler throws', () => {
    const stub = path.join(tmpDir, 'stub-assembler.mjs');
    fs.writeFileSync(stub, 'export async function main() { throw new Error("boom"); }');
    const hookPath = installWrapper(stub);
    const out = runWrapper(hookPath);
    assert.ok(out.includes('<rules-reminder>'));
    assert.ok(out.includes('native assembler threw: boom'));
  });
});
