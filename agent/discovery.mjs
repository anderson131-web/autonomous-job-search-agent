// agent/discovery.mjs — job discovery (spec section 4).
//
// Reuses career-ops's existing provider layer instead of re-scraping boards:
//   - providers/*.mjs (55+ modules: Greenhouse, Lever, Ashby, Workday,
//     iCIMS, SmartRecruiters, BambooHR, ...) implement the `{id, detect,
//     fetch}` contract in providers/_types.js — this already IS the
//     JobSource interface the spec asks for (section 4), so it is consumed
//     directly rather than rebuilt.
//   - portals.yml's `tracked_companies` supplies the company list (Fortune
//     500s, mid-size, startups, AI labs, etc. — 100+ pre-configured).
//   - scan.mjs's own filter builders (title/location/content) are reused so
//     the agent's filtering matches the interactive CLI's, not a
//     reinvented approximation.
//
// Dynamic, non-curated discovery (spec section 5, "discover companies
// dynamically rather than only a manually created list") is delegated to the
// existing `scan-ats-full.mjs` reverse-ATS sweep, which the operator runs
// periodically (`npm run scan:full`, or scheduled — see docs/AUTOMATION.md);
// importFromPipelineMd() below ingests whatever it (or `scan.mjs`) added to
// data/pipeline.md so the worker picks up those postings too, without this
// module re-implementing a full-internet company sweep.
//
// Indeed and ZipRecruiter are covered too, via their official Claude MCP
// connectors (agent/job-boards.mjs) — not scraping. LinkedIn and Glassdoor
// have no such connector and are intentionally absent: LinkedIn's User
// Agreement prohibits automated scraping/access, and this project stops at
// that boundary rather than attempting to route around it (spec section 4:
// "if a source blocks automation ... gracefully stop rather than attempting
// to bypass").

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { searchIndeed, searchZipRecruiter } from './job-boards.mjs';
import { REPO_ROOT } from './config.mjs';
import { loadProviders } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';
import { buildTitleFilter, buildLocationFilter, sanitizeMarkdownField } from '../scan.mjs';

const PORTALS_PATH = path.join(REPO_ROOT, 'portals.yml');
const PROVIDERS_DIR = path.join(REPO_ROOT, 'providers');
const PIPELINE_PATH = path.join(REPO_ROOT, 'data', 'pipeline.md');

function loadPortalsConfig() {
  if (!existsSync(PORTALS_PATH)) return { tracked_companies: [], title_filter: null, location_filter: null };
  return yaml.load(readFileSync(PORTALS_PATH, 'utf8')) || {};
}

/**
 * Poll every enabled company in portals.yml through the provider registry.
 * Returns normalized Job objects (matching schemas.mjs JobSchema, minus
 * jobId/discoveredAt which the caller/DB assign).
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {AbortSignal} [opts.signal] - Checked between companies so a
 *   dashboard "Stop scanning" click takes effect promptly on this — the
 *   slowest — phase of a cycle, without killing an in-flight fetch mid-request.
 * @returns {Promise<{jobs: object[], errors: {company: string, error: string}[], stopped: boolean}>}
 */
export async function discoverFromPortals({ log = () => {}, signal } = {}) {
  const portals = loadPortalsConfig();
  const companies = (portals.tracked_companies || []).filter((c) => c.enabled !== false);
  const titleFilter = portals.title_filter ? buildTitleFilter(portals.title_filter) : null;
  const locationFilter = portals.location_filter ? buildLocationFilter(portals.location_filter) : null;

  const providers = await loadProviders(PROVIDERS_DIR);
  const ctx = makeHttpCtx();
  const jobs = [];
  const errors = [];
  let stopped = false;

  for (const entry of companies) {
    if (signal?.aborted) {
      stopped = true;
      log('  ⏹️  Stop requested — ending portal sweep early.');
      break;
    }
    let provider = entry.provider ? providers.get(entry.provider) : null;
    if (!provider) {
      for (const p of providers.values()) {
        if (p.detect?.(entry)) {
          provider = p;
          break;
        }
      }
    }
    if (!provider) continue; // no matching provider — not every entry is API-reachable

    try {
      const raw = await provider.fetch(entry, ctx);
      for (const j of raw) {
        if (!j?.title || !j?.url) continue;
        // titleFilter is already the compiled (title) => boolean predicate
        // from buildTitleFilter() — call it directly. It used to be passed
        // into matchedTitleKeywords() instead, which expects the RAW
        // title_filter config object (for a different purpose — scoping
        // content-filter overrides), not a function. A function has no
        // `.positive` property, so that call silently always returned an
        // empty array and this line rejected every single job, always —
        // discoverFromPortals never actually returned results because of
        // this, not because no postings matched.
        if (titleFilter && !titleFilter(j.title)) continue;
        if (locationFilter && !locationPasses(j.location, locationFilter)) continue;
        jobs.push({
          source: provider.id,
          company: sanitizeMarkdownField(j.company || entry.name || ''),
          title: sanitizeMarkdownField(j.title),
          location: j.location ? sanitizeMarkdownField(j.location) : null,
          remote: typeof j.location === 'string' ? /remote/i.test(j.location) : null,
          url: j.url,
          description: j.description || null,
          postedAt: j.postedAt ? new Date(j.postedAt).toISOString() : null,
          salary: null,
          applicantCount: null,
        });
      }
    } catch (err) {
      errors.push({ company: entry.name || provider.id, error: err.message });
      log(`  ⚠️  ${entry.name || provider.id}: ${err.message}`);
    }
  }

  return { jobs, errors, stopped };
}

// buildLocationFilter's shape is opaque to this module; scan.mjs applies it
// inline rather than exporting a standalone predicate, so replicate the
// same three-tier semantics documented in templates/portals.example.yml
// (empty location passes; always_allow beats block; allow must match if set).
function locationPasses(location, filter) {
  const loc = (location || '').toLowerCase();
  if (!loc) return true;
  if (filter.always_allow?.some((k) => loc.includes(k.toLowerCase()))) return true;
  if (filter.block?.some((k) => loc.includes(k.toLowerCase()))) return false;
  if (!filter.allow || filter.allow.length === 0) return true;
  return filter.allow.some((k) => loc.includes(k.toLowerCase()));
}

/**
 * Import postings already staged in data/pipeline.md by `scan.mjs` /
 * `scan-ats-full.mjs` (the existing zero-token reverse-ATS sweep — this is
 * how dynamic, non-curated company discovery reaches the agent without
 * duplicating that sweep's logic here).
 *
 * @returns {object[]} Job objects in the same shape as discoverFromPortals().
 */
export function importFromPipelineMd() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const text = readFileSync(PIPELINE_PATH, 'utf8');
  const jobs = [];
  const lineRe = /^- \[ \] (\S+)(?: \| ([^|]+) \| ([^|]+))?/;
  for (const line of text.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [, url, company, title] = m;
    if (!url || !url.startsWith('http')) continue;
    jobs.push({
      source: 'pipeline-import',
      company: (company || '').trim() || 'Unknown',
      title: (title || '').trim() || 'Unknown role',
      location: null,
      remote: null,
      url,
      description: null,
      postedAt: null,
      salary: null,
      applicantCount: null,
    });
  }
  return jobs;
}

/**
 * Query Indeed + ZipRecruiter's official MCP connectors for each of the
 * candidate's target roles (spec §4/§5 — Indeed/ZipRecruiter as legitimate
 * job sources; "cast a wide net" per the candidate's stated preference).
 * Each query is its own `claude -p` call, so this is deliberately bounded —
 * one query per target role per board, not an unbounded sweep — to keep
 * subscription usage predictable (see docs/AUTONOMOUS_AGENT.md).
 *
 * @param {object} opts
 * @param {object} opts.candidate - CandidateProfileSchema shape.
 * @param {import('./config.mjs').AgentConfig} opts.config
 * @param {(msg: string) => void} [opts.log]
 * @param {AbortSignal} [opts.signal] - Checked between role queries.
 * @returns {Promise<object[]>} Job objects in the same shape as discoverFromPortals().
 */
/**
 * Pure — no network — so it's directly testable. Derives the actual search
 * parameters from the candidate's real work-mode preference
 * (config/profile.yml → work_preferences, mirrored by REMOTE_ALLOWED/
 * HYBRID_ALLOWED/ONSITE_ALLOWED in .env) instead of hardcoding remote-only.
 *
 * @param {object} candidate - CandidateProfileSchema shape.
 * @returns {{indeedLocation: string, zipLocationTypes: string[]}}
 */
export function resolveJobBoardSearchParams(candidate) {
  const prefs = candidate.preferences || {};
  const remoteOk = prefs.remoteAllowed ?? true;
  const hybridOk = prefs.hybridAllowed ?? true;
  const onsiteOk = prefs.onsiteAllowed ?? true;

  const zipLocationTypes = [
    ...(remoteOk ? ['REMOTE'] : []),
    ...(hybridOk ? ['HYBRID'] : []),
    ...(onsiteOk ? ['PHYSICAL'] : []),
  ];
  // Indeed's search tool takes one location string per call, and "remote"
  // is a distinct search mode there (not a filter you can combine with a
  // city) — so a hybrid/onsite-only candidate searches near their own
  // metro instead. True nationwide coverage would mean one call per target
  // metro; kept to one call per role here to bound subscription usage.
  const indeedLocation = remoteOk ? 'remote' : candidate.location || 'United States';

  return { indeedLocation, zipLocationTypes };
}

export async function discoverFromJobBoards({ candidate, config, log = () => {}, signal }) {
  const roles = candidate.preferences?.targetRoles?.length
    ? candidate.preferences.targetRoles
    : ['Software Engineer'];
  const { indeedLocation, zipLocationTypes } = resolveJobBoardSearchParams(candidate);

  // Apply the SAME portals.yml title_filter (positive + negative, e.g.
  // "Senior"/"Staff"/"Director" excluded for an entry-level candidate) that
  // discoverFromPortals() uses — Indeed/ZipRecruiter results used to bypass
  // it entirely, which is how senior-only postings kept showing up despite
  // the candidate being 0-1 years experience.
  const portals = loadPortalsConfig();
  const titleFilter = portals.title_filter ? buildTitleFilter(portals.title_filter) : null;

  const jobs = [];
  for (const role of roles) {
    if (signal?.aborted) {
      log('  ⏹️  Stop requested — ending job-board search early.');
      break;
    }
    log(`  Indeed: searching "${role}" (${indeedLocation})...`);
    const indeedJobs = await searchIndeed({ query: role, location: indeedLocation, jobType: 'fulltime' }, config);
    jobs.push(...indeedJobs.filter((j) => !titleFilter || titleFilter(j.title)));

    if (zipLocationTypes.length) {
      log(`  ZipRecruiter: searching "${role}" (${zipLocationTypes.join('/')})...`);
      const zipJobs = await searchZipRecruiter(
        { role, location: 'United States', locationTypes: zipLocationTypes, seniorityClasses: ['NO_EXPERIENCE', 'JUNIOR'] },
        config,
      );
      jobs.push(...zipJobs.filter((j) => !titleFilter || titleFilter(j.title)));
    }
  }
  return jobs;
}
