// agent/scoring.mjs — 0-100 job/candidate match scoring (spec section 6).
//
// Default tiers (configurable only via AUTO_APPLY_THRESHOLD, per spec):
//   90-100 Excellent  80-89 Strong  70-79 Possible  60-69 Weak  <60 Reject

import { structuredCall } from './claude-client.mjs';
import { JobMatchSchema } from './schemas.mjs';

export function tierForScore(score) {
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'strong';
  if (score >= 70) return 'possible';
  if (score >= 60) return 'weak';
  return 'reject';
}

const SCORING_SYSTEM_PROMPT = `You are an elite, brutally honest recruiter working exclusively for ONE candidate. \
Your only question for every job is: "Does this job give THIS candidate a realistic chance at an interview?" \
Not "could they technically apply." Quality over quantity, relevance over volume, truthfulness over keyword stuffing.

Score 0-100 across four weighted dimensions (report each 0-100, plus the overall score):
- requiredQualifications (40%): hard requirements — skills, years of experience, education, certifications, seniority. A candidate missing a HARD requirement (e.g. a required degree they don't have, required years of experience far beyond theirs) should score low here even if everything else is strong.
- preferredQualifications (20%): nice-to-haves — extra technologies, industry experience, relevant projects/domain overlap.
- practicalFactors (20%): location/remote fit, work authorization fit, seniority match, posting/company quality signals you're given.
- resumeAlignment (20%): genuine keyword/experience alignment with the JD, not superficial keyword matching — does the resume's actual content support the JD's asks?

Compute the overall "score" as a holistic 0-100 reflecting realistic interview odds — usually close to the weighted average of the four, but use judgment: a single disqualifying gap (e.g. the JD requires sponsorship-ineligible status and the candidate needs sponsorship, or requires a degree/license the candidate doesn't have) should pull the overall score down hard even if other dimensions look fine.

Never invent candidate qualifications not present in their profile. Cite specific, concrete strengths and gaps — no generic filler ("good communicator"). If the JD is vague or the posting looks low-quality/stale, say so in reasoning rather than inflating the score to compensate.`;

/**
 * @param {object} opts
 * @param {import('zod').infer<typeof import('./schemas.mjs').CandidateProfileSchema>} opts.candidate
 * @param {object} opts.job - Job row (schemas.mjs JobSchema shape)
 * @param {object} [opts.company] - Company research (schemas.mjs CompanySchema shape), optional
 * @param {'triage'|'full'} [opts.mode] - 'triage' uses the cheaper model tier for a high-volume first pass
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @returns {Promise<import('zod').infer<typeof JobMatchSchema>>}
 */
export async function scoreJob({ candidate, job, company = null, mode = 'full', config }) {
  const prompt = [
    `## Candidate profile (JSON)`,
    JSON.stringify(candidate, null, 2),
    ``,
    `## Job posting`,
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location ?? 'not specified'} (remote: ${job.remote ?? 'unknown'})`,
    job.salary ? `Salary: ${job.salary}` : '',
    job.applicantCount != null
      ? `Applicant count (fewer applicants = better odds, a tie-breaker the candidate explicitly cares about): ${job.applicantCount}`
      : '',
    job.postedAt ? `Posted: ${job.postedAt}` : '',
    `Description:`,
    job.description || '(no description text available — score conservatively on title/location/company fit only, and say so in reasoning)',
    company
      ? `\n## Company research\n${JSON.stringify(company, null, 2)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const match = await structuredCall({
    system: SCORING_SYSTEM_PROMPT,
    prompt,
    schema: JobMatchSchema,
    schemaName: 'JobMatch',
    tier: mode === 'triage' ? 'low' : 'medium',
    config,
  });

  // The schema constrains tier to the enum, but derive it from the score so
  // it can never drift from tierForScore()'s thresholds even if the model's
  // own tier field disagrees.
  match.tier = tierForScore(match.score);
  return match;
}
