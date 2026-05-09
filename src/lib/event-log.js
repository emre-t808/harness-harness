/**
 * event-log.js — Append-only NDJSON observability layer.
 *
 * Every hook in the harness writes one or more events here. The log is the
 * single source of truth for "what did the harness do, when, and why".
 *
 * Use logEvent() from Node hooks; bash hooks use templates/hooks/lib/event-log.sh.
 * Use readEvents() / explainSession (see explain.js) to query.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function newEventId() {
  return 'evt_' + crypto.randomBytes(8).toString('hex');
}

function rotate(file) {
  const archived = file + '.1';
  try { if (fs.existsSync(archived)) fs.unlinkSync(archived); } catch { /* ignore */ }
  try { fs.renameSync(file, archived); } catch { /* concurrent rotation; ignore */ }
}

export function logEvent(file, fields, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const record = {
    ts: new Date().toISOString(),
    event_id: newEventId(),
    ...fields,
  };
  const line = JSON.stringify(record) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_APPEND on POSIX is atomic for writes ≤ PIPE_BUF (4KB on Linux/macOS).
  // Events are tiny (~200 bytes typical, ~2KB worst case), so plain appendFileSync is safe.
  fs.appendFileSync(file, line);
  try {
    if (fs.statSync(file).size >= maxBytes) rotate(file);
  } catch { /* file disappeared due to concurrent rotation */ }
  return record;
}

export function readEvents(file, filter = {}) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const ln of lines) {
    try { events.push(JSON.parse(ln)); } catch { /* skip malformed */ }
  }
  if (Object.keys(filter).length === 0) return events;
  return events.filter(e => {
    for (const [k, v] of Object.entries(filter)) {
      if (e[k] !== v) return false;
    }
    return true;
  });
}
