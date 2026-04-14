/**
 * commands/activity.js — File activity heatmap (Phase 6)
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../lib/paths.js';
import { readTraceIndex } from '../lib/federated-index.js';

export async function activity(projectDir, flags) {
  const periodIdx = flags.indexOf('--period');
  const periodStr = periodIdx >= 0 ? flags[periodIdx + 1] : '7d';
  const days = parseInt(periodStr.replace(/d$/, ''), 10) || 7;

  const reposFlagIdx = flags.indexOf('--repos');
  const reposFilter = reposFlagIdx >= 0
    ? (flags[reposFlagIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean)
    : null;

  const localOnly = !flags.includes('--all') && !reposFilter;

  if (localOnly) {
    return localActivity(projectDir, days);
  }

  return crossRepoActivity(days, reposFilter);
}

async function localActivity(projectDir, days) {
  const paths = resolvePaths(projectDir);

  if (!fs.existsSync(paths.fileActivityFile)) {
    console.log('No activity data yet. Activity is aggregated during daily analysis.');
    console.log('Run: harness-harness analyze');
    return;
  }

  const { readFileActivity } = await import('../lib/activity.js');
  const activityData = readFileActivity(paths.fileActivityFile);

  if (activityData.length === 0) {
    console.log('No file activity recorded.');
    return;
  }

  console.log(`\nAgent Activity — ${path.basename(projectDir)} (last ${days} days)\n`);
  console.log('  ' + 'File'.padEnd(55) + 'Reads'.padStart(7) + 'Edits'.padStart(7));
  console.log('  ' + '─'.repeat(69));

  for (const entry of activityData.slice(0, 20)) {
    const filePath = entry.path.length > 52 ? '...' + entry.path.slice(-49) : entry.path;
    console.log(
      '  ' + filePath.padEnd(55) +
      String(entry.reads).padStart(7) +
      String(entry.edits).padStart(7)
    );
  }

  if (activityData.length > 20) {
    console.log(`\n  ... and ${activityData.length - 20} more files`);
  }
  console.log('');
}

async function crossRepoActivity(days, reposFilter) {
  const repos = readTraceIndex();

  if (repos.length === 0) {
    console.log('No repos in federated index. Run: harness-harness register --scan <dir>');
    return;
  }

  const filtered = reposFilter
    ? repos.filter(r => reposFilter.some(f => r.name.includes(f)))
    : repos;

  const allFiles = [];
  let totalSessions = 0;

  for (const repo of filtered) {
    totalSessions += repo.sessions_7d || 0;
    const topFiles = repo.top_files || [];
    for (const f of topFiles) {
      allFiles.push({
        path: f.path,
        repo: repo.name,
        reads: f.reads || 0,
        edits: f.edits || 0,
        total: (f.reads || 0) + (f.edits || 0),
      });
    }
  }

  if (allFiles.length === 0) {
    console.log('No activity data across repos. Activity is aggregated during daily analysis.');
    return;
  }

  allFiles.sort((a, b) => b.total - a.total);

  console.log(`\nAgent Activity Heatmap (last ${days} days, ${filtered.length} repos, ${totalSessions} sessions)\n`);

  console.log('Most Accessed Files:');
  console.log('  ' + 'Rank'.padEnd(6) + 'File'.padEnd(45) + 'Repo'.padEnd(22) + 'Reads'.padStart(7) + 'Edits'.padStart(7));
  console.log('  ' + '─'.repeat(87));

  for (let i = 0; i < Math.min(15, allFiles.length); i++) {
    const f = allFiles[i];
    const filePath = f.path.length > 42 ? '...' + f.path.slice(-39) : f.path;
    const repo = f.repo.length > 19 ? f.repo.slice(0, 19) + '…' : f.repo;
    console.log(
      '  ' + String(i + 1).padEnd(6) +
      filePath.padEnd(45) +
      repo.padEnd(22) +
      String(f.reads).padStart(7) +
      String(f.edits).padStart(7)
    );
  }

  const editedFiles = allFiles.filter(f => f.edits > 3);
  const repoGroups = {};
  for (const f of editedFiles) {
    if (!repoGroups[f.repo]) repoGroups[f.repo] = [];
    repoGroups[f.repo].push(f.path);
  }

  const repoNames = Object.keys(repoGroups);
  if (repoNames.length >= 2) {
    console.log('\n\nCross-Repo Edit Clusters:');
    for (let i = 0; i < repoNames.length; i++) {
      for (let j = i + 1; j < repoNames.length; j++) {
        const a = repoNames[i], b = repoNames[j];
        console.log(`  ${a} ↔ ${b}: both have high-edit files this period`);
        console.log(`    ${a}: ${repoGroups[a].slice(0, 3).join(', ')}`);
        console.log(`    ${b}: ${repoGroups[b].slice(0, 3).join(', ')}`);
      }
    }
  }

  console.log('');
}
