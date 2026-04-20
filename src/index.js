/**
 * Harness Harness — Public API
 *
 * For programmatic usage. CLI users should use `npx harness-harness`.
 */

export { resolvePaths } from './lib/paths.js';
export { classifyIntent, parseTraceEvent, scoreReferencedContext, generateSessionSummary } from './lib/trace-utils.js';
export { assembleContext, parseRouteConfig, loadRouteConfig, estimateTokens, getLastManifest } from './lib/context-assembler.js';
export { create as createSession, archive as archiveSession, cleanup as cleanupSessions, list as listSessions } from './lib/session-lifecycle.js';
export { parseSummary, aggregateScores, generateProposals, formatEffectivenessReport, formatProposals, parseBehavioralCompliance } from './lib/weekly-analysis.js';
export { parseOverrides, applyDemotion, applyPromotion, applyBudgetChange } from './lib/apply-overrides.js';
export { scoreRules, statusToScore, parseRuleLines, CHECK_LIBRARY } from './lib/behavioral-scoring.js';
export { discoverRules, formatDiscoveredRules, detectStack, buildStackFingerprint } from './lib/rule-discovery.js';
export { cleanupTraceFiles, trimIndex } from './lib/trace-cleanup.js';
export {
  runDailyCheckIfDue, runAggregation, getLastAggregationDate, writeNotification,
  loadGovernance, loadCooldownQueue, appendCooldownEntry, processCooldownQueue,
  vetoCooldownEntry, appendChangelog,
} from './lib/daily-check.js';
