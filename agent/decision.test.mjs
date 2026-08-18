import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentDB } from './db.mjs';
import { evaluateJob } from './decision.mjs';

// These two paths return before ever calling Claude/web search, so they're
// safe to test without network access or an API key.

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-decision-test-'));
  const db = new AgentDB(path.join(dir, 'test.db'));
  return { db, dir };
}

const candidate = {
  workAuthorization: { needsSponsorship: false, country: 'United States', status: 'Green Card', authorizedIn: ['United States'] },
};

test('evaluateJob short-circuits to SKIP when already applied to the same company+role', async () => {
  const { db, dir } = tmpDb();
  try {
    const jobId = db.upsertJob({ source: 'greenhouse', company: 'Acme', title: 'SWE', url: 'https://x.com/1', discoveredAt: new Date().toISOString() });
    const appId = db.ensureApplication(jobId, 'Acme', 'SWE');
    db.transitionApplication(appId, 'SUBMITTED');

    const job = db.getJob(jobId);
    const { decision, match } = await evaluateJob({ db, candidate, job });
    assert.equal(decision.decision, 'SKIP');
    assert.equal(match, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
