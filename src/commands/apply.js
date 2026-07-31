/**
 * apply command — Apply approved route override proposals
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../lib/paths.js';
import {
  parseOverrides, applyDemotion, applyPromotion,
  applyBudgetChange, parseBudgetDescription, markApplied,
} from '../lib/apply-overrides.js';

export async function apply(projectDir, flags) {
  const paths = resolvePaths(projectDir);
  const dryRun = flags.includes('--dry-run');
  const forceMode = flags.includes('--force');
  const teamMode = flags.includes('--team');

  // Read the same file `analyze` WRITES: the per-developer local file by default,
  // the shared file with --team. Without this, apply read the shared file while
  // analyze wrote proposals to local, so apply never saw them and every run
  // reported "no proposals" against an empty shared file.
  const overridesFile = teamMode
    ? paths.overridesFile
    : (paths.localOverridesFile || paths.overridesFile);
  const applyPaths = { ...paths, overridesFile };
  const overridesDisplay = path.relative(projectDir, overridesFile) || overridesFile;

  console.log(`Harness Harness — Apply Overrides (${dryRun ? 'DRY RUN' : 'live'})`);
  console.log('');

  if (!fs.existsSync(overridesFile)) {
    console.log('No route-overrides found. Run: harness-harness analyze');
    return;
  }

  const content = fs.readFileSync(overridesFile, 'utf8');
  const overrides = parseOverrides(content, forceMode);
  const total = overrides.promotions.length + overrides.demotions.length + overrides.budgetChanges.length;

  console.log(`Found ${total} approved overrides`);
  if (total === 0) {
    console.log('No approved overrides to apply.');
    console.log(`Mark proposals as "Status: approved" in ${overridesDisplay}`);
    return;
  }

  const appliedIndices = [];

  for (const d of overrides.demotions) {
    const routeFile = d.route.replace(/:/g, '-') + '.md';
    const routePath = path.join(paths.routesDir, routeFile);
    const result = applyDemotion(routePath, d.rule, dryRun);
    console.log(`  ${result.changed ? '✓' : '—'} ${result.description}`);
    if (result.changed) appliedIndices.push(d.lineIndex);
  }

  for (const p of overrides.promotions) {
    const result = applyPromotion(p.rule, paths, dryRun);
    for (const desc of result.descriptions) console.log(`  ✓ ${desc}`);
    if (result.changed) appliedIndices.push(p.lineIndex);
  }

  for (const b of overrides.budgetChanges) {
    const routeFile = b.route.replace(/:/g, '-') + '.md';
    const routePath = path.join(paths.routesDir, routeFile);
    const newBudget = parseBudgetDescription(routePath, b.description);
    if (newBudget) {
      const result = applyBudgetChange(routePath, newBudget, dryRun);
      console.log(`  ${result.changed ? '✓' : '—'} ${result.description}`);
      if (result.changed) appliedIndices.push(b.lineIndex);
    }
  }

  const developer = process.env.USER || process.env.USERNAME || 'unknown';
  markApplied(appliedIndices, applyPaths, dryRun, developer);
  console.log(`Applied by: ${developer} on ${new Date().toISOString().slice(0, 10)}`);
  console.log(`\nApplied ${appliedIndices.length} overrides.`);
}
