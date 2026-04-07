/**
 * apply-overrides.js — Apply approved proposals to route configs
 *
 * Reads .harness/memory/route-overrides.md, finds approved items,
 * and applies them to route config files.
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from './paths.js';

// ---------------------------------------------------------------------------
// Override parsing
// ---------------------------------------------------------------------------

export function parseOverrides(content, forceMode = false) {
  const promotions = [];
  const demotions = [];
  const budgetChanges = [];

  let currentSection = '';
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('### Promotions')) { currentSection = 'promotions'; continue; }
    if (line.startsWith('### Demotions')) { currentSection = 'demotions'; continue; }
    if (line.startsWith('### Budget Rebalancing')) { currentSection = 'budget'; continue; }
    if (line.startsWith('## ') || line.startsWith('### ')) { currentSection = ''; continue; }

    if (currentSection === 'promotions' && line.startsWith('- ')) {
      const ruleMatch = line.match(/^- ([A-Z]{2,4}-\d{2,4}) → Identity/);
      if (ruleMatch) {
        const statusLine = findStatusLine(lines, i);
        if (statusLine && statusLine.includes('approved')) {
          const reviewerLine = findFieldLine(lines, i, 'Reviewed by:');
          if (!reviewerLine && !forceMode) continue;
          promotions.push({ rule: ruleMatch[1], lineIndex: i });
        }
      }
    }

    if (currentSection === 'demotions' && line.startsWith('- ')) {
      const demoteMatch = line.match(/^- ([A-Z]{2,4}-\d{2,4}) → Skip in (.+)/);
      if (demoteMatch) {
        const statusLine = findStatusLine(lines, i);
        if (statusLine && statusLine.includes('approved')) {
          const reviewerLine = findFieldLine(lines, i, 'Reviewed by:');
          if (!reviewerLine && !forceMode) continue;
          demotions.push({
            rule: demoteMatch[1],
            route: demoteMatch[2].trim(),
            lineIndex: i,
            reviewer: reviewerLine ? reviewerLine.match(/Reviewed by:\s*(.+)/)?.[1]?.trim() : null,
          });
        }
      }
    }

    if (currentSection === 'budget' && line.startsWith('- ')) {
      const budgetMatch = line.match(/^- (.+?):\s*(.+)/);
      if (budgetMatch) {
        const statusLine = findStatusLine(lines, i);
        if (statusLine && statusLine.includes('approved')) {
          const reviewerLine = findFieldLine(lines, i, 'Reviewed by:');
          if (!reviewerLine && !forceMode) continue;
          budgetChanges.push({ route: budgetMatch[1].trim(), description: budgetMatch[2].trim(), lineIndex: i });
        }
      }
    }
  }

  return { promotions, demotions, budgetChanges };
}

function findStatusLine(lines, startIdx) {
  for (let j = startIdx + 1; j < Math.min(startIdx + 5, lines.length); j++) {
    if (lines[j].trim().startsWith('Status:')) return lines[j];
  }
  return null;
}

function findFieldLine(lines, startIdx, fieldName) {
  for (let j = startIdx + 1; j < Math.min(startIdx + 6, lines.length); j++) {
    if (lines[j].trim().startsWith(fieldName)) return lines[j];
    if (lines[j].startsWith('- ') || lines[j].startsWith('### ')) break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route config modification
// ---------------------------------------------------------------------------

export function applyDemotion(routeConfigPath, ruleId, dryRun = false) {
  if (!fs.existsSync(routeConfigPath)) {
    return { changed: false, description: `Route config not found: ${routeConfigPath}` };
  }

  let content = fs.readFileSync(routeConfigPath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const ruleLineRe = new RegExp(`^(- .*${ruleId}.*)$`, 'm');
  const match = content.match(ruleLineRe);

  if (!match) return { changed: false, description: `Rule ${ruleId} not found in ${path.basename(routeConfigPath)}` };

  const skipIdx = content.indexOf('### Skip');
  const matchIdx = content.indexOf(match[0]);
  if (skipIdx >= 0 && matchIdx > skipIdx) {
    return { changed: false, description: `Rule ${ruleId} already in Skip section` };
  }

  content = content.replace(match[0] + '\n', '');
  const skipMatch = content.match(/### Skip[^\n]*\n/);
  if (skipMatch) {
    const insertAt = content.indexOf(skipMatch[0]) + skipMatch[0].length;
    content = content.slice(0, insertAt) + `- ${ruleId} (score: 0.00, demoted ${today})\n` + content.slice(insertAt);
  }

  if (!dryRun) fs.writeFileSync(routeConfigPath, content, 'utf8');
  return { changed: true, description: `Demoted ${ruleId} to Skip in ${path.basename(routeConfigPath)}` };
}

export function applyPromotion(ruleId, paths, dryRun = false) {
  const descriptions = [];
  const routeFiles = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md'));

  for (const rf of routeFiles) {
    const rfPath = path.join(paths.routesDir, rf);
    let content = fs.readFileSync(rfPath, 'utf8');

    const identityMatch = content.match(/## Identity\n([\s\S]*?)(?=\n## )/);
    if (identityMatch && identityMatch[1].includes(ruleId)) {
      descriptions.push(`${rf}: ${ruleId} already in Identity`);
      continue;
    }

    if (identityMatch) {
      const insertAt = content.indexOf(identityMatch[0]) + identityMatch[0].length;
      content = content.slice(0, insertAt) +
        `\n- ${ruleId}: promoted to Identity layer (high effectiveness across all routes)` +
        content.slice(insertAt);

      const routeContextIdx = content.indexOf('## Route Context');
      if (routeContextIdx >= 0) {
        const ruleLineRe = new RegExp(`^- .+${ruleId}.+\n`, 'gm');
        const before = content.slice(0, routeContextIdx);
        const after = content.slice(routeContextIdx).replace(ruleLineRe, '');
        content = before + after;
      }

      if (!dryRun) fs.writeFileSync(rfPath, content, 'utf8');
      descriptions.push(`${rf}: promoted ${ruleId} to Identity`);
    }
  }

  return { changed: descriptions.length > 0, descriptions };
}

export function applyBudgetChange(routeConfigPath, newBudget, dryRun = false) {
  if (!fs.existsSync(routeConfigPath)) {
    return { changed: false, description: `Route config not found: ${routeConfigPath}` };
  }

  let content = fs.readFileSync(routeConfigPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { changed: false, description: 'No YAML frontmatter found' };

  let frontmatter = fmMatch[1];
  let nonReservedSum = 0;

  for (const [key, value] of Object.entries(newBudget)) {
    if (key === 'reserved') continue;
    const re = new RegExp(`(${key}:\\s*)\\d+`);
    if (re.test(frontmatter)) frontmatter = frontmatter.replace(re, `$1${value}`);
    nonReservedSum += value;
  }

  const budgetKeys = ['identity', 'route_context', 'working_memory', 'traces'];
  for (const key of budgetKeys) {
    if (!(key in newBudget)) {
      const existing = frontmatter.match(new RegExp(`${key}:\\s*(\\d+)`));
      if (existing) nonReservedSum += parseInt(existing[1], 10);
    }
  }

  const reserved = Math.max(0, 100 - nonReservedSum);
  frontmatter = frontmatter.replace(/(reserved:\s*)\d+/, `$1${reserved}`);
  content = content.replace(fmMatch[1], frontmatter);

  if (!dryRun) fs.writeFileSync(routeConfigPath, content, 'utf8');
  return { changed: true, description: `Updated budget in ${path.basename(routeConfigPath)}` };
}

export function parseBudgetDescription(routeConfigPath, description) {
  if (!fs.existsSync(routeConfigPath)) return null;

  const content = fs.readFileSync(routeConfigPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const current = {};
  for (const key of ['identity', 'route_context', 'working_memory', 'traces', 'reserved']) {
    const m = fmMatch[1].match(new RegExp(`${key}:\\s*(\\d+)`));
    if (m) current[key] = parseInt(m[1], 10);
  }

  if (!current.route_context) return null;

  const isIncrease = /increase/i.test(description);
  const isDecrease = /decrease/i.test(description);
  if (!isIncrease && !isDecrease) return null;

  const delta = isIncrease ? 5 : -5;
  const newRouteContext = Math.max(10, Math.min(50, current.route_context + delta));
  if (newRouteContext === current.route_context) return null;

  return { route_context: newRouteContext };
}

export function markApplied(lineIndices, paths, dryRun = false, developer = 'unknown') {
  if (dryRun || lineIndices.length === 0) return;

  const content = fs.readFileSync(paths.overridesFile, 'utf8');
  const lines = content.split('\n');
  const today = new Date().toISOString().slice(0, 10);

  for (const idx of lineIndices) {
    for (let j = idx + 1; j < Math.min(idx + 5, lines.length); j++) {
      if (lines[j].trim().startsWith('Status: approved')) {
        lines[j] = lines[j].replace('Status: approved', `Status: applied (${today} by ${developer})`);
        break;
      }
    }
  }

  fs.writeFileSync(paths.overridesFile, lines.join('\n'), 'utf8');
}
