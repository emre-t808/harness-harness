/**
 * tail command — stream the events.ndjson log.
 *
 * Usage: harness-harness tail [--lines N]
 */

import fs from 'fs';
import { spawn } from 'child_process';
import { resolvePaths } from '../lib/paths.js';

export async function tail(projectDir, flags = []) {
  const paths = resolvePaths(projectDir);
  const file = paths.eventsLogFile;

  if (!fs.existsSync(file)) {
    console.log(`No events yet. Expected: ${file}`);
    console.log('Trigger a Claude Code session to generate events.');
    return;
  }

  const linesIdx = flags.indexOf('--lines');
  const initialLines = linesIdx >= 0 ? flags[linesIdx + 1] : '50';

  const child = spawn('tail', ['-f', '-n', String(initialLines), file], { stdio: 'inherit' });
  process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
  child.on('exit', code => process.exit(code ?? 0));
}
