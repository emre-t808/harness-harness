/**
 * cleanup command — Clean up expired trace files
 */

import { resolvePaths } from '../lib/paths.js';
import { cleanupTraceFiles, trimIndex, formatBytes } from '../lib/trace-cleanup.js';

export async function cleanup(projectDir, flags) {
  const paths = resolvePaths(projectDir);
  const dryRun = flags.includes('--dry-run');
  const retentionDays = 30;

  console.log(`Harness Harness — Cleanup (${dryRun ? 'DRY RUN' : 'live'}, ${retentionDays}-day retention)`);
  console.log('');

  const fileResult = cleanupTraceFiles(paths.tracesDir, retentionDays, dryRun);
  console.log(`Files: ${fileResult.deletedFiles} deleted, ${formatBytes(fileResult.bytesReclaimed)} reclaimed`);
  if (fileResult.deletedDirs > 0) {
    console.log(`Directories: ${fileResult.deletedDirs} empty dirs removed`);
  }

  const indexResult = trimIndex(paths.traceIndex, 500, dryRun);
  if (indexResult.trimmed) {
    console.log(`Index: trimmed from ${indexResult.linesBefore} to ${indexResult.linesAfter} lines`);
  } else {
    console.log(`Index: ${indexResult.linesBefore} lines (within limit)`);
  }

  console.log('Done.');
}
