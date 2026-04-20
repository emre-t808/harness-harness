/**
 * health command — Show effectiveness dashboard with governance state
 */

import fs from 'fs';
import { resolvePaths } from '../lib/paths.js';
import { findRecentSummaries, parseSummary, aggregateScores, loadPreviousUtilization } from '../lib/weekly-analysis.js';
import { loadGovernance, loadCooldownQueue } from '../lib/daily-check.js';

export async function health(projectDir, flags) {
  const paths = resolvePaths(projectDir);

  console.log('');
  console.log('  Harness Harness — Health Dashboard');
  console.log('');

  // Check initialization
  if (!fs.existsSync(paths.harnessDir)) {
    console.log('  Not initialized. Run: harness-harness init');
    return;
  }

  // Governance mode
  const governance = loadGovernance(paths);
  console.log(`  Governance: ${governance.mode} (cooldown: ${governance.cooldownHours}h)`);
  console.log('');

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

  // Cooldown queue
  const queue = loadCooldownQueue(paths);
  if (queue.length > 0) {
    console.log(`  In cooldown (auto-applies after ${governance.cooldownHours}h):`);
    for (const e of queue) {
      const hours = Math.max(0, Math.round((new Date(e.appliesAt) - Date.now()) / 3600000));
      console.log(`    ${e.rule}: ${hours}h remaining (score: ${e.avgScore.toFixed(2)}, ${e.sessions} sessions)`);
    }
    console.log('  Veto: harness-harness veto <RULE-ID>');
    console.log('');
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

  // Recent auto-applied changes
  if (fs.existsSync(paths.changelogFile)) {
    const content = fs.readFileSync(paths.changelogFile, 'utf8');
    const recent = content.split('\n').filter(l => l.startsWith('- ')).slice(-5);
    if (recent.length > 0) {
      console.log('');
      console.log('  Recent auto-applied changes:');
      for (const r of recent) {
        console.log(`  ${r}`);
      }
    }
  }

  // Route count
  if (fs.existsSync(paths.routesDir)) {
    const routeCount = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md')).length;
    console.log(`  Routes configured: ${routeCount}`);
  }

  console.log('');
}
