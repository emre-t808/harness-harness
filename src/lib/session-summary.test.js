// T2: canonical session scoring orchestration + summary v2 contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSessionSummary,
  discoverSessionArtifacts,
  hashCanonical,
  resolveStorageKey,
  validateSummaryV2,
} from './session-summary.js';
import { createEvidenceStore, upsertObservation } from './evidence-state.js';

const NOW = new Date('2026-09-07T12:00:00Z');

function event(overrides = {}) {
  return {
    ts: '2026-09-07T10:00:00Z',
    session: 'fixture-session',
    tool: 'Bash',
    input_summary: 'echo hi',
    output_size: 10,
    referenced_context: [],
    files_touched: [],
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildSessionSummary({
    client: 'claude',
    sessionId: 'fixture-session',
    events: [event()],
    manifest: { intent: 'coding:meta', rules_injected: ['TR-001'] },
    signalsConfig: {},
    ...overrides,
  });
}

const WRITE_SIGNAL = {
  'TR-001': {
    behavioral_signals: [
      { trigger: { tool: ['Write'] }, expect: { present: true } },
    ],
  },
};
const FORBIDDEN_SIGNAL = {
  'TR-001': {
    behavioral_signals: [
      { trigger: { tool: ['Write'] }, expect: { file_not_modified: 'forbidden/**' } },
    ],
  },
};

test('storage key requires a known client and safe session id', () => {
  assert.equal(resolveStorageKey('claude', 'abc'), 'claude--abc');
  assert.throws(() => resolveStorageKey('gemini', 'abc'), /Unknown client/);
  assert.throws(() => resolveStorageKey('claude', '../escape'), /Unsafe session/);
});

test('behavioral compliance: signal met without citation scores 0.5', () => {
  const { sidecar } = build({
    events: [event({ tool: 'Write', files_touched: ['src/a.js'] })],
    signalsConfig: WRITE_SIGNAL,
  });
  assert.deepEqual(sidecar.scores, [
    { rule: 'TR-001', score: 0.5, evidence: 'behavioral-compliance' },
  ]);
  assert.equal(sidecar.measurementStatus, 'valid');
});

test('violation trumps citation', () => {
  const { sidecar, markdown } = build({
    events: [event({
      tool: 'Write',
      files_touched: ['forbidden/x.js'],
      referenced_context: ['TR-001'],
    })],
    signalsConfig: FORBIDDEN_SIGNAL,
  });
  assert.deepEqual(sidecar.scores, [{ rule: 'TR-001', score: 0, evidence: 'violated' }]);
  assert.match(markdown, /\| TR-001 \| 0\.0 \| violated \|/);
});

test('not-applicable stays null in sidecar and n/a in markdown', () => {
  const { sidecar, markdown } = build({ signalsConfig: WRITE_SIGNAL });
  assert.deepEqual(sidecar.scores, [{ rule: 'TR-001', score: null, evidence: 'not-applicable' }]);
  assert.match(markdown, /\| TR-001 \| n\/a \| not-applicable \|/);
});

test('applicable-unmet when the trigger fires but no expectation is met', () => {
  const { sidecar } = build({
    events: [event({ tool: 'Write', files_touched: ['src/a.js'] })],
    signalsConfig: {
      'TR-001': {
        behavioral_signals: [
          { trigger: { tool: ['Write'] }, expect: { sibling_file_touched: '*.test.js' } },
        ],
      },
    },
  });
  assert.deepEqual(sidecar.scores, [{ rule: 'TR-001', score: 0, evidence: 'applicable-unmet' }]);
});

test('unsupported tool data does not fire tool-filtered signals or crash', () => {
  const { sidecar } = build({
    events: [event({ tool: 'SomeFutureTool', input_summary: 'mystery blob' })],
    signalsConfig: WRITE_SIGNAL,
  });
  assert.equal(sidecar.measurementStatus, 'valid');
  assert.deepEqual(sidecar.scores, [{ rule: 'TR-001', score: null, evidence: 'not-applicable' }]);
});

test('malformed signal config degrades the measurement with a reason', () => {
  const { sidecar } = build({ signalsError: 'Unexpected token' });
  assert.equal(sidecar.measurementStatus, 'degraded');
  assert.ok(sidecar.degradedReasons.some((r) => r.startsWith('malformed-signals')));
});

test('missing manifest and missing timestamps degrade, never fabricate dates', () => {
  const { sidecar } = build({ manifest: null, events: [event({ ts: undefined })] });
  assert.equal(sidecar.measurementStatus, 'degraded');
  assert.ok(sidecar.degradedReasons.includes('missing-manifest'));
  assert.ok(sidecar.degradedReasons.includes('missing-event-timestamps'));
  assert.equal(sidecar.startedAt, null);
  assert.equal(sidecar.lastEventAt, null);
});

test('identical inputs produce identical hashes; different events differ', () => {
  const first = build();
  const second = build();
  assert.equal(first.sidecar.sourceHash, second.sidecar.sourceHash);
  assert.equal(first.sidecar.signalsHash, second.sidecar.signalsHash);
  const changed = build({ events: [event({ input_summary: 'echo other' })] });
  assert.notEqual(changed.sidecar.sourceHash, first.sidecar.sourceHash);
});

test('event window spans multiple days and orders start before last', () => {
  const { sidecar } = build({
    events: [
      event({ ts: '2026-09-06T23:59:00Z' }),
      event({ ts: '2026-09-07T00:10:00Z', tool: 'Read' }),
    ],
  });
  assert.equal(sidecar.startedAt, '2026-09-06T23:59:00.000Z');
  assert.equal(sidecar.lastEventAt, '2026-09-07T00:10:00.000Z');
});

test('canonical hashing is key-order independent', () => {
  assert.equal(hashCanonical({ a: 1, b: [{ c: 2, d: 3 }] }), hashCanonical({ b: [{ d: 3, c: 2 }], a: 1 }));
});

test('validateSummaryV2 accepts a built sidecar and rejects tampering', () => {
  const { sidecar } = build();
  assert.deepEqual(validateSummaryV2(sidecar, { now: NOW }), { ok: true, reasons: [] });

  const future = { ...sidecar, lastEventAt: '2027-01-01T00:00:00Z' };
  assert.ok(validateSummaryV2(future, { now: NOW }).reasons.includes('future-dated'));

  const badScore = { ...sidecar, scores: [{ rule: 'TR-001', score: NaN, evidence: 'referenced' }] };
  assert.ok(validateSummaryV2(badScore, { now: NOW }).reasons.some((r) => r.startsWith('non-finite-score')));

  const badEvidence = { ...sidecar, scores: [{ rule: 'TR-001', score: 1, evidence: 'vibes' }] };
  assert.ok(validateSummaryV2(badEvidence, { now: NOW }).reasons.some((r) => r.startsWith('unsupported-evidence')));

  const badSchema = { ...sidecar, schemaVersion: 3 };
  assert.ok(validateSummaryV2(badSchema, { now: NOW }).reasons.some((r) => r.startsWith('unsupported-schema')));
});

test('discoverSessionArtifacts merges date fragments and guards legacy ambiguity', () => {
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-discover-'));
  try {
    fs.mkdirSync(path.join(tracesDir, '2026-09-06'));
    fs.mkdirSync(path.join(tracesDir, '2026-09-07'));
    fs.writeFileSync(path.join(tracesDir, '2026-09-06', 'claude--s1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tracesDir, '2026-09-07', 'claude--s1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tracesDir, '2026-09-07', 'claude--s1-manifest.json'), '{}');

    const found = discoverSessionArtifacts(tracesDir, 'claude', 's1', { now: NOW });
    assert.equal(found.eventFiles.length, 2);
    assert.ok(found.manifestPath.endsWith('claude--s1-manifest.json'));
    assert.deepEqual(found.conflicts, []);

    // Legacy fragment with no prefixed artifacts: adopted.
    fs.writeFileSync(path.join(tracesDir, '2026-09-07', 's2.jsonl'), '{}\n');
    const legacy = discoverSessionArtifacts(tracesDir, 'claude', 's2', { now: NOW });
    assert.equal(legacy.eventFiles.length, 1);

    // Legacy fragment while another client claims the same raw id: conflict.
    fs.writeFileSync(path.join(tracesDir, '2026-09-07', 'codex--s2.jsonl'), '{}\n');
    const ambiguous = discoverSessionArtifacts(tracesDir, 'claude', 's2', { now: NOW });
    assert.deepEqual(ambiguous.eventFiles, []);
    assert.deepEqual(ambiguous.conflicts, ['ambiguous-legacy-trace']);
  } finally {
    fs.rmSync(tracesDir, { recursive: true, force: true });
  }
});

// OI-R73: the Stop hook rewrites the sidecar every turn. A turn with no tool
// calls still rewrites the manifest (a new prompt re-routes the session), so
// `rules` and `sourceHash` change while the last trace event does not. If the
// revision time stays put, the store sees two hashes at one instant and
// quarantines the session, which drops it out of the eligible count (OI-V37).
// Replays live session claude--8a711e3a: last event 13:09:31, manifest
// rewritten at 13:18:16 with other rules.
test('a tool-less turn that re-routes the session replaces its observation, not quarantines it', () => {
  const events = [event({ ts: '2026-09-07T09:00:00Z' }), event({ ts: '2026-09-07T10:00:00Z', tool: 'Read' })];
  const before = build({ events, manifest: { rules_injected: ['TR-001'], generated_at: '2026-09-07T08:59:00.000Z' } });
  const after = build({ events, manifest: { rules_injected: ['TR-002'], generated_at: '2026-09-07T11:00:00.000Z' } });
  assert.notEqual(after.sidecar.sourceHash, before.sidecar.sourceHash, 'the rules are a scoring input');

  const first = upsertObservation(createEvidenceStore('2026-09-01T00:00:00Z'), before.sidecar, { now: NOW });
  assert.equal(first.outcome, 'accepted');
  const second = upsertObservation(first.store, after.sidecar, { now: NOW });
  assert.equal(second.outcome, 'replaced', second.reason);
  const node = second.store.observations['claude--fixture-session'];
  assert.equal(node.eligibility, 'eligible');
  assert.equal(node.canonical.sourceHash, after.sidecar.sourceHash);
  assert.deepEqual(node.canonical.scores.map((s) => s.rule), ['TR-002']);
  assert.equal(before.sidecar.lastEventAt, '2026-09-07T10:00:00.000Z', 'an older manifest never moves the time back');
  assert.equal(after.sidecar.lastEventAt, '2026-09-07T11:00:00.000Z');
});

test('the manifest stamp orders revisions but never enters the hash or invents a time', () => {
  const plain = build({ manifest: { rules_injected: ['TR-001'] } });
  const stamped = build({ manifest: { rules_injected: ['TR-001'], generated_at: '2026-09-07T11:00:00.000Z' } });
  // Same scoring inputs, same hash: re-asking a prompt with the same rules is a no-op.
  assert.equal(stamped.sidecar.sourceHash, plain.sidecar.sourceHash);
  // A legacy manifest (no stamp) keeps the event-only window, byte for byte.
  assert.equal(plain.sidecar.lastEventAt, '2026-09-07T10:00:00.000Z');
  const junk = build({ manifest: { rules_injected: ['TR-001'], generated_at: 'not-a-time' } });
  assert.equal(junk.sidecar.lastEventAt, '2026-09-07T10:00:00.000Z');
  // No trace events: still degraded with no dates, even with a stamped manifest.
  const empty = build({ events: [], manifest: { rules_injected: ['TR-001'], generated_at: '2026-09-07T11:00:00.000Z' } });
  assert.equal(empty.sidecar.measurementStatus, 'degraded');
  assert.equal(empty.sidecar.lastEventAt, null);
  assert.equal(empty.sidecar.startedAt, null);
});
