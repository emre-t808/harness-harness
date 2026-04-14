/**
 * paths.js — Centralized path resolution for Harness Harness
 *
 * All paths are derived from the project root. No hardcoded paths anywhere.
 * Every module imports from here instead of constructing paths ad-hoc.
 */

import { join } from 'path';

/**
 * Build a paths object for a given project directory.
 * @param {string} projectDir - Absolute path to the project root
 * @returns {object} All harness paths
 */
export function resolvePaths(projectDir) {
  const harnessDir = join(projectDir, '.harness');
  const claudeDir = join(projectDir, '.claude');
  const localDir = join(harnessDir, 'local');

  return {
    projectDir,
    harnessDir,
    claudeDir,

    // Traces
    tracesDir: join(claudeDir, 'traces'),
    traceIndex: join(claudeDir, 'traces', 'index.md'),

    // Routes
    routesDir: join(harnessDir, 'routes'),

    // Memory
    memoryDir: join(harnessDir, 'memory'),
    effectivenessFile: join(harnessDir, 'memory', 'harness-effectiveness.md'),
    overridesFile: join(harnessDir, 'memory', 'route-overrides.md'),
    notificationsFile: join(harnessDir, 'memory', 'notifications.md'),
    tracePatternsFile: join(harnessDir, 'memory', 'trace-patterns.md'),
    workStatusFile: join(harnessDir, 'memory', 'work-status.md'),

    // Sessions
    sessionsDir: join(harnessDir, 'sessions'),
    sessionsArchiveDir: join(harnessDir, 'sessions', 'archive'),

    // Hooks (installed into .claude/hooks/)
    hooksDir: join(claudeDir, 'hooks'),

    // Config
    configFile: join(harnessDir, 'config.json'),
    claudeSettingsFile: join(claudeDir, 'settings.json'),

    // Rule registry (Phase 6)
    rulesFile: join(harnessDir, 'rules.yaml'),
    localRulesFile: join(localDir, 'rules.yaml'),

    // File activity (Phase 6)
    fileActivityFile: join(harnessDir, 'memory', 'file-activity.yaml'),

    // Phase 7
    propagationStateFile: join(harnessDir, 'memory', 'propagation-state.json'),
    ratingStateFile: join(harnessDir, 'memory', 'rating-state.json'),

    // Local (per-developer, gitignored)
    localDir,
    localRoutesDir: join(localDir, 'routes'),
    localMemoryDir: join(localDir, 'memory'),
    localSessionsDir: join(localDir, 'sessions'),
    localConfigFile: join(localDir, 'config.json'),
    localEffectivenessFile: join(localDir, 'memory', 'harness-effectiveness.md'),
    localOverridesFile: join(localDir, 'memory', 'route-overrides.md'),
    localNotificationsFile: join(localDir, 'memory', 'notifications.md'),

    // Manifests live alongside traces
    manifestDir: (date) => join(claudeDir, 'traces', date),
  };
}
