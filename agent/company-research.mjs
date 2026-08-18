// agent/company-research.mjs — company research before applying (spec §7).
//
// Two-step Claude call, not one combined tool+structured-output call: the
// web_search server tool and output_config.format don't compose cleanly in a
// single request, so step 1 gathers research with web_search enabled (plain
// text), and step 2 (structuredCall) synthesizes that text into the
// CompanySchema shape. Cached per company name for the life of the process —
// re-researching the same employer on every job posting would be wasteful
// and slow.

import { loadConfig, assertReadyForLiveCalls } from './config.mjs';
import { structuredCall } from './claude-client.mjs';
import { runClaudeCli } from './claude-cli.mjs';
import { CompanySchema } from './schemas.mjs';

const RESEARCH_SYSTEM_PROMPT =
  'Research the given company as a prospective employer. Cover: what they do (industry/product), ' +
  'approximate size, headquarters/locations, funding/public status if known, recent hiring or growth ' +
  'signals, and anything that reads as a red flag for a job seeker (no real web presence, scam-like ' +
  'posting patterns, well-documented labor issues). Be concise — plain notes, not a report. If you ' +
  'cannot find reliable information, say so plainly rather than speculating.';

const cache = new Map();

const SYNTHESIS_SYSTEM_PROMPT = `You convert freeform company-research notes into a structured record.

Rules:
- Only include facts present in the notes. Where the notes don't say, use null (or an empty array) — never guess a company size, industry, or founding detail.
- legitimacyTier: "verified" only for well-known, clearly real employers; "likely-legitimate" for smaller-but-plausible companies with a real website/domain; "unverified" when you can't confirm the company is real; "suspicious" when the notes describe red flags (no real website, too-good-to-be-true pay for the role, requests for money/personal financial info, vague/generic descriptions, mismatched domain).
- redFlags: list concrete signals from the notes (e.g. "no company website found", "posting age > 90 days with generic description"), not vague concerns.
- qualityScore 0-100 reflects overall company legitimacy + desirability as an employer based only on the notes — not a job-fit score.`;

/**
 * @param {object} opts
 * @param {string} opts.companyName
 * @param {string} [opts.careersUrlHint]
 * @param {number|null} [opts.postingAgeDays]
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @returns {Promise<import('zod').infer<typeof CompanySchema>>}
 */
export async function researchCompany({ companyName, careersUrlHint, postingAgeDays = null, config }) {
  const cfg = config || loadConfig();
  const cacheKey = companyName.toLowerCase().trim();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const notes = await gatherResearchNotes({ companyName, careersUrlHint, cfg });
  const company = await structuredCall({
    system: SYNTHESIS_SYSTEM_PROMPT,
    prompt:
      `Company: ${companyName}\n` +
      (postingAgeDays != null ? `Posting age (days since first seen): ${postingAgeDays}\n` : '') +
      `\nResearch notes:\n${notes}`,
    schema: CompanySchema,
    schemaName: 'Company',
    config: cfg,
  });
  company.postingAgeDays = postingAgeDays;
  cache.set(cacheKey, company);
  return company;
}

async function gatherResearchNotes({ companyName, careersUrlHint, cfg }) {
  assertReadyForLiveCalls(cfg);
  const prompt = `Research "${companyName}" as a prospective employer.${
    careersUrlHint ? ` Careers/posting URL for context: ${careersUrlHint}` : ''
  }`;

  if (cfg.claudeBackend === 'api') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    const response = await client.beta.messages.create({
      model: cfg.claudeModel,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      system: RESEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') return 'Research declined by the model; no notes available.';
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }

  // 'cli' backend — the claude CLI's built-in WebSearch tool, under your
  // logged-in Pro/Max subscription (same mechanism as `structuredCall`).
  const { text } = await runClaudeCli({
    prompt,
    system: RESEARCH_SYSTEM_PROMPT,
    model: cfg.claudeModel,
    effort: 'low',
    tools: 'WebSearch',
  });
  return text || 'No research notes returned.';
}

/** Test-only. */
export function _clearCompanyResearchCache() {
  cache.clear();
}
