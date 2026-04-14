/**
 * register command — Manage repos in the federated harness index.
 *
 * Supports:
 *   harness-harness register              → register current directory
 *   harness-harness register --scan <dir> → recursively find & register
 *   harness-harness register --list       → list registered repos
 */

import fs from 'fs';
import path from 'path';
import { globalConfigDir, reposFilePath } from '../lib/federated-index.js';

function readReposFile() {
  const filePath = reposFilePath();
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf8');
  const repos = [];
  let current = null;

  for (const line of content.split('\n')) {
    if (/^\s{2}- name:\s*(.+)/.test(line)) {
      if (current) repos.push(current);
      current = { name: line.match(/name:\s*(.+)/)[1].trim() };
    } else if (current && /^\s{4}(\w+):\s*(.+)/.test(line)) {
      const [, key, value] = line.match(/(\w+):\s*(.+)/);
      current[key] = value.trim();
    }
  }
  if (current) repos.push(current);
  return repos;
}

function writeReposFile(repos) {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    '# Harness Harness — Registered Repos',
    '# Managed by: harness-harness register',
    '',
    'repos:',
  ];
  for (const repo of repos) {
    lines.push(`  - name: ${repo.name}`);
    lines.push(`    path: ${repo.path}`);
    lines.push(`    registered: ${repo.registered}`);
  }

  fs.writeFileSync(reposFilePath(), lines.join('\n') + '\n', 'utf8');
}

function deriveRepoName(projectDir) {
  const configPath = path.join(projectDir, '.harness', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.projectName) return config.projectName;
  } catch { /* fallback */ }
  return path.basename(projectDir);
}

function registerOne(projectDir) {
  const harnessDir = path.join(projectDir, '.harness');
  if (!fs.existsSync(harnessDir)) {
    return { added: false, name: null, reason: 'not-initialized' };
  }

  const name = deriveRepoName(projectDir);
  const absPath = path.resolve(projectDir);
  const repos = readReposFile();

  if (repos.some(r => r.path === absPath)) {
    return { added: false, name, reason: 'already-registered' };
  }

  repos.push({ name, path: absPath, registered: new Date().toISOString() });
  writeReposFile(repos);
  return { added: true, name };
}

function scanForHarnessRepos(rootDir, maxDepth = 4) {
  const found = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    if (entries.some(e => e.isDirectory() && e.name === '.harness')) {
      found.push(dir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(path.resolve(rootDir), 0);
  return found;
}

export async function register(projectDir, flags) {
  const showList = flags.includes('--list');
  const scanIdx = flags.indexOf('--scan');
  const scanDir = scanIdx >= 0 ? flags[scanIdx + 1] : null;

  if (showList) {
    const repos = readReposFile();
    if (repos.length === 0) {
      console.log('No registered repos. Run: harness-harness register');
      return;
    }
    console.log('');
    console.log('  Registered repos:');
    console.log('');
    for (const r of repos) {
      console.log(`  ${r.name.padEnd(30)} ${r.path}`);
    }
    console.log('');
    console.log(`  Total: ${repos.length}`);
    console.log('');
    return;
  }

  if (scanDir) {
    if (!fs.existsSync(scanDir)) {
      console.log(`Directory not found: ${scanDir}`);
      return;
    }
    console.log(`Scanning ${path.resolve(scanDir)} for harness-initialized repos...`);
    const found = scanForHarnessRepos(scanDir);
    let added = 0, alreadyKnown = 0;
    for (const dir of found) {
      const result = registerOne(dir);
      if (result.added) {
        added++;
        console.log(`  + ${result.name} (${dir})`);
      } else if (result.reason === 'already-registered') {
        alreadyKnown++;
      }
    }
    console.log('');
    console.log(`Found ${found.length} harness-initialized repos. Registered ${added} new, ${alreadyKnown} already known.`);
    return;
  }

  const result = registerOne(projectDir);
  if (result.added) {
    console.log(`Registered: ${result.name} (${path.resolve(projectDir)})`);
  } else if (result.reason === 'already-registered') {
    console.log(`Already registered: ${result.name}`);
  } else {
    console.log('Not initialized. Run: harness-harness init');
  }
}
