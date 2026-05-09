/**
 * explain.js — Reconstruct a session's hook timeline from events.ndjson.
 *
 * Pairs `phase: start` records with their matching `phase: end` records
 * (keyed by hook + handler within the session), computing duration. Surfaces
 * orphan starts (no matching end → hook crashed/timed out) and standalone
 * `phase: error` records as separate timeline entries.
 *
 * Powers `harness-harness explain [session]`.
 */

import { readEvents } from './event-log.js';

export function explainSession(eventsFile, sessionId) {
  const events = readEvents(eventsFile, { session_id: sessionId });
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const timeline = [];
  const pending = new Map(); // key: hook::handler → start event

  for (const e of events) {
    const key = `${e.hook}::${e.handler}`;
    if (e.phase === 'start') {
      pending.set(key, e);
    } else if (e.phase === 'end' && pending.has(key)) {
      const start = pending.get(key);
      pending.delete(key);
      timeline.push({
        hook: e.hook,
        handler: e.handler,
        ts: start.ts,
        duration_ms: new Date(e.ts) - new Date(start.ts),
        status: (e.exit_code ?? 0) === 0 ? 'ok' : 'fail',
        exit_code: e.exit_code ?? 0,
        outputs: e.outputs ?? null,
      });
    } else if (e.phase === 'end') {
      // Standalone end event (no matching start — e.g. PostToolUse trace-capture
      // emits only end). Treat as a single-shot entry with no duration.
      timeline.push({
        hook: e.hook,
        handler: e.handler,
        ts: e.ts,
        status: (e.exit_code ?? 0) === 0 ? 'ok' : 'fail',
        exit_code: e.exit_code ?? 0,
        outputs: e.outputs ?? null,
      });
    } else if (e.phase === 'error') {
      timeline.push({
        hook: e.hook,
        handler: e.handler,
        ts: e.ts,
        status: 'error',
        step: e.step,
        error: e.error,
        fatal: e.fatal ?? false,
      });
    } else if (e.phase === 'decision') {
      timeline.push({
        hook: e.hook,
        handler: e.handler,
        ts: e.ts,
        status: 'decision',
        decision: e.decision ?? e.extra ?? null,
      });
    }
  }

  // Anything still in pending = orphan (start without matching end → crashed)
  for (const start of pending.values()) {
    timeline.push({
      hook: start.hook,
      handler: start.handler,
      ts: start.ts,
      status: 'orphan',
    });
  }

  timeline.sort((a, b) => a.ts.localeCompare(b.ts));
  return { session_id: sessionId, event_count: events.length, timeline };
}
