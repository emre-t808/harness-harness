// T3: canonical observation transitions (§5.1 table), epoch eligibility
// (§5.2), deterministic replay, atomic persistence, and lock lifetime.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEvidenceStore,
  computeGeneration,
  eligibleObservations,
  loadEvidenceState,
  rebuildRatings,
  resolveObservation,
  saveEvidenceState,
  upsertObservation,
} from './evidence-state.js';
import { withFileLockAsync } from './file-lock.js';

const NOW = new Date('2026-09-10T12:00:00Z');
const EPOCH = '2026-09-01T00:00:00Z';

function summary(overrides = {}) {
  const base = {
    schemaVersion: 2,
    client: 'claude',
    sessionId: 's1',
    storageKey: 'claude--s1',
    startedAt: '2026-09-02T10:00:00Z',
    lastEventAt: '2026-09-02T11:00:00Z',
    route: 'general',
    scorerVersion: 'behavioral-v2',
    signalsHash: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    measurementStatus: 'valid',
    degradedReasons: [],
    scores: [{ rule: 'TR-001', score: 1.0, evidence: 'referenced' }],
  };
  return { ...base, ...overrides };
}

function freshStore() {
  return createEvidenceStore(EPOCH);
}

describe('upsertObservation transition table', () => {
  it('A01: identical hash re-ingested any number of times is a no-op', () => {
    let { store } = upsertObservation(freshStore(), summary(), { now: NOW });
    const generation = computeGeneration(store);
    for (let i = 0; i < 3; i += 1) {
      const result = upsertObservation(store, summary(), { now: NOW });
      assert.equal(result.outcome, 'no-op');
      store = result.store;
    }
    assert.equal(computeGeneration(store), generation);
    assert.deepEqual(rebuildRatings(store), rebuildRatings(store));
  });

  it('A02: overlapping windows count each session once', () => {
    let store = freshStore();
    const sessions = ['a', 'b', 'b', 'c'];
    for (const id of sessions) {
      const record = summary({ sessionId: id, sourceHash: `hash-of-${id}`.padEnd(40, 'x') });
      store = upsertObservation(store, record, { now: NOW }).store;
    }
    assert.equal(eligibleObservations(store).length, 3);
    const ratings = rebuildRatings(store);
    assert.equal(ratings.rules['TR-001'].sessions_injected, 3);
  });

  it('A03: later valid revision replaces; older input is ignored as stale', () => {
    let store = upsertObservation(freshStore(), summary(), { now: NOW }).store;
    const revised = summary({
      lastEventAt: '2026-09-02T12:00:00Z',
      sourceHash: 'c'.repeat(64),
      scores: [{ rule: 'TR-001', score: 0.0, evidence: 'violated' }],
    });
    const replaced = upsertObservation(store, revised, { now: NOW });
    assert.equal(replaced.outcome, 'replaced');
    store = replaced.store;
    assert.equal(eligibleObservations(store).length, 1);
    assert.equal(rebuildRatings(store).rules['TR-001'].sessions_injected, 1);

    const stale = upsertObservation(store, summary(), { now: NOW });
    assert.equal(stale.outcome, 'stale-input');
    assert.equal(computeGeneration(stale.store), computeGeneration(store));
  });

  it('A03: newer degraded revision quarantines the whole session, later valid repair restores', () => {
    let store = upsertObservation(freshStore(), summary(), { now: NOW }).store;
    const degraded = summary({
      lastEventAt: '2026-09-02T13:00:00Z',
      sourceHash: 'd'.repeat(64),
      measurementStatus: 'degraded',
      degradedReasons: ['scorer-error: boom'],
    });
    const quarantined = upsertObservation(store, degraded, { now: NOW });
    assert.equal(quarantined.outcome, 'quarantined');
    store = quarantined.store;
    const node = store.observations['claude--s1'];
    assert.equal(node.eligibility, 'quarantined');
    assert.equal(node.canonical, null);
    assert.equal(node.lastAccepted.sourceHash, 'b'.repeat(64));
    assert.equal(eligibleObservations(store).length, 0);

    // Repeated quarantined input: no-op, quarantine NOT cleared.
    const repeat = upsertObservation(store, degraded, { now: NOW });
    assert.equal(repeat.outcome, 'no-op');
    assert.equal(repeat.store.observations['claude--s1'].eligibility, 'quarantined');

    // Strictly later valid repair restores eligibility.
    const repair = summary({ lastEventAt: '2026-09-02T14:00:00Z', sourceHash: 'e'.repeat(64) });
    const repaired = upsertObservation(store, repair, { now: NOW });
    assert.equal(repaired.outcome, 'replaced');
    assert.equal(repaired.store.observations['claude--s1'].eligibility, 'eligible');
    assert.equal(repaired.store.observations['claude--s1'].quarantine, null);
  });

  it('A03: equal-time conflicting hash quarantines and records both hashes', () => {
    let store = upsertObservation(freshStore(), summary(), { now: NOW }).store;
    const conflict = upsertObservation(store, summary({ sourceHash: 'f'.repeat(64) }), { now: NOW });
    assert.equal(conflict.outcome, 'quarantined');
    const node = conflict.store.observations['claude--s1'];
    assert.deepEqual([...node.quarantine.hashes].sort(), [['b'.repeat(64)], ['f'.repeat(64)]].flat().sort());
    assert.equal(node.quarantine.reason, 'equal-time-conflicting-hash');

    // Explicit resolution from rechecked inputs restores a validated record.
    const resolved = resolveObservation(conflict.store, summary(), 'owner re-checked raw trace', { now: NOW });
    assert.equal(resolved.outcome, 'resolved');
    assert.equal(resolved.store.observations['claude--s1'].eligibility, 'eligible');
    assert.equal(resolved.store.observations['claude--s1'].resolution.reason, 'owner re-checked raw trace');
  });

  it('A04: identical raw session id in two clients stays two observations', () => {
    let store = freshStore();
    store = upsertObservation(store, summary(), { now: NOW }).store;
    store = upsertObservation(store, summary({ client: 'codex', sourceHash: '9'.repeat(64) }), { now: NOW }).store;
    const keys = eligibleObservations(store).map((o) => o.storageKey).sort();
    assert.deepEqual(keys, ['claude--s1', 'codex--s1']);
  });

  it('A05: pre-epoch, epoch-spanning, re-scored and degraded records are excluded with distinct reasons', () => {
    let store = freshStore();
    store = upsertObservation(store, summary({
      sessionId: 'pre', startedAt: '2026-08-20T10:00:00Z', lastEventAt: '2026-08-20T11:00:00Z',
      sourceHash: '1'.repeat(64),
    }), { now: NOW }).store;
    store = upsertObservation(store, summary({
      sessionId: 'span', startedAt: '2026-08-31T23:00:00Z', lastEventAt: '2026-09-01T02:00:00Z',
      sourceHash: '2'.repeat(64),
    }), { now: NOW }).store;
    store = upsertObservation(store, summary({
      sessionId: 'rescored', rescored: true, sourceHash: '3'.repeat(64),
    }), { now: NOW }).store;
    store = upsertObservation(store, summary({
      sessionId: 'degraded', measurementStatus: 'degraded', sourceHash: '4'.repeat(64),
    }), { now: NOW }).store;

    assert.equal(eligibleObservations(store).length, 0);
    const byId = (id) => store.observations[`claude--${id}`];
    assert.equal(byId('pre').eligibility, 'report-only');
    assert.equal(byId('pre').eligibilityReason, 'started-before-epoch');
    assert.equal(byId('span').eligibility, 'report-only');
    assert.equal(byId('rescored').eligibilityReason, 're-scored-pre-epoch-history');
    assert.equal(byId('degraded').eligibility, 'quarantined');
    // Ineligible records remain visible for diagnostics, not silently dropped.
    assert.equal(Object.keys(store.observations).length, 4);
  });

  it('records unresolved input-integrity diagnostics without polluting observations', () => {
    const noKey = upsertObservation(freshStore(), summary({ client: 'gemini' }), { now: NOW });
    assert.equal(noKey.outcome, 'integrity-error');
    assert.equal(Object.keys(noKey.store.observations).length, 0);
    assert.equal(noKey.store.integrityDiagnostics.length, 1);

    const noTime = upsertObservation(freshStore(), summary({ lastEventAt: null, measurementStatus: 'degraded' }), { now: NOW });
    assert.equal(noTime.outcome, 'integrity-error');
  });

  it('future-dated records are treated as degraded input, not accepted', () => {
    const future = upsertObservation(freshStore(), summary({
      lastEventAt: '2027-01-01T00:00:00Z',
    }), { now: NOW });
    assert.equal(future.outcome, 'quarantined');
  });
});

describe('deterministic replay and persistence', () => {
  it('rebuild is stable-ordered and byte-deterministic across repeats', () => {
    let store = freshStore();
    const records = [
      summary({ sessionId: 'z', startedAt: '2026-09-03T10:00:00Z', lastEventAt: '2026-09-03T11:00:00Z', sourceHash: 'z'.repeat(64) }),
      summary({ sessionId: 'a', startedAt: '2026-09-02T10:00:00Z', lastEventAt: '2026-09-02T11:00:00Z', sourceHash: '5'.repeat(64) }),
      summary({ client: 'codex', sessionId: 'a', startedAt: '2026-09-02T10:00:00Z', lastEventAt: '2026-09-02T11:00:00Z', sourceHash: '6'.repeat(64) }),
    ];
    for (const r of records) store = upsertObservation(store, r, { now: NOW }).store;

    const first = rebuildRatings(store);
    const second = rebuildRatings(store);
    assert.deepEqual(first, second);
    assert.equal(first.rules['TR-001'].sessions_injected, 3);
    assert.equal(first.generation, computeGeneration(store));
  });

  it('null / not-applicable scores never increment sessions_injected', () => {
    let store = freshStore();
    store = upsertObservation(store, summary({
      scores: [{ rule: 'TR-001', score: null, evidence: 'not-applicable' }],
    }), { now: NOW }).store;
    store = upsertObservation(store, summary({
      sessionId: 's2', sourceHash: '7'.repeat(64),
      scores: [{ rule: 'TR-001', score: 0.5, evidence: 'behavioral-compliance' }],
    }), { now: NOW }).store;
    assert.equal(rebuildRatings(store).rules['TR-001'].sessions_injected, 1);
  });

  it('save/load round-trips atomically and refuses corrupt or unknown schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
    const paths = { evidenceStateFile: path.join(dir, 'memory', 'evidence-state.json') };
    try {
      const store = upsertObservation(freshStore(), summary(), { now: NOW }).store;
      saveEvidenceState(paths, store);
      assert.deepEqual(loadEvidenceState(paths), store);

      fs.writeFileSync(paths.evidenceStateFile, '{corrupt');
      assert.throws(() => loadEvidenceState(paths), /Refusing an empty reset/);

      fs.writeFileSync(paths.evidenceStateFile, JSON.stringify({ schemaVersion: 99 }));
      assert.throws(() => loadEvidenceState(paths), /unknown schemaVersion 99/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A06: crash between evidence write and ratings write recovers to the same generation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-crash-'));
    const paths = { evidenceStateFile: path.join(dir, 'evidence-state.json') };
    try {
      const store = upsertObservation(freshStore(), summary(), { now: NOW }).store;
      saveEvidenceState(paths, store);
      // Simulated crash: ratings never written. Recovery = pure rebuild.
      const recovered = rebuildRatings(loadEvidenceState(paths));
      assert.deepEqual(recovered, rebuildRatings(store));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('async lock lifetime', () => {
  it('holds the lock through async work and serializes writers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
    const target = path.join(dir, 'state.json');
    const order = [];
    try {
      await Promise.all([
        withFileLockAsync(target, async () => {
          order.push('first-start');
          await new Promise((r) => { setTimeout(r, 150); });
          order.push('first-end');
        }),
        (async () => {
          await new Promise((r) => { setTimeout(r, 20); });
          await withFileLockAsync(target, async () => { order.push('second'); });
        })(),
      ]);
      assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never steals an old lock whose owner is still alive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-live-'));
    const target = path.join(dir, 'state.json');
    const lockPath = `${target}.lock`;
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n2020-01-01T00:00:00Z`);
      const old = new Date(Date.now() - 120000);
      fs.utimesSync(lockPath, old, old);
      await assert.rejects(
        withFileLockAsync(target, async () => {}, 300),
        /Lock timeout/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
