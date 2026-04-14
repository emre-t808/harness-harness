/**
 * federated-index.js — Cross-repo federated trace index
 *
 * Maintains ~/.config/harness-harness/trace-index.yaml with one entry per
 * registered repo, describing recent activity, effectiveness, and top intents.
 * Called by daily-check as a piggyback after aggregation.
 */

import fs from 'fs';
import path from 'path';
import { join } from 'path';
import { withFileLock } from './file-lock.js';

export function globalConfigDir() {
  return join(process.env.HOME || '/tmp', '.config', 'harness-harness');
}

export function traceIndexPath() {
  return join(globalConfigDir(), 'trace-index.yaml');
}

export function reposFilePath() {
  return join(globalConfigDir(), 'repos.yaml');
}

/**
 * Parse the trace-index.yaml file into an array of repo entries.
 * Simple line parser — no YAML library dependency.
 */
export function readTraceIndex() {
  const filePath = traceIndexPath();
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf8');
  const repos = [];
  let current = null;
  let currentArrayKey = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === 'repos:' || trimmed === '') continue;
    if (trimmed.startsWith('#')) continue;

    if (/^\s{2}- name:\s*(.+)/.test(trimmed)) {
      if (current) repos.push(current);
      current = { name: trimmed.match(/name:\s*(.+)/)[1].trim() };
      currentArrayKey = null;
      continue;
    }

    // Nested array-of-objects header: "    rules_summary:"
    if (current && /^\s{4}(\w[\w_]*):\s*$/.test(trimmed)) {
      const key = trimmed.match(/(\w[\w_]*):/)[1];
      current[key] = [];
      currentArrayKey = key;
      continue;
    }

    // Inline object entry: "      - {id: X, text: Y, score: 0.5}"
    if (current && currentArrayKey && /^\s{6}- \{/.test(trimmed)) {
      const objStr = trimmed.replace(/^\s*- \{/, '').replace(/\}\s*$/, '');
      const obj = {};
      for (const pair of objStr.split(/,\s*(?![^\[]*\])/)) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx < 0) continue;
        const k = pair.slice(0, colonIdx).trim();
        let v = pair.slice(colonIdx + 1).trim();
        if (v.startsWith('[') && v.endsWith(']')) {
          v = v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        } else if (/^\d+\.\d+$/.test(v)) {
          v = parseFloat(v);
        } else if (/^\d+$/.test(v)) {
          v = parseInt(v, 10);
        }
        obj[k] = v;
      }
      current[currentArrayKey].push(obj);
      continue;
    }

    if (current && /^\s{4}(\w[\w_]*):\s*(.+)/.test(trimmed)) {
      const [, key, value] = trimmed.match(/(\w[\w_]*):\s*(.+)/);
      currentArrayKey = null;
      if (/^\d+$/.test(value)) current[key] = parseInt(value, 10);
      else if (/^\d+\.\d+$/.test(value)) current[key] = parseFloat(value);
      else if (value.startsWith('[') && value.endsWith(']')) {
        current[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      }
      else current[key] = value;
    }
  }
  if (current) repos.push(current);
  return repos;
}

/**
 * Write the trace-index.yaml file from an array of repo entries.
 */
export function writeTraceIndex(repos) {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    `# Harness Harness — Federated Trace Index`,
    `# Auto-generated. Do not edit manually.`,
    `last_updated: ${new Date().toISOString()}`,
    '',
    'repos:',
  ];

  for (const repo of repos) {
    lines.push(`  - name: ${repo.name}`);
    for (const [key, value] of Object.entries(repo)) {
      if (key === 'name') continue;
      if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`    ${key}: []`);
        } else if (typeof value[0] === 'object') {
          // Array of objects — YAML list of inline objects
          lines.push(`    ${key}:`);
          for (const item of value) {
            const fields = Object.entries(item).map(([k, v]) => {
              if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
              return `${k}: ${v}`;
            });
            lines.push(`      - {${fields.join(', ')}}`);
          }
        } else {
          lines.push(`    ${key}: [${value.join(', ')}]`);
        }
      } else {
        lines.push(`    ${key}: ${value}`);
      }
    }
  }

  withFileLock(traceIndexPath(), () => {
    fs.writeFileSync(traceIndexPath(), lines.join('\n') + '\n', 'utf8');
  });
}

/**
 * Update the federated index entry for a single repo.
 * Called by daily-check.js after aggregation completes.
 *
 * @param {object} paths - From resolvePaths()
 */
export async function updateFederatedIndex(paths) {
  const reposFile = reposFilePath();
  if (!fs.existsSync(reposFile)) return;

  const reposContent = fs.readFileSync(reposFile, 'utf8');
  if (!reposContent.includes(paths.projectDir)) return;

  // Derive repo name
  let repoName = path.basename(paths.projectDir);
  try {
    const config = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    if (config.projectName) repoName = config.projectName;
  } catch { /* use dirname */ }

  // Read effectiveness data
  let avgEffectiveness = 0;
  let ruleCount = 0;
  const effFile = paths.localEffectivenessFile && fs.existsSync(paths.localEffectivenessFile)
    ? paths.localEffectivenessFile
    : paths.effectivenessFile;

  if (fs.existsSync(effFile)) {
    const content = fs.readFileSync(effFile, 'utf8');
    const scoreMatches = [...content.matchAll(/\|\s*\S+\s*\|\s*\d+\s*\|\s*\d+\s*\|\s*([\d.]+)\s*\|/g)];
    if (scoreMatches.length > 0) {
      const scores = scoreMatches.map(m => parseFloat(m[1]));
      avgEffectiveness = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
      ruleCount = scores.length;
    }
  }

  // Find most recent trace date
  let lastTrace = null;
  if (fs.existsSync(paths.tracesDir)) {
    const dateDirs = fs.readdirSync(paths.tracesDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    if (dateDirs.length > 0) lastTrace = dateDirs[0];
  }

  // Count recent sessions
  let sessions7d = 0;
  if (fs.existsSync(paths.tracesDir)) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const recentDirs = fs.readdirSync(paths.tracesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoffStr);
    for (const dd of recentDirs) {
      const dirPath = path.join(paths.tracesDir, dd);
      if (fs.statSync(dirPath).isDirectory()) {
        sessions7d += fs.readdirSync(dirPath).filter(f => f.endsWith('-summary.md')).length;
      }
    }
  }

  // Read top intents from recent summaries
  const topIntents = [];
  if (fs.existsSync(paths.tracePatternsFile)) {
    const intentCounts = {};
    const content = fs.readFileSync(paths.tracePatternsFile, 'utf8');
    for (const match of content.matchAll(/\(([a-z:_-]+)\)/g)) {
      const intent = match[1];
      if (intent !== 'none') intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    }
    const sorted = Object.entries(intentCounts).sort((a, b) => b[1] - a[1]);
    topIntents.push(...sorted.slice(0, 3).map(([intent]) => intent));
  }

  // Phase 6: Rules summary for cross-repo search
  const rulesSummary = [];
  const registryFile = path.join(paths.harnessDir, 'rules.yaml');
  if (fs.existsSync(registryFile)) {
    try {
      const { parseRulesYaml } = await import('./rule-registry.js');
      const registry = parseRulesYaml(fs.readFileSync(registryFile, 'utf8'));
      for (const [id, rule] of registry) {
        rulesSummary.push({
          id,
          hash: rule.hash || '',
          text: (rule.text || '').replace(/[,{}]/g, ' ').trim(),
          tags: rule.tags || [],
          score: 0,
        });
      }
    } catch { /* skip */ }
  }

  if (fs.existsSync(effFile)) {
    const content = fs.readFileSync(effFile, 'utf8');
    for (const rule of rulesSummary) {
      const escaped = rule.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scoreMatch = content.match(new RegExp(`\\|\\s*${escaped}\\s*\\|[^|]*\\|[^|]*\\|\\s*([\\d.]+)\\s*\\|`));
      if (scoreMatch) rule.score = parseFloat(scoreMatch[1]);
    }
  }

  rulesSummary.sort((a, b) => b.score - a.score);

  // Phase 6: File activity summary
  let topFiles = [];
  const activityFile = path.join(paths.harnessDir, 'memory', 'file-activity.yaml');
  if (fs.existsSync(activityFile)) {
    try {
      const { readFileActivity } = await import('./activity.js');
      topFiles = readFileActivity(activityFile).slice(0, 10).map(f => ({
        path: f.path,
        reads: f.reads,
        edits: f.edits,
      }));
    } catch { /* skip */ }
  }

  const entry = {
    name: repoName,
    path: paths.projectDir,
    last_trace: lastTrace || 'never',
    last_indexed: new Date().toISOString(),
    sessions_7d: sessions7d,
    top_intents: topIntents,
    avg_effectiveness: avgEffectiveness,
    rule_count: ruleCount,
    rules_summary: rulesSummary,
    top_files: topFiles,
  };

  const existingRepos = readTraceIndex();
  const idx = existingRepos.findIndex(r => r.path === paths.projectDir);
  if (idx >= 0) {
    existingRepos[idx] = entry;
  } else {
    existingRepos.push(entry);
  }

  writeTraceIndex(existingRepos);
}
