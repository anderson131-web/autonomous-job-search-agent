import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentDB } from './db.mjs';

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-db-test-'));
  const db = new AgentDB(path.join(dir, 'test.db'));
  return { db, dir };
}

test('upsertJob dedupes by URL', () => {
  const { db, dir } = tmpDb();
  try {
    const id1 = db.upsertJob({ source: 'greenhouse', company: 'Acme', title: 'SWE', url: 'https://x.com/1', discoveredAt: new Date().toISOString() });
    const id2 = db.upsertJob({ source: 'greenhouse', company: 'Acme', title: 'SWE', url: 'https://x.com/1', discoveredAt: new Date().toISOString() });
    assert.equal(id1, id2);
    assert.equal(db.hasJobUrl('https://x.com/1'), true);
    assert.equal(db.hasJobUrl('https://x.com/2'), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureApplication + transitionApplication drive the state machine and log history', () => {
  const { db, dir } = tmpDb();
  try {
    const jobId = db.upsertJob({ source: 'lever', company: 'Beta', title: 'AI Engineer', url: 'https://x.com/2', discoveredAt: new Date().toISOString() });
    const appId = db.ensureApplication(jobId, 'Beta', 'AI Engineer');
    const appIdAgain = db.ensureApplication(jobId, 'Beta', 'AI Engineer');
    assert.equal(appId, appIdAgain, 'ensureApplication must not create a duplicate row');

    db.transitionApplication(appId, 'QUALIFIED');
    db.transitionApplication(appId, 'APPROVED');
    db.transitionApplication(appId, 'SUBMITTED', { patch: { dateApplied: new Date().toISOString(), applicationUrl: 'https://x.com/2' } });

    const app = db.getApplication(appId);
    assert.equal(app.status, 'SUBMITTED');
    assert.ok(app.application_url);

    assert.throws(() => db.transitionApplication(appId, 'NOT_A_STATUS'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasAppliedToCompanyRole guards against duplicate applications (spec §13)', () => {
  const { db, dir } = tmpDb();
  try {
    const jobId = db.upsertJob({ source: 'ashby', company: 'Gamma', title: 'ML Engineer', url: 'https://x.com/3', discoveredAt: new Date().toISOString() });
    const appId = db.ensureApplication(jobId, 'Gamma', 'ML Engineer');
    assert.equal(db.hasAppliedToCompanyRole('Gamma', 'ML Engineer'), false);
    db.transitionApplication(appId, 'SUBMITTED');
    assert.equal(db.hasAppliedToCompanyRole('Gamma', 'ML Engineer'), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rate-limit counters only count SUBMITTED applications in the window', () => {
  const { db, dir } = tmpDb();
  try {
    const jobId = db.upsertJob({ source: 'ashby', company: 'Delta', title: 'SWE', url: 'https://x.com/4', discoveredAt: new Date().toISOString() });
    const appId = db.ensureApplication(jobId, 'Delta', 'SWE');
    assert.equal(db.countSubmittedToday(), 0);
    db.transitionApplication(appId, 'SUBMITTED', { patch: { dateApplied: new Date().toISOString() } });
    assert.equal(db.countSubmittedToday(), 1);
    assert.equal(db.countSubmittedLastHour(), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getStats reflects application/job state without throwing on an empty db', () => {
  const { db, dir } = tmpDb();
  try {
    const stats = db.getStats();
    assert.equal(stats.jobsDiscovered, 0);
    assert.equal(stats.applicationsSubmitted, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('countJobsBySource groups discovered jobs by source for the dashboard', () => {
  const { db, dir } = tmpDb();
  try {
    db.upsertJob({ source: 'indeed', company: 'A', title: 'SWE', url: 'https://x.com/a', discoveredAt: new Date().toISOString() });
    db.upsertJob({ source: 'indeed', company: 'B', title: 'SWE', url: 'https://x.com/b', discoveredAt: new Date().toISOString() });
    db.upsertJob({ source: 'ziprecruiter', company: 'C', title: 'SWE', url: 'https://x.com/c', discoveredAt: new Date().toISOString() });
    const sources = db.countJobsBySource();
    assert.equal(sources.find((s) => s.source === 'indeed').n, 2);
    assert.equal(sources.find((s) => s.source === 'ziprecruiter').n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('matchScoreHistogram buckets the latest score per job into spec §6 bands', () => {
  const { db, dir } = tmpDb();
  try {
    const j1 = db.upsertJob({ source: 'indeed', company: 'A', title: 'SWE', url: 'https://x.com/1', discoveredAt: new Date().toISOString() });
    const j2 = db.upsertJob({ source: 'indeed', company: 'B', title: 'SWE', url: 'https://x.com/2', discoveredAt: new Date().toISOString() });
    db.insertMatch(j1, { score: 95, tier: 'excellent', strengths: [], gaps: [] }, { decision: 'APPLY', eligibilityIssues: [] });
    db.insertMatch(j2, { score: 45, tier: 'reject', strengths: [], gaps: [] }, { decision: 'SKIP', eligibilityIssues: [] });
    const hist = db.matchScoreHistogram();
    assert.equal(hist.find((b) => b.band === '90-100').count, 1);
    assert.equal(hist.find((b) => b.band === '<60').count, 1);
    assert.equal(hist.find((b) => b.band === '70-79').count, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings get/set round-trip and support the dashboard controls', () => {
  const { db, dir } = tmpDb();
  try {
    assert.equal(db.getSetting('autoApplyEnabled'), undefined);
    db.setSetting('autoApplyEnabled', true);
    db.setSetting('autoApplyThreshold', 75);
    assert.equal(db.getSetting('autoApplyEnabled'), true);
    assert.equal(db.getSetting('autoApplyThreshold'), 75);
    // Overwriting an existing key updates it in place, not a duplicate row.
    db.setSetting('autoApplyEnabled', false);
    assert.equal(db.getSetting('autoApplyEnabled'), false);
    assert.deepEqual(db.getAllSettings(), { autoApplyEnabled: false, autoApplyThreshold: 75 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopOpportunities includes location and salary for the dashboard table', () => {
  const { db, dir } = tmpDb();
  try {
    const jobId = db.upsertJob({
      source: 'indeed', company: 'Acme', title: 'SWE', location: 'Austin, TX', remote: false,
      url: 'https://x.com/1', salary: '$100k-$120k', discoveredAt: new Date().toISOString(),
    });
    db.insertMatch(jobId, { score: 88, tier: 'strong', strengths: [], gaps: [] }, { decision: 'APPLY', eligibilityIssues: [] });
    const [top] = db.listTopOpportunities(5);
    assert.equal(top.location, 'Austin, TX');
    assert.equal(top.salary, '$100k-$120k');
    assert.equal(top.url, 'https://x.com/1');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearJobData wipes jobs/matches/applications/companies without violating foreign keys, and leaves settings alone', () => {
  const { db, dir } = tmpDb();
  try {
    const jobId = db.upsertJob({ source: 'indeed', company: 'Acme', title: 'SWE', url: 'https://x.com/1', discoveredAt: new Date().toISOString() });
    db.insertMatch(jobId, { score: 80, tier: 'strong', strengths: [], gaps: [] }, { decision: 'APPLY', eligibilityIssues: [] });
    const appId = db.ensureApplication(jobId, 'Acme', 'SWE');
    db.transitionApplication(appId, 'SUBMITTED'); // writes a status_log row too
    db.upsertCompany({ name: 'Acme', legitimacyTier: 'verified', redFlags: [], qualityScore: 90 });
    db.recordScanRun({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), sourceCount: 1, jobsFound: 1, jobsNew: 1, errors: [] });
    db.setSetting('autoApplyEnabled', true);

    assert.doesNotThrow(() => db.clearJobData());

    assert.equal(db.getStats().jobsDiscovered, 0);
    assert.equal(db.getStats().applicationsSubmitted, 0);
    assert.equal(db.getCompanyByName('Acme'), null);
    assert.equal(db.lastScanRun(), null);
    // Settings are a user preference, not job data — clearing jobs must not reset them.
    assert.equal(db.getSetting('autoApplyEnabled'), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
