import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentDB } from './db.mjs';
import { analyzeOutcomes } from './learning.mjs';

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-learning-test-'));
  const db = new AgentDB(path.join(dir, 'test.db'));
  return { db, dir };
}

function seed(db, { company, title, source, score, outcome }) {
  const jobId = db.upsertJob({ source, company, title, url: `https://x.com/${Math.random()}`, discoveredAt: new Date().toISOString() });
  db.insertMatch(jobId, { score, tier: 'strong', strengths: [], gaps: [] }, { decision: 'APPLY', eligibilityIssues: [] });
  const appId = db.ensureApplication(jobId, company, title);
  db.transitionApplication(appId, 'SUBMITTED', { patch: { dateApplied: new Date().toISOString() } });
  if (outcome !== 'SUBMITTED') db.transitionApplication(appId, outcome);
}

test('analyzeOutcomes computes advance rate by score band without touching candidate data', () => {
  const { db, dir } = tmpDb();
  try {
    seed(db, { company: 'A', title: 'SWE', source: 'greenhouse', score: 95, outcome: 'INTERVIEW' });
    seed(db, { company: 'B', title: 'SWE', source: 'greenhouse', score: 92, outcome: 'REJECTED' });
    seed(db, { company: 'C', title: 'AI Engineer', source: 'lever', score: 65, outcome: 'REJECTED' });

    const report = analyzeOutcomes(db);
    assert.equal(report.totalTrackedApplications, 3);
    const band90 = report.byScoreBand.find((b) => b.band === '90-100');
    assert.equal(band90.applications, 2);
    assert.equal(band90.advanced, 1);
    assert.equal(band90.rate, 0.5);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
