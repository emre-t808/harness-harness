// src/lib/ingestion/format-detect.js

import fs from 'fs';
import path from 'path';

/**
 * Detect which context frameworks are present in a project directory.
 * Returns an array of detected format objects with paths.
 *
 * @param {string} projectDir - Absolute path to project root
 * @returns {object[]} Array of { format, paths[] }
 */
export function detectFormats(projectDir) {
  const detected = [];

  // 1. CLAUDE.md (hierarchical)
  const claudeMdPaths = findFilesByName(projectDir, 'CLAUDE.md', 3);
  if (claudeMdPaths.length > 0) {
    detected.push({ format: 'claude-md', paths: claudeMdPaths });
  }

  // 2. AGENTS.md (hierarchical)
  const agentsMdPaths = findFilesByName(projectDir, 'AGENTS.md', 3);
  if (agentsMdPaths.length > 0) {
    detected.push({ format: 'agents-md', paths: agentsMdPaths });
  }

  // 3. .cursorrules (flat, repo root)
  const cursorRulesPath = path.join(projectDir, '.cursorrules');
  if (fs.existsSync(cursorRulesPath)) {
    detected.push({ format: 'cursorrules', paths: [cursorRulesPath] });
  }

  // 4. .cursor/rules/ (directory of rule files)
  const cursorRulesDir = path.join(projectDir, '.cursor', 'rules');
  if (fs.existsSync(cursorRulesDir) && fs.statSync(cursorRulesDir).isDirectory()) {
    const cursorRuleFiles = fs.readdirSync(cursorRulesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(cursorRulesDir, f));
    if (cursorRuleFiles.length > 0) {
      detected.push({ format: 'cursor-rules-dir', paths: cursorRuleFiles });
    }
  }

  // 5. GSD .gsd/context/
  const gsdContextDir = path.join(projectDir, '.gsd', 'context');
  if (fs.existsSync(gsdContextDir) && fs.statSync(gsdContextDir).isDirectory()) {
    const gsdContextFiles = findFilesByExtension(gsdContextDir, '.md', 3);
    if (gsdContextFiles.length > 0) {
      detected.push({ format: 'gsd', paths: gsdContextFiles });
    }
  }

  // 6. Native HH routes (always detected if .harness/ exists)
  const harnessRoutesDir = path.join(projectDir, '.harness', 'routes');
  if (fs.existsSync(harnessRoutesDir)) {
    detected.push({ format: 'native', paths: [harnessRoutesDir] });
  }

  return detected;
}

/**
 * Recursively find files by name up to a max depth.
 * Skips node_modules, .git, dist, build, and hidden directories.
 */
function findFilesByName(rootDir, fileName, maxDepth) {
  const found = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (['node_modules', 'dist', 'build', 'out', 'target'].includes(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name === fileName) {
        found.push(fullPath);
      }
    }
  }

  walk(rootDir, 0);
  return found;
}

/**
 * Recursively find files by extension up to a max depth.
 */
function findFilesByExtension(rootDir, ext, maxDepth) {
  const found = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith(ext)) {
        found.push(fullPath);
      }
    }
  }

  walk(rootDir, 0);
  return found;
}
