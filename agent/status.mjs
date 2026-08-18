// agent/status.mjs — the application status state machine (spec section 14)
// and the (optional, best-effort) bridge back into career-ops's own
// human-readable tracker.
//
// The SQLite rows in agent/db.mjs are this subsystem's source of truth (see
// the comment at the top of db.mjs for why). Mirroring into
// data/applications.md is opt-in (SYNC_TO_LEGACY_TRACKER=true) and always
// best-effort: it uses the documented TSV-drop mechanism
// (batch/tracker-additions/*.tsv + merge-tracker.mjs) rather than hand-editing
// the tracker, and a failure here never blocks or corrupts the agent's own
// state machine.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT } from './config.mjs';
import { STATUSES } from './schemas.mjs';
import { notify } from './notify.mjs';

const execFileAsync = promisify(execFile);

export { STATUSES };

const NOTIFY_ON_ENTER = {
  HUMAN_REVIEW: 'human_review',
  SUBMITTED: 'application_submitted',
  FAILED: 'application_failed',
  INTERVIEW: 'interview_detected',
};

const LEGACY_STATE_MAP = {
  SUBMITTED: 'Applied',
  HUMAN_REVIEW: 'Evaluated',
  SKIPPED: 'SKIP',
  REJECTED: 'Rejected',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  FAILED: 'Discarded',
};

/**
 * Transition an application's status, log it, notify if warranted, and
 * (opt-in) mirror it into the legacy file tracker.
 *
 * @param {object} opts
 * @param {import('./db.mjs').AgentDB} opts.db
 * @param {string} opts.applicationId
 * @param {string} opts.jobId
 * @param {string} opts.toStatus - one of STATUSES
 * @param {string} [opts.reason]
 * @param {object} [opts.patch] - db.transitionApplication patch fields
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 */
export async function advanceStatus({ db, applicationId, jobId, toStatus, reason, patch = {}, config }) {
  db.transitionApplication(applicationId, toStatus, { reason, patch });
  db.setJobStatus(jobId, toStatus);

  const kind = NOTIFY_ON_ENTER[toStatus];
  if (kind) {
    const app = db.getApplication(applicationId);
    await notify({
      kind,
      title: `${app.position} at ${app.company} → ${toStatus}`,
      body: reason || '',
      meta: { applicationId, jobId, toStatus },
      config,
    });
  }

  if (process.env.SYNC_TO_LEGACY_TRACKER === 'true') {
    try {
      await mirrorToLegacyTracker(db, applicationId, toStatus);
    } catch (err) {
      console.warn(`  ⚠️  legacy tracker sync skipped: ${err.message}`);
    }
  }
}

async function mirrorToLegacyTracker(db, applicationId, toStatus) {
  const legacyState = LEGACY_STATE_MAP[toStatus];
  if (!legacyState) return; // intermediate states (DISCOVERED/ANALYZING/...) aren't tracker-worthy
  const app = db.getApplication(applicationId);
  const match = db.latestMatchForJob(app.job_id);
  const job = db.getJob(app.job_id);
  const score5 = match ? Math.round((match.match_score / 20) * 10) / 10 : null;

  const dir = path.join(REPO_ROOT, 'batch', 'tracker-additions');
  mkdirSync(dir, { recursive: true });
  const slug = `${slugify(app.company)}-${slugify(app.position)}`;
  const file = path.join(dir, `agent-${applicationId.slice(0, 8)}-${slug}.tsv`);
  const date = new Date().toISOString().slice(0, 10);

  const { stdout } = await execFileAsync('node', ['reserve-report-num.mjs', '--count', '1'], {
    cwd: REPO_ROOT,
  });
  const reservedNum = stdout.trim().split('-')[0].trim();

  const cols = [
    reservedNum,
    date,
    app.company,
    app.position,
    legacyState,
    score5 != null ? `${score5.toFixed(1)}/5` : 'N/A',
    'ℹ️', // pdf column — the agent's tailored PDF isn't the interactive pdf-mode artifact
    '', // report column — no evaluation report file; left blank intentionally
    `career-ops autonomous agent${match ? ` (score ${match.match_score}/100)` : ''}`,
    job?.url || '',
  ];
  writeFileSync(file, cols.join('\t') + '\n');

  await execFileAsync('node', ['merge-tracker.mjs'], { cwd: REPO_ROOT }).catch((err) => {
    // Leave the TSV in place — a failed merge is recoverable by re-running
    // `node merge-tracker.mjs` manually; never delete unmerged work.
    throw new Error(`merge-tracker.mjs failed: ${err.message}`);
  });
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}
