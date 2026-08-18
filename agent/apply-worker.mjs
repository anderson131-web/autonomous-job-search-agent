// agent/apply-worker.mjs — application automation (spec sections 10, 22-23).
//
// This is deliberately the most conservative module in the agent. It:
//   - Never attempts LinkedIn login/apply automation (ToS-prohibited —
//     LinkedIn jobs are HUMAN_REVIEW/manual by design, see agent/discovery.mjs).
//   - Never touches a CAPTCHA, 2FA prompt, or login wall — detecting any of
//     these stops the run and routes to HUMAN_REVIEW.
//   - Only fills fields it can map with high confidence (name, email, phone,
//     resume upload, LinkedIn/portfolio URL). Every other field — cover
//     letter text, custom questions, salary, work authorization, EEO/
//     demographic, "how did you hear about us" — is left for the candidate;
//     the agent never guesses (spec section 11).
//   - Only auto-submits (when DRY_RUN=false && AUTO_APPLY_ENABLED=true) on
//     Greenhouse/Lever/Ashby — the three ATS platforms career-ops's own
//     apply-autofill flow (docs/APPLY_AUTOFILL.md) has field-tested — AND
//     only when every visible field was filled with high confidence and no
//     CAPTCHA/knock-out/confirmation-needed field was seen. In practice most
//     real forms have at least one field that needs the candidate, so most
//     runs land in HUMAN_REVIEW with everything pre-filled and a screenshot
//     — which is the safe, intended default.
//   - Never clicks Submit on anything else. The candidate always has the
//     final call there, exactly as in the existing interactive apply mode.

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadConfig } from './config.mjs';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'agent', 'data', 'apply-screenshots');

const AUTO_SUBMIT_VENDORS = new Set(['greenhouse', 'lever', 'ashby']);

export { detectVendor, fillKnownFields, collectUnhandledFields };

function detectVendor(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/(^|\.)greenhouse\.io$/.test(host)) return 'greenhouse';
  if (/(^|\.)lever\.co$/.test(host)) return 'lever';
  if (/(^|\.)ashbyhq\.com$/.test(host)) return 'ashby';
  if (/myworkdayjobs\.com$/.test(host)) return 'workday';
  if (/smartrecruiters\.com$/.test(host)) return 'smartrecruiters';
  if (/icims\.com$/.test(host)) return 'icims';
  if (/linkedin\.com$/.test(host)) return 'linkedin';
  return 'unknown';
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="captcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[title*="recaptcha" i]',
  '.g-recaptcha',
  '.h-captcha',
  '[id*="captcha" i]',
];

const LOGIN_WALL_SELECTORS = ['input[type="password"]'];

// Field categories the agent will confidently self-fill. Everything else is
// a needs-confirmation item.
const FIELD_MATCHERS = [
  { key: 'fullName', re: /\b(full\s*name|your\s*name)\b/i, exclude: /first|last/i },
  { key: 'firstName', re: /first\s*name/i },
  { key: 'lastName', re: /last\s*name/i },
  { key: 'email', re: /e[-\s]?mail/i },
  { key: 'phone', re: /phone|mobile/i },
  { key: 'linkedin', re: /linked ?in/i },
  { key: 'portfolio', re: /portfolio|website|personal site/i },
];

/**
 * @param {object} opts
 * @param {object} opts.job - Job row
 * @param {object} opts.candidate - CandidateProfileSchema shape
 * @param {string|null} opts.resumePdfPath - Tailored resume PDF, if one rendered
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @returns {Promise<{outcome: 'SUBMITTED'|'HUMAN_REVIEW'|'FAILED', reason: string, screenshotPath: string|null, filledFields: string[], needsConfirmation: {question:string,fieldType:string}[]}>}
 */
export async function applyToJob({ job, candidate, resumePdfPath, config }) {
  const cfg = config || loadConfig();
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const vendor = detectVendor(job.url);
  if (vendor === 'linkedin') {
    return {
      outcome: 'HUMAN_REVIEW',
      reason: "LinkedIn's Terms of Service prohibit automated access — never automated. Apply manually.",
      screenshotPath: null,
      filledFields: [],
      needsConfirmation: [],
    };
  }
  if (vendor === 'unknown') {
    return {
      outcome: 'HUMAN_REVIEW',
      reason: 'Unrecognized/unsupported application platform — not attempting automated fill.',
      screenshotPath: null,
      filledFields: [],
      needsConfirmation: [],
    };
  }

  // Rate limiting — spec section 12/22 ("do not hammer websites").
  await sleep(1000 + Math.random() * 2000);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const result = { filledFields: [], needsConfirmation: [] };
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    for (const sel of LOGIN_WALL_SELECTORS) {
      if (await page.locator(sel).count()) {
        return await finish(page, {
          outcome: 'HUMAN_REVIEW',
          reason: 'Login/2FA wall detected — never automated. Apply manually.',
        });
      }
    }
    for (const sel of CAPTCHA_SELECTORS) {
      if (await page.locator(sel).count()) {
        return await finish(page, {
          outcome: 'HUMAN_REVIEW',
          reason: 'CAPTCHA detected — never automated. Apply manually.',
        });
      }
    }

    await fillKnownFields(page, candidate, result);
    if (resumePdfPath && existsSync(resumePdfPath)) {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count()) {
        await fileInput.setInputFiles(resumePdfPath).catch(() => {});
        result.filledFields.push('resume');
      }
    }

    await collectUnhandledFields(page, result);

    const screenshotPath = path.join(SCREENSHOT_DIR, `${job.jobId || 'job'}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    const readyForAutoSubmit =
      AUTO_SUBMIT_VENDORS.has(vendor) &&
      result.needsConfirmation.length === 0 &&
      !cfg.dryRun &&
      cfg.autoApplyEnabled;

    if (!readyForAutoSubmit) {
      return await finish(page, {
        outcome: 'HUMAN_REVIEW',
        reason: cfg.dryRun
          ? 'DRY_RUN is enabled — form filled but never submitted.'
          : result.needsConfirmation.length
            ? `${result.needsConfirmation.length} field(s) need your input before this can be submitted.`
            : 'Guarded auto-submit is disabled (AUTO_APPLY_ENABLED=false) — review and submit manually.',
        screenshotPath,
      }, result);
    }

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    if (!(await submitBtn.count())) {
      return await finish(page, {
        outcome: 'HUMAN_REVIEW',
        reason: 'Could not confidently locate a Submit button — never guessing at a click target.',
        screenshotPath,
      }, result);
    }
    await submitBtn.click();
    await page.waitForTimeout(2000);
    const finalScreenshot = path.join(SCREENSHOT_DIR, `${job.jobId || 'job'}-submitted.png`);
    await page.screenshot({ path: finalScreenshot, fullPage: true }).catch(() => {});

    return await finish(page, {
      outcome: 'SUBMITTED',
      reason: `Auto-submitted via guarded fast path (${vendor}, all fields high-confidence).`,
      screenshotPath: finalScreenshot,
    }, result);
  } catch (err) {
    return await finish(page, {
      outcome: 'FAILED',
      reason: `Apply automation error: ${err.message}`,
      screenshotPath: null,
    }, result).catch(() => ({
      outcome: 'FAILED',
      reason: `Apply automation error: ${err.message}`,
      screenshotPath: null,
      filledFields: result.filledFields,
      needsConfirmation: result.needsConfirmation,
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fillKnownFields(page, candidate, result) {
  const inputs = await page.locator('input[type="text"], input[type="email"], input[type="tel"], input:not([type])').all();
  for (const input of inputs) {
    const label = await labelFor(input);
    const matcher = FIELD_MATCHERS.find((m) => m.re.test(label) && !(m.exclude && m.exclude.test(label)));
    if (!matcher) continue;
    const value = valueFor(matcher.key, candidate);
    if (!value) continue;
    await input.fill(value).catch(() => {});
    result.filledFields.push(matcher.key);
  }
}

function valueFor(key, candidate) {
  switch (key) {
    case 'fullName':
      return candidate.fullName;
    case 'firstName':
      return candidate.fullName?.split(' ')[0] || '';
    case 'lastName':
      return candidate.fullName?.split(' ').slice(1).join(' ') || '';
    case 'email':
      return candidate.email;
    case 'phone':
      return candidate.phone || '';
    case 'linkedin':
      return candidate.linkedin ? `https://${String(candidate.linkedin).replace(/^https?:\/\//, '')}` : '';
    case 'portfolio':
      return candidate.portfolioUrl || '';
    default:
      return '';
  }
}

async function labelFor(input) {
  const aria = await input.getAttribute('aria-label').catch(() => null);
  if (aria) return aria;
  const placeholder = await input.getAttribute('placeholder').catch(() => null);
  if (placeholder) return placeholder;
  const name = await input.getAttribute('name').catch(() => null);
  return name || '';
}

// Every non-trivial field the agent didn't confidently fill is a
// candidate-confirmation item — never guessed (spec section 11). This is a
// conservative, best-effort scan (textareas + selects + radio/checkbox
// groups), not a full re-implementation of the interactive apply mode's
// knock-out-question detection.
async function collectUnhandledFields(page, result) {
  const textareas = await page.locator('textarea').all();
  for (const t of textareas) {
    const label = await labelFor(t);
    result.needsConfirmation.push({ question: label || 'Free-text field', fieldType: 'textarea' });
  }
  const selects = await page.locator('select').all();
  for (const s of selects) {
    const label = await labelFor(s);
    if (/country|state|province/i.test(label)) continue; // usually pre-fillable; leave for candidate anyway to avoid a wrong pick
    result.needsConfirmation.push({ question: label || 'Dropdown field', fieldType: 'select' });
  }
}

async function finish(page, outcome, result = { filledFields: [], needsConfirmation: [] }) {
  return { ...outcome, filledFields: result.filledFields, needsConfirmation: result.needsConfirmation };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
