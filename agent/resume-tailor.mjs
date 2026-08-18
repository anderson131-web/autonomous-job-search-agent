// agent/resume-tailor.mjs — per-job resume tailoring (spec section 9).
//
// Reuses the existing ATS PDF pipeline instead of reinventing one:
// build-cv-html.mjs fills templates/cv-template.html from a JSON payload,
// generate-pdf.mjs (renderHtmlToPdf, imported directly) renders that HTML to
// PDF with Playwright. This module's only job is producing that payload —
// reordered/emphasized, never fabricated — from cv.md + the job description.
//
//   resumes/
//     master/    — untouched copy of cv.md (the one truth, never edited here)
//     tailored/  — one {payload.json, .html, .pdf, .md} set per application

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT, loadConfig } from './config.mjs';
import { structuredCall } from './claude-client.mjs';
import { CvPayloadSchema } from './schemas.mjs';

const execFileAsync = promisify(execFile);

const MASTER_DIR = path.join(REPO_ROOT, 'resumes', 'master');
const TAILORED_DIR = path.join(REPO_ROOT, 'resumes', 'tailored');
const CV_PATH = path.join(REPO_ROOT, 'cv.md');
const BUILD_CV_HTML = path.join(REPO_ROOT, 'build-cv-html.mjs');

const TAILOR_SYSTEM_PROMPT = `You produce a JSON payload for an ATS resume template from a candidate's master CV and a target job description.

ABSOLUTE RULES (violating any of these makes your output unusable and dishonest):
- NEVER invent experience, employers, titles, dates, degrees, certifications, skills, or metrics that are not in the master CV.
- NEVER exaggerate or inflate an accomplishment beyond what the master CV states.
- You MAY: reorder sections/bullets to put the most JD-relevant material first, choose which existing bullets/projects to lead with or omit, and rephrase using terminology from the JD WHEN it is truthfully equivalent to what the CV already says (e.g. CV says "REST API development", JD says "RESTful services" — using "RESTful services" is fine; inventing "5 years of Kubernetes experience" the CV never mentions is not).
- "summary" must be grounded entirely in the master CV's own content, written for this specific role.
- "competencies" are keyword phrases genuinely supported by the master CV.
- Every experience/project bullet must map to something the master CV actually says, possibly reworded.
- Fill every field required by the schema even where the master CV is thin (e.g. put real projects under "projects" if there isn't a separate publications section) — do not omit required sections, but never pad them with invented content either.
- candidate.location/email/phone/linkedin/github/portfolio must be copied exactly from the profile data given to you, never altered.`;

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function ensureMasterCopy() {
  mkdirSync(MASTER_DIR, { recursive: true });
  const dest = path.join(MASTER_DIR, 'cv.md');
  if (existsSync(CV_PATH)) copyFileSync(CV_PATH, dest);
  return dest;
}

/**
 * @param {object} opts
 * @param {object} opts.candidate - CandidateProfileSchema shape
 * @param {object} opts.job - Job row
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @returns {Promise<{jobId: string, slug: string, payloadPath: string, htmlPath: string, pdfPath: string|null, payload: object}>}
 */
export async function tailorResumeForJob({ candidate, job, config }) {
  const cfg = config || loadConfig();
  ensureMasterCopy();
  mkdirSync(TAILORED_DIR, { recursive: true });

  const cvText = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf8') : '';
  const slug = `${slugify(job.company)}-${slugify(job.title)}-${(job.jobId || '').slice(0, 8)}`;

  const prompt = [
    `## Candidate profile (structured, authoritative for contact info — copy exactly)`,
    JSON.stringify(
      {
        name: candidate.fullName,
        email: candidate.email,
        phone: candidate.phone,
        location: candidate.location,
        linkedin: candidate.linkedin,
        github: candidate.github,
        portfolio: candidate.portfolioUrl,
      },
      null,
      2,
    ),
    ``,
    `## Master CV (markdown — the ONLY source of truth for experience/skills/education content)`,
    cvText,
    ``,
    `## Target job`,
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Description:`,
    job.description || '(no description available — tailor lightly, keep the master CV structure)',
  ].join('\n');

  const payload = await structuredCall({
    system: TAILOR_SYSTEM_PROMPT,
    prompt,
    schema: CvPayloadSchema,
    schemaName: 'CvPayload',
    config: cfg,
  });

  // Never let the model substitute its own contact info even if asked to
  // "copy exactly" — enforce it structurally too.
  payload.candidate.name = candidate.fullName;
  payload.candidate.email = candidate.email;
  payload.candidate.location = candidate.location;
  if (candidate.phone) payload.candidate.phone = candidate.phone;
  if (candidate.linkedin) payload.candidate.linkedin = { url: `https://${stripProto(candidate.linkedin)}`, display: stripProto(candidate.linkedin) };
  if (candidate.github) payload.candidate.github = { url: `https://${stripProto(candidate.github)}`, display: stripProto(candidate.github) };
  if (candidate.portfolioUrl) payload.candidate.portfolio = { url: candidate.portfolioUrl, display: stripProto(candidate.portfolioUrl) };

  const payloadPath = path.join(TAILORED_DIR, `${slug}.json`);
  const htmlPath = path.join(TAILORED_DIR, `${slug}.html`);
  const pdfPath = path.join(TAILORED_DIR, `${slug}.pdf`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

  let pdfWritten = null;
  try {
    await execFileAsync('node', [BUILD_CV_HTML, payloadPath, htmlPath], { cwd: REPO_ROOT });
    const { renderHtmlToPdf } = await import('../generate-pdf.mjs');
    const html = readFileSync(htmlPath, 'utf8');
    await renderHtmlToPdf(html, pdfPath, { format: payload.page_format || 'letter' });
    pdfWritten = pdfPath;
  } catch (err) {
    // PDF rendering is best-effort — the JSON payload + HTML are still saved,
    // and the caller can regenerate the PDF with `node generate-pdf.mjs`
    // manually. Never let a rendering failure block scoring/decision flow.
    pdfWritten = null;
    payload.__pdfError = err.message;
  }

  return {
    jobId: job.jobId,
    slug,
    payloadPath,
    htmlPath: existsSync(htmlPath) ? htmlPath : null,
    pdfPath: pdfWritten,
    payload,
  };
}

function stripProto(url) {
  return String(url).replace(/^https?:\/\//, '');
}
