/**
 * trace-cleanup.js — Trace storage management
 *
 * Deletes expired raw trace files while preserving summaries.
 */

import fs from 'fs';
import path from 'path';

const RETENTION_DAYS = 30;
const INDEX_MAX_LINES = 500;

export function cleanupTraceFiles(tracesDir, retentionDays = RETENTION_DAYS, dryRun = false) {
  let deletedFiles = 0;
  let bytesReclaimed = 0;
  let deletedDirs = 0;

  if (!fs.existsSync(tracesDir)) return { deletedFiles, bytesReclaimed, deletedDirs };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const dateDirs = fs.readdirSync(tracesDir).filter(d =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoffStr
  );

  for (const dateDir of dateDirs) {
    const dirPath = path.join(tracesDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath);
    let remainingFiles = 0;

    for (const file of files) {
      if (file.endsWith('-summary.md')) { remainingFiles++; continue; }

      if (file.endsWith('.jsonl') || file.endsWith('-manifest.json')) {
        const filePath = path.join(dirPath, file);
        const fileSize = fs.statSync(filePath).size;

        if (!dryRun) fs.unlinkSync(filePath);
        deletedFiles++;
        bytesReclaimed += fileSize;
      } else {
        remainingFiles++;
      }
    }

    if (remainingFiles === 0 && !dryRun) {
      try { fs.rmdirSync(dirPath); deletedDirs++; } catch { /* not empty */ }
    }
  }

  return { deletedFiles, bytesReclaimed, deletedDirs };
}

export function trimIndex(indexFile, maxLines = INDEX_MAX_LINES, dryRun = false) {
  if (!fs.existsSync(indexFile)) return { trimmed: false, linesBefore: 0, linesAfter: 0 };

  const content = fs.readFileSync(indexFile, 'utf8');
  const lines = content.split('\n');

  if (lines.length <= maxLines) return { trimmed: false, linesBefore: lines.length, linesAfter: lines.length };

  const headerLines = lines.slice(0, 3);
  const recentLines = lines.slice(-(maxLines - 3));
  const trimmed = [...headerLines, ...recentLines].join('\n');

  if (!dryRun) fs.writeFileSync(indexFile, trimmed, 'utf8');
  return { trimmed: true, linesBefore: lines.length, linesAfter: maxLines };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { RETENTION_DAYS, INDEX_MAX_LINES };
