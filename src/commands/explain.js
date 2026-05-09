/**
 * explain command — reconstruct hook timeline for a session.
 *
 * Usage:
 *   harness-harness explain                  # most recent session
 *   harness-harness explain --last           # alias
 *   harness-harness explain <session_id>     # specific session
 *   harness-harness explain --json           # machine-readable
 */

import { resolvePaths } from '../lib/paths.js';
import { readEvents } from '../lib/event-log.js';
import { explainSession } from '../lib/explain.js';

function pickSessionId(arg, eventsFile) {
  if (arg && !arg.startsWith('--')) return arg;
  const all = readEvents(eventsFile);
  if (!all.length) return null;
  // Most recent session_id seen in the log
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].session_id) return all[i].session_id;
  }
  return null;
}

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatEntry(t) {
  const ts = (t.ts || '').slice(11, 23); // HH:MM:SS.mmm
  const hook = (t.hook || '?').padEnd(14);
  const handler = (t.handler || '?').padEnd(25);
  const status = (t.status || '?').padEnd(9);
  const dur = formatDuration(t.duration_ms).padStart(7);
  let suffix = '';
  if (t.status === 'error') suffix = ` [step=${t.step ?? '?'}] ${t.error ?? ''}`;
  if (t.status === 'decision') suffix = ` ${JSON.stringify(t.decision ?? {})}`;
  if (t.outputs) {
    const summary = Object.entries(t.outputs)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    suffix = ` ${summary}`;
  }
  return `  ${ts}  ${hook} ${handler} ${status} ${dur}${suffix}`;
}

export async function explain(projectDir, flags = []) {
  const paths = resolvePaths(projectDir);
  const sessionId = pickSessionId(flags[0], paths.eventsLogFile);

  if (!sessionId) {
    console.log(`No events yet. Expected: ${paths.eventsLogFile}`);
    return;
  }

  const result = explainSession(paths.eventsLogFile, sessionId);

  if (flags.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Session: ${result.session_id}  (${result.event_count} events)`);
  if (result.timeline.length === 0) {
    console.log('  (no events for this session)');
    return;
  }
  for (const t of result.timeline) console.log(formatEntry(t));

  // Roll-up summary
  const errors = result.timeline.filter(t => t.status === 'error').length;
  const orphans = result.timeline.filter(t => t.status === 'orphan').length;
  if (errors || orphans) {
    console.log('');
    if (errors) console.log(`  ${errors} error(s)`);
    if (orphans) console.log(`  ${orphans} orphan hook(s) — start without matching end (crashed/timeout)`);
  }
}
