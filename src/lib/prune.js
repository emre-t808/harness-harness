// src/lib/prune.js
//
// Phase 8: Write-back engine. Identifies underrated / ghost rules ingested
// from external sources and either proposes or applies their removal.

import fs from 'fs';
import path from 'path';
import { loadRuleRegistry, serializeRulesYaml } from './rule-registry.js';
import { loadRatingState, computePopulationStats } from './rule-rating.js';
import { computeSourceHash } from './ingestion/parsers.js';
import { withFileLock } from './file-lock.js';

const MIN_SESSIONS_FOR_PRUNE = 5;
const MIN_POPULATION_FOR_PRUNE = 10;

function isIngestedRule(rule) {
  const o = rule.origin;
  if (!o) return false;
  return o !== 'native' && o !== 'explicit-id' && o !== 'free-text';
}

/**
 * Classify rules into underrated / ghosts / excluded.
 * Optional opts.registry, opts.ratingState let tests inject state.
 */
export function identifyPruneCandidates(paths, opts = {}) {
  const registry = opts.registry || loadRuleRegistry(paths);
  const ratingState = opts.ratingState || loadRatingState(paths);
  const popStats = computePopulationStats(ratingState);
  const threshold = popStats.mean - popStats.std_dev;

  const underrated = [];
  const ghosts = [];
  const excluded = [];

  for (const [id, rule] of registry) {
    if (!isIngestedRule(rule)) continue;

    if (rule.severity === 'must') {
      excluded.push({ rule, reason: 'severity-must' });
      continue;
    }

    const ratingEntry = ratingState.rules?.[id];
    if (ratingEntry?.has_prevented) {
      excluded.push({ rule, reason: 'prevented-mistake' });
      continue;
    }

    // Ghost detection
    if (rule.source) {
      if (!fs.existsSync(rule.source)) {
        ghosts.push({ rule, reason: 'source-file-deleted' });
        continue;
      }
      const currentHash = computeSourceHash(rule.source);
      if (currentHash !== rule.source_hash) {
        const sourceContent = fs.readFileSync(rule.source, 'utf8');
        if (!sourceContent.includes(rule.text)) {
          ghosts.push({ rule, reason: 'source-bullet-removed' });
          continue;
        }
      }
    }

    // Underrated check (needs enough population data)
    if (popStats.count < MIN_POPULATION_FOR_PRUNE) continue;
    if (!ratingEntry) continue;
    if ((ratingEntry.sessions_injected || 0) < MIN_SESSIONS_FOR_PRUNE) continue;
    if (ratingEntry.rating >= threshold) continue;

    underrated.push({
      rule,
      rating: ratingEntry.rating,
      threshold,
      sessions: ratingEntry.sessions_injected,
    });
  }

  return { underrated, ghosts, excluded, popStats };
}

export function writePruneProposal(paths, candidates) {
  const { underrated, ghosts, excluded, popStats } = candidates;
  const today = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`# Prune Proposals`);
  lines.push(`Generated: ${today}`);
  lines.push(`Population: mean=${Math.round(popStats.mean)}, σ=${Math.round(popStats.std_dev)}, n=${popStats.count}`);
  lines.push('');

  if (underrated.length > 0) {
    lines.push(`## Underrated rules (${underrated.length})`);
    lines.push(`Threshold: rating < ${Math.round(popStats.mean - popStats.std_dev)} AND sessions_injected ≥ ${MIN_SESSIONS_FOR_PRUNE}`);
    lines.push('');
    for (const { rule, rating, sessions } of underrated) {
      lines.push(`- **${rule.id}** (rating: ${Math.round(rating)}, sessions: ${sessions})`);
      lines.push(`  Source: ${rule.source}:${rule.source_line || '?'}`);
      lines.push(`  Text: "${rule.text}"`);
      lines.push(`  Action: remove bullet from source file + remove from registry`);
      lines.push('');
    }
  }

  if (ghosts.length > 0) {
    lines.push(`## Ghost rules (${ghosts.length}) — source already modified`);
    lines.push('');
    for (const { rule, reason } of ghosts) {
      lines.push(`- **${rule.id}** (${reason})`);
      lines.push(`  Source: ${rule.source}`);
      lines.push(`  Text: "${rule.text}"`);
      lines.push(`  Action: remove from registry only (source already clean)`);
      lines.push('');
    }
  }

  if (excluded.length > 0) {
    lines.push(`## Excluded (not pruned)`);
    lines.push('');
    for (const { rule, reason } of excluded) {
      lines.push(`- ${rule.id}: ${reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`To apply these proposals, run: \`harness-harness rules prune --apply\``);
  lines.push(`To reject specific rules, delete their entries from this file before applying.`);

  const proposalFile = path.join(paths.harnessDir, 'memory', 'prune-proposals.md');
  fs.mkdirSync(path.dirname(proposalFile), { recursive: true });
  fs.writeFileSync(proposalFile, lines.join('\n'), 'utf8');
  return proposalFile;
}

/**
 * Apply a reviewed prune proposal: rewrite source files, update rules.yaml,
 * create backups, archive the proposal.
 */
export function applyPruneProposal(paths) {
  const proposalFile = path.join(paths.harnessDir, 'memory', 'prune-proposals.md');
  if (!fs.existsSync(proposalFile)) {
    throw new Error('No prune proposal found. Run `rules prune` (dry-run) first.');
  }

  const proposal = fs.readFileSync(proposalFile, 'utf8');
  const ruleIdsToRemove = [...proposal.matchAll(/^- \*\*([\w-]+)\*\*/gm)].map(m => m[1]);

  if (ruleIdsToRemove.length === 0) {
    return { modified: 0, removed: 0, backups: [] };
  }

  const registry = loadRuleRegistry(paths);
  const today = new Date().toISOString().slice(0, 10);
  const backupDir = path.join(paths.harnessDir, 'memory', 'prune-backups', today);
  fs.mkdirSync(backupDir, { recursive: true });

  const rulesBySource = new Map();
  for (const id of ruleIdsToRemove) {
    const rule = registry.get(id);
    if (!rule || !rule.source) continue;
    if (!rulesBySource.has(rule.source)) rulesBySource.set(rule.source, []);
    rulesBySource.get(rule.source).push(rule);
  }

  const backups = [];
  let modifiedFiles = 0;

  for (const [sourceFile, rules] of rulesBySource) {
    if (!fs.existsSync(sourceFile)) continue;

    const backupPath = path.join(backupDir, path.basename(sourceFile) + '.bak');
    fs.copyFileSync(sourceFile, backupPath);
    backups.push({ source: sourceFile, backup: backupPath });

    const content = fs.readFileSync(sourceFile, 'utf8');
    const lines = content.split('\n');
    const linesToRemove = new Set();

    for (const rule of rules) {
      for (let i = 0; i < lines.length; i++) {
        if (linesToRemove.has(i)) continue;
        const line = lines[i];
        if (/^\s*[-*]\s/.test(line) && line.includes(rule.text)) {
          linesToRemove.add(i);
          break;
        }
      }
    }

    const newLines = lines.filter((_, idx) => !linesToRemove.has(idx));
    withFileLock(sourceFile, () => {
      fs.writeFileSync(sourceFile, newLines.join('\n'), 'utf8');
    });
    modifiedFiles++;
  }

  // Remove rules from registry
  for (const id of ruleIdsToRemove) {
    registry.delete(id);
  }
  if (paths.rulesFile) {
    fs.mkdirSync(path.dirname(paths.rulesFile), { recursive: true });
    withFileLock(paths.rulesFile, () => {
      fs.writeFileSync(paths.rulesFile, serializeRulesYaml(registry), 'utf8');
    });
  }

  // Archive the proposal file (rename with date suffix)
  try {
    fs.renameSync(proposalFile, proposalFile + '.' + today);
  } catch { /* non-fatal */ }

  return { modified: modifiedFiles, removed: ruleIdsToRemove.length, backups };
}

export { MIN_SESSIONS_FOR_PRUNE, MIN_POPULATION_FOR_PRUNE };
