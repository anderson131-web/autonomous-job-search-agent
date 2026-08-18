import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// importFromPipelineMd() reads a hardcoded REPO_ROOT/data/pipeline.md path,
// so this test exercises the parser directly rather than monkey-patching
// REPO_ROOT — it constructs the same regex-driven parse against a temp file
// and asserts the shape the real function would produce.
const lineRe = /^- \[ \] (\S+)(?: \| ([^|]+) \| ([^|]+))?/;

function parsePipelineText(text) {
  const jobs = [];
  for (const line of text.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [, url, company, title] = m;
    if (!url || !url.startsWith('http')) continue;
    jobs.push({ url, company: (company || '').trim() || 'Unknown', title: (title || '').trim() || 'Unknown role' });
  }
  return jobs;
}

test('pipeline.md row parser extracts url/company/title from the documented format', () => {
  const text = [
    '- [ ] https://job-boards.greenhouse.io/acme/jobs/1 | Acme | Software Engineer',
    '- [ ] https://jobs.lever.co/beta/2 | Beta Corp | AI Engineer | Remote | $120k-150k',
    '- [ ] not-a-url | Should be skipped | x',
    '- [ ] https://x.com/bare-url',
  ].join('\n');
  const jobs = parsePipelineText(text);
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(jobs[0].title, 'Software Engineer');
  assert.equal(jobs[1].company, 'Beta Corp');
  assert.equal(jobs[2].company, 'Unknown');
});

test('discoverFromPortals stops immediately (no network calls) when the signal is already aborted', async () => {
  const { discoverFromPortals } = await import('./discovery.mjs');
  const controller = new AbortController();
  controller.abort();
  const { jobs, stopped } = await discoverFromPortals({ signal: controller.signal, log: () => {} });
  assert.equal(stopped, true);
  assert.deepEqual(jobs, []);
});

test('discoverFromJobBoards stops immediately when the signal is already aborted', async () => {
  const { discoverFromJobBoards } = await import('./discovery.mjs');
  const controller = new AbortController();
  controller.abort();
  const candidate = { preferences: { targetRoles: ['Software Engineer', 'AI Engineer'] } };
  const jobs = await discoverFromJobBoards({ candidate, config: {}, signal: controller.signal, log: () => {} });
  assert.deepEqual(jobs, []);
});

test('resolveJobBoardSearchParams honors a hybrid/onsite-only preference (not remote)', async () => {
  const { resolveJobBoardSearchParams } = await import('./discovery.mjs');
  const candidate = {
    location: 'Naperville, IL',
    preferences: { remoteAllowed: false, hybridAllowed: true, onsiteAllowed: true },
  };
  const { indeedLocation, zipLocationTypes } = resolveJobBoardSearchParams(candidate);
  assert.equal(indeedLocation, 'Naperville, IL'); // never "remote" when remoteAllowed is false
  assert.deepEqual(zipLocationTypes.sort(), ['HYBRID', 'PHYSICAL']);
  assert.ok(!zipLocationTypes.includes('REMOTE'));
});

test('resolveJobBoardSearchParams searches remote when the candidate allows it', async () => {
  const { resolveJobBoardSearchParams } = await import('./discovery.mjs');
  const candidate = { location: 'Naperville, IL', preferences: { remoteAllowed: true, hybridAllowed: false, onsiteAllowed: false } };
  const { indeedLocation, zipLocationTypes } = resolveJobBoardSearchParams(candidate);
  assert.equal(indeedLocation, 'remote');
  assert.deepEqual(zipLocationTypes, ['REMOTE']);
});

test('resolveJobBoardSearchParams defaults to permissive when preferences are absent', async () => {
  const { resolveJobBoardSearchParams } = await import('./discovery.mjs');
  const { zipLocationTypes } = resolveJobBoardSearchParams({});
  assert.deepEqual(zipLocationTypes.sort(), ['HYBRID', 'PHYSICAL', 'REMOTE']);
});

// Regression for a real bug: discoverFromPortals() built titleFilter via
// buildTitleFilter() (which returns a ready (title) => boolean predicate)
// but then passed that FUNCTION into matchedTitleKeywords() — which expects
// the raw {positive, negative} config object, not a function. A function has
// no `.positive` property, so matchedTitleKeywords() always returned an
// empty array and the filter rejected every single job, unconditionally.
// This is why discoverFromPortals returned zero results on every real run,
// not because no postings actually matched.
test('buildTitleFilter returns a predicate that must be called directly, not passed to matchedTitleKeywords', async () => {
  const { buildTitleFilter, matchedTitleKeywords } = await import('../scan.mjs');
  const titleFilter = buildTitleFilter({
    positive: ['Software Engineer'],
    negative: ['Senior', 'Staff', 'Director'],
  });

  // The correct usage (what discovery.mjs does now): call the predicate.
  assert.equal(titleFilter('Software Engineer'), true);
  assert.equal(titleFilter('Senior Software Engineer'), false); // negative excludes even with a positive match
  assert.equal(titleFilter('Product Manager'), false); // no positive match

  // The bug this guards against: passing the predicate itself as the
  // "titleFilter" argument to matchedTitleKeywords() always yields [] —
  // silently rejecting everything — regardless of what the title actually is.
  assert.deepEqual(matchedTitleKeywords('Software Engineer', titleFilter), []);
});
