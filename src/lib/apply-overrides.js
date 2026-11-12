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
      const ruleMatch = line.match(/^- (\S+) → Identity/);
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
      const demoteMatch = line.match(/^- (\S+) → Skip in (.+)/);
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
      // The route ends at the last ': ' before 'utilization' (OI-R64): a lazy
      // '(.+?):' split "coding:meta: utilization …" at the first colon, so the
      // four colon routes looked up coding.md, writing.md … and were skipped.
      const budgetMatch = line.match(/^- (.+?):\s+(utilization\b.*)$/);
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

  // MOVE the rule's own line — never overwrite it. Replacing
  //   "- GA-001: Google → integrations/, NEVER MCP"
  // with "- GA-001 (score: 0.00, demoted …)" destroys the rule itself: the model can no
  // longer read what GA-001 says, so it can never follow it, so it scores 0.00 forever
  // and stays demoted. A demotion must be reversible, and it must not shred the content
  // it demotes. The provenance goes in a trailing HTML comment, which renders invisibly
  // and keeps the rule text intact for whoever re-promotes it.
  const demotedLine = `${match[0]} <!-- demoted ${today}: avg score 0.00 -->`;

  content = content.replace(match[0] + '\n', '');
  const skipMatch = content.match(/### Skip[^\n]*\n/);
  if (skipMatch) {
    const insertAt = content.indexOf(skipMatch[0]) + skipMatch[0].length;
    content = content.slice(0, insertAt) + `${demotedLine}\n` + content.slice(insertAt);
  }

  if (!dryRun) fs.writeFileSync(routeConfigPath, content, 'utf8');
  return { changed: true, description: `Demoted ${ruleId} to Skip in ${path.basename(routeConfigPath)}` };
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function catalogueTitle(ruleId, catalogueDir) {
  const heading = new RegExp(`^#{2,3} ${escapeRe(ruleId)}: (.+?)\\s*$`, 'm');
  for (const f of fs.readdirSync(catalogueDir).filter(n => n.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(catalogueDir, f), 'utf8');
    const m = text.match(heading);
    if (!m) continue;
    const entry = text.slice(m.index + m[0].length).split(/\n#{1,3} /)[0];
    const antiPattern = entry.match(/^\*\*Anti-pattern:\*\*\s*(.+?)\s*$/m);
    return { title: m[1], antiPattern: antiPattern ? antiPattern[1] : null };
  }
  return null;
}

function routeGuidance(ruleId, title, routeFiles) {
  const line = new RegExp(`^- ${escapeRe(ruleId)}: ${escapeRe(title)} — (.+?)\\s*(?:<!--.*)?$`, 'm');
  for (const rfPath of routeFiles) {
    const m = fs.readFileSync(rfPath, 'utf8').match(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The line a promotion inserts into a route that has no line for the rule:
 * `- <ID>: <title> — <summary>`, the catalogue form RID-002 checks. A bare
 * `- <ID>` gives the model the ID without the rule (OI-R65), so when the
 * catalogue or a summary is out of reach this returns a refusal reason.
 */
export function catalogueRuleLine(ruleId, paths, routeFiles = []) {
  const dir = paths.rulesCatalogDir;
  if (!dir || !fs.existsSync(dir)) {
    return { error: `no rule catalogue reachable (set "rulesCatalogDir" in .harness/config.json, e.g. "context/anti-patterns"), so ${ruleId}'s text is unknown` };
  }
  const entry = catalogueTitle(ruleId, dir);
  if (!entry) return { error: `${ruleId} has no "## ${ruleId}:" heading in ${dir}` };
  const summary = routeGuidance(ruleId, entry.title, routeFiles) ?? entry.antiPattern;
  if (!summary) {
    return { error: `${ruleId} has no one-line summary (no route line carries one and its catalogue entry has no **Anti-pattern:** line); write its Identity line by hand` };
  }
  return { line: `- ${ruleId}: ${entry.title} — ${summary}` };
}

function identityBlock(content) {
  return content.match(/## Identity\n([\s\S]*?)(?=\n## )/);
}

function routeContextLine(content, ruleId) {
  const rcIdx = content.indexOf('## Route Context');
  return rcIdx >= 0 ? content.slice(rcIdx).match(new RegExp(`^- .*${ruleId}.*$`, 'm')) : null;
}

/**
 * Promote a rule into every route's Identity block. A route that already
 * carries the rule in Route Context has that line MOVED, text intact. A route
 * with no line gets the catalogue line; if that cannot be built, the whole
 * promotion is refused and nothing is written (OI-R65).
 */
export function applyPromotion(ruleId, paths, dryRun = false) {
  const routeFiles = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md'))
    .map(f => path.join(paths.routesDir, f));
  const needsNewLine = routeFiles.some((rfPath) => {
    const content = fs.readFileSync(rfPath, 'utf8');
    const identity = identityBlock(content);
    return identity && !identity[1].includes(ruleId) && !routeContextLine(content, ruleId);
  });
  let newLine = null;
  if (needsNewLine) {
    const built = catalogueRuleLine(ruleId, paths, routeFiles);
    if (built.error) {
      return { changed: false, refused: built.error, descriptions: [`refused ${ruleId}: ${built.error}`] };
    }
    newLine = built.line;
  }
  const descriptions = [];
  for (const rfPath of routeFiles) {
    const desc = promoteInRoute(rfPath, ruleId, newLine, dryRun);
    if (desc) descriptions.push(desc);
  }
  return { changed: descriptions.length > 0, descriptions };
}

function promoteInRoute(rfPath, ruleId, newLine, dryRun) {
  const rf = path.basename(rfPath);
  let content = fs.readFileSync(rfPath, 'utf8');
  const identityMatch = identityBlock(content);
  if (!identityMatch) return null;
  if (identityMatch[1].includes(ruleId)) return `${rf}: ${ruleId} already in Identity`;

  // MOVE the rule's own line into Identity, text intact — do not synthesize a
  // replacement. Note `.*` not `.+`: a rule line starts "- GA-001: …", so there
  // is nothing before the ID, and `.+` never matched (the rule was duplicated).
  const today = new Date().toISOString().slice(0, 10);
  const existing = routeContextLine(content, ruleId);
  const promotedLine = `${existing ? existing[0] : newLine} <!-- promoted ${today}: high effectiveness across routes -->`;

  const insertAt = content.indexOf(identityMatch[0]) + identityMatch[0].length;
  content = content.slice(0, insertAt) + `\n${promotedLine}` + content.slice(insertAt);

  const rcIdx = content.indexOf('## Route Context');
  if (rcIdx >= 0) {
    const ruleLineRe = new RegExp(`^- .*${ruleId}.*\n`, 'gm');
    content = content.slice(0, rcIdx) + content.slice(rcIdx).replace(ruleLineRe, '');
  }

  if (!dryRun) fs.writeFileSync(rfPath, content, 'utf8');
  return `${rf}: promoted ${ruleId} to Identity`;
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
