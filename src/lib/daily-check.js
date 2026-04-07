/**
 * daily-check.js — Automatic daily aggregation piggybacked on Stop hook
 *
 * After session-summary.js writes its summary, it calls runDailyCheckIfDue().
 * This checks whether 24 hours have passed since the last aggregation.
 * If yes, it runs the full analysis pipeline inline:
 *   1. Aggregate effectiveness scores (past 7 days)
 *   2. Generate proposals (promote/demote/budget)
 *   3. Auto-reorder route configs
 *   4. Clean up expired traces
 *   5. Write a notification for the next SessionStart
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
import { cleanupTraceFiles, trimIndex } from './trace-cleanup.js';
import { withFileLock } from './file-lock.js';

const AGGREGATION_INTERVAL_HOURS = 24;
const ANALYSIS_WINDOW_DAYS = 7;
const CLEANUP_RETENTION_DAYS = 30;
const INDEX_MAX_LINES = 500;

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

/**
 * Write a notification file for the next SessionStart hook to pick up.
 * Overwrites any previous notification (daily cycle).
 */
export function writeNotification(notificationsFile, proposalCount, sessionCount) {
  const today = new Date().toISOString().slice(0, 10);
  const developer = process.env.USER || process.env.USERNAME || 'unknown';
  const lines = ['## Harness Notifications', ''];

  if (proposalCount > 0) {
    lines.push(`- [${today}] Daily analysis by ${developer}: ${sessionCount} sessions analyzed, ${proposalCount} new proposal(s). Review with \`harness-harness health\``);
  } else {
    lines.push(`- [${today}] Daily analysis by ${developer}: ${sessionCount} sessions analyzed, all scores within thresholds.`);
  }
  lines.push('');

  fs.mkdirSync(path.dirname(notificationsFile), { recursive: true });
  fs.writeFileSync(notificationsFile, lines.join('\n'), 'utf8');
}

/**
 * Run the full aggregation + proposal + cleanup pipeline.
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

  // Format reports
  const previousUtil = loadPreviousUtilization(paths);
  const report = formatEffectivenessReport(aggregated, parsed.length, allRoutes, ANALYSIS_WINDOW_DAYS, previousUtil);
  const proposalReport = formatProposals(proposals);

  // Write effectiveness report to local (locked)
  const targetEffFile = paths.localEffectivenessFile || paths.effectivenessFile;
  fs.mkdirSync(path.dirname(targetEffFile), { recursive: true });
  withFileLock(targetEffFile, () => {
    fs.writeFileSync(targetEffFile, report, 'utf8');
  });

  // Write proposals to local (locked)
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

  // Auto-reorder route configs
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

  // Notification
  const totalProposals = proposals.promotions.length + proposals.demotions.length + proposals.budgetChanges.length;
  writeNotification(paths.localNotificationsFile || paths.notificationsFile, totalProposals, parsed.length);

  return {
    ran: true,
    sessionsAnalyzed: parsed.length,
    routes: allRoutes,
    proposals: totalProposals,
    reordered: reorderedCount,
    tracesCleaned: cleanupResult.deletedFiles,
  };
}

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

export { AGGREGATION_INTERVAL_HOURS, ANALYSIS_WINDOW_DAYS, CLEANUP_RETENTION_DAYS };
