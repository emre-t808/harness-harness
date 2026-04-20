/**
 * veto command — Remove a rule from the auto-governance cooldown queue
 *
 * Usage: harness-harness veto <RULE-ID>
 *
 * This prevents a pending Identity promotion from auto-applying.
 * The rule stays in its current position (Load If Budget / Must Load).
 */

import { resolvePaths } from '../lib/paths.js';
import { vetoCooldownEntry, loadCooldownQueue } from '../lib/daily-check.js';

export async function veto(projectDir, flags) {
  const paths = resolvePaths(projectDir);
  const ruleId = flags.find(f => !f.startsWith('-'));

  if (!ruleId) {
    const queue = loadCooldownQueue(paths);
    if (queue.length === 0) {
      console.log('  No entries in cooldown queue.');
    } else {
      console.log('  Cooldown queue:');
      for (const e of queue) {
        const hours = Math.max(0, Math.round((new Date(e.appliesAt) - Date.now()) / 3600000));
        console.log(`    ${e.rule}  score: ${e.avgScore.toFixed(2)}  applies in: ${hours}h`);
      }
      console.log('');
      console.log('  Usage: harness-harness veto <RULE-ID>');
    }
    return;
  }

  const removed = vetoCooldownEntry(paths, ruleId);
  if (removed) {
    console.log(`  Vetoed: ${ruleId} removed from cooldown queue.`);
    console.log('  The rule will stay in its current position.');
  } else {
    console.log(`  ${ruleId} not found in cooldown queue.`);
    const queue = loadCooldownQueue(paths);
    if (queue.length > 0) {
      console.log('  Current queue:');
      for (const e of queue) {
        console.log(`    ${e.rule}`);
      }
    }
  }
}
