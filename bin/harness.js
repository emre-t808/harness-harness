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
    health            Show effectiveness dashboard
    analyze           Run weekly effectiveness analysis
    apply             Apply approved route overrides
    cleanup           Clean up expired trace files
    routes list       List configured routes
    routes create     Create a new custom route

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

function printVersion() {
  const pkg = JSON.parse(
    (await import('fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  console.log(`harness-harness v${pkg.version}`);
}

async function main() {
  const projectDir = flags.includes('--project')
    ? resolve(flags[flags.indexOf('--project') + 1])
    : PROJECT_DIR;

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
