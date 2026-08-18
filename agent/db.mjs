// agent/db.mjs — the autonomous agent's persistent store (spec section 13).
//
// This is a NEW, additive subsystem, not a replacement for career-ops's
// existing file-based tracker (data/applications.md stays the human-readable
// source of truth for interactive use — see DATA_CONTRACT.md and
// ARCHITECTURE.md § "Files are canonical"). The 24/7 worker needs a real
// transactional store for its own state machine (jobs/companies/matches/
// applications, rate limiting, dedup), so it owns agent/data/agent.db as ITS
// source of truth, and agent/status.mjs mirrors completed applications into
// data/applications.md via the existing merge-tracker.mjs/set-status.mjs
// scripts so the interactive CLI and dashboard TUI keep seeing everything.
//
// Uses node:sqlite (built into Node 22+) — no native dependency to compile.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATUSES } from './schemas.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  remote INTEGER,
  url TEXT NOT NULL UNIQUE,
  description TEXT,
  posted_at TEXT,
  salary TEXT,
  applicant_count INTEGER,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DISCOVERED'
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);

CREATE TABLE IF NOT EXISTS companies (
  company_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  industry TEXT,
  size_estimate TEXT,
  headquarters TEXT,
  description TEXT,
  recent_hiring_activity TEXT,
  legitimacy_tier TEXT,
  red_flags TEXT, -- JSON array
  quality_score REAL,
  researched_at TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  match_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  match_score REAL NOT NULL,
  tier TEXT NOT NULL,
  decision TEXT NOT NULL,
  strengths TEXT, -- JSON array
  gaps TEXT,      -- JSON array
  reasoning TEXT,
  eligibility_issues TEXT, -- JSON array
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_job ON matches(job_id);

CREATE TABLE IF NOT EXISTS applications (
  application_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
  company TEXT NOT NULL,
  position TEXT NOT NULL,
  status TEXT NOT NULL,
  date_applied TEXT,
  resume_version TEXT,
  cover_letter_version TEXT,
  application_url TEXT,
  notes TEXT,
  outcome TEXT, -- final outcome once known: Rejected/Interview/Offer/Hired/null
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);

CREATE TABLE IF NOT EXISTS status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_count INTEGER,
  jobs_found INTEGER,
  jobs_new INTEGER,
  errors TEXT -- JSON array
);

-- Runtime overrides set from the dashboard (spec §19 "configurable without
-- modifying source code" extended to "without editing .env and restarting,
-- too"). Absent key = fall back to the .env-loaded default. See
-- agent/config.mjs's applyRuntimeOverrides().
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export class AgentDB {
  /** @param {string} dbPath */
  constructor(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ── Jobs ──────────────────────────────────────────────────────────────

  /** Returns true if a job with this URL is already known (dedup, spec §13). */
  hasJobUrl(url) {
    const row = this.db.prepare('SELECT 1 FROM jobs WHERE url = ?').get(url);
    return !!row;
  }

  /** Upsert a job by URL; returns the job_id (existing or new). */
  upsertJob(job) {
    const existing = this.db.prepare('SELECT job_id FROM jobs WHERE url = ?').get(job.url);
    if (existing) return existing.job_id;
    const jobId = job.jobId || randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, source, company, title, location, remote, url, description,
           posted_at, salary, applicant_count, discovered_at, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        jobId,
        job.source,
        job.company,
        job.title,
        job.location ?? null,
        job.remote == null ? null : job.remote ? 1 : 0,
        job.url,
        job.description ?? null,
        job.postedAt ?? null,
        job.salary ?? null,
        job.applicantCount ?? null,
        job.discoveredAt || new Date().toISOString(),
        job.status || 'DISCOVERED',
      );
    return jobId;
  }

  getJob(jobId) {
    return this.rowToJob(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId));
  }

  setJobStatus(jobId, status) {
    this.db.prepare('UPDATE jobs SET status = ? WHERE job_id = ?').run(status, jobId);
  }

  listJobsByStatus(status, limit = 500) {
    return this.db
      .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY discovered_at DESC LIMIT ?')
      .all(status, limit)
      .map((r) => this.rowToJob(r));
  }

  rowToJob(r) {
    if (!r) return null;
    return {
      jobId: r.job_id,
      source: r.source,
      company: r.company,
      title: r.title,
      location: r.location,
      remote: r.remote == null ? null : !!r.remote,
      url: r.url,
      description: r.description,
      postedAt: r.posted_at,
      salary: r.salary,
      applicantCount: r.applicant_count,
      discoveredAt: r.discovered_at,
      status: r.status,
    };
  }

  // ── Companies ─────────────────────────────────────────────────────────

  upsertCompany(company) {
    const existing = this.db
      .prepare('SELECT company_id FROM companies WHERE name = ?')
      .get(company.name);
    const companyId = existing?.company_id || randomUUID();
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE companies SET website=?, industry=?, size_estimate=?, headquarters=?,
             description=?, recent_hiring_activity=?, legitimacy_tier=?, red_flags=?,
             quality_score=?, researched_at=? WHERE company_id=?`,
        )
        .run(
          company.website ?? null,
          company.industry ?? null,
          company.sizeEstimate ?? null,
          company.headquarters ?? null,
          company.description ?? null,
          company.recentHiringActivity ?? null,
          company.legitimacyTier ?? null,
          JSON.stringify(company.redFlags ?? []),
          company.qualityScore ?? null,
          now,
          companyId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO companies (company_id, name, website, industry, size_estimate,
             headquarters, description, recent_hiring_activity, legitimacy_tier, red_flags,
             quality_score, researched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          companyId,
          company.name,
          company.website ?? null,
          company.industry ?? null,
          company.sizeEstimate ?? null,
          company.headquarters ?? null,
          company.description ?? null,
          company.recentHiringActivity ?? null,
          company.legitimacyTier ?? null,
          JSON.stringify(company.redFlags ?? []),
          company.qualityScore ?? null,
          now,
        );
    }
    return companyId;
  }

  getCompanyByName(name) {
    const r = this.db.prepare('SELECT * FROM companies WHERE name = ?').get(name);
    if (!r) return null;
    return { ...r, redFlags: JSON.parse(r.red_flags || '[]') };
  }

  // ── Matches ───────────────────────────────────────────────────────────

  /**
   * @param {string} jobId
   * @param {object} match - JobMatchSchema shape (score, tier, strengths, gaps, reasoning — never carries `decision`).
   * @param {object} [decision] - ApplicationDecisionSchema shape, if one was made alongside this match
   *   (evaluateJob() always produces both together — pass both here rather than only `match`).
   */
  insertMatch(jobId, match, decision = {}) {
    const matchId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO matches (match_id, job_id, match_score, tier, decision, strengths, gaps,
           reasoning, eligibility_issues, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        matchId,
        jobId,
        match.score,
        match.tier,
        decision.decision ?? null,
        JSON.stringify(match.strengths ?? []),
        JSON.stringify(match.gaps ?? []),
        match.reasoning ?? null,
        JSON.stringify(decision.eligibilityIssues ?? []),
        new Date().toISOString(),
      );
    return matchId;
  }

  latestMatchForJob(jobId) {
    const r = this.db
      .prepare('SELECT * FROM matches WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(jobId);
    if (!r) return null;
    return {
      ...r,
      strengths: JSON.parse(r.strengths || '[]'),
      gaps: JSON.parse(r.gaps || '[]'),
      eligibilityIssues: JSON.parse(r.eligibility_issues || '[]'),
    };
  }

  // ── Applications & the status state machine (spec §14) ───────────────

  /** Creates the application row if absent (one per job_id — dedup guard). */
  ensureApplication(jobId, company, position) {
    const existing = this.db
      .prepare('SELECT * FROM applications WHERE job_id = ?')
      .get(jobId);
    if (existing) return existing.application_id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO applications (application_id, job_id, company, position, status,
           created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, jobId, company, position, 'DISCOVERED', now, now);
    return id;
  }

  /** Already-applied guard — spec §8 "check duplicate application". */
  hasAppliedToCompanyRole(company, position) {
    const row = this.db
      .prepare(
        `SELECT 1 FROM applications WHERE company = ? AND position = ?
           AND status NOT IN ('DISCOVERED','ANALYZING','SKIPPED','FAILED')`,
      )
      .get(company, position);
    return !!row;
  }

  transitionApplication(applicationId, toStatus, { reason = null, patch = {} } = {}) {
    if (!STATUSES.includes(toStatus)) {
      throw new Error(`Unknown status: ${toStatus}`);
    }
    const current = this.db
      .prepare('SELECT status FROM applications WHERE application_id = ?')
      .get(applicationId);
    if (!current) throw new Error(`No application ${applicationId}`);
    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    for (const [col, val] of Object.entries({
      status: toStatus,
      date_applied: patch.dateApplied,
      resume_version: patch.resumeVersion,
      cover_letter_version: patch.coverLetterVersion,
      application_url: patch.applicationUrl,
      notes: patch.notes,
      outcome: patch.outcome,
    })) {
      if (val !== undefined) {
        fields.push(`${col} = ?`);
        values.push(val);
      }
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(applicationId);
    this.db
      .prepare(`UPDATE applications SET ${fields.join(', ')} WHERE application_id = ?`)
      .run(...values);
    this.db
      .prepare(
        'INSERT INTO status_log (application_id, from_status, to_status, reason, at) VALUES (?,?,?,?,?)',
      )
      .run(applicationId, current.status, toStatus, reason, now);
  }

  getApplication(applicationId) {
    return this.db
      .prepare('SELECT * FROM applications WHERE application_id = ?')
      .get(applicationId);
  }

  listApplicationsByStatus(status, limit = 200) {
    // Joins jobs for a manual-apply link even when application_url isn't set
    // yet (e.g. a HUMAN_REVIEW row that never reached the apply step) — the
    // posting's own URL is always there as a fallback.
    return this.db
      .prepare(
        `SELECT a.*, j.url AS job_url, j.location AS job_location, j.salary AS job_salary
           FROM applications a JOIN jobs j ON j.job_id = a.job_id
           WHERE a.status = ? ORDER BY a.updated_at DESC LIMIT ?`,
      )
      .all(status, limit);
  }

  listRecentApplications(limit = 20) {
    return this.db
      .prepare('SELECT * FROM applications ORDER BY updated_at DESC LIMIT ?')
      .all(limit);
  }

  // ── Rate limiting (spec §12: "do not hammer websites") ────────────────

  countSubmittedSince(isoSince) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
           WHERE status IN ('SUBMITTED') AND date_applied >= ?`,
      )
      .get(isoSince);
    return r.n;
  }

  countSubmittedToday() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.countSubmittedSince(startOfDay.toISOString());
  }

  countSubmittedLastHour() {
    return this.countSubmittedSince(new Date(Date.now() - 3600_000).toISOString());
  }

  // ── Dashboard / stats (spec §15) ──────────────────────────────────────

  getStats() {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args);
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    return {
      jobsDiscovered: one('SELECT COUNT(*) n FROM jobs').n,
      jobsAnalyzed: one("SELECT COUNT(*) n FROM jobs WHERE status NOT IN ('DISCOVERED')").n,
      jobsQualified: one("SELECT COUNT(*) n FROM jobs WHERE status IN ('QUALIFIED','APPROVED','APPLYING','SUBMITTED','HUMAN_REVIEW','INTERVIEW','OFFER')").n,
      applicationsSubmitted: one("SELECT COUNT(*) n FROM applications WHERE status='SUBMITTED'").n,
      awaitingHumanReview: one("SELECT COUNT(*) n FROM applications WHERE status='HUMAN_REVIEW'").n,
      interviews: one("SELECT COUNT(*) n FROM applications WHERE status='INTERVIEW'").n,
      offers: one("SELECT COUNT(*) n FROM applications WHERE status='OFFER'").n,
      rejected: one("SELECT COUNT(*) n FROM applications WHERE status='REJECTED'").n,
      avgMatchScore: one('SELECT AVG(match_score) n FROM matches').n,
      applicationsThisWeek: one(
        "SELECT COUNT(*) n FROM applications WHERE status='SUBMITTED' AND date_applied >= ?",
        weekAgo,
      ).n,
      applicationsThisMonth: one(
        "SELECT COUNT(*) n FROM applications WHERE status='SUBMITTED' AND date_applied >= ?",
        monthAgo,
      ).n,
    };
  }

  listTopOpportunities(limit = 20) {
    return this.db
      .prepare(
        `SELECT j.company, j.title, j.location, j.remote, j.salary, j.url, m.match_score, a.status
           FROM jobs j
           JOIN matches m ON m.job_id = j.job_id
           LEFT JOIN applications a ON a.job_id = j.job_id
           WHERE m.created_at = (SELECT MAX(created_at) FROM matches WHERE job_id = j.job_id)
           ORDER BY m.match_score DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** How many discovered jobs came from each source (portal vendor id, 'indeed', 'ziprecruiter', 'pipeline-import'). */
  countJobsBySource() {
    return this.db
      .prepare('SELECT source, COUNT(*) AS n FROM jobs GROUP BY source ORDER BY n DESC')
      .all();
  }

  /** Distribution of every scored job (not just tracked applications) across the spec §6 bands. */
  matchScoreHistogram() {
    const bands = [
      ['90-100', 90, 100],
      ['80-89', 80, 89.999],
      ['70-79', 70, 79.999],
      ['60-69', 60, 69.999],
      ['<60', 0, 59.999],
    ];
    const latestScores = this.db
      .prepare(
        `SELECT match_score FROM matches m
           WHERE created_at = (SELECT MAX(created_at) FROM matches WHERE job_id = m.job_id)`,
      )
      .all()
      .map((r) => r.match_score);
    return bands.map(([band, lo, hi]) => ({
      band,
      count: latestScores.filter((s) => s >= lo && s <= hi).length,
    }));
  }

  // ── Learning loop (spec §17) ───────────────────────────────────────────

  outcomesForLearning() {
    // The learning loop tracks outcomes by the application's own status
    // (Applied -> Rejected/Interview/Offer/Hired), not the separate `outcome`
    // column — that column exists for a final free-text note, not the state
    // the state machine already carries.
    return this.db
      .prepare(
        `SELECT a.company, a.position, a.status AS outcome, m.match_score, j.title, j.source
           FROM applications a
           JOIN jobs j ON j.job_id = a.job_id
           LEFT JOIN matches m ON m.job_id = a.job_id
             AND m.created_at = (SELECT MAX(created_at) FROM matches WHERE job_id = a.job_id)
           WHERE a.status IN ('SUBMITTED','INTERVIEW','OFFER','REJECTED','HIRED')`,
      )
      .all();
  }

  recordScanRun({ startedAt, finishedAt, sourceCount, jobsFound, jobsNew, errors }) {
    this.db
      .prepare(
        `INSERT INTO scan_runs (started_at, finished_at, source_count, jobs_found, jobs_new, errors)
           VALUES (?,?,?,?,?,?)`,
      )
      .run(startedAt, finishedAt, sourceCount, jobsFound, jobsNew, JSON.stringify(errors ?? []));
  }

  lastScanRun() {
    return this.db.prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  // ── Runtime settings overrides (dashboard controls) ────────────────────

  getSetting(key) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : undefined;
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getAllSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  /**
   * Wipes every discovered job, match, application, and company — e.g. after
   * a discovery/filtering bug fix, to re-run cleanly instead of the list
   * being polluted with jobs found under the old (broken) filtering.
   * Deliberately does NOT touch `settings` (dashboard toggles) — clearing
   * job data shouldn't silently reset your dry-run/auto-apply/threshold
   * choices too.
   */
  clearJobData() {
    this.db.exec('DELETE FROM status_log');
    this.db.exec('DELETE FROM matches');
    this.db.exec('DELETE FROM applications');
    this.db.exec('DELETE FROM jobs');
    this.db.exec('DELETE FROM companies');
    this.db.exec('DELETE FROM scan_runs');
  }
}

let _shared = null;
/** @param {string} [dbPath] @returns {AgentDB} */
export function getDB(dbPath) {
  if (_shared && (!dbPath || _shared.path === dbPath)) return _shared;
  _shared = new AgentDB(dbPath);
  _shared.path = dbPath;
  return _shared;
}
