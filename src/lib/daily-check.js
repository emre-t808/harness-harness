/**
 * daily-check.js — Automatic daily aggregation with graduated auto-governance
 *
 * After session-summary.js writes its summary, it calls runDailyCheckIfDue().
 * This checks whether 24 hours have passed since the last aggregation.
 * If yes, it runs the full analysis + auto-apply pipeline:
 *   1. Aggregate effectiveness scores (past 7 days)
 *   2. Generate proposals (promote/demote/budget)
 *   3. Auto-apply safe changes based on governance tier
 *   4. Queue risky changes in cooldown
 *   5. Process matured cooldown entries
 *   6. Log all changes to changelog.md
 *   7. Auto-reorder route configs
 *   8. Clean up expired traces
 *   9. Write notification with change digest
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from './paths.js';
import {
  findRecentSummaries, parseSummary, aggregateScores,
  generateProposals, reorderLoadIfBudget,
  loadPreviousUtilization,
  formatEffectivenessReport, formatProposals,
} from './weekly-analysis.js';
import { applyDemotion, applyPromotion, applyBudgetChange, parseBudgetDescription } from './apply-overrides.js';
import { cleanupTraceFiles, trimIndex } from './trace-cleanup.js';
import { withFileLock } from './file-lock.js';

const AGGREGATION_INTERVAL_HOURS = 24;
const ANALYSIS_WINDOW_DAYS = 7;
const CLEANUP_RETENTION_DAYS = 30;
const INDEX_MAX_LINES = 500;

// ---------------------------------------------------------------------------
// Governance config
// ---------------------------------------------------------------------------

const DEFAULT_GOVERNANCE = {
  mode: 'auto',
  cooldownHours: 48,
  minSessions: {
    demote: 5,
    budgetRebalance: 3,
    promoteMustLoad: 8,
    promoteIdentity: 10,
  },
  protectPrevented: true,
};

export function loadGovernance(paths) {
  let governance = { ...DEFAULT_GOVERNANCE, minSessions: { ...DEFAULT_GOVERNANCE.minSessions } };

  // Team config
  if (fs.existsSync(paths.configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
      if (config.governance) {
        const g = config.governance;
        if (g.mode) governance.mode = g.mode;
        if (g.cooldownHours !== undefined) governance.cooldownHours = g.cooldownHours;
        if (g.protectPrevented !== undefined) governance.protectPrevented = g.protectPrevented;
        if (g.minSessions) governance.minSessions = { ...governance.minSessions, ...g.minSessions };
      }
    } catch { /* use defaults */ }
  }

  // Developer override (local config wins)
  if (paths.localConfigFile && fs.existsSync(paths.localConfigFile)) {
    try {
      const local = JSON.parse(fs.readFileSync(paths.localConfigFile, 'utf8'));
      if (local.governance) {
        const g = local.governance;
        if (g.mode) governance.mode = g.mode;
        if (g.cooldownHours !== undefined) governance.cooldownHours = g.cooldownHours;
        if (g.protectPrevented !== undefined) governance.protectPrevented = g.protectPrevented;
        if (g.minSessions) governance.minSessions = { ...governance.minSessions, ...g.minSessions };
      }
    } catch { /* use defaults */ }
  }

  return governance;
}

// ---------------------------------------------------------------------------
// Cooldown queue
// ---------------------------------------------------------------------------

export function loadCooldownQueue(paths) {
  if (!paths.cooldownFile || !fs.existsSync(paths.cooldownFile)) return [];
  try { return JSON.parse(fs.readFileSync(paths.cooldownFile, 'utf8')); }
  catch { return []; }
}

function saveCooldownQueue(paths, queue) {
  fs.mkdirSync(path.dirname(paths.cooldownFile), { recursive: true });
  fs.writeFileSync(paths.cooldownFile, JSON.stringify(queue, null, 2), 'utf8');
}

export function appendCooldownEntry(paths, proposal, cooldownHours) {
  const queue = loadCooldownQueue(paths);
  if (queue.some(e => e.rule === proposal.rule)) return; // no duplicates
  queue.push({
    rule: proposal.rule,
    avgScore: proposal.avgScore,
    sessions: proposal.sessions,
    routes: proposal.routes,
    proposedAt: new Date().toISOString(),
    appliesAt: new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString(),
  });
  saveCooldownQueue(paths, queue);
}

export function processCooldownQueue(paths) {
  const queue = loadCooldownQueue(paths);
  if (queue.length === 0) return [];
  const now = new Date();
  const matured = queue.filter(e => new Date(e.appliesAt) <= now);
  const remaining = queue.filter(e => new Date(e.appliesAt) > now);
  if (matured.length > 0) {
    saveCooldownQueue(paths, remaining);
  }
  return matured;
}

export function vetoCooldownEntry(paths, ruleId) {
  const queue = loadCooldownQueue(paths);
  const filtered = queue.filter(e => e.rule !== ruleId);
  if (filtered.length === queue.length) return false; // not found
  saveCooldownQueue(paths, filtered);
  return true;
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

export function appendChangelog(changelogFile, entries) {
  const today = new Date().toISOString().slice(0, 10);
  const developer = process.env.USER || process.env.USERNAME || 'auto';
  const lines = [];
  for (const entry of entries) {
    lines.push(`- [${today}] ${entry.action}: ${entry.rule} in ${entry.route || 'all routes'} (${entry.reason}) — by ${developer}`);
  }
  fs.mkdirSync(path.dirname(changelogFile), { recursive: true });
  const existing = fs.existsSync(changelogFile)
    ? fs.readFileSync(changelogFile, 'utf8')
    : '## Harness Changelog\n\nAll auto-applied changes are logged here.\n\n';
  fs.writeFileSync(changelogFile, existing + lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Last aggregation date
// ---------------------------------------------------------------------------

/**
 * Parse the "Last aggregated: YYYY-MM-DD" line from the effectiveness file.
 * Returns a Date or null if missing/unparseable.
 */
export function getLastAggregationDate(effectivenessFile) {
  if (!fs.existsSync(effectivenessFile)) return null;
  const content = fs.readFileSync(effectivenessFile, 'utf8');
  const match = content.match(/Last aggregated:\s*(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const date = new Date(match[1] + 'T00:00:00Z');
  return isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Write a notification file for the next SessionStart hook to pick up.
 * Now includes auto-applied change digest.
 */
export function writeNotification(notificationsFile, proposalCount, sessionCount, autoApplied = [], cooldownCount = 0) {
  const today = new Date().toISOString().slice(0, 10);
  const developer = process.env.USER || process.env.USERNAME || 'unknown';
  const lines = ['## Harness Notifications', ''];

  if (autoApplied.length > 0) {
    lines.push(`- [${today}] Auto-applied ${autoApplied.length} change(s):`);
    for (const a of autoApplied) {
      lines.push(`  - ${a.action}: ${a.rule} (${a.reason})`);
    }
  }

  if (cooldownCount > 0) {
    lines.push(`- [${today}] ${cooldownCount} promotion(s) in cooldown. Veto with \`harness-harness veto <RULE-ID>\``);
  }

  if (proposalCount > 0 && autoApplied.length === 0 && cooldownCount === 0) {
    lines.push(`- [${today}] Daily analysis by ${developer}: ${sessionCount} sessions analyzed, ${proposalCount} new proposal(s). Review with \`harness-harness health\``);
  }

  if (autoApplied.length === 0 && proposalCount === 0 && cooldownCount === 0) {
    lines.push(`- [${today}] Daily analysis by ${developer}: ${sessionCount} sessions analyzed, all scores within thresholds.`);
  }

  lines.push('');
  fs.mkdirSync(path.dirname(notificationsFile), { recursive: true });
  fs.writeFileSync(notificationsFile, lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Auto-governance engine
// ---------------------------------------------------------------------------

function runAutoGovernance(proposals, governance, paths, parsedCount) {
  const autoApplied = [];

  // T1: Budget rebalances — apply immediately
  for (const b of proposals.budgetChanges) {
    if (parsedCount >= governance.minSessions.budgetRebalance) {
      const routeFile = path.join(paths.routesDir, b.route.replace(/:/g, '-') + '.md');
      if (fs.existsSync(routeFile)) {
        const newBudget = parseBudgetDescription(routeFile, b.description);
        if (newBudget) {
          const result = applyBudgetChange(routeFile, newBudget);
          if (result.changed) {
            autoApplied.push({ action: 'budget-rebalance', rule: b.route, route: b.route, reason: b.description });
          }
        }
      }
    }
  }

  // T2: Demotions — apply immediately if enough sessions
  for (const d of proposals.demotions) {
    if (d.sessions >= governance.minSessions.demote) {
      const routeFile = path.join(paths.routesDir, d.route.replace(/:/g, '-') + '.md');
      if (fs.existsSync(routeFile)) {
        const result = applyDemotion(routeFile, d.rule);
        if (result.changed) {
          autoApplied.push({ action: 'demote', rule: d.rule, route: d.route, reason: `${d.avgScore.toFixed(2)} avg across ${d.sessions} sessions` });
        }
      }
    }
  }

  // T3/T4: Promotions — queue with cooldown
  for (const p of proposals.promotions) {
    if (p.sessions >= governance.minSessions.promoteIdentity) {
      appendCooldownEntry(paths, p, governance.cooldownHours);
    }
  }

  // Process matured cooldown entries
  const matured = processCooldownQueue(paths);
  for (const entry of matured) {
    const result = applyPromotion(entry.rule, paths);
    if (result.changed) {
      autoApplied.push({
        action: 'promote-identity',
        rule: entry.rule,
        route: 'all routes',
        reason: `${entry.avgScore.toFixed(2)} avg across ${entry.sessions} sessions, cooldown expired`,
      });
    }
  }

  // Log all auto-applied changes
  if (autoApplied.length > 0) {
    appendChangelog(paths.changelogFile, autoApplied);
  }

  return autoApplied;
}

// ---------------------------------------------------------------------------
// Main aggregation pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full aggregation + proposal + auto-apply + cleanup pipeline.
 * Called only when the check determines it's due.
 */
export function runAggregation(paths) {
  const summaryPaths = findRecentSummaries(ANALYSIS_WINDOW_DAYS, paths);
  if (summaryPaths.length === 0) return { ran: false, reason: 'no-summaries' };

  const parsed = [];
  for (const sp of summaryPaths) {
    const result = parseSummary(fs.readFileSync(sp, 'utf8'));
    if (result && result.scores.length > 0) parsed.push(result);
  }
  if (parsed.length === 0) return { ran: false, reason: 'no-effectiveness-data' };

  // Aggregate
  const aggregated = aggregateScores(parsed);
  const allRoutes = [...new Set(parsed.map(p => p.route))].sort();
  const proposals = generateProposals(aggregated, allRoutes);

  // Load governance config
  const governance = loadGovernance(paths);

  // Auto-governance: apply safe changes, queue risky ones
  let autoApplied = [];
  if (governance.mode === 'auto') {
    autoApplied = runAutoGovernance(proposals, governance, paths, parsed.length);
  }

  // Format reports (always, regardless of governance mode)
  const previousUtil = loadPreviousUtilization(paths);
  const report = formatEffectivenessReport(aggregated, parsed.length, allRoutes, ANALYSIS_WINDOW_DAYS, previousUtil);
  const proposalReport = formatProposals(proposals);

  // Write effectiveness report to local (locked)
  const targetEffFile = paths.localEffectivenessFile || paths.effectivenessFile;
  fs.mkdirSync(path.dirname(targetEffFile), { recursive: true });
  withFileLock(targetEffFile, () => {
    fs.writeFileSync(targetEffFile, report, 'utf8');
  });

  // Write proposals to local (locked) — even in auto mode, for audit trail
  const targetOverFile = paths.localOverridesFile || paths.overridesFile;
  fs.mkdirSync(path.dirname(targetOverFile), { recursive: true });
  withFileLock(targetOverFile, () => {
    const existing = fs.existsSync(targetOverFile) ? fs.readFileSync(targetOverFile, 'utf8') : '';
    if (!existing || existing.includes('No proposals yet') || existing.includes('no proposals yet')) {
      fs.writeFileSync(targetOverFile, proposalReport, 'utf8');
    } else {
      fs.appendFileSync(targetOverFile, '\n' + proposalReport, 'utf8');
    }
  });

  // Auto-reorder route configs (T0 — always runs)
  let reorderedCount = 0;
  if (fs.existsSync(paths.routesDir)) {
    const fileScores = {};
    for (const [rule, data] of Object.entries(aggregated.perRule)) {
      const avg = data.totalWeight > 0 ? data.totalWeightedScore / data.totalWeight : 0;
      fileScores[rule] = avg;
    }

    const routeConfigs = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md'));
    for (const rc of routeConfigs) {
      const rcPath = path.join(paths.routesDir, rc);
      const result = reorderLoadIfBudget(rcPath, fileScores);
      if (result.changed) {
        fs.writeFileSync(rcPath, result.updated, 'utf8');
        reorderedCount++;
      }
    }
  }

  // Trace cleanup
  const cleanupResult = cleanupTraceFiles(paths.tracesDir, CLEANUP_RETENTION_DAYS);
  trimIndex(paths.traceIndex, INDEX_MAX_LINES);

  // Notification with change digest
  const totalProposals = proposals.promotions.length + proposals.demotions.length + proposals.budgetChanges.length;
  const cooldownQueue = loadCooldownQueue(paths);
  writeNotification(
    paths.localNotificationsFile || paths.notificationsFile,
    totalProposals,
    parsed.length,
    autoApplied,
    cooldownQueue.length,
  );

  return {
    ran: true,
    sessionsAnalyzed: parsed.length,
    routes: allRoutes,
    proposals: totalProposals,
    autoApplied: autoApplied.length,
    cooldownPending: cooldownQueue.length,
    reordered: reorderedCount,
    tracesCleaned: cleanupResult.deletedFiles,
    governanceMode: governance.mode,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Entry point: check if daily aggregation is due, run if so.
 * Safe to call on every Stop hook — exits early if not due.
 */
export async function runDailyCheckIfDue(projectDir) {
  const paths = resolvePaths(projectDir);

  if (!fs.existsSync(paths.harnessDir)) return { ran: false, reason: 'not-initialized' };

  const lastDate = getLastAggregationDate(paths.effectivenessFile);
  const hoursSince = lastDate
    ? (Date.now() - lastDate.getTime()) / (1000 * 60 * 60)
    : Infinity;

  if (hoursSince < AGGREGATION_INTERVAL_HOURS) {
    return { ran: false, reason: 'not-due', hoursSince: Math.round(hoursSince) };
  }

  return runAggregation(paths);
}

export { AGGREGATION_INTERVAL_HOURS, ANALYSIS_WINDOW_DAYS, CLEANUP_RETENTION_DAYS, DEFAULT_GOVERNANCE };
