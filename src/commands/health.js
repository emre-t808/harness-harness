/**
 * health command — Show effectiveness dashboard
 */

import fs from 'fs';
import { resolvePaths } from '../lib/paths.js';
import { findRecentSummaries, parseSummary, aggregateScores, computeTrend, loadPreviousUtilization } from '../lib/weekly-analysis.js';
import { readTraceIndex } from '../lib/federated-index.js';
import { computeStaleness, generateRecommendation } from '../lib/staleness.js';
import { detectFormats } from '../lib/ingestion/format-detect.js';
import { computeBloatScore, bloatRecommendation, bloatStatus } from '../lib/bloat-detector.js';
import { loadRuleRegistry } from '../lib/rule-registry.js';

export async function health(projectDir, flags) {
  const showAll = flags.includes('--all');
  const reposIdx = flags.indexOf('--repos');
  const reposFilter = reposIdx >= 0 && flags[reposIdx + 1]
    ? flags[reposIdx + 1].split(',').map(s => s.trim())
    : null;

  if (showAll || reposFilter) {
    return healthCrossRepo(reposFilter);
  }

  const paths = resolvePaths(projectDir);

  console.log('');
  console.log('  Harness Harness — Health Dashboard');
  console.log('');

  // Check initialization
  if (!fs.existsSync(paths.harnessDir)) {
    console.log('  Not initialized. Run: harness-harness init');
    return;
  }

  // Show effectiveness scores
  if (fs.existsSync(paths.effectivenessFile)) {
    const content = fs.readFileSync(paths.effectivenessFile, 'utf8');
    console.log(content);
  } else {
    console.log('  No effectiveness data yet.');
  }

  // Quick analysis of recent sessions
  const days = 7;
  const summaryPaths = findRecentSummaries(days, paths);
  console.log(`  Sessions in last ${days} days: ${summaryPaths.length}`);

  if (summaryPaths.length > 0) {
    const parsed = [];
    for (const sp of summaryPaths) {
      const result = parseSummary(fs.readFileSync(sp, 'utf8'));
      if (result && result.scores.length > 0) parsed.push(result);
    }

    if (parsed.length > 0) {
      const aggregated = aggregateScores(parsed);
      const allRoutes = [...new Set(parsed.map(p => p.route))];
      const previousUtil = loadPreviousUtilization(paths);

      console.log(`  Routes active: ${allRoutes.join(', ')}`);
      console.log('');

      // Top rules
      const topRules = Object.entries(aggregated.perRule)
        .map(([rule, data]) => ({ rule, avg: data.totalWeight > 0 ? data.totalWeightedScore / data.totalWeight : 0 }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 5);

      if (topRules.length > 0) {
        console.log('  Top Rules:');
        for (const r of topRules) {
          console.log(`    ${r.rule}: ${r.avg.toFixed(2)}`);
        }
        console.log('');
      }

      // Wasted rules
      const wastedRules = Object.entries(aggregated.perRule)
        .map(([rule, data]) => ({ rule, avg: data.totalWeight > 0 ? data.totalWeightedScore / data.totalWeight : 0 }))
        .filter(r => r.avg === 0)
        .slice(0, 5);

      if (wastedRules.length > 0) {
        console.log('  Wasted (never referenced):');
        for (const r of wastedRules) {
          console.log(`    ${r.rule}: 0.00`);
        }
        console.log('');
      }
    }
  }

  // Show pending proposals
  if (fs.existsSync(paths.overridesFile)) {
    const content = fs.readFileSync(paths.overridesFile, 'utf8');
    const pendingCount = (content.match(/Status: pending/g) || []).length;
    if (pendingCount > 0) {
      console.log(`  Pending proposals: ${pendingCount}`);
      console.log(`  Review: cat ${paths.overridesFile}`);
      console.log(`  Apply:  harness-harness apply`);
    } else {
      console.log('  No pending proposals.');
    }
  }

  // Route count
  if (fs.existsSync(paths.routesDir)) {
    const routeCount = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md')).length;
    console.log(`  Routes configured: ${routeCount}`);
  }

  // Phase 7: Context framework detection
  const formats = detectFormats(projectDir);
  if (formats.length > 0) {
    const frameworkNames = formats.filter(f => f.format !== 'native').map(f => {
      const count = f.paths.length;
      return `${f.format}${count > 1 ? ` (${count} files)` : ''}`;
    });
    if (frameworkNames.length > 0) {
      console.log(`  Context framework: ${frameworkNames.join(' + ')}`);
    } else {
      console.log('  Context framework: native .harness/ only');
    }
  }

  // Phase 7: Rule origin breakdown + bloat
  try {
    const registry = loadRuleRegistry(paths);
    if (registry.size > 0) {
      const originCounts = {};
      let totalAge = 0;
      let countedForAge = 0;

      for (const rule of registry.values()) {
        const origin = rule.origin || 'native';
        originCounts[origin] = (originCounts[origin] || 0) + 1;

        if (rule.created) {
          const ageDays = (Date.now() - new Date(rule.created).getTime()) / (1000 * 60 * 60 * 24);
          if (!isNaN(ageDays)) {
            totalAge += ageDays;
            countedForAge++;
          }
        }
      }

      let underperformingCount = 0;
      let ratingMean = 1500;
      let ratingStdDev = 0;

      try {
        const { loadRatingState, computePopulationStats } = await import('../lib/rule-rating.js');
        const ratingState = loadRatingState(paths);
        const popStats = computePopulationStats(ratingState);
        ratingMean = popStats.mean;
        ratingStdDev = popStats.std_dev;

        const threshold = ratingMean - ratingStdDev;
        for (const [ruleId, entry] of Object.entries(ratingState.rules || {})) {
          if ((entry.sessions_injected || 0) >= 5 && entry.rating < threshold) {
            underperformingCount++;
          }
        }

        if (popStats.count >= 5) {
          console.log(`  Rating distribution: mean=${Math.round(popStats.mean)}, σ=${Math.round(popStats.std_dev)}, n=${popStats.count}`);
          const topRated = Object.entries(ratingState.rules || {})
            .filter(([, e]) => (e.sessions_injected || 0) >= 3)
            .sort((a, b) => b[1].rating - a[1].rating)
            .slice(0, 3);
          if (topRated.length > 0) {
            console.log(`  Top rated: ${topRated.map(([id, e]) => `${id}(${Math.round(e.rating)})`).join(', ')}`);
          }
        }
      } catch { /* no rating state */ }

      const originBreakdown = Object.entries(originCounts)
        .map(([origin, count]) => `${count} from ${origin}`)
        .join(', ');
      console.log(`  Rules: ${registry.size} total (${originBreakdown})`);

      const avgAge = countedForAge > 0 ? totalAge / countedForAge : 0;
      const stats = {
        total_rules: registry.size,
        underperforming_rules: underperformingCount,
        avg_rule_age_days: avgAge,
        min_coverage_ratio: 1.0,
        rating_std_dev: ratingStdDev,
      };
      const score = computeBloatScore(stats);
      const statusLabel = bloatStatus(score);
      if (score >= 0.3) {
        console.log(`  Status: ${statusLabel} (bloat score: ${score})`);
        const rec = bloatRecommendation(stats, score);
        if (rec) console.log(`  ${rec}`);
      }
    }
  } catch { /* non-fatal */ }

  console.log('');
}

async function healthCrossRepo(reposFilter) {
  const repos = readTraceIndex();
  if (repos.length === 0) {
    console.log('');
    console.log('  No repos in federated index.');
    console.log('  Register repos: harness-harness register --scan <dir>');
    console.log('');
    return;
  }

  const filtered = reposFilter
    ? repos.filter(r => reposFilter.some(f => r.name.includes(f)))
    : repos;

  const scored = filtered.map(r => ({
    ...r,
    staleness_score: computeStaleness(r),
    recommendation: generateRecommendation({ ...r, staleness_score: computeStaleness(r) }),
  }));
  scored.sort((a, b) => a.staleness_score - b.staleness_score);

  const activeCount = scored.filter(r => (r.sessions_7d || 0) > 0).length;

  console.log('');
  console.log(`  Harness Health — All Repos (${scored.length} registered, ${activeCount} active this week)`);
  console.log(`  Last indexed: ${scored[0]?.last_indexed || 'never'}`);
  console.log('');

  const nameWidth = Math.max(20, ...scored.map(r => r.name.length)) + 2;
  console.log(
    '  ' + 'Repo'.padEnd(nameWidth) +
    'Sessions'.padStart(10) +
    'Effectiveness'.padStart(15) +
    'Staleness'.padStart(11) +
    '  Status'
  );

  for (const r of scored) {
    const staleness = r.staleness_score;
    let status;
    if (staleness < 0.2) status = '[HEALTHY]';
    else if (staleness < 0.5) status = '[NEEDS ATTENTION]';
    else if (staleness < 0.8) status = '[STALE]';
    else status = '[CRITICAL]';

    console.log(
      '  ' + r.name.padEnd(nameWidth) +
      String(r.sessions_7d || 0).padStart(10) +
      String(r.avg_effectiveness || 0).padStart(15) +
      String(staleness.toFixed(2)).padStart(11) +
      '  ' + status
    );
  }

  const needsAttention = scored.filter(r => r.recommendation);
  if (needsAttention.length > 0) {
    console.log('');
    console.log('  Recommendations:');
    for (const r of needsAttention) {
      console.log(`    ${r.name}: ${r.recommendation}`);
    }
  }

  console.log('');
}
