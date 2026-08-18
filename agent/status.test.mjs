import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentDB } from './db.mjs';
import { advanceStatus } from './status.mjs';
import { loadConfig } from './config.mjs';

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-status-test-'));
  const db = new AgentDB(path.join(dir, 'test.db'));
  return { db, dir };
}

test('advanceStatus updates both the application and job rows', async () => {
  const { db, dir } = tmpDb();
  const cfg = loadConfig({}); // SYNC_TO_LEGACY_TRACKER unset -> tracker bridge skipped
  try {
    const jobId = db.upsertJob({ source: 'greenhouse', company: 'Acme', title: 'SWE', url: 'https://x.com/1', discoveredAt: new Date().toISOString() });
    const appId = db.ensureApplication(jobId, 'Acme', 'SWE');

    await advanceStatus({ db, applicationId: appId, jobId, toStatus: 'QUALIFIED', config: cfg });
    assert.equal(db.getApplication(appId).status, 'QUALIFIED');
    assert.equal(db.getJob(jobId).status, 'QUALIFIED');

    await advanceStatus({ db, applicationId: appId, jobId, toStatus: 'HUMAN_REVIEW', reason: 'needs a look', config: cfg });
    assert.equal(db.getApplication(appId).status, 'HUMAN_REVIEW');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
