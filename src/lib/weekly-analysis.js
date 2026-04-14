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
// Phase 8: absolute constants are now fallbacks; primary decisions are Elo-anchored.
const FALLBACK_PROMOTE_THRESHOLD = 0.75;
const FALLBACK_DEMOTE_THRESHOLD = 0.10;
const MIN_POPULATION_FOR_ELO_THRESHOLDS = 10;
const MIN_SESSIONS_FOR_ELO_DECISION = 5;
// Back-compat exports (kept for any external callers of the legacy names)
const PROMOTE_THRESHOLD = FALLBACK_PROMOTE_THRESHOLD;
const DEMOTE_THRESHOLD = FALLBACK_DEMOTE_THRESHOLD;
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
  const rowRe = /^\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*(.+?)\s*\|$/gm;
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
  const _perSessionScores = [];  // Phase 7: per-session detail for Elo
  const midpoint = Math.floor(summaries.length / 2);

  for (let i = 0; i < summaries.length; i++) {
    const { route, scores, slotUtilization } = summaries[i];
    const weight = i >= midpoint ? 2 : 1;

    _perSessionScores.push(scores.map(s => ({
      ruleId: s.rule,
      evidence: s.evidence,
      score: s.score,
    })));

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
          hasBehavioralCompliance: false,  // Phase 7
        };
      }
      perRule[rule].totalWeightedScore += score * weight;
      perRule[rule].totalWeight += weight;
      perRule[rule].sessionsInjected++;
      if (score > 0) perRule[rule].timesReferenced++;
      if (evidence === 'prevented-mistake') perRule[rule].hasPrevented = true;
      if (evidence === 'behavioral-compliance' || evidence === 'verified-compliance' || evidence === 'content-verified') {
        perRule[rule].hasBehavioralCompliance = true;
      }

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

  return { perRule, perRoute, _perSessionScores };
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

export function generateProposals(aggregated, allRoutes, propagationState = {}, ratingState = null) {
  const { perRule, perRoute } = aggregated;
  const promotions = [];
  const demotions = [];
  const budgetChanges = [];
  const propagations = [];  // Phase 7

  // Population stats from Elo ratings (if available)
  let ratingMean = 1500;
  let ratingStdDev = 0;
  if (ratingState) {
    try {
      // Lazy import to avoid circular deps
      // Using dynamic import pattern — but generateProposals is sync, so compute inline.
      const ratings = Object.values(ratingState.rules || {})
        .filter(entry => (entry.sessions_injected || 0) >= 3)
        .map(entry => entry.rating);
      if (ratings.length > 0) {
        ratingMean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        const variance = ratings.reduce((sum, r) => sum + Math.pow(r - ratingMean, 2), 0) / ratings.length;
        ratingStdDev = Math.sqrt(variance);
      }
    } catch { /* use defaults */ }
  }

  const PROPAGATION_RATING_THRESHOLD = ratingMean + ratingStdDev;
  const PROPAGATION_MIN_SESSIONS = 10;
  const PROPAGATION_WEEKS_REQUIRED = 2;

  // Phase 8: Elo-anchored promote/demote thresholds (with small-pop fallback)
  const popRatings = Object.values(ratingState?.rules || {})
    .filter(e => (e.sessions_injected || 0) >= 3);
  const useEloThresholds = popRatings.length >= MIN_POPULATION_FOR_ELO_THRESHOLDS && ratingStdDev > 0;
  const eloPromoteRating = ratingMean + 0.5 * ratingStdDev;
  const eloDemoteRating = ratingMean - 1.0 * ratingStdDev;

  const newPropagationState = {};

  for (const [rule, data] of Object.entries(perRule)) {
    const avgScore = weightedAvg(data.totalWeightedScore, data.totalWeight);
    const routeAvgs = Object.entries(data.routeScores).map(([route, rd]) => ({
      route, avg: weightedAvg(rd.totalWeightedScore, rd.totalWeight),
    }));

    const ruleRatingEntry = ratingState?.rules?.[rule];
    const ruleRating = ruleRatingEntry?.rating ?? 1500;
    const ruleSessions = ruleRatingEntry?.sessions_injected ?? 0;

    // Promote
    const promoteEligible = useEloThresholds
      ? (ruleRating >= eloPromoteRating && ruleSessions >= MIN_SESSIONS_FOR_ELO_DECISION)
      : (routeAvgs.length >= 2 && routeAvgs.every(r => r.avg >= FALLBACK_PROMOTE_THRESHOLD));

    if (promoteEligible) {
      promotions.push({
        rule, avgScore,
        rating: useEloThresholds ? Math.round(ruleRating) : undefined,
        threshold: useEloThresholds ? Math.round(eloPromoteRating) : FALLBACK_PROMOTE_THRESHOLD,
        routes: routeAvgs.map(r => `${r.route} (${r.avg.toFixed(2)})`).join(', '),
        sessions: data.sessionsInjected,
      });
    }

    // Demote (safety exclusions: prevented-mistake + behavioral-compliance + content-verified)
    if (!data.hasPrevented && !data.hasBehavioralCompliance) {
      if (useEloThresholds) {
        if (ruleRating < eloDemoteRating && ruleSessions >= MIN_SESSIONS_FOR_ELO_DECISION) {
          for (const { route, avg } of routeAvgs) {
            demotions.push({
              rule, route, avgScore: avg,
              rating: Math.round(ruleRating),
              sessions: data.sessionsInjected,
            });
          }
        }
      } else {
        for (const { route, avg } of routeAvgs) {
          if (avg < FALLBACK_DEMOTE_THRESHOLD && data.sessionsInjected >= 3) {
            demotions.push({ rule, route, avgScore: avg, sessions: data.sessionsInjected });
          }
        }
      }
    }

    // Phase 7: propagation eligibility
    const ratingEntry = ratingState?.rules?.[rule];
    const currentRating = ratingEntry?.rating ?? 1500;
    const sessionsInjected = ratingEntry?.sessions_injected ?? 0;

    const ratingAboveThreshold = ratingStdDev > 0 && currentRating >= PROPAGATION_RATING_THRESHOLD;
    const hasEnoughSessions = sessionsInjected >= PROPAGATION_MIN_SESSIONS;

    const prevState = propagationState.rules?.[rule] || { weeks_above_threshold: 0 };
    const weeksNow = ratingAboveThreshold
      ? (prevState.weeks_above_threshold || 0) + 1
      : Math.max(0, (prevState.weeks_above_threshold || 0) - 1);

    newPropagationState[rule] = {
      weeks_above_threshold: weeksNow,
      last_rating: Math.round(currentRating),
      last_score: avgScore,
      last_routes: routeAvgs.map(r => r.route),
    };

    const eligibleByRating = ratingAboveThreshold && hasEnoughSessions && weeksNow >= PROPAGATION_WEEKS_REQUIRED;
    const eligibleBySafety = data.hasPrevented;
    const eligibleByFastTrack = ratingAboveThreshold && ratingStdDev > 0 &&
      currentRating >= (ratingMean + 2 * ratingStdDev) && sessionsInjected >= 5;

    if (eligibleByRating || eligibleBySafety || eligibleByFastTrack) {
      const reason = eligibleBySafety ? 'safety-rule'
        : eligibleByFastTrack ? 'fast-track-exceptional-rating'
        : 'sustained-high-rating';

      propagations.push({
        rule,
        avgScore,
        rating: Math.round(currentRating),
        pool_mean: Math.round(ratingMean),
        pool_std_dev: Math.round(ratingStdDev),
        routes: routeAvgs.map(r => r.route),
        weeksAboveThreshold: weeksNow,
        sessionsInjected,
        reason,
      });
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

  return {
    promotions, demotions, budgetChanges, propagations,
    propagationState: newPropagationState,
    usedEloThresholds: useEloThresholds,
    ratingPopulation: { mean: Math.round(ratingMean), std_dev: Math.round(ratingStdDev), count: popRatings.length },
  };
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
  const developer = process.env.USER || process.env.USERNAME || 'unknown';
  const lines = [];

  lines.push('## Proposed Adjustments');
  lines.push(`Generated: ${today}`);
  lines.push('Status: pending-review');
  if (proposals.usedEloThresholds) {
    const pop = proposals.ratingPopulation || {};
    lines.push(`_Thresholds: Elo-anchored (promote ≥ mean + 0.5σ, demote < mean − σ; pool mean=${pop.mean}, σ=${pop.std_dev}, n=${pop.count})_`);
  } else {
    lines.push(`_Thresholds: absolute fallback (promote ≥ ${FALLBACK_PROMOTE_THRESHOLD}, demote < ${FALLBACK_DEMOTE_THRESHOLD}) — rating population < ${MIN_POPULATION_FOR_ELO_THRESHOLDS} rules_`);
  }
  lines.push('');

  if (proposals.promotions.length > 0) {
    lines.push('### Promotions');
    for (const p of proposals.promotions) {
      lines.push(`- ${p.rule} → Identity layer (all routes)`);
      lines.push(`  Evidence: ${p.avgScore.toFixed(2)} avg across ${p.sessions ?? '?'} sessions`);
      lines.push(`  Routes: ${p.routes}`);
      lines.push('  Status: pending');
      lines.push(`  Proposed by: ${developer} (${today})`);
    }
    lines.push('');
  }

  if (proposals.demotions.length > 0) {
    lines.push('### Demotions');
    for (const d of proposals.demotions) {
      lines.push(`- ${d.rule} → Skip in ${d.route}`);
      lines.push(`  Evidence: ${d.avgScore.toFixed(2)} avg across ${d.sessions ?? '?'} sessions`);
      lines.push('  Status: pending');
      lines.push(`  Proposed by: ${developer} (${today})`);
    }
    lines.push('');
  }

  if (proposals.budgetChanges.length > 0) {
    lines.push('### Budget Rebalancing');
    for (const b of proposals.budgetChanges) {
      lines.push(`- ${b.route}: ${b.description}`);
      lines.push('  Status: pending');
      lines.push(`  Proposed by: ${developer} (${today})`);
    }
    lines.push('');
  }

  if (proposals.propagations && proposals.propagations.length > 0) {
    lines.push('### Propagation Suggestions');
    lines.push('');
    for (const p of proposals.propagations) {
      lines.push(`- ${p.rule} → propagate to repos with matching routes`);
      lines.push(`  Rating: ${p.rating} (pool mean: ${p.pool_mean}, σ: ${p.pool_std_dev})`);
      lines.push(`  Evidence: ${p.avgScore.toFixed(2)} avg across ${p.sessionsInjected} sessions`);
      lines.push(`  Weeks above threshold: ${p.weeksAboveThreshold}`);
      lines.push(`  Reason: ${p.reason}`);
      lines.push(`  Routes: ${(p.routes || []).join(', ')}`);
      lines.push('  Status: pending');
      lines.push(`  Proposed by: ${developer} (${today})`);
      lines.push('');
    }
  }

  if (!proposals.promotions.length && !proposals.demotions.length && !proposals.budgetChanges.length && !(proposals.propagations && proposals.propagations.length)) {
    lines.push('No proposals generated — insufficient data or all scores within thresholds.');
    lines.push('');
  }

  return lines.join('\n');
}

export { PROMOTE_THRESHOLD, DEMOTE_THRESHOLD, UTILIZATION_HIGH, UTILIZATION_LOW, weightedAvg };
