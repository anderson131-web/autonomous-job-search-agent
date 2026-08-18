# 🤖 Autonomous Job Search Agent

A 24/7 autonomous job-search and application agent — discovers roles,
scores fit against a real candidate profile, researches companies, tailors
resumes, and (under tightly guarded conditions) auto-applies. Built to
prioritize *interview probability over volume*: no spray-and-pray, and
every decision the agent makes (apply / skip / ask a human) comes with a
recorded reason. Nothing about a candidate is ever guessed or invented.

This is an **add-on module for [career-ops](https://github.com/santifer/career-ops)**,
santifer's open-source job-search CLI — see [Relationship to career-ops](#relationship-to-career-ops)
below for exactly what that means.

## Features

- **Structured, schema-validated reasoning** — every scoring, decision, and
  tailoring step is a validated call against a defined schema
  (`CandidateProfile`, `Job`, `Company`, `JobMatch`, `ApplicationDecision`,
  `TailoredResume`, `ApplicationQuestion`, `ApplicationResult`), never
  free-text parsing
- **Nationwide US job discovery** — curated-company ATS portals
  (Greenhouse/Lever/Ashby) plus Indeed and ZipRecruiter through their
  official connectors (not scraping). **LinkedIn is deliberately excluded
  from automated discovery** — its Terms of Service prohibit automated
  access
  - Configurable remote/hybrid/onsite scope and a title/seniority filter
    (e.g. entry-level only)
- **0-100 match scoring** against the candidate's real resume and stated
  preferences, with a configurable auto-apply threshold
- **Company research** (legitimacy tier, red flags, quality score) folded
  into the apply/skip decision
- **Intelligent decision pipeline** — every job resolves to `APPLY`, `SKIP`,
  or `HUMAN_REVIEW`, each with a recorded reason; dedup and a company
  blacklist are checked before anything else runs
- **Resume tailoring that never fabricates** — reorders and re-emphasizes
  real experience from the candidate's actual CV; fabricating skills,
  dates, or experience is explicitly disallowed by design
- **Guarded auto-submit** — off by default (`DRY_RUN=true`). Even when
  enabled, auto-submit only fires for CAPTCHA-free **Greenhouse / Lever /
  Ashby** forms, only above the score threshold, only under daily/hourly
  rate caps, and **never** for LinkedIn or any field the agent isn't
  confident about (salary, work authorization, EEO/demographic, free-text
  questions) — those always route to human review. Work authorization is
  read verbatim from the candidate's config, never inferred.
- **24/7 worker loop** with rate limiting, exponential backoff, cross-run
  dedup, and a PID-liveness-checked file lock so a crashed process can't
  block the next run for its full staleness window
- **SQLite state machine** (jobs, companies, matches, applications,
  status log, scan runs) — the agent's own database, separate from
  career-ops's file-based tracker, since this subsystem needs real
  transactional state for an unattended 24/7 loop
- **Interactive local dashboard** — live stats, score histogram, top
  opportunities (with location/salary/manual-apply links), a human-review
  queue, run/stop/clear controls, and runtime-adjustable Dry Run /
  auto-apply / threshold settings
- **Learning loop** — analyzes outcomes (interview/offer rates by title,
  company, source, score band) to refine future scoring; never touches
  factual candidate data
- **~50 automated tests** (`node --test agent/*.test.mjs`), including real
  headless-browser assertions for the form-filling logic, not just mocks

## Relationship to career-ops

This repo contains **only the autonomous-agent layer** I designed and built
— it is **not** a copy of [career-ops](https://github.com/santifer/career-ops)
and doesn't include or redistribute santifer's code. At runtime it imports
a handful of career-ops's own modules from the parent checkout it's dropped
into:

| Import | From career-ops |
|---|---|
| `loadBlacklist`, `buildTitleFilter`, `buildLocationFilter`, `sanitizeMarkdownField` | `scan.mjs` |
| `normalizeCompany` | `tracker-utils.mjs` |
| `loadProviders` | `providers/_registry.mjs` |
| `makeHttpCtx` | `providers/_http.mjs` |

It also reads `cv.md`, `config/profile.yml`, and `portals.yml` from the
career-ops root (career-ops's own onboarding creates these). That's why
**this is an add-on, not a standalone app** — it needs a career-ops
checkout as its host. See [Setup](#setup) below.

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
| `decision.mjs` | The APPLY / SKIP / HUMAN_REVIEW pipeline |
| `resume-tailor.mjs` | Per-job resume tailoring (never fabricates) |
| `apply-worker.mjs` | Playwright application automation — guarded auto-submit only |
| `status.mjs` | Application status state machine |
| `notify.mjs` | Console + optional webhook/email notifications |
| `learning.mjs` | Outcome-pattern analysis over completed applications |
| `worker.mjs` | The 24/7 loop (`runOnce()` / `startWorker()`) |
| `dashboard-server.mjs` | Local interactive HTTP dashboard |
| `doctor.mjs` / `cli.mjs` | Prerequisite checks + command dispatch |

See [`AUTONOMOUS_AGENT.md`](AUTONOMOUS_AGENT.md) for the full user-facing
guide (every setting, every mode, deployment options) and each module's own
file header for implementation detail.

## Tech Stack

- **Node.js 22+** (`node:sqlite`'s `DatabaseSync` — no native dependency)
- A large language model as the reasoning engine, driven entirely through
  validated structured output — never free-text parsing
- **Playwright** for guarded, conservative application-form automation
- **Zod v4** for schema validation and JSON Schema generation

## Setup

1. Clone and set up [career-ops](https://github.com/santifer/career-ops)
   first, and complete its onboarding (`cv.md`, `config/profile.yml`,
   `portals.yml` need to exist).
2. Drop this repo's `agent/` folder into your career-ops checkout
   (replacing/adding alongside its own `agent/` if present), and copy
   `AUTONOMOUS_AGENT.md` into career-ops's `docs/`.
3. From the career-ops root:
   ```bash
   npm install @anthropic-ai/sdk dotenv playwright zod
   npx playwright install chromium
   cp agent/../.env.example .env   # or merge into your existing .env
   node agent/doctor.mjs           # verify prerequisites
   ```
4. If using the default headless-CLI backend, make sure it's installed and
   logged in locally before running.

## Usage

```bash
node agent/doctor.mjs       # check prerequisites (env, cv.md, profile.yml)
node agent/cli.mjs scan-once  # one discover → score → decide cycle, then exit
node agent/cli.mjs start      # the 24/7 loop
node agent/dashboard-server.mjs  # http://localhost:4141
```

Start with `DRY_RUN=true` (the default) — the agent will discover, score,
research, and tailor exactly as it would for real, but never click Submit.
Review its `HUMAN_REVIEW` queue and dashboard output before ever setting
`DRY_RUN=false` and `AUTO_APPLY_ENABLED=true`.

## Testing

```bash
node --test agent/*.test.mjs
```

~50 tests covering the scoring engine, decision pipeline, discovery
filters, the SQLite layer, the scan-lock's PID-liveness check, and a real
headless-browser exercise of the form-filling logic (not mocked).

## Project Status

Actively developed. The core pipeline (discover → score → research →
decide → tailor → guarded apply) and the interactive dashboard are
functional and covered by tests. Not yet packaged as a one-command
installer — see [Setup](#setup) for the manual integration steps.

## License

MIT — see [LICENSE](LICENSE). See also [Relationship to career-ops](#relationship-to-career-ops)
above regarding the small set of career-ops modules this project depends on
at runtime but does not include.
