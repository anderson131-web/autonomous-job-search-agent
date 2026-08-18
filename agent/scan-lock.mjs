// agent/scan-lock.mjs — a simple cross-process lock so two cycles never run
// concurrently against the same database (spec §12: "do not hammer
// websites"; also a real safety property once AUTO_APPLY_ENABLED=true —
// overlapping cycles could double-count rate limits or double-apply to the
// same job). Guards against both: the dashboard's "Run scan now" button
// racing the 24/7 `start` loop, and two dashboard clicks racing each other.

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_STALE_MS = 30 * 60_000; // fallback for a held-but-unverifiable lock (see isPidAlive below)

/**
 * Whether `pid` still refers to a running process, cross-platform (Windows
 * included — verified against both a live and a dead PID). `process.kill`
 * with signal 0 sends no signal, just probes: ESRCH means "no such
 * process," EPERM means it exists but we can't signal it (still alive).
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * @param {string} lockPath
 * @param {number} [staleMs] - Fallback only, for the rare case the lock's
 *   `pid` can't be checked (e.g. corrupt file) — real staleness is
 *   determined by asking the OS whether that pid still exists, so a lock
 *   from a process that crashed or was force-killed is reclaimed
 *   immediately rather than blocking for up to 30 minutes.
 * @returns {boolean} true if the lock was acquired, false if another live process holds it
 */
export function acquireScanLock(lockPath, staleMs = DEFAULT_STALE_MS) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (typeof held.pid === 'number' && isPidAlive(held.pid)) {
        return false; // the owning process is genuinely still running
      }
      // pid is dead (or missing/malformed) — fall back to the age check
      // only when we couldn't determine liveness at all.
      if (typeof held.pid !== 'number') {
        const age = Date.now() - new Date(held.startedAt).getTime();
        if (age < staleMs) return false;
      }
    } catch {
      // Unreadable/corrupt lock file — treat as stale and overwrite below.
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}

export function releaseScanLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone — fine.
  }
}
