import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireScanLock, releaseScanLock } from './scan-lock.mjs';

function tmpLockPath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-lock-test-'));
  return { dir, lockPath: path.join(dir, 'scan.lock') };
}

test('acquireScanLock grants the lock when none is held', () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    assert.equal(acquireScanLock(lockPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireScanLock refuses a second acquire while the first is held (no overlapping cycles)', () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    assert.equal(acquireScanLock(lockPath), true);
    assert.equal(acquireScanLock(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseScanLock lets a later acquire succeed', () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    assert.equal(acquireScanLock(lockPath), true);
    releaseScanLock(lockPath);
    assert.equal(acquireScanLock(lockPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock (crashed process) is treated as free', () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date(Date.now() - 3600_000).toISOString() }));
    assert.equal(acquireScanLock(lockPath, 30 * 60_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead pid is reclaimed immediately even if very recent — regression for a real bug', () => {
  // Reproduces exactly what happened in production: a process was force-killed
  // (e.g. `taskkill /F`, a crash) mid-scan, seconds ago, so releaseScanLock()'s
  // finally block never ran. The old age-only check treated that as "held"
  // for up to 30 minutes even though the owning process was provably gone —
  // acquireScanLock now asks the OS whether the pid is actually alive instead.
  const { dir, lockPath } = tmpLockPath();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() })); // "just now"
    assert.equal(acquireScanLock(lockPath, 30 * 60_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by a genuinely running process (this test itself) is never reclaimed early', () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    assert.equal(acquireScanLock(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseScanLock on a missing lock file never throws', () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    assert.doesNotThrow(() => releaseScanLock(lockPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
