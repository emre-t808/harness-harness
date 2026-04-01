/**
 * routes command — List or create route configs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolvePaths } from '../lib/paths.js';
import { parseRouteConfig } from '../lib/context-assembler.js';

const __filename = fileURLToPath(import.meta.url);
const TEMPLATES_DIR = path.resolve(path.dirname(__filename), '..', '..', 'templates');

export async function routes(projectDir, flags) {
  const paths = resolvePaths(projectDir);
  const subcommand = flags[0];

  if (!fs.existsSync(paths.harnessDir)) {
    console.log('Not initialized. Run: harness-harness init');
    return;
  }

  if (subcommand === 'create') {
    const name = flags[1];
    if (!name) {
      console.log('Usage: harness-harness routes create <intent-name>');
      console.log('Example: harness-harness routes create coding-python');
      return;
    }

    const filename = name.replace(/:/g, '-') + '.md';
    const destPath = path.join(paths.routesDir, filename);

    if (fs.existsSync(destPath)) {
      console.log(`Route already exists: ${destPath}`);
      return;
    }

    // Use general template as base
    const templatePath = path.join(TEMPLATES_DIR, 'routes', 'general.md');
    let content = fs.readFileSync(templatePath, 'utf8');
    content = content.replace(/^intent: general$/m, `intent: ${name}`);
    content = content.replace(/Default route for unmatched intents/,
      `Custom route for ${name}`);

    fs.writeFileSync(destPath, content, 'utf8');
    console.log(`Created route: ${destPath}`);
    console.log('Edit this file to add your rules and context files.');
    return;
  }

  // Default: list routes
  if (!fs.existsSync(paths.routesDir)) {
    console.log('No routes directory found.');
    return;
  }

  const routeFiles = fs.readdirSync(paths.routesDir).filter(f => f.endsWith('.md'));

  if (routeFiles.length === 0) {
    console.log('No routes configured. Run: harness-harness init');
    return;
  }

  console.log('');
  console.log('  Routes:');
  console.log('');

  for (const rf of routeFiles) {
    const content = fs.readFileSync(path.join(paths.routesDir, rf), 'utf8');
    const config = parseRouteConfig(content);
    const intent = config.meta.intent || rf.replace('.md', '');
    const desc = config.meta.description || '';
    const budget = config.budget;

    console.log(`  ${intent}`);
    if (desc) console.log(`    ${desc}`);
    console.log(`    Budget: identity=${budget.identity}% route=${budget.route_context}% memory=${budget.working_memory}% traces=${budget.traces}% reserved=${budget.reserved}%`);
    console.log('');
  }
}
