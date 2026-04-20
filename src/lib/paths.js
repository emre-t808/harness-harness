/**
 * paths.js — Centralized path resolution for Harness Harness
 *
 * All paths are derived from the project root. No hardcoded paths anywhere.
 * Every module imports from here instead of constructing paths ad-hoc.
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Build a paths object for a given project directory.
 * @param {string} projectDir - Absolute path to the project root
 * @returns {object} All harness paths
 */
export function resolvePaths(projectDir) {
  // Org-level config: shared across all repos on this machine
  const orgConfigDir = join(homedir(), '.config', 'harness-harness');
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
    changelogFile: join(harnessDir, 'memory', 'changelog.md'),
    cooldownFile: join(harnessDir, 'memory', 'cooldown-queue.json'),
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

    // Local (per-developer, gitignored)
    localDir,
    localRoutesDir: join(localDir, 'routes'),
    localMemoryDir: join(localDir, 'memory'),
    localSessionsDir: join(localDir, 'sessions'),
    localConfigFile: join(localDir, 'config.json'),
    localEffectivenessFile: join(localDir, 'memory', 'harness-effectiveness.md'),
    localOverridesFile: join(localDir, 'memory', 'route-overrides.md'),
    localNotificationsFile: join(localDir, 'memory', 'notifications.md'),

    // Org-level rules and config (shared across all repos on this machine)
    orgDir: orgConfigDir,
    orgRulesFile: join(orgConfigDir, 'org-rules.md'),
    orgConfigFile: join(orgConfigDir, 'config.json'),

    // Manifests live alongside traces
    manifestDir: (date) => join(claudeDir, 'traces', date),
  };
}
