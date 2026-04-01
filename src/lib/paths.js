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

    // Manifests live alongside traces
    manifestDir: (date) => join(claudeDir, 'traces', date),
  };
}
