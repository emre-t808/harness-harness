/**
 * init command — Scaffold Harness Harness into a project
 *
 * Modes:
 *   (default)     Detect conflicts, warn if found, install in full mode
 *   --merge       Install alongside existing hooks (accept double injection)
 *   --replace     Back up existing UserPromptSubmit hooks, replace with assembler
 *   --trace-only  Only install tracing (PostToolUse + Stop) — no assembler
 *   --force       Reinitialize even if .harness/ already exists
 *
 * Creates:
 *   .harness/           config, routes, memory, sessions
 *   .claude/hooks/      hh-* hook files
 *   .claude/settings.json  updated with matcher-group hook entries
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolvePaths } from '../lib/paths.js';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_DIR = path.resolve(path.dirname(__filename), '..', '..');
const TEMPLATES_DIR = path.join(PACKAGE_DIR, 'templates');

// All hook templates with their metadata
const ALL_HOOKS = [
  // Context injection hooks
  { src: 'session-start.sh', dest: 'hh-session-start.sh', group: 'context' },
  { src: 'assembler-fallback.sh', dest: 'hh-assembler-fallback.sh', group: 'context' },
  { src: 'post-compact.sh', dest: 'hh-post-compact.sh', group: 'context' },

  // Side-effect hooks (always safe)
  { src: 'trace-capture.sh', dest: 'hh-trace-capture.sh', group: 'trace' },
  { src: 'state-nudge.sh', dest: 'hh-state-nudge.sh', group: 'trace' },
  { src: 'session-summary.js', dest: 'hh-session-summary.js', group: 'trace' },
  { src: 'pre-compact.sh', dest: 'hh-pre-compact.sh', group: 'trace' },
  { src: 'session-end.sh', dest: 'hh-session-end.sh', group: 'trace' },
];

const SLASH_COMMANDS = [
  'hh-health.md',
  'hh-analyze.md',
  'hh-apply.md',
  'hh-routes.md',
  'hh-rules.md',
  'hh-share.md',
  'hh-activity.md',
];

export async function init(projectDir, flags) {
  const force = flags.includes('--force');
  const mergeMode = flags.includes('--merge');
  const replaceMode = flags.includes('--replace');
  const traceOnly = flags.includes('--trace-only');
  const localOnly = flags.includes('--local-only');
  const paths = resolvePaths(projectDir);

  console.log('');
  console.log('  Harness Harness — init');
  console.log(`  Project: ${projectDir}`);

  if (traceOnly) console.log('  Mode: trace-only (no assembler, no context injection)');
  else if (replaceMode) console.log('  Mode: replace (backing up existing UserPromptSubmit hooks)');
  else if (mergeMode) console.log('  Mode: merge (installing alongside existing hooks)');
  else console.log('  Mode: full (with conflict detection)');
  if (localOnly) console.log('  Mode: local-only (hooks + local dirs, skip shared config)');

  console.log('');

  // Check if already initialized
  if (fs.existsSync(paths.harnessDir) && !force && !localOnly) {
    console.log('  .harness/ already exists. Use --force to reinitialize.');
    return;
  }

  // 1. Create directory structure
  const dirs = [
    paths.harnessDir,
    paths.routesDir,
    paths.memoryDir,
    paths.sessionsDir,
    path.join(paths.sessionsDir, 'archive'),
    paths.localDir,
    path.join(paths.localDir, 'routes'),
    path.join(paths.localDir, 'memory'),
    path.join(paths.localDir, 'sessions'),
    paths.tracesDir,
    paths.hooksDir,
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  console.log('  Created directory structure');

  // 2. Copy route templates (don't overwrite existing)
  if (!localOnly) {
    const routeTemplates = fs.readdirSync(path.join(TEMPLATES_DIR, 'routes'));
    let routesCopied = 0;
    for (const tmpl of routeTemplates) {
      const dest = path.join(paths.routesDir, tmpl);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(TEMPLATES_DIR, 'routes', tmpl), dest);
        routesCopied++;
      }
    }
    console.log(`  Routes: ${routesCopied} templates installed (${routeTemplates.length - routesCopied} already exist)`);
  }

  // 3. Conflict detection (before installing hooks)
  const conflicts = detectConflicts(paths);
  if (conflicts.hasContextConflict && !mergeMode && !replaceMode && !traceOnly) {
    console.log('');
    console.log('  ⚠ Conflict detected: existing UserPromptSubmit hooks found');
    console.log('  These hooks inject context into Claude:');
    for (const cmd of conflicts.contextHookCommands) {
      console.log(`    - ${cmd}`);
    }
    console.log('');
    console.log('  Options:');
    console.log('    harness-harness init --merge       Install alongside (double context)');
    console.log('    harness-harness init --replace     Back up and replace existing hooks');
    console.log('    harness-harness init --trace-only  Only trace, skip assembler');
    console.log('');
    console.log('  Defaulting to --merge (installing alongside existing hooks).');
    console.log('');
    // Default to merge rather than aborting — user was warned
  }

  // 4. Back up existing hooks if --replace
  if (replaceMode && conflicts.hasContextConflict) {
    backupExistingHooks(paths, conflicts);
    console.log('  Backup: existing hooks saved to .harness/hooks-backup/');
  }

  // 5. Determine which hooks to install based on mode
  const hooksToInstall = traceOnly
    ? ALL_HOOKS.filter(h => h.group === 'trace')
    : ALL_HOOKS;

  // 6. Install hook files (no more {{PROJECT_DIR}} — hooks use $CLAUDE_PROJECT_DIR)
  for (const hook of hooksToInstall) {
    const srcContent = fs.readFileSync(path.join(TEMPLATES_DIR, 'hooks', hook.src), 'utf8');
    // Substitute template variables
    const content = srcContent
      .replace(/\{\{PROJECT_DIR\}\}/g, projectDir)
      .replace(/\{\{HARNESS_PACKAGE_DIR\}\}/g, PACKAGE_DIR);
    const destPath = path.join(paths.hooksDir, hook.dest);
    fs.writeFileSync(destPath, content, 'utf8');
    if (hook.dest.endsWith('.sh')) {
      fs.chmodSync(destPath, 0o755);
    }
  }
  console.log(`  Hooks: ${hooksToInstall.length} installed to .claude/hooks/`);

  // 6b. Install slash commands (don't overwrite existing)
  const commandsDir = path.join(paths.claudeDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  let commandsCopied = 0;
  for (const cmd of SLASH_COMMANDS) {
    const dest = path.join(commandsDir, cmd);
    if (!fs.existsSync(dest)) {
      const srcPath = path.join(TEMPLATES_DIR, 'commands', cmd);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, dest);
        commandsCopied++;
      }
    }
  }
  console.log(`  Commands: ${commandsCopied} slash commands installed to .claude/commands/`);

  // 7. Install assembler (only in full/merge/replace mode)
  if (!traceOnly) {
    const assemblerSrc = path.join(PACKAGE_DIR, 'src', 'lib', 'context-assembler.js').replace(/\\/g, '/');
    const assemblerWrapper = `#!/usr/bin/env node
// Harness Harness — Smart Context Assembler (UserPromptSubmit hook)
// Auto-generated by harness-harness init. Do not edit manually.
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

async function loadAssembler() {
  // Strategy 1: installed as npm dependency or globally
  try { return await import('harness-harness/assembler'); } catch {}
  // Strategy 2: absolute path to package (resolved at init time)
  try { return await import('${assemblerSrc}'); } catch {}
  // All strategies failed
  process.exit(1);
}

loadAssembler().then(m => m.main(projectDir)).catch(() => process.exit(1));
`;
    fs.writeFileSync(path.join(paths.hooksDir, 'hh-assembler.js'), assemblerWrapper, 'utf8');
    console.log('  Assembler: installed as .claude/hooks/hh-assembler.js');
  }

  // 8. Update .claude/settings.json with correct matcher group structure
  updateClaudeSettings(paths, traceOnly, replaceMode);
  console.log('  Settings: .claude/settings.json updated with hook entries');

  // 12. Warn about project .gitignore
  const projectGitignore = path.join(projectDir, '.gitignore');
  if (fs.existsSync(projectGitignore)) {
    const gi = fs.readFileSync(projectGitignore, 'utf8');
    const needed = ['.claude/hooks/', '.claude/settings.json', '.claude/traces/'];
    const missing = needed.filter(p => !gi.includes(p));
    if (missing.length > 0) {
      console.log('');
      console.log('  WARNING: Add these to your .gitignore:');
      for (const m of missing) console.log(`    ${m}`);
    }
  }

  // 9. Create harness config
  if (!localOnly) {
    if (!fs.existsSync(paths.configFile)) {
      const config = {
        version: '0.2.0',
        projectDir,
        budgetTokens: 130000,
        customIntents: [],
        fileToRules: {},
        retentionDays: 30,
        initMode: traceOnly ? 'trace-only' : replaceMode ? 'replace' : 'merge',
      };
      fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2), 'utf8');
      console.log('  Config: .harness/config.json created');
    }
  }

  if (!localOnly) {
    // 10. Create initial memory files
    const memoryFiles = [
      { path: paths.effectivenessFile, content: '## Harness Effectiveness Scores\n\nNo data yet. Scores will appear after your first analyzed session.\n' },
      { path: paths.overridesFile, content: '## Route Overrides\n\nNo proposals yet.\n' },
      { path: paths.tracePatternsFile, content: '# Trace Patterns\n\nSession stats will be appended here by the session-summary hook.\n' },
      { path: paths.workStatusFile, content: '## Work Status\n\nUpdate this file with your current work status.\n' },
    ];

    for (const mf of memoryFiles) {
      if (!fs.existsSync(mf.path)) {
        fs.writeFileSync(mf.path, mf.content, 'utf8');
      }
    }
    console.log('  Memory: initial files created');
  }

  // 11. Create .gitignore for harness
  const gitignorePath = path.join(paths.harnessDir, '.gitignore');
  const gitignoreContent = [
    '# Harness Harness',
    'sessions/archive/',
    'hooks-backup/',
    '',
    '# Per-developer local overrides (never commit)',
    'local/',
  ].join('\n') + '\n';
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, gitignoreContent);
  } else {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    if (!existing.includes('local/')) {
      fs.appendFileSync(gitignorePath, '\n# Per-developer local overrides\nlocal/\n');
    }
  }

  console.log('');
  if (localOnly) {
    console.log('  Done! Local plumbing installed (shared config from team repo).');
    console.log('');
    console.log('  Your local overrides go in .harness/local/:');
    console.log('    routes/     — Route config overrides');
    console.log('    config.json — Config overrides');
    console.log('    memory/     — Personal effectiveness scores');
  } else {
    console.log('  Done! Harness Harness is ready.');
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Edit .harness/routes/general.md with your project identity and rules');
    console.log('    2. Customize routes in .harness/routes/ for your codebase');
    console.log('    3. Map rule files to IDs in .harness/config.json (fileToRules)');
    console.log('    4. Start using Claude Code — tracing begins automatically');
    console.log('    5. After a few sessions: harness-harness health');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

function detectConflicts(paths) {
  const result = {
    hasContextConflict: false,
    contextHookCommands: [],
    existingSettings: null,
  };

  if (!fs.existsSync(paths.claudeSettingsFile)) return result;

  try {
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8'));
    result.existingSettings = settings;

    if (!settings.hooks) return result;

    // Check UserPromptSubmit for existing context-injecting hooks
    const upsGroups = settings.hooks.UserPromptSubmit || [];
    for (const group of upsGroups) {
      const hooks = group.hooks || [];
      for (const hook of hooks) {
        const cmd = hook.command || hook.url || '';
        // Skip our own hooks
        if (cmd.includes('hh-')) continue;
        // Any non-HH UserPromptSubmit hook is a potential conflict
        result.hasContextConflict = true;
        result.contextHookCommands.push(cmd);
      }
    }

    // Also check flat format (in case user has non-standard structure)
    if (Array.isArray(upsGroups) && upsGroups.length > 0 && upsGroups[0].type) {
      // Flat format detected — hooks directly in the array
      for (const hook of upsGroups) {
        const cmd = hook.command || hook.url || '';
        if (cmd.includes('hh-')) continue;
        if (cmd) {
          result.hasContextConflict = true;
          result.contextHookCommands.push(cmd);
        }
      }
    }
  } catch { /* parse error — treat as no conflicts */ }

  return result;
}

// ---------------------------------------------------------------------------
// Backup existing hooks
// ---------------------------------------------------------------------------

function backupExistingHooks(paths, conflicts) {
  const backupDir = path.join(paths.harnessDir, 'hooks-backup');
  fs.mkdirSync(backupDir, { recursive: true });

  // Save the pre-init settings.json
  if (fs.existsSync(paths.claudeSettingsFile)) {
    fs.copyFileSync(
      paths.claudeSettingsFile,
      path.join(backupDir, `settings-backup-${Date.now()}.json`)
    );
  }

  // Write a manifest of what was backed up
  const manifest = {
    backedUpAt: new Date().toISOString(),
    conflictingHooks: conflicts.contextHookCommands,
    note: 'These UserPromptSubmit hooks were replaced by Harness Harness. Restore by copying settings-backup-*.json back to .claude/settings.json.',
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// ---------------------------------------------------------------------------
// Settings.json update — CORRECT matcher group format
// ---------------------------------------------------------------------------

function updateClaudeSettings(paths, traceOnly, replaceMode) {
  let settings = {};

  if (fs.existsSync(paths.claudeSettingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // Helper: remove existing HH hooks from a matcher group array
  function removeHHHooks(groups) {
    if (!Array.isArray(groups)) return [];
    return groups
      .map(group => {
        // Handle matcher-group format
        if (group.hooks && Array.isArray(group.hooks)) {
          const filtered = group.hooks.filter(h => {
            const cmd = h.command || h.url || '';
            return !cmd.includes('hh-');
          });
          if (filtered.length === 0) return null;
          return { ...group, hooks: filtered };
        }
        // Handle flat format (legacy) — skip HH entries
        const cmd = group.command || group.url || '';
        if (cmd.includes('hh-')) return null;
        return group;
      })
      .filter(Boolean);
  }

  // Helper: if replaceMode, also remove non-HH UserPromptSubmit hooks
  function removeAllUPSHooks(groups) {
    if (!Array.isArray(groups)) return [];
    return []; // Replace mode: clear all UserPromptSubmit hooks
  }

  // Use relative paths from project root (Claude Code hooks cwd = project root)
  const projectRoot = path.dirname(path.dirname(paths.hooksDir));
  const relHooksDir = path.relative(projectRoot, paths.hooksDir);

  // -----------------------------------------------------------------------
  // SessionStart — context injection (startup + resume + compact)
  // -----------------------------------------------------------------------
  if (!traceOnly) {
    settings.hooks.SessionStart = removeHHHooks(settings.hooks.SessionStart || []);
    settings.hooks.SessionStart.push({
      matcher: 'startup|resume|compact',
      hooks: [
        {
          type: 'command',
          command: `bash "./${path.join(relHooksDir, 'hh-session-start.sh')}"`,
          timeout: 5,
        },
      ],
    });
  }

  // -----------------------------------------------------------------------
  // UserPromptSubmit — Smart Assembler + fallback
  // -----------------------------------------------------------------------
  if (!traceOnly) {
    if (replaceMode) {
      settings.hooks.UserPromptSubmit = removeAllUPSHooks(settings.hooks.UserPromptSubmit || []);
    } else {
      settings.hooks.UserPromptSubmit = removeHHHooks(settings.hooks.UserPromptSubmit || []);
    }
    settings.hooks.UserPromptSubmit.push({
      hooks: [
        {
          type: 'command',
          command: `node "./${path.join(relHooksDir, 'hh-assembler.js')}"`,
          timeout: 10,
        },
        {
          type: 'command',
          command: `bash "./${path.join(relHooksDir, 'hh-assembler-fallback.sh')}"`,
          timeout: 5,
        },
      ],
    });
  }

  // -----------------------------------------------------------------------
  // PostToolUse — trace capture (all tools) + state nudge (Edit|Write)
  // -----------------------------------------------------------------------
  settings.hooks.PostToolUse = removeHHHooks(settings.hooks.PostToolUse || []);

  // Trace capture: fires on ALL tool calls, side-effect only
  settings.hooks.PostToolUse.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `bash "./${path.join(relHooksDir, 'hh-trace-capture.sh')}"`,
        timeout: 5,
      },
    ],
  });

  // State nudge: fires on Edit|Write, returns additionalContext
  settings.hooks.PostToolUse.push({
    matcher: 'Edit|Write',
    hooks: [
      {
        type: 'command',
        command: `bash "./${path.join(relHooksDir, 'hh-state-nudge.sh')}"`,
        timeout: 5,
      },
    ],
  });

  // -----------------------------------------------------------------------
  // Stop — session summary
  // -----------------------------------------------------------------------
  settings.hooks.Stop = removeHHHooks(settings.hooks.Stop || []);
  settings.hooks.Stop.push({
    hooks: [
      {
        type: 'command',
        command: `node "./${path.join(relHooksDir, 'hh-session-summary.js')}"`,
        timeout: 30,
      },
    ],
  });

  // -----------------------------------------------------------------------
  // PreCompact — save state before compaction (side-effect only)
  // -----------------------------------------------------------------------
  settings.hooks.PreCompact = removeHHHooks(settings.hooks.PreCompact || []);
  settings.hooks.PreCompact.push({
    matcher: 'manual|auto',
    hooks: [
      {
        type: 'command',
        command: `bash "./${path.join(relHooksDir, 'hh-pre-compact.sh')}"`,
        timeout: 5,
      },
    ],
  });

  // -----------------------------------------------------------------------
  // PostCompact — re-inject context after compaction
  // -----------------------------------------------------------------------
  if (!traceOnly) {
    settings.hooks.PostCompact = removeHHHooks(settings.hooks.PostCompact || []);
    settings.hooks.PostCompact.push({
      matcher: 'manual|auto',
      hooks: [
        {
          type: 'command',
          command: `bash "./${path.join(relHooksDir, 'hh-post-compact.sh')}"`,
          timeout: 10,
        },
      ],
    });
  }

  // -----------------------------------------------------------------------
  // SessionEnd — cleanup and fallback summary
  // -----------------------------------------------------------------------
  settings.hooks.SessionEnd = removeHHHooks(settings.hooks.SessionEnd || []);
  settings.hooks.SessionEnd.push({
    hooks: [
      {
        type: 'command',
        command: `bash "./${path.join(relHooksDir, 'hh-session-end.sh')}"`,
        timeout: 10,
      },
    ],
  });

  // Write settings
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(settings, null, 2), 'utf8');
}
