/**
 * analyze command — Run weekly effectiveness analysis on-demand
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../lib/paths.js';
import {
  findRecentSummaries, parseSummary, aggregateScores,
  generateProposals, reorderLoadIfBudget,
  loadPreviousUtilization,
  formatEffectivenessReport, formatProposals,
} from '../lib/weekly-analysis.js';

export async function analyze(projectDir, flags) {
  const paths = resolvePaths(projectDir);
  const dryRun = flags.includes('--dry-run');
  const daysIdx = flags.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(flags[daysIdx + 1], 10) : 7;

  console.log(`Harness Harness — Analyze (${dryRun ? 'DRY RUN' : 'live'}, ${days}-day window)`);
  console.log('');

  if (!fs.existsSync(paths.harnessDir)) {
    console.log('Not initialized. Run: harness-harness init');
    return;
  }

  // 1. Find summaries
  const summaryPaths = findRecentSummaries(days, paths);
  console.log(`Found ${summaryPaths.length} session summaries`);

  if (summaryPaths.length === 0) {
    console.log('No summaries to analyze.');
    return;
  }

  // 2. Parse
  const parsed = [];
  for (const sp of summaryPaths) {
    const result = parseSummary(fs.readFileSync(sp, 'utf8'));
    if (result && result.scores.length > 0) parsed.push(result);
  }
  console.log(`Parsed ${parsed.length} with effectiveness data`);

  if (parsed.length === 0) {
    console.log('No effectiveness data found.');
    return;
  }

  // 3. Aggregate
  const aggregated = aggregateScores(parsed);
  const allRoutes = [...new Set(parsed.map(p => p.route))].sort();
  console.log(`Routes: ${allRoutes.join(', ')}`);

  // 4. Proposals
  const proposals = generateProposals(aggregated, allRoutes);
  console.log(`Proposals: ${proposals.promotions.length} promotions, ${proposals.demotions.length} demotions`);

  // 5. Format
  const previousUtil = loadPreviousUtilization(paths);
  const report = formatEffectivenessReport(aggregated, parsed.length, allRoutes, days, previousUtil);
  const proposalReport = formatProposals(proposals);

  if (dryRun) {
    console.log('\n--- Effectiveness Report (preview) ---');
    console.log(report);
    console.log('--- Proposals (preview) ---');
    console.log(proposalReport);
  } else {
    fs.writeFileSync(paths.effectivenessFile, report, 'utf8');
    console.log(`Updated: ${paths.effectivenessFile}`);

    const existing = fs.existsSync(paths.overridesFile) ? fs.readFileSync(paths.overridesFile, 'utf8') : '';
    if (existing.includes('No proposals yet') || existing.includes('no proposals yet')) {
      fs.writeFileSync(paths.overridesFile, proposalReport, 'utf8');
    } else {
      fs.appendFileSync(paths.overridesFile, '\n' + proposalReport, 'utf8');
    }
    console.log(`Updated: ${paths.overridesFile}`);
  }

  // 6. Auto-reorder
  if (fs.existsSync(paths.routesDir)) {
    const fileScores = {};
    for (const [rule, data] of Object.entries(aggregated.perRule)) {
      const avg = data.totalWeight > 0 ? data.totalWeightedScore / data.totalWeight : 0;
      fileScores[rule] = avg;
    }

    const routeConfigs = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md'));
    let reordered = 0;

    for (const rc of routeConfigs) {
      const rcPath = path.join(paths.routesDir, rc);
      const result = reorderLoadIfBudget(rcPath, fileScores);
      if (result.changed) {
        reordered++;
        if (dryRun) {
          console.log(`[DRY RUN] Would reorder: ${rc}`);
        } else {
          fs.writeFileSync(rcPath, result.updated, 'utf8');
          console.log(`Auto-reordered: ${rc}`);
        }
      }
    }
    console.log(`\nAuto-reordered ${reordered} route configs`);
  }

  console.log('Done.');
}
