// agent/job-boards.mjs — Indeed + ZipRecruiter discovery via their official
// Claude MCP connectors (spec section 4/5: legitimate job sources beyond a
// curated company list).
//
// These are NOT scrapers. `mcp.indeed.com` and `api.ziprecruiter.com` are
// job boards' own hosted MCP servers, reached the same way career-ops's
// headless reasoning already runs — through `claude -p` (agent/claude-cli.mjs)
// — so a search here is authenticated exactly like a normal Claude Code tool
// call, under whatever connectors are enabled on your account. Check
// `claude mcp list` to see which are connected; if Indeed/ZipRecruiter show
// "Needs authentication" or aren't listed, these functions degrate to
// returning an empty array rather than failing the discovery cycle.
//
// LinkedIn and Glassdoor have no such connector and are not implemented here
// — LinkedIn's ToS prohibits automated access outright.

import { runClaudeCli, extractJson } from './claude-cli.mjs';

const RESULT_SYSTEM_PROMPT =
  'You have access to exactly one job-search tool for this task. Call it once with the exact ' +
  'parameters given, then reply with ONLY a JSON array (no prose, no markdown fences) of every ' +
  'result it returned, each formatted as {"title":string,"company":string,"location":string,' +
  '"url":string,"compensation":string|null,"postedAt":string|null}. Use the exact apply/view URL ' +
  'from the tool result. If the tool returns zero results or errors, reply with an empty JSON array: [].';

/**
 * @param {object} opts
 * @param {string} opts.query - Job title/keywords.
 * @param {string} [opts.location] - City/state, or "remote".
 * @param {string} [opts.countryCode] - ISO 3166 two-letter, default "US".
 * @param {string} [opts.jobType] - fulltime|parttime|contract|internship|temporary
 * @param {import('./config.mjs').AgentConfig} config
 * @returns {Promise<object[]>} Job-shaped objects (source: 'indeed').
 */
export async function searchIndeed({ query, location = 'remote', countryCode = 'US', jobType = 'fulltime' }, config) {
  const prompt =
    `Call the Indeed job search tool with: search="${query}", location="${location}", ` +
    `country_code="${countryCode}", job_type="${jobType}".`;
  return runBoardSearch({ prompt, tool: 'mcp__claude_ai_Indeed__search_jobs', source: 'indeed', config });
}

/**
 * @param {object} opts
 * @param {string} opts.role - Job role/title.
 * @param {string} [opts.location] - City/state/zip, or omit for a broad US search.
 * @param {string[]} [opts.locationTypes] - REMOTE | HYBRID | PHYSICAL
 * @param {string[]} [opts.seniorityClasses] - NO_EXPERIENCE | JUNIOR | MID | SENIOR
 * @param {import('./config.mjs').AgentConfig} config
 * @returns {Promise<object[]>} Job-shaped objects (source: 'ziprecruiter').
 */
export async function searchZipRecruiter(
  { role, location = 'United States', locationTypes = ['REMOTE'], seniorityClasses = ['NO_EXPERIENCE', 'JUNIOR'] },
  config,
) {
  const prompt =
    `Call the ZipRecruiter job search tool with: job_role="${role}", location="${location}", ` +
    `location_types=${JSON.stringify(locationTypes)}, seniority_classes=${JSON.stringify(seniorityClasses)}, ` +
    `employment_types=["FULL_TIME"].`;
  return runBoardSearch({ prompt, tool: 'mcp__claude_ai_ZipRecruiter__search_jobs', source: 'ziprecruiter', config });
}

async function runBoardSearch({ prompt, tool, source, config }) {
  try {
    const { text } = await runClaudeCli({
      prompt,
      system: RESULT_SYSTEM_PROMPT,
      model: config?.claudeTriageModel || 'haiku',
      effort: 'low',
      tools: tool,
      permissionMode: 'bypassPermissions',
      timeoutMs: 90_000,
    });
    const parsed = JSON.parse(extractJson(text));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((j) => j?.title && j?.url)
      .map((j) => ({
        source,
        company: String(j.company || 'Unknown'),
        title: String(j.title),
        location: j.location ? String(j.location) : null,
        remote: j.location ? /remote/i.test(j.location) : null,
        url: String(j.url),
        description: null,
        postedAt: j.postedAt || null,
        salary: j.compensation || null,
        applicantCount: null,
      }));
  } catch (err) {
    console.warn(`  ⚠️  ${source} search failed (query "${prompt.slice(0, 60)}..."): ${err.message}`);
    return [];
  }
}
