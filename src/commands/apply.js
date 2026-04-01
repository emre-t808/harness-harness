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

  console.log(`Harness Harness — Apply Overrides (${dryRun ? 'DRY RUN' : 'live'})`);
  console.log('');

  if (!fs.existsSync(paths.overridesFile)) {
    console.log('No route-overrides found. Run: harness-harness analyze');
    return;
  }

  const content = fs.readFileSync(paths.overridesFile, 'utf8');
  const overrides = parseOverrides(content);
  const total = overrides.promotions.length + overrides.demotions.length + overrides.budgetChanges.length;

  console.log(`Found ${total} approved overrides`);
  if (total === 0) {
    console.log('No approved overrides to apply.');
    console.log('Mark proposals as "Status: approved" in .harness/memory/route-overrides.md');
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

  markApplied(appliedIndices, paths, dryRun);
  console.log(`\nApplied ${appliedIndices.length} overrides.`);
}
