/**
 * index command — Manually refresh the federated index from registered repos.
 * Useful for engineering leaders, CI jobs, or onboarding after bulk registration.
 */

import fs from 'fs';
import path from 'path';
import { reposFilePath, updateFederatedIndex } from '../lib/federated-index.js';
import { resolvePaths } from '../lib/paths.js';

export async function index(projectDir, flags) {
  const reposFile = reposFilePath();
  if (!fs.existsSync(reposFile)) {
    console.log('No registered repos. Run: harness-harness register --scan <dir>');
    return;
  }

  const content = fs.readFileSync(reposFile, 'utf8');
  const repoPaths = [];
  for (const match of content.matchAll(/^\s{4}path:\s*(.+)/gm)) {
    repoPaths.push(match[1].trim());
  }

  const repoFlag = flags.find(f => f === '--repo');
  const repoName = repoFlag ? flags[flags.indexOf(repoFlag) + 1] : null;

  console.log(`Indexing ${repoName ? 1 : repoPaths.length} repo(s)...`);

  let updated = 0;
  for (const repoPath of repoPaths) {
    if (repoName && !path.basename(repoPath).includes(repoName)) continue;
    if (!fs.existsSync(path.join(repoPath, '.harness'))) {
      console.log(`  skip: ${repoPath} (.harness not found)`);
      continue;
    }
    try {
      const paths = resolvePaths(repoPath);
      updateFederatedIndex(paths);
      console.log(`  ok: ${path.basename(repoPath)}`);
      updated++;
    } catch (err) {
      console.log(`  fail: ${path.basename(repoPath)} — ${err.message}`);
    }
  }

  console.log(`\nIndexed ${updated} repo(s).`);
}
