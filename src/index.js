/**
 * Harness Harness — Public API
 *
 * For programmatic usage. CLI users should use `npx harness-harness`.
 */

export { resolvePaths } from './lib/paths.js';
export { classifyIntent, parseTraceEvent, scoreReferencedContext, generateSessionSummary, extractReferencedRules } from './lib/trace-utils.js';
export { parseRuleLine, parseRulesFromSection, computeRuleHash } from './lib/rule-parser.js';
export { updateFederatedIndex, readTraceIndex, writeTraceIndex, globalConfigDir } from './lib/federated-index.js';
export { computeStaleness, generateRecommendation } from './lib/staleness.js';
export { assembleContext, parseRouteConfig, loadRouteConfig, estimateTokens, getLastManifest } from './lib/context-assembler.js';
export { create as createSession, archive as archiveSession, cleanup as cleanupSessions, list as listSessions } from './lib/session-lifecycle.js';
export { parseSummary, aggregateScores, generateProposals, formatEffectivenessReport, formatProposals } from './lib/weekly-analysis.js';
export { parseOverrides, applyDemotion, applyPromotion, applyBudgetChange } from './lib/apply-overrides.js';
export { cleanupTraceFiles, trimIndex } from './lib/trace-cleanup.js';
export { runDailyCheckIfDue, runAggregation, getLastAggregationDate, writeNotification } from './lib/daily-check.js';

// Phase 6: rule registry, activity, dismissed rules
export {
  parseRulesYaml, serializeRulesYaml, loadRuleRegistry,
  resolveRule, filterRules, addRuleToFile,
} from './lib/rule-registry.js';
export { aggregateFileActivity, writeFileActivity, readFileActivity } from './lib/activity.js';
export { getDismissedRuleIds, trackSurfacedRules, readDismissedRules, DISMISS_THRESHOLD } from './lib/dismissed-rules.js';
