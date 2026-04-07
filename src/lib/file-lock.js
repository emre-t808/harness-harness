/**
 * file-lock.js — Simple file-based locking (git .lock pattern).
 * Prevents corruption when multiple developers run hooks simultaneously.
 *
 * Uses O_EXCL for atomic lock acquisition (no TOCTOU race).
 */
import fs from 'fs';

const DEFAULT_TIMEOUT_MS = 5000;
const STALE_LOCK_AGE_MS = 30000;
const POLL_INTERVAL_MS = 50;

function tryAcquireLock(lockPath) {
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err; // Unexpected error (permissions, etc.)
  }
}

function recoverStaleLock(lockPath) {
  try {
    const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (lockAge > STALE_LOCK_AGE_MS) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    // Lock was removed by another process — that's fine, we can retry
    return true;
  }
  return false;
}

export function withFileLock(filePath, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const lockPath = filePath + '.lock';
  const start = Date.now();

  while (!tryAcquireLock(lockPath)) {
    // Lock exists — check if stale
    recoverStaleLock(lockPath);

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Lock timeout: ${lockPath}`);
    }

    // Brief spin wait
    const waitEnd = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < waitEnd) { /* spin */ }
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already cleaned */ }
  }
}
