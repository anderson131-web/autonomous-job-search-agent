// agent/worker.mjs — the 24/7 agent loop (spec section 12).
//
//   while system_running:
//     discover_jobs()
//     deduplicate_jobs()
//     analyze_jobs()          -> score + research + decide
//     select_high_value_jobs()
//     generate_tailored_materials()
//     process_applications()  -> fill / guarded auto-submit
//     record_results()
//     retry_failures()
//     wait()
//
// Rate limiting, dedup, and retry-with-backoff throughout — spec section 12
// ("do not hammer websites") and section 20 ("failure recovery").

import path from 'node:path';
import { getDB } from './db.mjs';
import { loadConfig, applyRuntimeOverrides, AGENT_ROOT } from './config.mjs';
import { loadCandidateProfile } from './candidate-profile.mjs';
import { discoverFromPortals, importFromPipelineMd, discoverFromJobBoards } from './discovery.mjs';
import { evaluateJob } from './decision.mjs';
import { tailorResumeForJob } from './resume-tailor.mjs';
import { applyToJob } from './apply-worker.mjs';
import { advanceStatus } from './status.mjs';
import { notify } from './notify.mjs';
import { acquireScanLock, releaseScanLock } from './scan-lock.mjs';

const SCAN_LOCK_PATH = path.join(AGENT_ROOT, 'data', 'scan.lock');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Run exactly one iteration of the loop (discover -> score -> decide ->
 * tailor -> apply -> record). Exported standalone so `worker.mjs --once` and
 * the test suite can run a single pass deterministically.
 *
 * Cross-process locked (agent/scan-lock.mjs): a cycle triggered from the
 * dashboard's "Run scan now" and a concurrently-running `start` loop can
 * never overlap — the second caller gets an immediate, clearly-labeled
 * no-op result instead of two cycles racing each other's rate limits and
 * applications.
 *
 * @param {object} [opts]
 * @param {import('./db.mjs').AgentDB} [opts.db]
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @param {AbortSignal} [opts.signal] - Abort to stop the cycle early, at the
 *   next safe checkpoint (between companies/roles during discovery, between
 *   jobs during scoring) — never mid-job, so nothing is left half-written.
 * @returns {Promise<{jobsFound: number, jobsNew: number, evaluated: number, applied: number, humanReview: number, errors: string[], skipped?: boolean, stopped?: boolean}>}
 */
export async function runOnce({ db, config, signal } = {}) {
  const baseCfg = config || loadConfig();
  db = db || getDB(baseCfg.dbPath);

  if (!acquireScanLock(SCAN_LOCK_PATH)) {
    log('⏭️  Another cycle is already running (or a stale lock — see agent/data/scan.lock) — skipping.');
    return { jobsFound: 0, jobsNew: 0, evaluated: 0, applied: 0, humanReview: 0, errors: [], skipped: true };
  }

  try {
    return await runOnceLocked(db, baseCfg, signal);
  } finally {
    releaseScanLock(SCAN_LOCK_PATH);
  }
}

async function runOnceLocked(db, baseCfg, signal) {
  // Re-read dashboard-set overrides fresh every cycle, so a toggle flipped
  // in the UI takes effect on the next tick without a process restart.
  const cfg = applyRuntimeOverrides(baseCfg, db);
  const startedAt = new Date().toISOString();
  const errors = [];
  let stopped = false;

  const candidate = await loadCandidateProfile({ config: cfg });

  // 1-2. Discover + dedup.
  log('Discovering jobs...');
  let jobsFound = 0;
  let jobsNew = 0;
  const discovered = [];
  try {
    const { jobs, errors: sourceErrors, stopped: portalsStopped } = await discoverFromPortals({ log, signal });
    for (const e of sourceErrors) errors.push(`${e.company}: ${e.error}`);
    discovered.push(...jobs, ...importFromPipelineMd());
    stopped = stopped || portalsStopped;
  } catch (err) {
    errors.push(`ATS portal discovery failed: ${err.message}`);
    log(`⚠️  ATS portal discovery failed: ${err.message}`);
  }
  if (!signal?.aborted) {
    try {
      discovered.push(...(await discoverFromJobBoards({ candidate, config: cfg, log, signal })));
    } catch (err) {
      errors.push(`Indeed/ZipRecruiter discovery failed: ${err.message}`);
      log(`⚠️  Indeed/ZipRecruiter discovery failed: ${err.message}`);
    }
  }
  jobsFound = discovered.length;

  const newJobRows = [];
  for (const j of discovered) {
    if (db.hasJobUrl(j.url)) continue;
    const jobId = db.upsertJob({ ...j, discoveredAt: new Date().toISOString() });
    jobsNew++;
    newJobRows.push(db.getJob(jobId));
  }
  log(`Found ${jobsFound} postings (${jobsNew} new).`);

  // 3-4. Analyze + select.
  let evaluated = 0;
  let applied = 0;
  let humanReview = 0;
  for (const job of newJobRows) {
    if (signal?.aborted) {
      stopped = true;
      log('⏹️  Stop requested — ending this cycle before scoring the rest of the batch.');
      break;
    }
    db.setJobStatus(job.jobId, 'ANALYZING');
    let evalResult;
    try {
      evalResult = await evaluateJob({ db, candidate, job, config: cfg, log });
    } catch (err) {
      errors.push(`evaluate ${job.company}/${job.title}: ${err.message}`);
      log(`⚠️  evaluation failed for ${job.company} — ${job.title}: ${err.message}`);
      continue;
    }
    evaluated++;
    const { decision, match, company } = evalResult;
    if (match) db.insertMatch(job.jobId, match, decision);
    if (company) db.upsertCompany(company);

    if (decision.decision === 'SKIP') {
      db.setJobStatus(job.jobId, 'SKIPPED');
      continue;
    }

    db.setJobStatus(job.jobId, 'QUALIFIED');
    const applicationId = db.ensureApplication(job.jobId, job.company, job.title);

    if (decision.decision === 'HUMAN_REVIEW') {
      await advanceStatus({
        db,
        applicationId,
        jobId: job.jobId,
        toStatus: 'HUMAN_REVIEW',
        reason: [...decision.eligibilityIssues, ...decision.gaps].join('; ') || 'Needs review.',
        config: cfg,
      });
      humanReview++;
      continue;
    }

    // decision.decision === 'APPLY' — score met threshold, no eligibility
    // issues, company checked out. Notify on genuinely high-value finds
    // (never on every job — spec section 16).
    if (match.score >= Math.max(cfg.autoApplyThreshold, 85)) {
      await notify({
        kind: 'high_value_job',
        title: `${match.score}/100 — ${job.title} at ${job.company}`,
        body: decision.reasons.slice(0, 3).join(' · '),
        config: cfg,
      });
    }

    await advanceStatus({ db, applicationId, jobId: job.jobId, toStatus: 'APPROVED', config: cfg });

    // 5. Generate tailored materials.
    let tailored = null;
    try {
      db.setJobStatus(job.jobId, 'APPLYING');
      tailored = await tailorResumeForJob({ candidate, job, config: cfg });
    } catch (err) {
      errors.push(`tailor resume ${job.company}/${job.title}: ${err.message}`);
      await advanceStatus({
        db, applicationId, jobId: job.jobId, toStatus: 'FAILED',
        reason: `Resume tailoring failed: ${err.message}`, config: cfg,
      });
      continue;
    }

    // 6. Rate limit check before spending an application slot (spec §12/22).
    if (db.countSubmittedToday() >= cfg.maxApplicationsPerDay) {
      await advanceStatus({
        db, applicationId, jobId: job.jobId, toStatus: 'HUMAN_REVIEW',
        reason: `Daily application cap (${cfg.maxApplicationsPerDay}) reached — ready to apply, paused for today.`,
        patch: { resumeVersion: tailored.slug }, config: cfg,
      });
      humanReview++;
      continue;
    }
    if (db.countSubmittedLastHour() >= cfg.maxApplicationsPerHour) {
      await advanceStatus({
        db, applicationId, jobId: job.jobId, toStatus: 'HUMAN_REVIEW',
        reason: `Hourly application cap (${cfg.maxApplicationsPerHour}) reached — will retry next cycle.`,
        patch: { resumeVersion: tailored.slug }, config: cfg,
      });
      humanReview++;
      continue;
    }

    // 7. Apply (guarded — see agent/apply-worker.mjs for exactly when this
    //    can auto-submit vs. always stopping at HUMAN_REVIEW).
    try {
      const applyResult = await applyToJob({
        job,
        candidate,
        resumePdfPath: tailored.pdfPath,
        config: cfg,
      });
      await advanceStatus({
        db,
        applicationId,
        jobId: job.jobId,
        toStatus: applyResult.outcome,
        reason: applyResult.reason,
        patch: {
          resumeVersion: tailored.slug,
          applicationUrl: job.url,
          dateApplied: applyResult.outcome === 'SUBMITTED' ? new Date().toISOString() : undefined,
          notes: applyResult.needsConfirmation?.length
            ? `Needs confirmation: ${applyResult.needsConfirmation.map((q) => q.question).join('; ')}`
            : undefined,
        },
        config: cfg,
      });
      if (applyResult.outcome === 'SUBMITTED') applied++;
      else humanReview++;
    } catch (err) {
      errors.push(`apply ${job.company}/${job.title}: ${err.message}`);
      await advanceStatus({
        db, applicationId, jobId: job.jobId, toStatus: 'FAILED',
        reason: `Apply automation error: ${err.message}`,
        patch: { resumeVersion: tailored.slug }, config: cfg,
      });
    }
  }

  // 8. Retry failures left over from earlier cycles that haven't exceeded a
  // sane retry budget — spec §12/20 ("retry safely", "save state, retry
  // later"). Kept simple: FAILED rows older than 1 hour get one more look by
  // being nudged back to HUMAN_REVIEW rather than silently retried forever
  // (a network blip that becomes a resubmission is worse than a human glance).
  for (const app of db.listApplicationsByStatus('FAILED', 50)) {
    const ageMs = Date.now() - new Date(app.updated_at).getTime();
    if (ageMs > 3600_000) {
      await advanceStatus({
        db, applicationId: app.application_id, jobId: app.job_id, toStatus: 'HUMAN_REVIEW',
        reason: 'Repeated automation failure — needs a human look rather than further silent retries.',
        config: cfg,
      });
    }
  }

  db.recordScanRun({
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceCount: newJobRows.length,
    jobsFound,
    jobsNew,
    errors,
  });

  if (errors.length > 3) {
    await notify({
      kind: 'system_error',
      title: `${errors.length} errors this cycle`,
      body: errors.slice(0, 5).join(' | '),
      config: cfg,
    });
  }

  log(
    `Cycle ${stopped ? 'stopped early by request' : 'done'} — evaluated ${evaluated}, applied ${applied}, ` +
      `human review ${humanReview}, errors ${errors.length}.`,
  );
  return { jobsFound, jobsNew, evaluated, applied, humanReview, errors, stopped };
}

/**
 * The 24/7 loop. Runs runOnce() forever, sleeping SEARCH_INTERVAL_MINUTES
 * between cycles, and never lets one cycle's exception kill the process
 * (spec §20: "if the process crashes: restart, resume from database" — this
 * loop just doesn't crash on a single bad cycle in the first place).
 */
export async function startWorker({ config } = {}) {
  const cfg = config || loadConfig();
  const db = getDB(cfg.dbPath);
  log(
    `career-ops autonomous agent starting — DRY_RUN=${cfg.dryRun} AUTO_APPLY_ENABLED=${cfg.autoApplyEnabled} ` +
      `threshold=${cfg.autoApplyThreshold} interval=${cfg.searchIntervalMinutes}m`,
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce({ db, config: cfg });
    } catch (err) {
      log(`⚠️  cycle crashed, will retry next interval: ${err.stack || err.message}`);
      await notify({ kind: 'system_error', title: 'Worker cycle crashed', body: err.message, config: cfg });
    }
    await sleep(cfg.searchIntervalMinutes * 60_000);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
