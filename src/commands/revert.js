/**
 * revert command — list or apply revert snapshots.
 *
 * Usage:
 *   harness-harness revert                  # list available reverts
 *   harness-harness revert <event_id>       # apply a specific revert
 *   harness-harness revert --list           # alias for list
 */

import { resolvePaths } from '../lib/paths.js';
import { listReverts, applyRevert } from '../lib/revert.js';
import { logEvent } from '../lib/event-log.js';

export async function revert(projectDir, flags = []) {
  const paths = resolvePaths(projectDir);
  // First positional arg that isn't a flag or a --project value.
  const positional = flags.filter((f, i) => {
    if (f.startsWith('--')) return false;
    // If the previous flag was --project, this is its value; skip.
    if (i > 0 && flags[i - 1] === '--project') return false;
    return true;
  });
  const arg = positional[0];

  if (!arg || arg === '--list') {
    const list = listReverts(paths.revertsDir);
    if (!list.length) {
      console.log(`No reverts available in ${paths.revertsDir}`);
      return;
    }
    console.log(`${list.length} revert(s) available:\n`);
    for (const r of list) {
      console.log(`  ${r.event_id.padEnd(40)} ${r.saved_at}  →  ${r.target}`);
    }
    console.log('\nApply with: harness-harness revert <event_id>');
    return;
  }

  try {
    const r = applyRevert(paths.revertsDir, arg);
    console.log(`Reverted ${r.target}`);
    console.log(`  from event ${r.event_id} (saved ${r.saved_at})`);
    logEvent(paths.eventsLogFile, {
      hook: 'cli', handler: 'revert.js', phase: 'decision',
      decision: { action: 'revert-applied', event_id: r.event_id, target: r.target },
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('Run "harness-harness revert" to list available reverts.');
    process.exit(1);
  }
}
