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
