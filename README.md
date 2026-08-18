# Autonomous Job Search Agent

A 24/7 job-search agent that discovers roles, scores them against a real
candidate profile, researches the companies, tailors a resume, and — only
under tightly guarded conditions — auto-applies. The goal was never volume;
it's interview probability. Every job the agent looks at ends up in one of
three buckets: apply, skip, or hand it to a human, and each of those comes
with a reason attached. Nothing about the candidate gets guessed or made up
along the way.

This is an add-on for [career-ops](https://github.com/santifer/career-ops),
santifer's open-source job-search CLI. It doesn't replace it or bundle its
code — see [Relationship to career-ops](#relationship-to-career-ops) below.

## What it does

- Discovers roles nationwide across curated-company ATS portals
  (Greenhouse, Lever, Ashby) plus Indeed and ZipRecruiter through their
  official connectors — no scraping. LinkedIn is left out on purpose; its
  Terms of Service don't allow automated access, so it's not touched.
- Filters by remote/hybrid/onsite and by title/seniority (e.g. entry-level
  only), then scores each surviving job 0-100 against the candidate's
  actual resume and stated preferences.
- Pulls in company research (legitimacy, red flags, a quality score) before
  deciding anything.
- Runs every decision through a validated schema instead of parsing free
  text — `CandidateProfile`, `Job`, `Company`, `JobMatch`,
  `ApplicationDecision`, `TailoredResume`, `ApplicationQuestion`,
  `ApplicationResult`.
- Tailors a resume per job by reordering and re-emphasizing real
  experience — it's not allowed to invent a skill, a date, or a line of
  experience that isn't already in the source CV.
- Can auto-submit an application, but only for CAPTCHA-free Greenhouse /
  Lever / Ashby forms, only above the score threshold, only under a daily
  and hourly rate cap, and never for LinkedIn. Anything the agent isn't
  sure about — salary, work authorization, EEO/demographic questions,
  open-ended text fields — goes to a human-review queue instead of getting
  guessed. This is off by default (`DRY_RUN=true`).
- Runs as a long-lived loop with rate limiting, backoff, dedup across runs,
  and a file lock that checks whether the process holding it is actually
  still alive, so a crash doesn't block the next run for a full staleness
  window.
- Keeps its own SQLite state (jobs, companies, matches, applications,
  status log, scan runs) — separate from career-ops's file-based tracker,
  since an unattended loop needs real transactional state, not a
  human-editable markdown file.
- Ships a small local dashboard: stats, a score histogram, the current top
  opportunities with location/salary/manual-apply links, the human-review
  queue, and controls to start/stop a run or flip Dry Run / auto-apply /
  threshold at runtime.
- Has a learning pass over past outcomes (interview/offer rate by title,
  company, source, score band) that feeds back into scoring — it never
  touches the candidate's factual data, only how it's weighted.
- Comes with around 50 tests, including a real headless-browser test of
  the form-filling logic rather than a mock.

## Relationship to career-ops

This repo is only the agent layer I built on top of career-ops — it isn't
a copy of [career-ops](https://github.com/santifer/career-ops) itself and
doesn't bundle santifer's code. At runtime it imports a handful of
career-ops's own modules from whatever checkout it's dropped into:

| Import | From career-ops |
|---|---|
| `loadBlacklist`, `buildTitleFilter`, `buildLocationFilter`, `sanitizeMarkdownField` | `scan.mjs` |
| `normalizeCompany` | `tracker-utils.mjs` |
| `loadProviders` | `providers/_registry.mjs` |
| `makeHttpCtx` | `providers/_http.mjs` |

It also reads `cv.md`, `config/profile.yml`, and `portals.yml` from the
career-ops root — career-ops's own onboarding creates those. That's why
this is an add-on and not a standalone app: it needs a career-ops checkout
underneath it. See [Setup](#setup).

## Architecture

| Module | Responsibility |
|---|---|
| `config.mjs` | Central settings, loaded from `.env` |
| `schemas.mjs` | Validation schemas for every structured call |
| `claude-cli.mjs` | Headless subprocess wrapper for the reasoning backend (default; runs against an existing subscription rather than a separate API bill) |
| `claude-client.mjs` | Structured, schema-validated calls with retry/backoff; dispatches to the CLI or API backend |
| `db.mjs` | SQLite state: jobs, companies, matches, applications, status log, scan runs |
| `candidate-profile.mjs` | Builds a `CandidateProfile` from `cv.md` (extracted, cached) + `config/profile.yml` (authoritative, never inferred) |
| `discovery.mjs` | Job discovery via career-ops's provider registry + `portals.yml`, plus `job-boards.mjs` |
| `job-boards.mjs` | Indeed + ZipRecruiter search via their official connectors |
| `company-research.mjs` | Web-search-backed company research, cached per company |
| `scoring.mjs` | 0-100 job/candidate match scoring |
| `decision.mjs` | The apply / skip / human-review pipeline |
| `resume-tailor.mjs` | Per-job resume tailoring (never fabricates) |
| `apply-worker.mjs` | Playwright application automation — guarded auto-submit only |
| `status.mjs` | Application status state machine |
| `notify.mjs` | Console + optional webhook/email notifications |
| `learning.mjs` | Outcome-pattern analysis over completed applications |
| `worker.mjs` | The 24/7 loop (`runOnce()` / `startWorker()`) |
| `dashboard-server.mjs` | Local interactive HTTP dashboard |
| `doctor.mjs` / `cli.mjs` | Prerequisite checks + command dispatch |

`AUTONOMOUS_AGENT.md` has the full walkthrough — every setting, every mode,
deployment options. Each module's file header covers implementation detail.

## Tech stack

Node.js 22+ (using `node:sqlite`'s `DatabaseSync`, no native dependency),
a large language model as the reasoning engine behind every structured
call, Playwright for the conservative form-filling automation, and Zod v4
for schema validation.

## Setup

1. Clone and set up [career-ops](https://github.com/santifer/career-ops)
   first, and get through its onboarding — `cv.md`, `config/profile.yml`,
   and `portals.yml` need to exist.
2. Drop this repo's `agent/` folder into that checkout, and copy
   `AUTONOMOUS_AGENT.md` into its `docs/`.
3. From the career-ops root:
   ```bash
   npm install @anthropic-ai/sdk dotenv playwright zod
   npx playwright install chromium
   cp agent/../.env.example .env   # or merge into your existing .env
   node agent/doctor.mjs           # verify prerequisites
   ```
4. If you're using the default headless-CLI backend, make sure it's
   installed and logged in before running anything.

## Usage

```bash
node agent/doctor.mjs         # check prerequisites (env, cv.md, profile.yml)
node agent/cli.mjs scan-once  # one discover → score → decide cycle, then exit
node agent/cli.mjs start      # the 24/7 loop
node agent/dashboard-server.mjs  # http://localhost:4141
```

Leave `DRY_RUN=true` (the default) at first — the agent still discovers,
scores, researches, and tailors for real, it just never clicks Submit.
Look through its human-review queue and the dashboard before turning on
`AUTO_APPLY_ENABLED` with `DRY_RUN=false`.

## Testing

```bash
node --test agent/*.test.mjs
```

Around 50 tests: the scoring engine, the decision pipeline, discovery
filters, the SQLite layer, the scan-lock's process-liveness check, and a
real headless-browser run of the form-filling logic.

## Project status

Actively developed. Discovery → scoring → research → decision → tailoring
→ guarded apply, plus the dashboard, all work and are tested. Not packaged
as a one-command installer yet — see [Setup](#setup) for the manual steps.

## License

MIT — see [LICENSE](LICENSE). See [Relationship to career-ops](#relationship-to-career-ops)
for the career-ops modules this depends on at runtime without including.
