/**
 * commands/share.js — Cross-repo rule sharing (Phase 6)
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../lib/paths.js';
import { readTraceIndex } from '../lib/federated-index.js';
import {
  loadRuleRegistry, addRuleToFile, parseRulesYaml,
} from '../lib/rule-registry.js';
import { computeRuleHash } from '../lib/rule-parser.js';

export async function share(projectDir, flags) {
  const ruleId = flags[0];
  if (!ruleId) {
    console.log('Usage: harness-harness share <rule-id> --to <repo-or-.>');
    return;
  }

  const toIdx = flags.indexOf('--to');
  const toArg = toIdx >= 0 ? flags[toIdx + 1] : '.';
  const targetDir = toArg === '.' ? projectDir : toArg;
  const targetPaths = resolvePaths(path.resolve(targetDir));

  if (!fs.existsSync(targetPaths.harnessDir)) {
    console.log(`Target not initialized: ${targetDir}. Run: harness-harness init`);
    return;
  }

  const targetRegistry = loadRuleRegistry(targetPaths);
  if (targetRegistry.has(ruleId)) {
    console.log(`Rule ${ruleId} already exists in ${path.basename(targetDir)}.`);
    return;
  }

  const repos = readTraceIndex();
  const sources = [];

  for (const repo of repos) {
    if (repo.path === path.resolve(targetDir)) continue;

    const repoRules = repo.rules_summary || [];
    const match = repoRules.find(r => r.id === ruleId);
    if (match) {
      sources.push({ repo: repo.name, repoPath: repo.path, rule: match });
    }
  }

  if (sources.length === 0) {
    console.log(`Rule ${ruleId} not found in any registered repo.`);
    console.log('Search for rules: harness-harness rules <query>');
    return;
  }

  let source;
  if (sources.length === 1) {
    source = sources[0];
  } else {
    console.log(`${ruleId} found in ${sources.length} repos:`);
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const score = s.rule.score !== undefined ? ` (effectiveness: ${s.rule.score})` : '';
      console.log(`  ${i + 1}. ${s.repo}${score}`);
    }
    source = sources.sort((a, b) => (b.rule.score || 0) - (a.rule.score || 0))[0];
    console.log(`\nUsing: ${source.repo} (highest effectiveness). Override with: --from <repo-name>`);

    const fromIdx = flags.indexOf('--from');
    if (fromIdx >= 0) {
      const fromName = flags[fromIdx + 1];
      const explicit = sources.find(s => s.repo.includes(fromName));
      if (explicit) source = explicit;
    }
  }

  const newRule = {
    id: ruleId,
    text: source.rule.text || ruleId,
    hash: source.rule.hash || computeRuleHash(source.rule.text || ruleId),
    tags: source.rule.tags || [],
    severity: 'should',
    author: `shared from ${source.repo}`,
    created: new Date().toISOString().slice(0, 10),
    routes: [],
  };

  const sourceRegistryFile = path.join(source.repoPath, '.harness', 'rules.yaml');
  if (fs.existsSync(sourceRegistryFile)) {
    try {
      const sourceRegistry = parseRulesYaml(fs.readFileSync(sourceRegistryFile, 'utf8'));
      const fullRule = sourceRegistry.get(ruleId);
      if (fullRule) {
        Object.assign(newRule, fullRule);
        newRule.id = ruleId;
        newRule.author = `shared from ${source.repo}`;
        newRule.created = new Date().toISOString().slice(0, 10);
      }
    } catch { /* use summary data */ }
  }

  const targetRegistryFile = targetPaths.rulesFile;
  addRuleToFile(newRule, targetRegistryFile);

  console.log(`\nResolved ${ruleId} → ${source.repo} (effectiveness: ${source.rule.score || 'unknown'})`);
  console.log(`Added to ${path.relative(targetDir, targetRegistryFile)}`);
  console.log(`  Text: "${newRule.text}"`);
  console.log(`  Tags: [${(newRule.tags || []).join(', ')}]`);
  console.log(`  Initial effectiveness: 0.00 (will be scored independently)`);
  console.log(`\nTo activate, add "${ruleId}" to a route's Must Load section.`);
}
