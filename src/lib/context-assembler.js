/**
 * context-assembler.js — Smart Context Assembler
 *
 * Single entry point for context injection. Replaces multiple independent
 * hooks with one budget-aware, intent-routed assembler.
 *
 * Pipeline:
 *   1. Read user message from stdin (JSON with `prompt` field)
 *   2. classifyIntent(message) → intent tag
 *   3. Load route config from .harness/routes/{intent}.md
 *   4. Read effectiveness scores for rule ordering
 *   5. Fill budget slots: Identity → Route Context → Working Memory → Traces
 *   6. Output <harness-context> block
 *
 * All paths are resolved via resolvePaths(projectDir).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { classifyIntent } from './trace-utils.js';
import { resolvePaths } from './paths.js';
import { join } from 'path';
import { mergeRouteConfigs, mergeEffectivenessScores, mergeProjectConfigs } from './config-merge.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_BUDGET_TOKENS = 130_000;

export const DEFAULT_BUDGET = {
  identity: 15,
  route_context: 25,
  working_memory: 15,
  traces: 10,
  reserved: 35,
};

let lastManifest = null;

export function getLastManifest() {
  return lastManifest;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ---------------------------------------------------------------------------
// Route config parsing
// ---------------------------------------------------------------------------

export function parseRouteConfig(content) {
  const meta = {};
  const budget = {};
  const sections = {};

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    let inBudget = false;
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (key === 'budget') { inBudget = true; continue; }
      if (inBudget && line.startsWith('  ')) {
        const num = parseInt(value, 10);
        if (!isNaN(num)) budget[key] = num;
      } else {
        inBudget = false;
        meta[key] = value;
      }
    }
  }

  const sectionRe = /^## (.+)$/gm;
  let match;
  const starts = [];
  while ((match = sectionRe.exec(content)) !== null) {
    starts.push({ name: match[1].trim(), index: match.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : content.length;
    sections[starts[i].name] = content.slice(starts[i].index, end).trim();
  }

  return { meta, budget, sections };
}

export function loadRouteConfig(intent, paths) {
  const filename = intent.replace(/:/g, '-') + '.md';

  // Team route (shared, committed)
  let teamPath = `${paths.routesDir}/${filename}`;
  if (!existsSync(teamPath)) teamPath = `${paths.routesDir}/general.md`;
  const teamRoute = existsSync(teamPath)
    ? parseRouteConfig(readFileSync(teamPath, 'utf8'))
    : { meta: { intent }, budget: {}, sections: {} };

  // Developer route (local, gitignored)
  if (paths.localRoutesDir) {
    const devPath = `${paths.localRoutesDir}/${filename}`;
    const devRoute = existsSync(devPath)
      ? parseRouteConfig(readFileSync(devPath, 'utf8'))
      : null;
    return mergeRouteConfigs(teamRoute, devRoute);
  }

  return teamRoute;
}

// ---------------------------------------------------------------------------
// Effectiveness scores
// ---------------------------------------------------------------------------

export function loadEffectivenessScores(paths) {
  const teamScores = loadScoresFromFile(paths.effectivenessFile);
  const devScores = paths.localEffectivenessFile
    ? loadScoresFromFile(paths.localEffectivenessFile)
    : {};
  return mergeEffectivenessScores(teamScores, devScores);
}

function loadScoresFromFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const scores = {};
  const rowRe = /^\|\s*([A-Z]{2,4}-\d{2,4})\s*\|[^|]*\|[^|]*\|\s*([\d.]+)\s*\|/gm;
  let match;
  while ((match = rowRe.exec(content)) !== null) {
    scores[match[1]] = parseFloat(match[2]);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Trace patterns
// ---------------------------------------------------------------------------

export function loadTraceInsights(intent, paths, limit = 5) {
  if (!existsSync(paths.tracePatternsFile)) return '';

  const content = readFileSync(paths.tracePatternsFile, 'utf8');
  if (!content.trim()) return '';

  const blocks = content.split(/(?=^### )/m).filter(b => b.startsWith('### '));
  if (blocks.length === 0) return '';

  const intentNormalized = intent.replace(/:/g, '-');
  let matched = blocks.filter(b => {
    const lower = b.toLowerCase();
    return lower.includes(`(${intent})`) || lower.includes(`(${intentNormalized})`);
  });

  if (matched.length === 0) matched = blocks;
  return matched.slice(-limit).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Budget-aware file loading
// ---------------------------------------------------------------------------

export function extractLoadIfBudgetPaths(sectionContent) {
  const paths = [];
  const lineRe = /^- (.+\.md)\b/gm;
  let match;
  while ((match = lineRe.exec(sectionContent)) !== null) {
    paths.push(match[1].trim().replace(/\s*\(.*$/, ''));
  }
  return paths;
}

/**
 * Load files within a token budget, ordered by effectiveness score.
 * @param {string[]} filePaths - Paths relative to project dir or absolute
 * @param {number} budgetTokens
 * @param {Record<string, number>} effectivenessScores
 * @param {string} projectDir
 * @param {Record<string, string[]>} [fileToRules] - Map file basenames to rule IDs
 */
export function loadFilesWithinBudget(filePaths, budgetTokens, effectivenessScores = {}, projectDir = '', fileToRules = {}) {
  const scored = filePaths.map(p => {
    const basename = p.split('/').pop() || '';
    const ruleIds = fileToRules[basename] || [];
    let score = 0;
    for (const ruleId of ruleIds) {
      if (effectivenessScores[ruleId] !== undefined) {
        score = Math.max(score, effectivenessScores[ruleId]);
      }
    }
    return { path: p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  let tokensUsed = 0;
  const parts = [];
  const filesLoaded = [];

  for (const { path: filePath } of scored) {
    const absPath = filePath.startsWith('/') ? filePath : `${projectDir}/${filePath}`;
    if (!existsSync(absPath)) continue;

    const fileContent = readFileSync(absPath, 'utf8');
    const fileTokens = estimateTokens(fileContent);

    if (tokensUsed + fileTokens > budgetTokens) continue;

    parts.push(fileContent);
    tokensUsed += fileTokens;
    filesLoaded.push(filePath);
  }

  return { content: parts.join('\n\n---\n\n'), tokensUsed, filesLoaded };
}

// ---------------------------------------------------------------------------
// Session & Working Memory
// ---------------------------------------------------------------------------

function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`;
}

export function findActiveSession(paths) {
  if (!existsSync(paths.sessionsDir)) return null;

  const entries = readdirSync(paths.sessionsDir).filter(
    e => e !== 'archive' && !e.startsWith('.') &&
      statSync(`${paths.sessionsDir}/${e}`).isDirectory()
  );
  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    const ma = statSync(`${paths.sessionsDir}/${a}`).mtime.getTime();
    const mb = statSync(`${paths.sessionsDir}/${b}`).mtime.getTime();
    return mb - ma;
  });

  return entries[0];
}

export function loadWorkStatus(paths) {
  if (!existsSync(paths.workStatusFile)) return '';
  const content = readFileSync(paths.workStatusFile, 'utf8');
  const match = content.match(/## Active Work\n([\s\S]*?)(?=\n## |\n---|$)/);
  return match ? match[1].trim() : content.slice(0, 2000);
}

function isFirstTurn(sessionId) {
  const cacheDir = process.env.XDG_RUNTIME_DIR
    || join(process.env.HOME || '/tmp', '.cache', 'harness-harness');
  try { mkdirSync(cacheDir, { recursive: true }); } catch { /* exists */ }
  const markerPath = join(cacheDir, `session-${sessionId}`);
  if (existsSync(markerPath)) return false;
  try { writeFileSync(markerPath, new Date().toISOString()); } catch { /* non-fatal */ }
  return true;
}

function buildFirstTurnContext(paths) {
  const parts = ['**Session Restored** (first turn)'];

  try {
    const branch = execSync('git branch --show-current', { cwd: paths.projectDir, encoding: 'utf8', timeout: 5000 }).trim();
    parts.push(`**Branch:** ${branch}`);
  } catch { parts.push('**Branch:** unknown'); }

  try {
    const uncommitted = execSync('git status --porcelain', { cwd: paths.projectDir, encoding: 'utf8', timeout: 5000 });
    const count = uncommitted.split('\n').filter(l => l.trim()).length;
    if (count > 0) {
      parts.push(`**Uncommitted changes:** ${count} files`);
      parts.push(uncommitted.split('\n').filter(l => l.trim()).slice(0, 5).join('\n'));
    }
  } catch { /* non-fatal */ }

  try {
    const commits = execSync('git log --oneline -5', { cwd: paths.projectDir, encoding: 'utf8', timeout: 5000 }).trim();
    parts.push(`**Recent commits:**\n${commits}`);
  } catch { /* non-fatal */ }

  const workStatus = loadWorkStatus(paths);
  if (workStatus) parts.push(`**Active Work:**\n${workStatus}`);

  return parts.join('\n\n');
}

export function assembleWorkingMemory(intent, firstTurn, budgetTokens, paths) {
  const parts = [];
  let tokensUsed = 0;

  if (firstTurn) {
    const restoration = buildFirstTurnContext(paths);
    const restorationTokens = estimateTokens(restoration);
    if (tokensUsed + restorationTokens <= budgetTokens) {
      parts.push(restoration);
      tokensUsed += restorationTokens;
    }
  }

  const activeSession = findActiveSession(paths);
  if (activeSession) {
    const statePath = `${paths.sessionsDir}/${activeSession}/state.md`;
    if (existsSync(statePath)) {
      const state = readFileSync(statePath, 'utf8');
      const stateTokens = estimateTokens(state);
      if (tokensUsed + stateTokens <= budgetTokens) {
        parts.push(`**Session State** (${activeSession}):\n${state}`);
        tokensUsed += stateTokens;
      }
    }
  }

  if (!firstTurn) {
    const workStatus = loadWorkStatus(paths);
    if (workStatus) {
      const wsTokens = estimateTokens(workStatus);
      if (tokensUsed + wsTokens <= budgetTokens) {
        parts.push(`**Active Work:**\n${workStatus}`);
        tokensUsed += wsTokens;
      }
    }
  }

  return parts.length === 0 ? 'No working memory available.' : parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function extractSectionContent(section) {
  return section.replace(/^## .+\n?/, '').trim();
}

/**
 * Assemble the full context block.
 * @param {string} intent
 * @param {object} route - Parsed route config
 * @param {object} paths - From resolvePaths()
 * @param {string} [userMessage]
 * @param {Record<string, string[]>} [fileToRules] - Optional file→rule mapping
 */
export function assembleContext(intent, route, paths, userMessage = '', fileToRules = {}) {
  const sessionId = getSessionId();
  const effectivenessScores = loadEffectivenessScores(paths);

  const slotBudget = {
    identity: Math.floor(TOTAL_BUDGET_TOKENS * (route.budget.identity / 100)),
    route_context: Math.floor(TOTAL_BUDGET_TOKENS * (route.budget.route_context / 100)),
    working_memory: Math.floor(TOTAL_BUDGET_TOKENS * (route.budget.working_memory / 100)),
    traces: Math.floor(TOTAL_BUDGET_TOKENS * (route.budget.traces / 100)),
  };

  const manifestSlots = {
    identity: { tokens: 0, files: [] },
    route_context: { tokens: 0, files: [] },
    working_memory: { tokens: 0, files: [] },
    trace_insights: { tokens: 0, files: [] },
  };
  const rulesInjected = new Set();

  // --- Slot 1: Identity ---
  let identity = route.sections['Identity']
    ? extractSectionContent(route.sections['Identity'])
    : 'Project identity not configured. Run: harness-harness init';

  const identityTokens = estimateTokens(identity);
  if (identityTokens > slotBudget.identity) {
    identity = identity.slice(0, slotBudget.identity * 4);
  }
  manifestSlots.identity.tokens = estimateTokens(identity);

  // --- Slot 2: Route Context ---
  let routeRules = '';
  const routeContextFiles = [];
  const routeSection = route.sections['Route Context']
    ? extractSectionContent(route.sections['Route Context'])
    : '';

  if (routeSection) {
    routeRules = routeSection;
    routeContextFiles.push('route-config (inline rules)');

    const inlineRuleIds = routeSection.match(/\b[A-Z]{2,4}-\d{2,4}\b/g) || [];
    for (const id of inlineRuleIds) rulesInjected.add(id);

    const budgetPaths = extractLoadIfBudgetPaths(routeSection);
    if (budgetPaths.length > 0) {
      const inlineTokens = estimateTokens(routeRules);
      const remainingBudget = slotBudget.route_context - inlineTokens;
      if (remainingBudget > 0) {
        const loaded = loadFilesWithinBudget(budgetPaths, remainingBudget, effectivenessScores, paths.projectDir, fileToRules);
        if (loaded.content) {
          routeRules += `\n\n### Loaded Context Files (${loaded.filesLoaded.length} files, ~${loaded.tokensUsed} tokens)\n\n${loaded.content}`;
          routeContextFiles.push(...loaded.filesLoaded);
        }
      }
    }
  }
  manifestSlots.route_context.tokens = estimateTokens(routeRules);
  manifestSlots.route_context.files = routeContextFiles;

  // --- Slot 3: Working Memory ---
  const firstTurn = isFirstTurn(sessionId);
  const workingMemory = assembleWorkingMemory(intent, firstTurn, slotBudget.working_memory, paths);
  manifestSlots.working_memory.tokens = estimateTokens(workingMemory);

  // --- Slot 4: Trace Insights ---
  let traceInsights = loadTraceInsights(intent, paths);
  if (!traceInsights) traceInsights = 'No trace data available yet.';

  if (userMessage && /\b(wrong|mistake|error|incorrect|fix|actually)\b/i.test(userMessage)) {
    traceInsights += '\n\n**Learning Capture Triggered** — error keywords detected.\n'
      + 'If a mistake was made, record it so the harness can learn from it.';
  }

  const traceTokens = estimateTokens(traceInsights);
  if (traceTokens > slotBudget.traces) {
    traceInsights = traceInsights.slice(0, slotBudget.traces * 4);
  }
  manifestSlots.trace_insights.tokens = estimateTokens(traceInsights);

  // --- Calculate totals ---
  const allContent = [identity, routeRules, workingMemory, traceInsights].join('\n');
  const tokensUsed = estimateTokens(allContent);
  const budgetPercent = Math.round((tokensUsed / TOTAL_BUDGET_TOKENS) * 100);

  lastManifest = {
    session: sessionId,
    turn: null,
    intent,
    route: intent.replace(/:/g, '-'),
    slots: manifestSlots,
    total_tokens_injected: tokensUsed,
    budget_used_percent: budgetPercent,
    rules_injected: [...rulesInjected].sort(),
  };

  // --- Output ---
  const parts = [];
  parts.push(`<harness-context intent="${intent}" session="${sessionId}" budget-used="${budgetPercent}%">`);
  parts.push('');
  parts.push('<identity>');
  parts.push(identity);
  parts.push('</identity>');
  parts.push('');
  parts.push('<route-rules>');
  parts.push(routeRules);
  parts.push('</route-rules>');
  parts.push('');
  parts.push('<working-memory>');
  parts.push(workingMemory);
  parts.push('</working-memory>');
  parts.push('');
  parts.push('<trace-insights>');
  parts.push(traceInsights);
  parts.push('</trace-insights>');
  parts.push('');
  parts.push('<meta>');
  parts.push('If this context does not match your task, check your route configs in .harness/routes/');
  parts.push('</meta>');
  parts.push('');
  parts.push('</harness-context>');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main (when run as hook via stdin)
// ---------------------------------------------------------------------------

export async function main(projectDir) {
  const paths = resolvePaths(projectDir);
  let input = '';

  try {
    input = readFileSync('/dev/stdin', 'utf8');
  } catch {
    process.exit(1);
  }

  let message = input;
  try {
    const parsed = JSON.parse(input);
    if (parsed.prompt) message = parsed.prompt;
  } catch { /* raw text */ }

  if (!message || !message.trim()) process.exit(1);

  // Load config with team/developer merge
  let customIntents = [];
  let fileToRulesConfig = {};
  if (existsSync(paths.configFile)) {
    try {
      let config = JSON.parse(readFileSync(paths.configFile, 'utf8'));
      if (paths.localConfigFile && existsSync(paths.localConfigFile)) {
        const devConfig = JSON.parse(readFileSync(paths.localConfigFile, 'utf8'));
        config = mergeProjectConfigs(config, devConfig);
      }
      customIntents = config.customIntents || [];
      fileToRulesConfig = config.fileToRules || {};
    } catch { /* use defaults */ }
  }

  const intent = classifyIntent(message, customIntents);
  const route = loadRouteConfig(intent, paths);
  const fileToRules = fileToRulesConfig;
  const output = assembleContext(intent, route, paths, message, fileToRules);
  process.stdout.write(output);

  // Write manifest
  const manifest = getLastManifest();
  if (manifest) {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const manifestDir = paths.manifestDir(date);
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(`${manifestDir}/${manifest.session}-manifest.json`, JSON.stringify(manifest, null, 2));
    } catch { /* non-fatal */ }
  }

  // Write success marker
  try {
    const successDir = process.env.XDG_RUNTIME_DIR
      || join(process.env.HOME || '/tmp', '.cache', 'harness-harness');
    try { mkdirSync(successDir, { recursive: true }); } catch { /* exists */ }
    writeFileSync(join(successDir, 'assembler-success'), Date.now().toString());
  } catch { /* non-fatal */ }
}