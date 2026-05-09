import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { saveRevert, applyRevert, listReverts } from './revert.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'revert-'));
}

test('saveRevert + applyRevert round-trips file content', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'route.md');
  fs.writeFileSync(target, 'original content\n');

  const id = saveRevert(dir, 'evt_abc', target, 'original content\n');

  // Now mutate the file
  fs.writeFileSync(target, 'modified content\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'modified content\n');

  // Apply revert
  const result = applyRevert(dir, id);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'original content\n');
  assert.strictEqual(result.target, target);
});

test('listReverts returns reverts ordered newest first', async () => {
  const dir = tmpDir();
  saveRevert(dir, 'evt_first', '/tmp/a', 'a');
  await new Promise(r => setTimeout(r, 10));
  saveRevert(dir, 'evt_second', '/tmp/b', 'b');
  await new Promise(r => setTimeout(r, 10));
  saveRevert(dir, 'evt_third', '/tmp/c', 'c');

  const list = listReverts(dir);
  assert.strictEqual(list.length, 3);
  assert.strictEqual(list[0].event_id, 'evt_third');
  assert.strictEqual(list[2].event_id, 'evt_first');
});

test('listReverts: returns [] when reverts dir does not exist', () => {
  const dir = path.join(tmpDir(), 'nonexistent-subdir');
  assert.deepStrictEqual(listReverts(dir), []);
});

test('applyRevert: throws when event_id not found', () => {
  const dir = tmpDir();
  assert.throws(() => applyRevert(dir, 'evt_nope'), /No revert/);
});

test('saveRevert: includes saved_at timestamp', () => {
  const dir = tmpDir();
  saveRevert(dir, 'evt_x', '/tmp/x', 'x');
  const list = listReverts(dir);
  assert.match(list[0].saved_at, /^\d{4}-\d{2}-\d{2}T/);
});
