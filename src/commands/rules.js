/**
 * commands/rules.js — Rule registry management CLI (Phase 6)
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../lib/paths.js';
import {
  loadRuleRegistry, filterRules, addRuleToFile,
  parseRulesYaml, serializeRulesYaml,
} from '../lib/rule-registry.js';
import { parseRulesFromSection } from '../lib/rule-parser.js';
import { readTraceIndex } from '../lib/federated-index.js';
import { parseRouteConfig } from '../lib/context-assembler.js';
import { withFileLock } from '../lib/file-lock.js';
import { detectFormats } from '../lib/ingestion/format-detect.js';
import { parseSourceFile, computeSourceHash } from '../lib/ingestion/parsers.js';

export async function rules(projectDir, flags) {
  const subcommand = flags[0];

  if (subcommand && !['list', 'search', 'add', 'migrate', 'ingest', 'prune'].includes(subcommand)
      && !subcommand.startsWith('-')) {
    return searchCrossRepo(subcommand, flags.slice(1));
  }

  const paths = resolvePaths(projectDir);

  if (subcommand === 'list') return listRules(paths, flags.slice(1));
  if (subcommand === 'search') return searchRules(paths, flags.slice(1));
  if (subcommand === 'add') return addRule(paths, flags.slice(1));
  if (subcommand === 'migrate') return migrateRules(paths, flags.slice(1));
  if (subcommand === 'ingest') return ingestRules(paths, flags.slice(1));
  if (subcommand === 'prune') return pruneRules(paths, flags.slice(1));

  console.log(`
  harness-harness rules — Rule management

  Local commands (current repo):
    rules list                       List all rules
    rules list --tag <tag>           Filter by tag
    rules list --route <intent>      Filter by route
    rules list --origin <origin>     Filter by source framework
    rules list --score 0             Filter by score
    rules list --stale               Show rules whose source files have changed
    rules list --duplicates          Show rules with similar text in other repos
    rules list --underrated          Rules with rating below pool mean − 1σ
    rules search <query>             Full-text search
    rules add --id <ID> --text "..." Add a rule to the registry
    rules migrate                    Import inline rules from routes into registry
    rules ingest                     Ingest rules from external formats
    rules ingest --source claude-md  Ingest from a specific format
    rules ingest --update            Re-ingest and update changed sources
    rules ingest --dry-run           Preview without writing
    rules prune                      Identify underrated + ghost rules (dry-run, writes proposal)
    rules prune --apply              Apply the reviewed pruning proposal

  Cross-repo commands:
    rules <query>                    Search across all registered repos
`);
}

async function listRules(paths, flags) {
  const registry = loadRuleRegistry(paths);

  if (registry.size === 0) {
    console.log('No rules in registry. Run: harness-harness rules migrate');
    return;
  }

  const filter = {};
  const tagIdx = flags.indexOf('--tag');
  if (tagIdx >= 0) filter.tag = flags[tagIdx + 1];
  const routeIdx = flags.indexOf('--route');
  if (routeIdx >= 0) filter.route = flags[routeIdx + 1];
  const originIdx = flags.indexOf('--origin');
  if (originIdx >= 0) filter.origin = flags[originIdx + 1];

  const scoreIdx = flags.indexOf('--score');
  const scoreFilter = scoreIdx >= 0 ? parseFloat(flags[scoreIdx + 1]) : undefined;

  const showStale = flags.includes('--stale');
  const showDuplicates = flags.includes('--duplicates');
  const showUnderrated = flags.includes('--underrated');

  const results = filterRules(registry, filter);

  // Underrated filter (via Elo rating state)
  if (showUnderrated) {
    const { loadRatingState, computePopulationStats } = await import('../lib/rule-rating.js');
    const ratingState = loadRatingState(paths);
    const { mean, std_dev } = computePopulationStats(ratingState);
    const threshold = mean - std_dev;

    const underrated = results.filter(rule => {
      const entry = ratingState.rules?.[rule.id];
      if (!entry) return false;
      if ((entry.sessions_injected || 0) < 5) return false;
      return entry.rating < threshold;
    });

    console.log(`  Population: mean=${Math.round(mean)}, σ=${Math.round(std_dev)}, threshold=${Math.round(threshold)}`);
    console.log(`  Underrated rules (injected ≥5, rating < mean − σ):`);
    for (const rule of underrated) {
      const entry = ratingState.rules?.[rule.id];
      console.log(`    ${rule.id}: rating=${Math.round(entry.rating)}, sessions=${entry.sessions_injected}, text="${(rule.text || '').slice(0, 60)}"`);
    }
    return;
  }

  // Stale filter
  let finalResults = results;
  if (showStale) {
    const { computeSourceHash } = await import('../lib/ingestion/parsers.js');
    const stale = [];
    for (const rule of finalResults) {
      if (!rule.source || !rule.source_hash) continue;
      const currentHash = computeSourceHash(rule.source);
      if (currentHash && currentHash !== rule.source_hash) {
        stale.push(rule);
      }
    }
    finalResults = stale;
  }

  // Score filter
  if (scoreFilter !== undefined && !Number.isNaN(scoreFilter)) {
    const scores = await loadScoresMap(paths);
    finalResults = finalResults.filter(r => (scores[r.id] ?? 0) === scoreFilter);
  }

  // Duplicates across repos
  if (showDuplicates) {
    const { readTraceIndex } = await import('../lib/federated-index.js');
    const { normalizedSimilarity } = await import('../lib/rule-registry.js');
    const repos = readTraceIndex();
    const thisRepoPath = path.resolve(paths.projectDir);

    for (const rule of finalResults) {
      const matches = [];
      for (const repo of repos) {
        if (repo.path === thisRepoPath) continue;
        const otherRules = repo.rules_summary || [];
        const similar = otherRules.find(or =>
          normalizedSimilarity(or.text || '', rule.text) >= 0.7
        );
        if (similar) {
          matches.push({ repo: repo.name, rule: similar });
        }
      }
      if (matches.length > 0) {
        console.log(`  ${rule.id}: "${rule.text}"`);
        for (const m of matches) {
          console.log(`    Similar: ${m.repo} / ${m.rule.id} (score: ${m.rule.score || 'n/a'})`);
        }
      }
    }
    return;
  }

  console.log('');
  console.log(`  Rules (${finalResults.length} of ${registry.size}):`);
  console.log('');

  for (const rule of finalResults) {
    const tags = (rule.tags || []).length > 0 ? ` [${rule.tags.join(', ')}]` : '';
    const sev = rule.severity === 'must' ? ' (must)' : '';
    const origin = rule.origin ? ` <${rule.origin}>` : '';
    console.log(`  ${rule.id}${sev}${origin}${tags}`);
    console.log(`    ${rule.text}`);
    if (rule.routes && rule.routes.length > 0) {
      console.log(`    Routes: ${rule.routes.join(', ')}`);
    }
    console.log('');
  }
}

async function loadScoresMap(paths) {
  const scores = {};
  if (!fs.existsSync(paths.effectivenessFile)) return scores;
  const content = fs.readFileSync(paths.effectivenessFile, 'utf8');
  const rowRe = /^\|\s*(\S+)\s*\|\s*\d+\s*\|\s*\d+\s*\|\s*([\d.]+)\s*\|/gm;
  let match;
  while ((match = rowRe.exec(content)) !== null) {
    scores[match[1]] = parseFloat(match[2]);
  }
  return scores;
}

async function searchRules(paths, flags) {
  // Strip known flag pairs and any --flag tokens from the query terms
  const queryTerms = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === '--project') { i++; continue; }
    if (f.startsWith('--')) { i++; continue; }
    queryTerms.push(f);
  }
  const query = queryTerms.join(' ');
  if (!query) {
    console.log('Usage: harness-harness rules search <query>');
    return;
  }

  const registry = loadRuleRegistry(paths);
  const results = filterRules(registry, { query });

  if (results.length === 0) {
    console.log(`No rules matching "${query}" in this repo.`);
    console.log('Try cross-repo search: harness-harness rules <query>');
    return;
  }

  console.log(`\nFound ${results.length} rules matching "${query}":\n`);
  for (const rule of results) {
    console.log(`  ${rule.id} (${rule.severity || 'should'})`);
    console.log(`    ${rule.text}`);
    console.log('');
  }
}

async function addRule(paths, flags) {
  const idIdx = flags.indexOf('--id');
  const textIdx = flags.indexOf('--text');
  const tagsIdx = flags.indexOf('--tags');
  const sevIdx = flags.indexOf('--severity');
  const routesIdx = flags.indexOf('--routes');

  if (idIdx < 0 || textIdx < 0) {
    console.log('Usage: harness-harness rules add --id <ID> --text "rule text" [--tags a,b] [--severity must] [--routes coding-backend,general]');
    return;
  }

  const rule = {
    id: flags[idIdx + 1],
    text: flags[textIdx + 1],
    tags: tagsIdx >= 0 ? flags[tagsIdx + 1].split(',').map(s => s.trim()) : [],
    severity: sevIdx >= 0 ? flags[sevIdx + 1] : 'should',
    routes: routesIdx >= 0 ? flags[routesIdx + 1].split(',').map(s => s.trim()) : [],
  };

  const teamFile = flags.includes('--local') ? paths.localRulesFile : paths.rulesFile;
  addRuleToFile(rule, teamFile);
  console.log(`Added ${rule.id} to ${path.relative(paths.projectDir, teamFile)}`);
}

async function migrateRules(paths, flags) {
  const dryRun = flags.includes('--dry-run');

  if (!fs.existsSync(paths.routesDir)) {
    console.log('No routes directory found.');
    return;
  }

  const routeFiles = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md'));
  const allRules = [];

  for (const rf of routeFiles) {
    const content = fs.readFileSync(path.join(paths.routesDir, rf), 'utf8');
    const config = parseRouteConfig(content);
    const routeSection = config.sections['Route Context'] || '';
    const intent = (config.meta.intent || rf.replace('.md', '')).replace(/:/g, '-');
    const parsed = parseRulesFromSection(routeSection, rf);

    for (const rule of parsed) {
      allRules.push({
        ...rule,
        routes: [intent],
        severity: 'should',
        tags: [],
      });
    }
  }

  const deduped = new Map();
  for (const rule of allRules) {
    if (deduped.has(rule.id)) {
      const existing = deduped.get(rule.id);
      const routes = new Set([...existing.routes, ...rule.routes]);
      deduped.set(rule.id, { ...existing, routes: [...routes] });
    } else {
      deduped.set(rule.id, rule);
    }
  }

  console.log(`Found ${deduped.size} rules across ${routeFiles.length} route files.`);

  if (dryRun) {
    for (const [id, rule] of deduped) {
      console.log(`  ${id}: ${rule.text} [${rule.routes.join(', ')}]`);
    }
    console.log('\n  --dry-run: no files written');
    return;
  }

  const existingRegistry = fs.existsSync(paths.rulesFile)
    ? parseRulesYaml(fs.readFileSync(paths.rulesFile, 'utf8'))
    : new Map();

  let added = 0, skipped = 0;
  for (const [id, rule] of deduped) {
    if (existingRegistry.has(id)) {
      skipped++;
      continue;
    }
    existingRegistry.set(id, { ...rule, created: new Date().toISOString().slice(0, 10) });
    added++;
  }

  fs.mkdirSync(path.dirname(paths.rulesFile), { recursive: true });
  withFileLock(paths.rulesFile, () => {
    fs.writeFileSync(paths.rulesFile, serializeRulesYaml(existingRegistry), 'utf8');
  });

  console.log(`Migrated ${added} rules to ${path.relative(paths.projectDir, paths.rulesFile)} (${skipped} already existed).`);
}

/**
 * Cross-repo rule search: reads federated index and searches rules_summary
 */
async function searchCrossRepo(query, flags) {
  const repos = readTraceIndex();
  if (repos.length === 0) {
    console.log('No repos in federated index. Run: harness-harness register --scan <dir>');
    return;
  }

  const q = query.toLowerCase();
  const matches = [];

  for (const repo of repos) {
    const repoRules = repo.rules_summary || [];
    for (const rule of repoRules) {
      const text = (rule.text || '').toLowerCase();
      const id = (rule.id || '').toLowerCase();
      const tags = (rule.tags || []).map(t => String(t).toLowerCase());

      if (text.includes(q) || id.includes(q) || tags.some(t => t.includes(q))) {
        matches.push({ ...rule, repo: repo.name, repoPath: repo.path });
      }
    }
  }

  if (matches.length === 0) {
    console.log(`No rules matching "${query}" across ${repos.length} repos.`);
    return;
  }

  matches.sort((a, b) => (b.score || 0) - (a.score || 0));

  console.log(`\nFound ${matches.length} rules matching "${query}" across ${new Set(matches.map(m => m.repo)).size} repos:\n`);

  for (const m of matches) {
    const tags = (m.tags || []).length > 0 ? ` [${m.tags.join(', ')}]` : '';
    const score = m.score !== undefined ? ` (effectiveness: ${m.score})` : '';
    console.log(`  ${m.repo} / ${m.id}${score}${tags}`);
    console.log(`    "${m.text}"`);
    console.log('');
  }

  console.log(`Import a rule: harness-harness share ${matches[0].id} --to .`);
}

async function ingestRules(paths, flags) {
  const dryRun = flags.includes('--dry-run');
  const update = flags.includes('--update');
  const sourceIdx = flags.indexOf('--source');
  const sourceFilter = sourceIdx >= 0 ? flags[sourceIdx + 1] : null;

  const formats = detectFormats(paths.projectDir);

  if (formats.length === 0 || (formats.length === 1 && formats[0].format === 'native')) {
    console.log('No external context formats detected.');
    console.log('Supported: CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/, .gsd/context/');
    return;
  }

  const toIngest = sourceFilter
    ? formats.filter(f => f.format === sourceFilter)
    : formats.filter(f => f.format !== 'native');

  if (toIngest.length === 0) {
    console.log(`No files matching --source ${sourceFilter}`);
    return;
  }

  console.log(`Detected ${toIngest.length} format(s):`);
  for (const f of toIngest) {
    console.log(`  ${f.format}: ${f.paths.length} file(s)`);
  }
  console.log('');

  const existingRegistry = fs.existsSync(paths.rulesFile)
    ? parseRulesYaml(fs.readFileSync(paths.rulesFile, 'utf8'))
    : new Map();

  const allNewRules = [];
  const allSourceHashes = new Map();
  const coverageBySource = new Map();

  for (const fmt of toIngest) {
    for (const filePath of fmt.paths) {
      const sourceHash = computeSourceHash(filePath);
      allSourceHashes.set(filePath, sourceHash);

      const { rules: extractedRules, coverage } = parseSourceFile(filePath, fmt.format, paths.projectDir);
      coverageBySource.set(filePath, coverage);
      allNewRules.push(...extractedRules);
    }
  }

  for (const [src, cov] of coverageBySource) {
    if (cov.total_lines > 100 && cov.coverage_ratio < 0.03) {
      const rel = path.relative(paths.projectDir, src);
      console.log(`  WARN ${rel}: extracted ${cov.rules_extracted} rules from ${cov.total_lines} lines (${(cov.coverage_ratio * 100).toFixed(1)}%). Prose-heavy content — bloat detection will ignore this file.`);
    }
  }

  const diff = computeIngestionDiff(existingRegistry, allNewRules, allSourceHashes);

  console.log(`Ingestion summary:`);
  console.log(`  New rules:      ${diff.added.length}`);
  console.log(`  Unchanged:      ${diff.unchanged.length}`);
  if (update) {
    console.log(`  Modified:       ${diff.modified.length}`);
    console.log(`  Removed:        ${diff.removed.length}`);
  }
  console.log('');

  if (dryRun) {
    console.log('--- Added rules ---');
    for (const rule of diff.added.slice(0, 20)) {
      console.log(`  ${rule.id}: ${rule.text.slice(0, 80)}`);
    }
    if (diff.added.length > 20) console.log(`  ... and ${diff.added.length - 20} more`);

    if (update && diff.modified.length > 0) {
      console.log('\n--- Modified rules ---');
      for (const rule of diff.modified.slice(0, 10)) {
        console.log(`  ${rule.id}: ${rule.text.slice(0, 80)}`);
      }
    }

    console.log('\n--dry-run: no files written');
    return;
  }

  for (const rule of diff.added) {
    existingRegistry.set(rule.id, rule);
  }

  if (update) {
    for (const rule of diff.modified) {
      existingRegistry.set(rule.id, rule);
    }
    for (const id of diff.removed) {
      existingRegistry.delete(id);
    }
  }

  fs.mkdirSync(path.dirname(paths.rulesFile), { recursive: true });
  withFileLock(paths.rulesFile, () => {
    fs.writeFileSync(paths.rulesFile, serializeRulesYaml(existingRegistry), 'utf8');
  });

  console.log(`Ingested ${diff.added.length} rules to ${path.relative(paths.projectDir, paths.rulesFile)}`);
  if (update && diff.modified.length > 0) {
    console.log(`Updated ${diff.modified.length} rules from modified sources.`);
  }
  if (update && diff.removed.length > 0) {
    console.log(`Removed ${diff.removed.length} rules no longer in sources.`);
  }
}

async function pruneRules(paths, flags) {
  const apply = flags.includes('--apply');
  const { identifyPruneCandidates, writePruneProposal, applyPruneProposal } = await import('../lib/prune.js');

  if (apply) {
    try {
      const result = applyPruneProposal(paths);
      console.log(`Pruning complete:`);
      console.log(`  Source files modified: ${result.modified}`);
      console.log(`  Rules removed from registry: ${result.removed}`);
      if (result.backups.length > 0) {
        const backupDir = path.dirname(result.backups[0].backup);
        console.log(`  Backups: ${path.relative(paths.projectDir, backupDir)}`);
      }
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
    return;
  }

  const candidates = identifyPruneCandidates(paths);
  const proposalFile = writePruneProposal(paths, candidates);

  console.log(`Pruning candidates (dry-run):`);
  console.log(`  Underrated: ${candidates.underrated.length}`);
  console.log(`  Ghosts:     ${candidates.ghosts.length}`);
  console.log(`  Excluded:   ${candidates.excluded.length} (severity=must, hasPrevented, etc.)`);
  console.log('');
  console.log(`Proposal written to: ${path.relative(paths.projectDir, proposalFile)}`);
  console.log(`Review, then run: harness-harness rules prune --apply`);
}

function computeIngestionDiff(existingRegistry, newRules, sourceHashes) {
  const added = [];
  const unchanged = [];
  const modified = [];
  const removed = [];

  const newRuleMap = new Map();
  for (const rule of newRules) {
    newRuleMap.set(rule.id, rule);
  }

  for (const rule of newRules) {
    const existing = existingRegistry.get(rule.id);
    if (!existing) {
      added.push(rule);
    } else if (existing.origin === rule.origin) {
      if (existing.source_hash !== rule.source_hash) {
        modified.push(rule);
      } else {
        unchanged.push(rule);
      }
    } else {
      unchanged.push(rule);
    }
  }

  for (const [id, existing] of existingRegistry) {
    if (!existing.origin || existing.origin === 'native' || existing.origin === 'explicit-id' || existing.origin === 'free-text') {
      continue;
    }
    if (!newRuleMap.has(id)) {
      removed.push(id);
    }
  }

  return { added, unchanged, modified, removed };
}
