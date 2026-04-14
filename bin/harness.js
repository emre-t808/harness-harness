#!/usr/bin/env node

/**
 * Harness Harness CLI
 *
 * The self-improving agentic harness for Claude Code.
 *
 * Commands:
 *   init      Scaffold harness into your project
 *   health    Show effectiveness scores and pending proposals
 *   analyze   Run weekly analysis on-demand
 *   apply     Apply approved route override proposals
 *   cleanup   Clean up old trace files
 *   routes    List or create route configs
 */

import { resolve } from 'path';
import { existsSync, statSync } from 'fs';

const args = process.argv.slice(2);
const command = args[0];
const flags = args.slice(1);

const PROJECT_DIR = process.cwd();

function printHelp() {
  console.log(`
  harness-harness — The self-improving agentic harness for Claude Code

  Usage:
    harness-harness <command> [options]

  Commands:
    init              Scaffold harness into your project
    health            Show effectiveness dashboard (--all for cross-repo)
    analyze           Run weekly effectiveness analysis
    apply             Apply approved route overrides
    cleanup           Clean up expired trace files
    routes list       List configured routes
    routes create     Create a new custom route
    register          Register repo(s) in federated index
    index             Refresh federated index from registered repos
    rules             List, search, add, or migrate rules (registry)
    share             Import a rule from another repo
    activity          Show agent file activity heatmap

  Options:
    --dry-run         Preview changes without writing
    --days <n>        Analysis window (default: 7)
    --project <path>  Project directory (default: cwd)
    --help, -h        Show this help message
    --version, -v     Show version

  Examples:
    npx harness-harness init
    npx harness-harness health
    npx harness-harness analyze --days 14
    npx harness-harness cleanup --dry-run
`);
}

async function printVersion() {
  const { readFileSync } = await import('fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`harness-harness v${pkg.version}`);
}

async function main() {
  let projectDir;
  if (flags.includes('--project')) {
    projectDir = resolve(flags[flags.indexOf('--project') + 1]);
  } else {
    // Positional path detection — skip flags[0] (that's a subcommand or plain arg),
    // and require an existing directory to avoid collisions with subcommand names.
    const positionalPath = flags.slice(1).find(f => {
      if (f.startsWith('-')) return false;
      const abs = resolve(f);
      try { return existsSync(abs) && statSync(abs).isDirectory(); }
      catch { return false; }
    });
    projectDir = positionalPath ? resolve(positionalPath) : PROJECT_DIR;
  }

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`harness-harness v${pkg.version}`);
    process.exit(0);
  }

  switch (command) {
    case 'init': {
      const { init } = await import('../src/commands/init.js');
      await init(projectDir, flags);
      break;
    }
    case 'health': {
      const { health } = await import('../src/commands/health.js');
      await health(projectDir, flags);
      break;
    }
    case 'analyze': {
      const { analyze } = await import('../src/commands/analyze.js');
      await analyze(projectDir, flags);
      break;
    }
    case 'apply': {
      const { apply } = await import('../src/commands/apply.js');
      await apply(projectDir, flags);
      break;
    }
    case 'cleanup': {
      const { cleanup } = await import('../src/commands/cleanup.js');
      await cleanup(projectDir, flags);
      break;
    }
    case 'routes': {
      const { routes } = await import('../src/commands/routes.js');
      await routes(projectDir, flags);
      break;
    }
    case 'register': {
      const { register } = await import('../src/commands/register.js');
      await register(projectDir, flags);
      break;
    }
    case 'index': {
      const { index } = await import('../src/commands/index.js');
      await index(projectDir, flags);
      break;
    }
    case 'rules': {
      const { rules } = await import('../src/commands/rules.js');
      await rules(projectDir, flags);
      break;
    }
    case 'share': {
      const { share } = await import('../src/commands/share.js');
      await share(projectDir, flags);
      break;
    }
    case 'activity': {
      const { activity } = await import('../src/commands/activity.js');
      await activity(projectDir, flags);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run harness-harness --help for usage.');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
