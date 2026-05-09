/**
 * revert.js — Capture and restore file snapshots for autonomous changes.
 *
 * Every time daily-check.js auto-applies a promotion or demotion, it calls
 * saveRevert() with the original content of the route config. If the change
 * turns out to be wrong, the operator runs `harness-harness revert <event_id>`
 * to restore the file. Each revert is keyed by the event_id from events.ndjson
 * so it joins cleanly with the audit log.
 */

import fs from 'fs';
import path from 'path';

function revertFile(revertsDir, eventId) {
  return path.join(revertsDir, `${eventId}.json`);
}

export function saveRevert(revertsDir, eventId, targetPath, originalContent) {
  fs.mkdirSync(revertsDir, { recursive: true });
  const record = {
    event_id: eventId,
    saved_at: new Date().toISOString(),
    target: targetPath,
    original_content: originalContent,
  };
  fs.writeFileSync(revertFile(revertsDir, eventId), JSON.stringify(record, null, 2));
  return eventId;
}

export function applyRevert(revertsDir, eventId) {
  const f = revertFile(revertsDir, eventId);
  if (!fs.existsSync(f)) throw new Error(`No revert for ${eventId}`);
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(r.target, r.original_content);
  return r;
}

export function listReverts(revertsDir) {
  if (!fs.existsSync(revertsDir)) return [];
  return fs.readdirSync(revertsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(revertsDir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}
