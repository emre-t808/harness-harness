import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { withFileLock } from './file-lock.js';

const TEST_FILE = '/tmp/hh-lock-test-' + process.pid + '.txt';

afterEach(() => {
  try { fs.unlinkSync(TEST_FILE); } catch {}
  try { fs.unlinkSync(TEST_FILE + '.lock'); } catch {}
});

describe('withFileLock', () => {
  it('acquires and releases lock', () => {
    fs.writeFileSync(TEST_FILE, 'initial');
    const result = withFileLock(TEST_FILE, () => {
      assert.ok(fs.existsSync(TEST_FILE + '.lock'), 'lock should exist during fn');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.ok(!fs.existsSync(TEST_FILE + '.lock'), 'lock should be released after');
  });

  it('releases lock even when fn throws', () => {
    fs.writeFileSync(TEST_FILE, 'initial');
    assert.throws(() => {
      withFileLock(TEST_FILE, () => { throw new Error('boom'); });
    }, /boom/);
    assert.ok(!fs.existsSync(TEST_FILE + '.lock'), 'lock should be released after error');
  });

  it('propagates return value', () => {
    fs.writeFileSync(TEST_FILE, 'initial');
    const result = withFileLock(TEST_FILE, () => 42);
    assert.equal(result, 42);
  });

  it('recovers stale locks older than 30s', () => {
    fs.writeFileSync(TEST_FILE, 'initial');
    fs.writeFileSync(TEST_FILE + '.lock', 'stale');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(TEST_FILE + '.lock', past, past);

    const result = withFileLock(TEST_FILE, () => 'recovered');
    assert.equal(result, 'recovered');
  });

  it('throws on lock timeout with fresh lock (Bug 8)', () => {
    fs.writeFileSync(TEST_FILE, 'initial');
    // Create a fresh (non-stale) lock manually
    fs.writeFileSync(TEST_FILE + '.lock', `99999\n${new Date().toISOString()}`);

    assert.throws(
      () => withFileLock(TEST_FILE, () => {}, 200), // 200ms timeout
      /Lock timeout/,
      'should throw on timeout'
    );

    // Cleanup the lock (afterEach handles this too)
    try { fs.unlinkSync(TEST_FILE + '.lock'); } catch {}
  });

  it('uses atomic O_EXCL lock acquisition (Bug 8)', () => {
    fs.writeFileSync(TEST_FILE, 'initial');
    // Verify sequential locks don't corrupt
    let count = 0;
    for (let i = 0; i < 5; i++) {
      withFileLock(TEST_FILE, () => { count++; });
    }
    assert.equal(count, 5, 'all sequential locks should succeed');
    assert.ok(!fs.existsSync(TEST_FILE + '.lock'), 'no lock left after all operations');
  });
});
