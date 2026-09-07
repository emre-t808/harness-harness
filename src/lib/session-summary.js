/**
 * session-summary.js — canonical session scoring orchestration and the
 * normalized summary v2 contract (harness-reliability PRD §5.1).
 *
 * Every client adapter calls buildSessionSummary(); the Markdown summary and
 * the JSON sidecar derive from the same score object. Degraded measurements
 * carry machine-readable reasons and can never masquerade as valid v2.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { scoreRuleCompliance } from './rule-scoring.js';

export const SCORER_VERSION = 'behavioral-v2';
export const SUMMARY_SCHEMA_VERSION = 2;
export const KNOWN_CLIENTS = ['claude', 'codex'];

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SUPPORTED_EVIDENCE = new Set([
  'violated', 'prevented-mistake', 'content-verified', 'verified-compliance',
  'referenced', 'behavioral-compliance', 'applicable-unmet', 'not-applicable',
  'ignored',
]);

export function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string'
    && sessionId !== '.'
    && sessionId !== '..'
    && SAFE_SESSION_ID.test(sessionId);
}

export function resolveStorageKey(client, sessionId) {
  if (!KNOWN_CLIENTS.includes(client)) {
    throw new Error(`Unknown client "${client}" — expected one of: ${KNOWN_CLIENTS.join(', ')}`);
  }
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`Unsafe session id ${JSON.stringify(sessionId)}`);
  }
  return `${client}--${sessionId}`;
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function collectRules(events, manifest) {
  if (manifest && Array.isArray(manifest.rules_injected)) {
    return manifest.rules_injected
      .map((r) => (typeof r === 'object' && r !== null ? r.id : r))
      .filter((id) => typeof id === 'string');
  }
  const refs = new Set();
  for (const evt of events) {
    for (const r of (evt.referenced_context || [])) refs.add(r);
  }
  return [...refs];
}

export function deriveIntent(events, manifest) {
  for (const evt of events) {
    if (evt.intent && evt.intent !== 'general') return evt.intent;
  }
  if (manifest && manifest.intent) return manifest.intent;
  return 'general';
}

/** The exact event fields that feed scoring — nothing else enters the hash. */
function canonicalEvent(evt) {
  return {
    ts: evt.ts ?? null,
    tool: evt.tool ?? null,
    input_summary: evt.input_summary ?? null,
    files_touched: evt.files_touched ?? [],
    referenced_context: evt.referenced_context ?? [],
    response_snippet: evt.response_snippet ?? null,
  };
}

function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function resolveEventWindow(events, degradedReasons) {
  const instants = events.map((evt) => parseInstant(evt.ts));
  if (events.length === 0 || instants.some((t) => t === null)) {
    degradedReasons.push('missing-event-timestamps');
    return { startedAt: null, lastEventAt: null };
  }
  const startedAt = new Date(Math.min(...instants)).toISOString();
  const lastEventAt = new Date(Math.max(...instants)).toISOString();
  return { startedAt, lastEventAt };
}

function scoreSession(events, rules, signalsConfig, degradedReasons) {
  const ruleObjs = rules.map((id) => ({
    id,
    behavioral_signals: (signalsConfig?.[id] || {}).behavioral_signals,
  }));
  try {
    return scoreRuleCompliance(events, ruleObjs);
  } catch (err) {
    degradedReasons.push(`scorer-error: ${err.message}`);
    return Object.fromEntries(rules.map((id) => [id, { score: null, evidence: 'not-applicable' }]));
  }
}

/**
 * Build the canonical summary for one session.
 *
 * @param {object} input
 * @param {string} input.client - adapter-provided, never guessed
 * @param {string} input.sessionId - raw session id (safe grammar)
 * @param {object[]} input.events - trace events (canonical scoring input)
 * @param {object|null} input.manifest - injection manifest, if available
 * @param {object|null} input.signalsConfig - parsed .harness/rule-signals.json
 * @param {string|null} [input.signalsError] - parse failure of the signal config
 * @param {string} [input.developer]
 * @returns {{ markdown: string, sidecar: object }}
 */
export function buildSessionSummary(input) {
  const {
    client, sessionId, events = [], manifest = null,
    signalsConfig = {}, signalsError = null, developer = 'unknown',
  } = input;
  const storageKey = resolveStorageKey(client, sessionId);
  const degradedReasons = [];

  if (signalsError) degradedReasons.push(`malformed-signals: ${signalsError}`);
  if (!manifest) degradedReasons.push('missing-manifest');
  const { startedAt, lastEventAt } = resolveEventWindow(events, degradedReasons);

  const rules = collectRules(events, manifest);
  const usableSignals = signalsError ? {} : signalsConfig;
  const scores = scoreSession(events, rules, usableSignals, degradedReasons);
  const route = deriveIntent(events, manifest);

  const canonicalInput = {
    client,
    sessionId,
    events: events.map(canonicalEvent),
    rules,
    signals: Object.fromEntries(
      rules.filter((id) => usableSignals?.[id]).map((id) => [id, usableSignals[id]]),
    ),
    scorerVersion: SCORER_VERSION,
  };

  const sidecar = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    client,
    sessionId,
    storageKey,
    startedAt,
    lastEventAt,
    route,
    scorerVersion: SCORER_VERSION,
    signalsHash: hashCanonical({ signals: canonicalInput.signals, scorerVersion: SCORER_VERSION }),
    sourceHash: hashCanonical(canonicalInput),
    measurementStatus: degradedReasons.length > 0 ? 'degraded' : 'valid',
    degradedReasons,
    scores: rules.map((id) => {
      const s = scores[id] || { score: 0, evidence: 'ignored' };
      // score === null is a deliberate 'not-applicable' — preserve it.
      return { rule: id, score: s.score === undefined ? 0 : s.score, evidence: s.evidence };
    }),
  };

  const markdown = renderSummaryMarkdown({
    sessionId, events, route, rules, scores, developer,
    date: (lastEventAt || new Date().toISOString()).slice(0, 10),
    manifest,
  });
  return { markdown, sidecar };
}

function renderScoreTable(rules, scores) {
  if (rules.length === 0) return [];
  const lines = ['### Effectiveness Scores', '', '| Context | Score | Evidence |', '|---------|-------|----------|'];
  for (const r of rules) {
    const s = scores[r] || { score: 0, evidence: 'ignored' };
    const scoreCell = s.score === null ? 'n/a' : s.score.toFixed(1);
    lines.push(`| ${r} | ${scoreCell} | ${s.evidence} |`);
  }
  lines.push('');
  return lines;
}

export function renderSummaryMarkdown({ sessionId, events, route, rules, scores, developer, date, manifest }) {
  const uniqueFiles = [...new Set(events.flatMap((e) => e.files_touched || []))].sort();
  const lines = [
    `## Session ${sessionId} — ${date}`, '',
    `**Developer:** ${developer}`,
    `**Route:** ${route}`,
    `**Tools:** ${events.length}`,
    `**Files:** ${uniqueFiles.length}`, '',
    ...renderScoreTable(rules, scores),
    '### Files Touched', '',
    ...(uniqueFiles.length > 0 ? uniqueFiles.map((f) => `- ${f}`) : ['_None_']),
    '',
  ];
  const totalBytes = events.reduce((sum, e) => sum + (e.output_size || 0), 0);
  lines.push('### Token Utilization', '', `- Output bytes: ${totalBytes}`, `- Estimated tokens: ~${Math.round(totalBytes / 4)}`, '');
  let markdown = lines.join('\n');
  if (manifest) markdown += computeSlotUtilization(manifest, events, scores);
  return markdown;
}

export function computeSlotUtilization(manifest, events, scores) {
  if (!manifest || !manifest.slots) return '';
  const allRefs = new Set(events.flatMap((e) => e.referenced_context || []));
  const rows = [];
  let totalInjected = 0;
  let totalReferenced = 0;
  for (const [name, data] of Object.entries(manifest.slots)) {
    const injected = data.tokens || 0;
    totalInjected += injected;
    const referenced = referencedTokens(name, injected, manifest, scores, allRefs);
    totalReferenced += referenced;
    const util = injected > 0 ? Math.round((referenced / injected) * 100) : 0;
    rows.push(`| ${name.replace(/_/g, ' ')} | ${injected} | ${referenced} | ${util}% |`);
  }
  const totalUtil = totalInjected > 0 ? Math.round((totalReferenced / totalInjected) * 100) : 0;
  return [
    '', '### Slot Utilization', '',
    '| Slot | Injected | Referenced | Utilization |',
    '|---|---|---|---|',
    ...rows,
    `| **Total** | **${totalInjected}** | **${totalReferenced}** | **${totalUtil}%** |`, '',
  ].join('\n');
}

function referencedTokens(name, injected, manifest, scores, allRefs) {
  if (name === 'identity') return injected;
  if (name !== 'route_context') return Math.round(injected * 0.5);
  const ruleIds = (manifest.rules_injected || []).map((r) => (typeof r === 'object' ? r.id : r));
  const scored = ruleIds.map((r) => (scores || {})[r]).filter((s) => s && s.score !== null);
  if (scored.length > 0) {
    return Math.round(injected * (scored.filter((s) => s.score > 0).length / scored.length));
  }
  return Math.round(injected * (ruleIds.filter((r) => allRefs.has(r)).length / Math.max(1, ruleIds.length)));
}

/**
 * Validate a parsed v2 sidecar record at ingestion time (PRD §5.1).
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateSummaryV2(record, { now = new Date() } = {}) {
  const reasons = [];
  if (!record || typeof record !== 'object') return { ok: false, reasons: ['not-an-object'] };
  if (record.schemaVersion !== SUMMARY_SCHEMA_VERSION) reasons.push(`unsupported-schema: ${record.schemaVersion}`);
  if (!KNOWN_CLIENTS.includes(record.client)) reasons.push(`unknown-client: ${record.client}`);
  if (!isSafeSessionId(record.sessionId)) reasons.push('unsafe-session-id');
  if (record.measurementStatus === 'valid') {
    const started = parseInstant(record.startedAt);
    const last = parseInstant(record.lastEventAt);
    if (started === null || last === null) reasons.push('unparseable-timestamps');
    else if (started > last) reasons.push('unordered-timestamps');
    else if (last > now.getTime()) reasons.push('future-dated');
  } else if (record.measurementStatus !== 'degraded') {
    reasons.push(`unknown-measurement-status: ${record.measurementStatus}`);
  }
  if (typeof record.sourceHash !== 'string' || record.sourceHash.length < 32) reasons.push('missing-source-hash');
  validateScores(record.scores, reasons);
  return { ok: reasons.length === 0, reasons };
}

function recentDateDirs(tracesDir, now, windowDays) {
  if (!fs.existsSync(tracesDir)) return [];
  const cutoff = new Date(now.getTime() - windowDays * 86400000).toISOString().slice(0, 10);
  return fs.readdirSync(tracesDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoff)
    .sort();
}

function existingIn(tracesDir, dirs, filename) {
  return dirs
    .map((d) => path.join(tracesDir, d, filename))
    .filter((p) => fs.existsSync(p));
}

/**
 * Locate a session's trace fragments and manifest across date boundaries.
 * Prefixed (<client>--<session>) artifacts win; legacy unprefixed artifacts
 * are used only when no other client claims the same raw session id —
 * otherwise ownership is ambiguous and the fragment is reported, not merged.
 */
export function discoverSessionArtifacts(tracesDir, client, sessionId, { now = new Date(), windowDays = 14 } = {}) {
  const storageKey = resolveStorageKey(client, sessionId);
  const dirs = recentDateDirs(tracesDir, now, windowDays);
  const conflicts = [];

  const otherClientHasArtifacts = KNOWN_CLIENTS
    .filter((c) => c !== client)
    .some((c) => existingIn(tracesDir, dirs, `${c}--${sessionId}.jsonl`).length > 0);

  let eventFiles = existingIn(tracesDir, dirs, `${storageKey}.jsonl`);
  const legacyFiles = existingIn(tracesDir, dirs, `${sessionId}.jsonl`);
  if (eventFiles.length === 0 && legacyFiles.length > 0) {
    if (otherClientHasArtifacts) conflicts.push('ambiguous-legacy-trace');
    else eventFiles = legacyFiles;
  }

  const manifests = existingIn(tracesDir, dirs, `${storageKey}-manifest.json`);
  const legacyManifests = otherClientHasArtifacts
    ? []
    : existingIn(tracesDir, dirs, `${sessionId}-manifest.json`);
  const manifestPath = manifests.at(-1) ?? legacyManifests.at(-1) ?? null;

  return { storageKey, eventFiles, manifestPath, conflicts };
}

function validateScores(scores, reasons) {
  if (!Array.isArray(scores)) {
    reasons.push('scores-not-an-array');
    return;
  }
  for (const entry of scores) {
    if (!entry || typeof entry.rule !== 'string') reasons.push('score-missing-rule');
    else if (entry.score !== null && !Number.isFinite(entry.score)) reasons.push(`non-finite-score: ${entry.rule}`);
    else if (!SUPPORTED_EVIDENCE.has(entry.evidence)) reasons.push(`unsupported-evidence: ${entry.evidence}`);
  }
}
