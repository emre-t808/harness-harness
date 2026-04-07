/**
 * config-merge.js — Deep merge utilities for team/developer config cascade.
 * Developer values always override team values.
 */

import { DEFAULT_BUDGET } from './context-assembler.js';

/**
 * Apply DEFAULT_BUDGET to fill any missing budget keys.
 * Called AFTER merging team + dev so that: dev > team > defaults.
 */
function applyBudgetDefaults(route) {
  return {
    ...route,
    budget: { ...DEFAULT_BUDGET, ...route.budget },
  };
}

/**
 * Merge two parsed route configs. Developer values override team values.
 * Sections are REPLACED (not concatenated).
 * Budget defaults are applied AFTER merging so partial dev overrides
 * don't clobber team values with parser defaults.
 */
export function mergeRouteConfigs(teamRoute, devRoute) {
  if (!devRoute) return applyBudgetDefaults(teamRoute);
  if (!teamRoute) return applyBudgetDefaults(devRoute);

  const merged = {
    meta: { ...teamRoute.meta, ...devRoute.meta },
    budget: { ...teamRoute.budget, ...devRoute.budget },
    sections: mergeSections(teamRoute.sections, devRoute.sections),
  };
  return applyBudgetDefaults(merged);
}

function mergeSections(teamSections, devSections) {
  const merged = { ...teamSections };
  for (const [key, value] of Object.entries(devSections || {})) {
    if (value && value.trim()) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Merge two config.json objects. Developer values override team values.
 * customIntents are concatenated (developer intents checked first).
 * fileToRules are merged (developer mappings override per-file).
 */
export function mergeProjectConfigs(teamConfig, devConfig) {
  if (!devConfig) return teamConfig;
  if (!teamConfig) return devConfig;

  return {
    ...teamConfig,
    ...devConfig,
    customIntents: [
      ...(devConfig.customIntents || []),
      ...(teamConfig.customIntents || []),
    ],
    fileToRules: {
      ...(teamConfig.fileToRules || {}),
      ...(devConfig.fileToRules || {}),
    },
  };
}

/**
 * Merge effectiveness score maps. Developer scores override team scores
 * for the same rule ID.
 */
export function mergeEffectivenessScores(teamScores, devScores) {
  return { ...teamScores, ...devScores };
}
