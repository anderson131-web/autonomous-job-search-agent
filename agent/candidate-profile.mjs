// agent/candidate-profile.mjs — builds the CandidateProfile (spec section 3).
//
// Two sources, two trust levels:
//   - cv.md is free text. Claude *extracts* structure from it (never invents)
//     under a strict system prompt, and the result is schema-validated.
//   - config/profile.yml is already structured and authoritative for contact
//     info, location/remote preferences, and — critically — work
//     authorization. Those fields are read directly, never inferred by
//     Claude, because a wrong guess there is legally significant (spec
//     section 11).
//
// Result is cached to agent/data/candidate-profile.cache.json, keyed by a
// hash of both source files, so a 24/7 loop doesn't re-parse the resume on
// every tick.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { z } from 'zod';
import { REPO_ROOT, AGENT_ROOT, loadConfig } from './config.mjs';
import { structuredCall } from './claude-client.mjs';
import { CandidateProfileSchema } from './schemas.mjs';

const CV_PATH = path.join(REPO_ROOT, 'cv.md');
const PROFILE_YML_PATH = path.join(REPO_ROOT, 'config', 'profile.yml');
const CACHE_PATH = path.join(AGENT_ROOT, 'data', 'candidate-profile.cache.json');

// The subset of CandidateProfile that Claude is allowed to derive from free
// text — no contact info, no preferences, no work authorization.
const ResumeExtractSchema = CandidateProfileSchema.pick({
  education: true,
  certifications: true,
  workExperience: true,
  yearsOfExperience: true,
  skills: true,
  projects: true,
  achievements: true,
  industries: true,
});

const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts from a candidate's resume/CV markdown.

CRITICAL RULES — violating any of these makes your output unusable:
- Only report what is explicitly written in the provided text. Never invent, infer, round up, or embellish skills, titles, dates, employers, degrees, certifications, or achievements.
- "yearsOfExperience" must be computed only from explicit dates/durations in the text (e.g. sum professional roles' date ranges to today). If dates are ambiguous or missing, estimate conservatively from what IS stated and never invent a number pulled from nowhere.
- If a field has no basis in the text, return an empty array or the closest neutral value — never fabricate content to fill it.
- Do not add skills implied by a company/tool name unless the resume itself states the candidate used it (e.g. do not assume "AWS" because the candidate mentions "cloud").
- Preserve the candidate's own wording for bullets/achievements rather than rewriting them.`;

function fileHash(...paths) {
  const h = crypto.createHash('sha256');
  for (const p of paths) {
    h.update(existsSync(p) ? readFileSync(p) : Buffer.from('missing'));
  }
  return h.digest('hex');
}

function readProfileYaml() {
  if (!existsSync(PROFILE_YML_PATH)) {
    throw new Error(
      'config/profile.yml is missing. Run career-ops onboarding first (see AGENTS.md ' +
        '"First Run — Onboarding") or copy config/profile.example.yml and fill it in.',
    );
  }
  return yaml.load(readFileSync(PROFILE_YML_PATH, 'utf8')) || {};
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh]
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @returns {Promise<import('zod').infer<typeof CandidateProfileSchema>>}
 */
export async function loadCandidateProfile({ forceRefresh = false, config } = {}) {
  if (!existsSync(CV_PATH)) {
    throw new Error(
      'cv.md is missing at the project root. career-ops onboarding creates it from your ' +
        'resume — see AGENTS.md "First Run — Onboarding" step 1. The agent will not invent ' +
        'a candidate profile.',
    );
  }
  const cvText = readFileSync(CV_PATH, 'utf8');
  const profileYaml = readProfileYaml();
  const hash = fileHash(CV_PATH, PROFILE_YML_PATH);

  let extract = readCache(hash);
  if (!extract || forceRefresh) {
    extract = await structuredCall({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: `Extract structured resume facts from this CV (markdown):\n\n${cvText}`,
      schema: ResumeExtractSchema,
      schemaName: 'ResumeExtract',
      config: config || loadConfig(),
    });
    writeCache(hash, extract);
  }

  return CandidateProfileSchema.parse(mergeWithProfileYaml(extract, profileYaml));
}

function mergeWithProfileYaml(extract, y) {
  const candidate = y.candidate || {};
  const location = y.location || {};
  const workPrefs = y.work_preferences || {};
  const targetRoles = y.target_roles || {};
  const compensation = y.compensation || {};
  return {
    ...extract,
    fullName: candidate.full_name || '',
    email: candidate.email || '',
    phone: candidate.phone || null,
    location: candidate.location || location.city || '',
    linkedin: candidate.linkedin || null,
    portfolioUrl: candidate.portfolio_url || null,
    github: candidate.github || null,
    preferences: {
      targetRoles: targetRoles.primary || [],
      seniority: workPrefs.seniority || [],
      remoteAllowed: workPrefs.remote ?? true,
      hybridAllowed: workPrefs.hybrid ?? true,
      onsiteAllowed: workPrefs.onsite ?? true,
      relocationOpen: workPrefs.relocation_open ?? false,
      locationFlexibility: compensation.location_flexibility || null,
      compensationTargetRange: compensation.target_range || null,
    },
    workAuthorization: {
      country: location.country || 'United States',
      status: location.visa_status || 'Not specified — ask the candidate before applying',
      authorizedIn: location.authorized_in || [],
      needsSponsorship: location.needs_sponsorship ?? false,
    },
  };
}

function readCache(hash) {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (cached.hash !== hash) return null;
    return ResumeExtractSchema.parse(cached.extract);
  } catch {
    return null;
  }
}

function writeCache(hash, extract) {
  mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify({ hash, extract }, null, 2));
}

export { CV_PATH, PROFILE_YML_PATH, ResumeExtractSchema, mergeWithProfileYaml };
