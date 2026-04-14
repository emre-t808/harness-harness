/**
 * dismissed-rules.js — Cross-repo rule dismissal tracking (Phase 6)
 *
 * Rules surfaced in <cross-repo-rules> but not imported after N sessions
 * are permanently dismissed to reduce noise.
 */

import fs from 'fs';
import path from 'path';
import { globalConfigDir } from './federated-index.js';
import { withFileLock } from './file-lock.js';

const DISMISS_THRESHOLD = 5;

function dismissedFilePath() {
  return path.join(globalConfigDir(), 'dismissed-rules.yaml');
}

/**
 * Read dismissed rules with their seen counts.
 * @returns {Map<string, number>} ruleId → times seen without import
 */
export function readDismissedRules() {
  const filePath = dismissedFilePath();
  if (!fs.existsSync(filePath)) return new Map();

  const content = fs.readFileSync(filePath, 'utf8');
  const dismissed = new Map();

  for (const match of content.matchAll(/^\s{2}- (\S+):\s*(\d+)/gm)) {
    dismissed.set(match[1], parseInt(match[2], 10));
  }

  return dismissed;
}

/**
 * Increment the seen count for rules that were surfaced but not imported.
 */
export function trackSurfacedRules(surfacedRuleIds) {
  if (!surfacedRuleIds || surfacedRuleIds.length === 0) return;

  const dismissed = readDismissedRules();

  for (const id of surfacedRuleIds) {
    const current = dismissed.get(id) || 0;
    dismissed.set(id, current + 1);
  }

  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    '# Dismissed cross-repo rules',
    '# Rules seen N+ times without being imported stop appearing',
    `# Threshold: ${DISMISS_THRESHOLD}`,
    '',
    'dismissed:',
  ];

  for (const [id, count] of dismissed) {
    lines.push(`  - ${id}: ${count}`);
  }

  const filePath = dismissedFilePath();
  withFileLock(filePath, () => {
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  });
}

/**
 * Get IDs of rules that have been dismissed (seen >= threshold).
 */
export function getDismissedRuleIds() {
  const dismissed = readDismissedRules();
  const ids = new Set();
  for (const [id, count] of dismissed) {
    if (count >= DISMISS_THRESHOLD) ids.add(id);
  }
  return ids;
}

export { DISMISS_THRESHOLD };
