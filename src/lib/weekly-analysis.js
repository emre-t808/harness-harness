/**
 * weekly-analysis.js — Weekly aggregation and proposal generation
 *
 * Reads session summaries, aggregates effectiveness scores per rule per route,
 * generates proposals (promote/demote/budget), and auto-applies safe reordering.
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from './paths.js';

// Thresholds
const PROMOTE_THRESHOLD = 0.75;
const DEMOTE_THRESHOLD = 0.10;
const UTILIZATION_HIGH = 70;
const UTILIZATION_LOW = 40;

// ---------------------------------------------------------------------------
// Summary parsing
// ---------------------------------------------------------------------------

export function parseSummary(content) {
  const routeMatch = content.match(/\*\*Route:\*\*\s*(.+)/);
  const route = routeMatch ? routeMatch[1].trim() : 'general';

  const tablePattern = /### Effectiveness Scores\n\n\|[^\n]+\n\|[-| ]+\n((?:\|[^\n]+\n)*)/;
  const tableMatch = content.match(tablePattern);

  if (!tableMatch) return null;

  const scores = [];
  const rowRe = /^\|\s*([A-Z]{2,4}-\d{2,4})\s*\|\s*([\d.]+)\s*\|\s*(.+?)\s*\|$/gm;
  let match;
  while ((match = rowRe.exec(tableMatch[1])) !== null) {
    scores.push({ rule: match[1], score: parseFloat(match[2]), evidence: match[3].trim() });
  }

  const slotUtilization = parseSlotUtilization(content);
  return { route, scores, slotUtilization };
}

export function parseSlotUtilization(content) {
  const utilPattern = /### Slot Utilization\n\n\|[^\n]+\n\|[-| ]+\n((?:\|[^\n]+\n)*)/;
  const utilMatch = content.match(utilPattern);
  if (!utilMatch) return null;

  const slots = {};
  let totalUtilization = 0;

  const slotRowRe = /^\|\s*\*?\*?(.+?)\*?\*?\s*\|\s*\*?\*?([\d,]+)\*?\*?\s*\|\s*\*?\*?([\d,]+)\*?\*?\s*\|\s*\*?\*?(\d+)%\*?\*?\s*\|$/gm;
  let slotMatch;
  while ((slotMatch = slotRowRe.exec(utilMatch[1])) !== null) {
    const name = slotMatch[1].trim().replace(/\*\*/g, '');
    const injected = parseInt(slotMatch[2].replace(/,/g, ''), 10);
    const referenced = parseInt(slotMatch[3].replace(/,/g, ''), 10);
    const utilization = parseInt(slotMatch[4], 10);
    if (name === 'Total') { totalUtilization = utilization; }
    else { slots[name] = { injected, referenced, utilization }; }
  }

  return Object.keys(slots).length > 0 ? { slots, totalUtilization } : null;
}

// ---------------------------------------------------------------------------
// Summary discovery
// ---------------------------------------------------------------------------

export function findRecentSummaries(days, paths) {
  const summaries = [];
  if (!fs.existsSync(paths.tracesDir)) return summaries;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const dateDirs = fs.readdirSync(paths.tracesDir).filter(d =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoffStr
  );

  for (const dateDir of dateDirs) {
    const dirPath = path.join(paths.tracesDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('-summary.md'));
    for (const f of files) {
      summaries.push(path.join(dirPath, f));
    }
  }

  return summaries.sort();
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function weightedAvg(totalWeightedScore, totalWeight) {
  return totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
}

export function aggregateScores(summaries) {
  const perRule = {};
  const perRoute = {};
  const midpoint = Math.floor(summaries.length / 2);

  for (let i = 0; i < summaries.length; i++) {
    const { route, scores, slotUtilization } = summaries[i];
    const weight = i >= midpoint ? 2 : 1;

    if (!perRoute[route]) {
      perRoute[route] = { sessionCount: 0, ruleScores: {}, utilization: { totalUtil: 0, count: 0, totalWasteTokens: 0 } };
    }
    perRoute[route].sessionCount++;

    if (slotUtilization) {
      perRoute[route].utilization.totalUtil += slotUtilization.totalUtilization;
      perRoute[route].utilization.count++;
      for (const slotData of Object.values(slotUtilization.slots)) {
        perRoute[route].utilization.totalWasteTokens += (slotData.injected - slotData.referenced);
      }
    }

    for (const { rule, score, evidence } of scores) {
      if (!perRule[rule]) {
        perRule[rule] = {
          totalWeightedScore: 0, totalWeight: 0,
          sessionsInjected: 0, timesReferenced: 0,
          routeScores: {}, hasPrevented: false,
        };
      }
      perRule[rule].totalWeightedScore += score * weight;
      perRule[rule].totalWeight += weight;
      perRule[rule].sessionsInjected++;
      if (score > 0) perRule[rule].timesReferenced++;
      if (evidence === 'prevented-mistake') perRule[rule].hasPrevented = true;

      if (!perRule[rule].routeScores[route]) {
        perRule[rule].routeScores[route] = { totalWeightedScore: 0, totalWeight: 0 };
      }
      perRule[rule].routeScores[route].totalWeightedScore += score * weight;
      perRule[rule].routeScores[route].totalWeight += weight;

      if (!perRoute[route].ruleScores[rule]) {
        perRoute[route].ruleScores[rule] = { totalWeightedScore: 0, totalWeight: 0 };
      }
      perRoute[route].ruleScores[rule].totalWeightedScore += score * weight;
      perRoute[route].ruleScores[rule].totalWeight += weight;
    }
  }

  return { perRule, perRoute };
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

export function generateProposals(aggregated, allRoutes) {
  const { perRule, perRoute } = aggregated;
  const promotions = [];
  const demotions = [];
  const budgetChanges = [];

  for (const [rule, data] of Object.entries(perRule)) {
    const avgScore = weightedAvg(data.totalWeightedScore, data.totalWeight);
    const routeAvgs = Object.entries(data.routeScores).map(([route, rd]) => ({
      route, avg: weightedAvg(rd.totalWeightedScore, rd.totalWeight),
    }));

    if (routeAvgs.length >= 2 && routeAvgs.every(r => r.avg >= PROMOTE_THRESHOLD)) {
      promotions.push({
        rule, avgScore,
        routes: routeAvgs.map(r => `${r.route} (${r.avg.toFixed(2)})`).join(', '),
        sessions: data.sessionsInjected,
      });
    }

    if (!data.hasPrevented) {
      for (const { route, avg } of routeAvgs) {
        if (avg < DEMOTE_THRESHOLD && data.sessionsInjected >= 3) {
          demotions.push({ rule, route, avgScore: avg, sessions: data.sessionsInjected });
        }
      }
    }
  }

  for (const [route, rd] of Object.entries(perRoute)) {
    if (rd.utilization.count < 2) continue;
    const avgUtil = Math.round(rd.utilization.totalUtil / rd.utilization.count);
    if (avgUtil > UTILIZATION_HIGH) {
      budgetChanges.push({ route, currentUtil: avgUtil, description: `utilization ${avgUtil}% → increase route_context by 5%`, direction: 'increase' });
    } else if (avgUtil < UTILIZATION_LOW) {
      budgetChanges.push({ route, currentUtil: avgUtil, description: `utilization ${avgUtil}% → decrease route_context by 5%`, direction: 'decrease' });
    }
  }

  return { promotions, demotions, budgetChanges };
}

// ---------------------------------------------------------------------------
// Auto-apply: reorder "Load If Budget Allows"
// ---------------------------------------------------------------------------

export function reorderLoadIfBudget(routeConfigPath, fileScores) {
  const content = fs.readFileSync(routeConfigPath, 'utf8');
  const sectionRe = /### Load If Budget Allows[^\n]*\n((?:- .+\n)*)/;
  const match = content.match(sectionRe);

  if (!match) return { changed: false, original: content, updated: content };

  const lines = match[1].split('\n').filter(l => l.startsWith('- '));
  if (lines.length <= 1) return { changed: false, original: content, updated: content };

  const scored = lines.map(line => {
    const pathMatch = line.match(/^- (.+\.md)\b/);
    const filePath = pathMatch ? pathMatch[1].trim().replace(/\s*\(.*$/, '') : '';
    const basename = filePath.split('/').pop() || '';
    const score = fileScores[filePath] ?? fileScores[basename] ?? 0;
    return { line, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const reordered = scored.map(s => s.line).join('\n') + '\n';

  if (reordered === match[1]) return { changed: false, original: content, updated: content };

  return { changed: true, original: content, updated: content.replace(match[1], reordered) };
}

// ---------------------------------------------------------------------------
// Trend computation
// ---------------------------------------------------------------------------

export function loadPreviousUtilization(paths) {
  if (!fs.existsSync(paths.effectivenessFile)) return {};
  const content = fs.readFileSync(paths.effectivenessFile, 'utf8');
  const utilMap = {};
  const rowRe = /^\|\s*(.+?)\s*\|\s*\d+\s*\|\s*(\d+)%\s*\|/gm;
  let match;
  while ((match = rowRe.exec(content)) !== null) {
    const route = match[1].trim();
    if (route !== 'Route' && !route.startsWith('---')) {
      utilMap[route] = parseInt(match[2], 10);
    }
  }
  return utilMap;
}

export function computeTrend(current, previous) {
  if (previous === undefined || previous === null) return '→';
  const diff = current - previous;
  if (diff > 10) return '↑';
  if (diff < -10) return '↓';
  return '→';
}

// ---------------------------------------------------------------------------
// Report formatters
// ---------------------------------------------------------------------------

export function formatEffectivenessReport(aggregated, summaryCount, allRoutes, days = 7, previousUtilization = {}) {
  const { perRule, perRoute } = aggregated;
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push('## Harness Effectiveness Scores');
  lines.push(`Last aggregated: ${today}`);
  lines.push(`Sessions analyzed: ${summaryCount} (past ${days} days)`);
  lines.push('');

  lines.push('### Weekly Summary');
  lines.push('| Route | Sessions | Avg Utilization | Trend | Top Rule | Worst Waste |');
  lines.push('|---|---|---|---|---|---|');

  for (const [route, rd] of Object.entries(perRoute)) {
    const ruleEntries = Object.entries(rd.ruleScores).map(([rule, rs]) => ({
      rule, avg: weightedAvg(rs.totalWeightedScore, rs.totalWeight),
    })).sort((a, b) => b.avg - a.avg);

    const topRule = ruleEntries[0] ? `${ruleEntries[0].rule} (${ruleEntries[0].avg.toFixed(2)})` : '—';
    const worstRules = ruleEntries.filter(r => r.avg === 0);
    let worstWaste = '—';
    if (worstRules.length > 0) {
      const wasteTokens = rd.utilization.count > 0 ? Math.round(rd.utilization.totalWasteTokens / rd.utilization.count) : 0;
      worstWaste = wasteTokens > 0 ? `${worstRules[0].rule} (0.0, ~${wasteTokens} tokens)` : `${worstRules[0].rule} (0.0)`;
    }

    let avgUtil;
    if (rd.utilization.count > 0) {
      avgUtil = Math.round(rd.utilization.totalUtil / rd.utilization.count);
    } else {
      avgUtil = ruleEntries.length > 0 ? Math.round(ruleEntries.filter(r => r.avg > 0).length / ruleEntries.length * 100) : 0;
    }

    const trend = computeTrend(avgUtil, previousUtilization[route]);
    lines.push(`| ${route} | ${rd.sessionCount} | ${avgUtil}% | ${trend} | ${topRule} | ${worstWaste} |`);
  }
  lines.push('');

  lines.push('### Per-Rule Scores');
  lines.push('| Rule | Sessions | Referenced | Avg Score | Top Route |');
  lines.push('|---|---|---|---|---|');

  const sortedRules = Object.entries(perRule).map(([rule, data]) => ({
    rule, avg: weightedAvg(data.totalWeightedScore, data.totalWeight), ...data,
  })).sort((a, b) => b.avg - a.avg);

  for (const r of sortedRules) {
    const routeAvgs = Object.entries(r.routeScores).map(([route, rs]) => ({
      route, avg: weightedAvg(rs.totalWeightedScore, rs.totalWeight),
    })).sort((a, b) => b.avg - a.avg);

    const topRoute = routeAvgs[0] ? `${routeAvgs[0].route} (${routeAvgs[0].avg.toFixed(2)})` : '—';
    lines.push(`| ${r.rule} | ${r.sessionsInjected} | ${r.timesReferenced} | ${r.avg.toFixed(2)} | ${topRoute} |`);
  }
  lines.push('');

  return lines.join('\n');
}

export function formatProposals(proposals) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push('## Proposed Adjustments');
  lines.push(`Generated: ${today}`);
  lines.push('Status: pending-review');
  lines.push('');

  if (proposals.promotions.length > 0) {
    lines.push('### Promotions');
    for (const p of proposals.promotions) {
      lines.push(`- ${p.rule} → Identity layer (all routes)`);
      lines.push(`  Evidence: ${p.avgScore.toFixed(2)} avg across ${p.sessions} sessions`);
      lines.push(`  Routes: ${p.routes}`);
      lines.push('  Status: pending');
    }
    lines.push('');
  }

  if (proposals.demotions.length > 0) {
    lines.push('### Demotions');
    for (const d of proposals.demotions) {
      lines.push(`- ${d.rule} → Skip in ${d.route}`);
      lines.push(`  Evidence: ${d.avgScore.toFixed(2)} avg across ${d.sessions} sessions`);
      lines.push('  Status: pending');
    }
    lines.push('');
  }

  if (proposals.budgetChanges.length > 0) {
    lines.push('### Budget Rebalancing');
    for (const b of proposals.budgetChanges) {
      lines.push(`- ${b.route}: ${b.description}`);
      lines.push('  Status: pending');
    }
    lines.push('');
  }

  if (!proposals.promotions.length && !proposals.demotions.length && !proposals.budgetChanges.length) {
    lines.push('No proposals generated — insufficient data or all scores within thresholds.');
    lines.push('');
  }

  return lines.join('\n');
}

export { PROMOTE_THRESHOLD, DEMOTE_THRESHOLD, UTILIZATION_HIGH, UTILIZATION_LOW, weightedAvg };
