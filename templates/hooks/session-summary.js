#!/usr/bin/env node
/**
 * hh-session-summary.js — Stop hook (thin adapter)
 *
 * Delegates scoring and rendering to the harness-harness package
 * (src/lib/session-summary.js): both clients call the same scorer, and the
 * Markdown summary plus the JSON sidecar derive from one score object.
 *
 * IMPORTANT: Checks stop_hook_active to prevent infinite loops.
 *
 * Input:  JSON on stdin with { session_id, stop_hook_active }
 * Output: NONE — no stdout (must not inject context)
 * Side effects:
 *   1. Writes {client}--{session}-summary.md and .json (atomic replace)
 *   2. Appends to .claude/traces/index.md and .harness/memory/trace-patterns.md
 *   3. Piggybacks the daily aggregation check
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || '{{PROJECT_DIR}}';
const HARNESS_PACKAGE_DIR = '{{HARNESS_PACKAGE_DIR}}';
const CLIENT = process.env.HH_CLIENT || '{{HH_CLIENT}}';
const TRACES_DIR = path.join(PROJECT_DIR, '.claude', 'traces');
const INDEX_FILE = path.join(TRACES_DIR, 'index.md');
const PATTERNS_FILE = path.join(PROJECT_DIR, '.harness', 'memory', 'trace-patterns.md');
const EVENTS_LOG = path.join(PROJECT_DIR, '.harness', 'local', 'events.ndjson');
const DEVELOPER = process.env.USER || process.env.USERNAME || 'unknown';

// Inline event-log emitter — installed hooks must not depend on the package
// being node_modules-resolvable from PROJECT_DIR.
function logEventLocal(fields) {
  try {
    const record = {
      ts: new Date().toISOString(),
      event_id: 'evt_' + Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
      ...fields,
    };
    fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true });
    fs.appendFileSync(EVENTS_LOG, JSON.stringify(record) + '\n');
  } catch { /* event log failure must not crash the hook */ }
}

function readStdin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const lines = [];
    rl.on('line', (line) => lines.push(line));
    rl.on('close', () => resolve(lines.join('\n')));
    setTimeout(() => resolve(lines.join('\n')), 300);
  });
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readTraceEvents(eventFiles) {
  const events = [];
  for (const file of eventFiles) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const parsed = parseJsonSafe(line.trim());
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

function loadRuleSignals() {
  const signalsPath = path.join(PROJECT_DIR, '.harness', 'rule-signals.json');
  if (!fs.existsSync(signalsPath)) return { signalsConfig: {}, signalsError: null };
  try {
    return { signalsConfig: JSON.parse(fs.readFileSync(signalsPath, 'utf8')), signalsError: null };
  } catch (err) {
    return { signalsConfig: {}, signalsError: err.message };
  }
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
}

function ensureFile(filePath, header) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, header + '\n', 'utf8');
  }
}

function skip(reason, extra) {
  logEventLocal({ hook: 'Stop', handler: 'session-summary.js', phase: 'skip', reason, ...extra });
  process.exit(0);
}

async function resolveSessionId() {
  const raw = await readStdin();
  const parsed = parseJsonSafe(raw.trim());
  if (parsed && parsed.stop_hook_active === true) process.exit(0);
  if (parsed && parsed.session_id !== undefined && parsed.session_id !== null) {
    return parsed.session_id;
  }
  if (process.env.CLAUDE_SESSION_ID !== undefined) return process.env.CLAUDE_SESSION_ID;
  return null;
}

async function main() {
  logEventLocal({ hook: 'Stop', handler: 'session-summary.js', phase: 'start' });
  const sessionId = await resolveSessionId();
  if (sessionId === null) skip('no-session-identity');

  let lib;
  try {
    lib = await import(path.join(HARNESS_PACKAGE_DIR, 'src', 'lib', 'session-summary.js'));
  } catch (err) {
    skip('package-unavailable', { error: err.message });
  }

  let artifacts;
  try {
    artifacts = lib.discoverSessionArtifacts(TRACES_DIR, CLIENT, sessionId);
  } catch (err) {
    // Unknown client or unsafe explicit identity: visible skip, no writes.
    skip('invalid-identity-or-client', { error: err.message, client: CLIENT });
  }
  for (const conflict of artifacts.conflicts) {
    logEventLocal({ hook: 'Stop', handler: 'session-summary.js', phase: 'conflict', reason: conflict, session_id: sessionId });
  }
  if (artifacts.eventFiles.length === 0) skip('no-trace-events', { session_id: sessionId });

  const events = readTraceEvents(artifacts.eventFiles);
  let manifest = null;
  if (artifacts.manifestPath) {
    manifest = parseJsonSafe(fs.readFileSync(artifacts.manifestPath, 'utf8'));
  }
  const { signalsConfig, signalsError } = loadRuleSignals();

  const { markdown, sidecar } = lib.buildSessionSummary({
    client: CLIENT, sessionId, events, manifest, signalsConfig, signalsError, developer: DEVELOPER,
  });

  const summaryDate = (sidecar.lastEventAt || new Date().toISOString()).slice(0, 10);
  const summaryDir = path.join(TRACES_DIR, summaryDate);
  writeFileAtomic(path.join(summaryDir, `${artifacts.storageKey}-summary.md`), markdown);
  writeFileAtomic(
    path.join(summaryDir, `${artifacts.storageKey}-summary.json`),
    JSON.stringify(sidecar, null, 2) + '\n',
  );

  const allRefs = [...new Set(events.flatMap((e) => e.referenced_context || []))];
  const uniqueFiles = [...new Set(events.flatMap((e) => e.files_touched || []))];
  ensureFile(INDEX_FILE, '# Session Trace Index\n');
  fs.appendFileSync(INDEX_FILE, `- ${artifacts.storageKey} | ${summaryDate} | ${sidecar.route} | ${events.length} tools | ${allRefs.length} refs\n`);
  ensureFile(PATTERNS_FILE, '# Trace Patterns\n\nSession stats appended by session-summary hook.\n');
  fs.appendFileSync(PATTERNS_FILE, `\n### ${summaryDate} — ${artifacts.storageKey} (${sidecar.route})\n- Tools: ${events.length}\n- Referenced: ${allRefs.join(', ') || 'none'}\n- Files: ${uniqueFiles.length} unique\n`);

  // Daily aggregation check — piggybacks on Stop hook
  if (HARNESS_PACKAGE_DIR && !HARNESS_PACKAGE_DIR.startsWith('{{')) {
    try {
      const dailyCheckPath = path.join(HARNESS_PACKAGE_DIR, 'src', 'lib', 'daily-check.js');
      const { runDailyCheckIfDue } = await import(dailyCheckPath);
      const result = await runDailyCheckIfDue(PROJECT_DIR);
      if (result.ran) {
        process.stderr.write(`[hh-daily-check] Aggregated ${result.sessionsAnalyzed} sessions, ${result.proposals} proposals\n`);
      }
    } catch (err) {
      logEventLocal({ hook: 'Stop', handler: 'session-summary.js', phase: 'error', step: 'daily-check', error: err.message, fatal: false });
      process.stderr.write(`[hh-daily-check] ${err.message}\n`);
    }
  }

  logEventLocal({
    hook: 'Stop', handler: 'session-summary.js', phase: 'end',
    session_id: sessionId,
    outputs: { events: events.length, refs: allRefs.length, measurementStatus: sidecar.measurementStatus },
  });
}

main().catch((err) => {
  logEventLocal({ hook: 'Stop', handler: 'session-summary.js', phase: 'error', error: err.message, fatal: true });
  process.stderr.write(`[hh-session-summary] ${err.message}\n`);
  process.exit(0);
});
