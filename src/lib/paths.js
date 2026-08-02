/**
 * paths.js — Centralized path resolution for Harness Harness
 *
 * All paths are derived from the project root. No hardcoded paths anywhere.
 * Every module imports from here instead of constructing paths ad-hoc.
 */

import { join, isAbsolute } from 'path';
import { readFileSync } from 'fs';

/**
 * Where this project's route configs actually live.
 *
 * Defaults to `.harness/routes` (unchanged for every existing install), but a project
 * whose live routes are elsewhere can say so with `"routesDir"` in `.harness/config.json`:
 *
 *   { "routesDir": "context/routes" }
 *
 * Without this, `analyze` / `apply` / `routes` / the daily tuner all read and WRITE
 * `.harness/routes` — so in a project whose assembler reads its routes from somewhere
 * else, every one of them silently operates on a directory nothing loads. That is not
 * hypothetical: it happened, and the tuner spent months "tuning" a dead template dir.
 *
 * @param {string} projectDir
 * @param {string} harnessDir
 * @returns {string} absolute path to the route configs
 */
function resolveRoutesDir(projectDir, harnessDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(harnessDir, 'config.json'), 'utf8'));
    const dir = typeof cfg.routesDir === 'string' ? cfg.routesDir.trim() : '';
    if (dir) return isAbsolute(dir) ? dir : join(projectDir, dir);
  } catch {
    // No config yet, or malformed — fall through to the default.
  }
  return join(harnessDir, 'routes');
}

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

    // Routes (configurable — see resolveRoutesDir)
    routesDir: resolveRoutesDir(projectDir, harnessDir),

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

    // Phase 9: observability + autonomy
    eventsLogFile: join(localDir, 'events.ndjson'),
    revertsDir: join(localDir, 'reverts'),
    autonomyStateFile: join(localDir, 'autonomy-state.json'),

    // Manifests live alongside traces
    manifestDir: (date) => join(claudeDir, 'traces', date),
  };
}

/**
 * Rules the project declares off-limits to demotion proposals, from
 * `"protectedRules": ["FO-009", ...]` in .harness/config.json. Missing or
 * malformed config → empty list (no protection).
 * @param {object} paths - result of resolvePaths()
 * @returns {string[]}
 */
export function loadProtectedRules(paths) {
  try {
    const cfg = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    return Array.isArray(cfg.protectedRules)
      ? cfg.protectedRules.filter((r) => typeof r === 'string' && r.trim())
      : [];
  } catch {
    return [];
  }
}
