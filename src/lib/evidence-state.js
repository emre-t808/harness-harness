/**
 * evidence-state.js — canonical observation store and deterministic replay
 * (harness-reliability PRD §5.2).
 *
 * One canonical observation per (client, sessionId). Revisions replace;
 * degraded or conflicting revisions quarantine the whole session; derived
 * ratings are rebuilt from the store, never incrementally re-applied. The
 * store holds hashes, IDs, evidence enums and numbers — no transcripts.
 */

import fs from 'fs';
import path from 'path';
import {
  hashCanonical,
  resolveStorageKey,
  validateSummaryV2,
} from './session-summary.js';
import { processSession } from './rule-rating.js';

export const EVIDENCE_SCHEMA_VERSION = 2;
const MAX_INTEGRITY_DIAGNOSTICS = 50;

export function createEvidenceStore(epochStartedAt) {
  const time = Date.parse(epochStartedAt);
  if (!Number.isFinite(time)) {
    throw new Error(`Epoch start must be a parseable UTC instant, got ${JSON.stringify(epochStartedAt)}`);
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    epoch: { startedAt: new Date(time).toISOString() },
    observations: {},
    integrityDiagnostics: [],
  };
}

function compactObservation(summary) {
  return {
    client: summary.client,
    sessionId: summary.sessionId,
    startedAt: summary.startedAt ?? null,
    lastEventAt: summary.lastEventAt ?? null,
    route: summary.route ?? 'general',
    scorerVersion: summary.scorerVersion ?? null,
    signalsHash: summary.signalsHash ?? null,
    sourceHash: summary.sourceHash,
    measurementStatus: summary.measurementStatus,
    rescored: summary.rescored === true,
    scores: (summary.scores || []).map((s) => ({ rule: s.rule, score: s.score, evidence: s.evidence })),
  };
}

function parseTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function cloneStore(store) {
  return {
    ...store,
    observations: { ...store.observations },
    integrityDiagnostics: [...(store.integrityDiagnostics || [])],
  };
}

function eligibilityFor(node, epoch) {
  if (node.quarantine) return { eligibility: 'quarantined', reason: node.quarantine.reason };
  const canonical = node.canonical;
  if (!canonical) return { eligibility: 'quarantined', reason: 'no-canonical-observation' };
  if (canonical.rescored) return { eligibility: 'report-only', reason: 're-scored-pre-epoch-history' };
  const started = parseTime(canonical.startedAt);
  if (started === null || started < Date.parse(epoch.startedAt)) {
    return { eligibility: 'report-only', reason: 'started-before-epoch' };
  }
  return { eligibility: 'eligible', reason: 'valid-post-epoch-observation' };
}

function finalizeNode(node, epoch) {
  const { eligibility, reason } = eligibilityFor(node, epoch);
  return { ...node, eligibility, eligibilityReason: reason };
}

function latestKnown(node) {
  const times = [parseTime(node.canonical?.lastEventAt), parseTime(node.quarantine?.at)]
    .filter((t) => t !== null);
  const hashes = [node.canonical?.sourceHash, ...(node.quarantine?.hashes || [])]
    .filter(Boolean);
  return { time: times.length > 0 ? Math.max(...times) : null, hashes: new Set(hashes) };
}

function recordIntegrityError(store, summary, reasons) {
  const next = cloneStore(store);
  next.integrityDiagnostics.push({
    reason: 'input-integrity',
    detail: reasons,
    sourceHash: typeof summary?.sourceHash === 'string' ? summary.sourceHash : null,
    lastEventAt: summary?.lastEventAt ?? null,
  });
  if (next.integrityDiagnostics.length > MAX_INTEGRITY_DIAGNOSTICS) {
    next.integrityDiagnostics = next.integrityDiagnostics.slice(-MAX_INTEGRITY_DIAGNOSTICS);
  }
  return { store: next, outcome: 'integrity-error', reason: reasons.join('; ') };
}

function classifyIncoming(summary, now) {
  const validation = validateSummaryV2(summary, { now });
  const degraded = !validation.ok || summary.measurementStatus !== 'valid';
  let storageKey = null;
  try {
    storageKey = resolveStorageKey(summary.client, summary.sessionId);
  } catch { /* untrustworthy key */ }
  const incomingTime = parseTime(summary.lastEventAt);
  const trustworthy = storageKey !== null && incomingTime !== null
    && typeof summary.sourceHash === 'string' && summary.sourceHash.length >= 32;
  return { validation, degraded, storageKey, incomingTime, trustworthy };
}

function applyQuarantine(node, summary, incomingTime, reason) {
  const hashes = [...new Set([
    ...(node?.quarantine?.hashes || []),
    ...(node?.canonical ? [node.canonical.sourceHash] : []),
    summary.sourceHash,
  ])];
  return {
    canonical: null,
    lastAccepted: node?.canonical ?? node?.lastAccepted ?? null,
    quarantine: { reason, at: new Date(incomingTime).toISOString(), hashes },
  };
}

/**
 * Ingest one summary record, applying the §5.1 revision transition table.
 * Pure: returns a new store. @returns {{ store, outcome, reason }}
 */
export function upsertObservation(store, summary, { now = new Date() } = {}) {
  const { validation, degraded, storageKey, incomingTime, trustworthy } = classifyIncoming(summary, now);
  if (!trustworthy) {
    return recordIntegrityError(store, summary, validation.ok ? ['untrustworthy-key-or-time'] : validation.reasons);
  }

  const existing = store.observations[storageKey];
  const decide = () => {
    if (existing) {
      const { time: latestTime, hashes } = latestKnown(existing);
      if (hashes.has(summary.sourceHash)) return { node: existing, outcome: 'no-op', reason: 'identical-hash' };
      if (latestTime !== null && incomingTime < latestTime) {
        return { node: existing, outcome: 'stale-input', reason: `older revision (${summary.lastEventAt}) ignored` };
      }
      if (latestTime !== null && incomingTime === latestTime) {
        return {
          node: applyQuarantine(existing, summary, incomingTime, 'equal-time-conflicting-hash'),
          outcome: 'quarantined',
          reason: 'equal-time conflicting hashes recorded',
        };
      }
    }
    if (degraded) {
      const reason = existing ? 'later-degraded-revision' : 'degraded-input';
      return { node: applyQuarantine(existing, summary, incomingTime, reason), outcome: 'quarantined', reason };
    }
    return {
      node: { canonical: compactObservation(summary), lastAccepted: null, quarantine: null },
      outcome: existing ? 'replaced' : 'accepted',
      reason: existing ? 'later valid revision replaces observation' : 'new canonical observation',
    };
  };

  const { node, outcome, reason } = decide();
  if (outcome === 'no-op' || outcome === 'stale-input') return { store, outcome, reason };
  const next = cloneStore(store);
  next.observations[storageKey] = finalizeNode(node, next.epoch);
  return { store: next, outcome, reason };
}

/**
 * Explicit resolution from rechecked authoritative inputs (§5.1 last row).
 * Accepts only a fully valid record; records the chosen hash and reason.
 */
export function resolveObservation(store, summary, resolutionReason, { now = new Date() } = {}) {
  const validation = validateSummaryV2(summary, { now });
  if (!validation.ok || summary.measurementStatus !== 'valid') {
    return { store, outcome: 'rejected', reason: `resolution input not valid: ${validation.reasons.join('; ')}` };
  }
  const storageKey = resolveStorageKey(summary.client, summary.sessionId);
  const next = cloneStore(store);
  next.observations[storageKey] = finalizeNode({
    canonical: compactObservation(summary),
    lastAccepted: null,
    quarantine: null,
    resolution: { reason: resolutionReason, sourceHash: summary.sourceHash },
  }, next.epoch);
  return { store: next, outcome: 'resolved', reason: resolutionReason };
}

export function eligibleObservations(store) {
  return Object.entries(store.observations)
    .filter(([, node]) => node.eligibility === 'eligible' && node.canonical)
    .map(([storageKey, node]) => ({ storageKey, ...node.canonical }))
    .sort((a, b) =>
      (a.startedAt || '').localeCompare(b.startedAt || '')
      || a.client.localeCompare(b.client)
      || a.sessionId.localeCompare(b.sessionId));
}

export function computeGeneration(store) {
  return hashCanonical({
    schemaVersion: store.schemaVersion,
    epoch: store.epoch,
    observations: Object.keys(store.observations).sort().map((key) => {
      const node = store.observations[key];
      return [key, node.canonical?.sourceHash ?? null, node.quarantine?.hashes ?? null, node.eligibility];
    }),
  });
}

/**
 * Deterministic full replay: eligible observations in stable order, one
 * session each, null scores excluded. Identical stores → identical output.
 */
export function rebuildRatings(store) {
  let ratingState = { rules: {} };
  for (const observation of eligibleObservations(store)) {
    const sessionScores = observation.scores
      .filter((s) => s.score !== null)
      .map((s) => ({ ruleId: s.rule, evidence: s.evidence }));
    ratingState = processSession(ratingState, sessionScores, {
      asOf: (observation.lastEventAt || '').slice(0, 10) || null,
    });
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generation: computeGeneration(store),
    rules: ratingState.rules,
  };
}

export function loadEvidenceState(paths) {
  if (!fs.existsSync(paths.evidenceStateFile)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.evidenceStateFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `${paths.evidenceStateFile} is corrupt (${err.message}). Refusing an empty reset — `
      + 'restore it from backup or re-run migrate-evidence after inspecting it.',
    );
  }
  if (parsed?.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `${paths.evidenceStateFile} has unknown schemaVersion ${parsed?.schemaVersion}; `
      + `this build supports ${EVIDENCE_SCHEMA_VERSION}. Migrate deliberately, never overwrite.`,
    );
  }
  return parsed;
}

export function saveEvidenceState(paths, store) {
  const file = paths.evidenceStateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function saveRatingStateV2(paths, rebuilt) {
  const file = paths.ratingStateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
