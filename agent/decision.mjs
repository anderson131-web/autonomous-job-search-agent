// agent/decision.mjs — the intelligent application decision pipeline
// (spec section 8):
//
//   Job found → extract requirements → match against candidate →
//   research company → calculate score → check eligibility →
//   check duplicate application → Claude evaluates opportunity →
//   Apply / Skip / Human Review
//
// Every decision carries reasons (spec's worked example). This never
// auto-applies purely on "can I technically submit" — see agent/apply-worker.mjs
// for the separate, further-gated step that actually fills/submits a form.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadConfig } from './config.mjs';
import { scoreJob, tierForScore } from './scoring.mjs';
import { researchCompany } from './company-research.mjs';
import { loadBlacklist } from '../scan.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';

const BLACKLIST_PATH = path.join(REPO_ROOT, 'data', 'blacklist.md');

const SPONSORSHIP_NO_RE =
  /\b(will not|does not|cannot|unable to|no)\s+(sponsor|provide sponsorship)\b|\bno sponsorship\b|\bwithout sponsorship\b/i;

/**
 * @param {object} opts
 * @param {import('./db.mjs').AgentDB} opts.db
 * @param {object} opts.candidate - CandidateProfileSchema shape
 * @param {object} opts.job - Job row (already upserted in db, has jobId)
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{decision: object, match: object, company: object|null}>}
 */
export async function evaluateJob({ db, candidate, job, config, log = () => {} }) {
  const cfg = config || loadConfig();

  // 1. Duplicate check (spec §8, §13 "duplicate applications impossible").
  if (db.hasAppliedToCompanyRole(job.company, job.title)) {
    const decision = decisionOf('SKIP', 0, ['Already applied to this company + role.'], [], []);
    return { decision, match: null, company: null };
  }

  // 2. Candidate's own do-not-apply list (data/blacklist.md), same file the
  //    interactive `apply`/`scan` modes already respect — never auto-populated.
  if (existsSync(BLACKLIST_PATH)) {
    const blacklist = loadBlacklist(BLACKLIST_PATH);
    const hit = blacklist.get(normalizeCompany(job.company));
    if (hit) {
      const decision = decisionOf(
        'HUMAN_REVIEW',
        0,
        [],
        [],
        [`${job.company} is on data/blacklist.md (since ${hit.since || 'unknown'}): ${hit.reason || 'no reason recorded'}. Confirm before proceeding.`],
      );
      return { decision, match: null, company: null };
    }
  }

  // 3. Hard eligibility gate: an explicit "no sponsorship" JD against a
  //    candidate who needs sponsorship is a real disqualifier — never guess
  //    past it, always let the candidate see it (spec §11).
  const eligibilityIssues = [];
  if (candidate.workAuthorization.needsSponsorship && job.description && SPONSORSHIP_NO_RE.test(job.description)) {
    eligibilityIssues.push(
      'Posting states it will not sponsor work authorization; candidate profile indicates sponsorship is needed.',
    );
  }

  // 4. Score the match (spec §6).
  const match = await scoreJob({ candidate, job, mode: 'full', config: cfg, });
  log(`  score ${match.score}/100 (${match.tier}) — ${job.company} — ${job.title}`);

  // 5. Research the company before treating this as worth applying to
  //    (spec §7) — only for postings that are actually in contention, to
  //    avoid spending a web-search-backed call on obvious rejects.
  let company = null;
  if (match.score >= 70) {
    try {
      company = await researchCompany({
        companyName: job.company,
        careersUrlHint: job.url,
        postingAgeDays: postingAgeDays(job.postedAt),
        config: cfg,
      });
    } catch (err) {
      log(`  ⚠️  company research failed for ${job.company}: ${err.message}`);
    }
  }

  if (company?.legitimacyTier === 'suspicious') {
    eligibilityIssues.push(
      `Company research flagged this posting as suspicious: ${company.redFlags.join('; ') || 'see company research notes'}.`,
    );
  }

  // 6. Final decision.
  let decisionValue;
  if (eligibilityIssues.length > 0) {
    decisionValue = 'HUMAN_REVIEW';
  } else if (match.score >= cfg.autoApplyThreshold) {
    decisionValue = 'APPLY';
  } else {
    decisionValue = 'SKIP';
  }

  const reasons = [...match.strengths];
  if (decisionValue === 'APPLY') {
    reasons.push(`Score ${match.score} meets the ${cfg.autoApplyThreshold} auto-apply threshold.`);
  } else if (decisionValue === 'SKIP') {
    reasons.push(`Score ${match.score} is below the ${cfg.autoApplyThreshold} auto-apply threshold.`);
  }

  const decision = decisionOf(decisionValue, match.score, reasons, match.gaps, eligibilityIssues);
  return { decision, match, company };
}

function decisionOf(decision, score, reasons, gaps, eligibilityIssues) {
  return {
    decision,
    score,
    reasons,
    gaps,
    eligibilityIssues,
    notes: null,
  };
}

function postingAgeDays(postedAt) {
  if (!postedAt) return null;
  const posted = new Date(postedAt).getTime();
  if (!Number.isFinite(posted)) return null;
  return Math.max(0, Math.round((Date.now() - posted) / 86_400_000));
}

export { tierForScore };
