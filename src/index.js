/**
 * Harness Harness — Public API
 *
 * For programmatic usage. CLI users should use `npx harness-harness`.
 */

export { resolvePaths } from './lib/paths.js';
export { classifyIntent, parseTraceEvent, scoreReferencedContext, generateSessionSummary } from './lib/trace-utils.js';
export { assembleContext, parseRouteConfig, loadRouteConfig, estimateTokens, getLastManifest } from './lib/context-assembler.js';
export { create as createSession, archive as archiveSession, cleanup as cleanupSessions, list as listSessions } from './lib/session-lifecycle.js';
export { parseSummary, aggregateScores, generateProposals, formatEffectivenessReport, formatProposals } from './lib/weekly-analysis.js';
export { parseOverrides, applyDemotion, applyPromotion, applyBudgetChange } from './lib/apply-overrides.js';
export { cleanupTraceFiles, trimIndex } from './lib/trace-cleanup.js';
