# agent/ — the 24/7 autonomous job-search agent

An additive subsystem on top of career-ops's existing tools. It does **not**
replace the interactive CLI modes (`/career-ops scan`, `oferta`, `apply`,
etc.) — those still work exactly as before. This is a separate, unattended
worker that runs the same kind of pipeline continuously, using Claude as the
reasoning engine and its own SQLite database as its state machine.

User-facing guide: [`docs/AUTONOMOUS_AGENT.md`](../docs/AUTONOMOUS_AGENT.md).
This file is the architecture map for anyone reading/maintaining the code.

## Why a separate database

career-ops's own architectural doctrine (see `ARCHITECTURE.md` → "Files are
canonical — databases are derived", settled in issue #918) is that
`data/applications.md` stays the permanent, human-readable source of truth,
and any database is a derived index, never primary. That doctrine is about
the **interactive, human-in-the-loop** system.

The autonomous worker is a different kind of consumer: it needs real
transactional state (atomic status transitions, rate-limit counters, dedup
guards) running unattended, 24/7, with no human present to resolve a
git-diff conflict. So `agent/db.mjs` owns `agent/data/agent.db` as **its
own** source of truth — scoped entirely to this subsystem — and
`agent/status.mjs` optionally (opt-in, best-effort) mirrors completed
applications back into `data/applications.md` via the *existing*,
documented TSV-drop + `merge-tracker.mjs` mechanism, so the interactive CLI,
the Go dashboard TUI, and the web/ UI keep seeing everything without any of
them needing to learn about SQLite.

## Module map

| Module | Responsibility |
|---|---|
| `config.mjs` | All settings, read from `.env` (see `.env.example`) |
| `schemas.mjs` | Zod schemas: CandidateProfile, Job, Company, JobMatch, ApplicationDecision, TailoredResume, ApplicationQuestion, ApplicationResult, CvPayload |
| `claude-cli.mjs` | Headless `claude -p` subprocess wrapper — the default reasoning backend, runs on your Claude Pro/Max subscription, no separate API key |
| `claude-client.mjs` | Structured-output Claude calls, schema-validated, retried with backoff. Dispatches to `claude-cli.mjs` (`CLAUDE_BACKEND=cli`, default) or the Anthropic API SDK (`CLAUDE_BACKEND=api`) |
| `db.mjs` | SQLite state: jobs, companies, matches, applications, status_log, scan_runs |
| `candidate-profile.mjs` | Builds CandidateProfile from `cv.md` (Claude-extracted, cached) + `config/profile.yml` (authoritative, never inferred) |
| `discovery.mjs` | Job discovery via the existing `providers/*.mjs` registry + `portals.yml`, `job-boards.mjs` (Indeed/ZipRecruiter), and an importer for `data/pipeline.md` (bridges `scan-ats-full.mjs`'s reverse-ATS sweep) |
| `job-boards.mjs` | Indeed + ZipRecruiter search via their official Claude MCP connectors — not scraping. LinkedIn/Glassdoor have no such connector and aren't implemented |
| `company-research.mjs` | Claude + web_search tool → structured company research, cached per company |
| `scoring.mjs` | 0-100 job/candidate match scoring |
| `decision.mjs` | The APPLY / SKIP / HUMAN_REVIEW pipeline (dedup → blacklist → eligibility → score → company research → decide) |
| `resume-tailor.mjs` | Per-job resume tailoring, rendered through the existing `build-cv-html.mjs` / `generate-pdf.mjs` ATS pipeline |
| `apply-worker.mjs` | Playwright application automation — conservative by design, see file header |
| `status.mjs` | The application status state machine + legacy-tracker bridge |
| `notify.mjs` | Console + optional webhook/email notifications |
| `learning.mjs` | Outcome-pattern analysis (interview/offer rates by title/company/source/score band) |
| `worker.mjs` | The 24/7 loop (`runOnce()` / `startWorker()`) |
| `dashboard-server.mjs` | Local HTTP dashboard |
| `doctor.mjs` / `cli.mjs` | Prerequisite checks + command dispatch |

## Safety boundaries (do not relax these without re-reading the spec)

- **LinkedIn is never automated.** `apply-worker.mjs` routes any
  `linkedin.com` URL straight to `HUMAN_REVIEW` — LinkedIn's Terms of
  Service prohibit automated access, full stop.
- **CAPTCHA / 2FA / login walls always stop the run.** Never bypassed,
  never worked around.
- **Guarded auto-submit only fires on Greenhouse/Lever/Ashby**, only when
  every visible field was filled with high confidence, only when
  `DRY_RUN=false` and `AUTO_APPLY_ENABLED=true`, and only under the daily/
  hourly rate caps. Any field the agent isn't confident about (salary, work
  authorization, EEO/demographic, free-text questions, "how did you hear
  about us") routes to `HUMAN_REVIEW` — never guessed.
- **Work authorization is read verbatim from `config/profile.yml`**, never
  inferred by Claude.
- **Resume tailoring never fabricates.** `resume-tailor.mjs`'s system prompt
  forbids inventing experience/skills/dates, and the underlying `cv.md`
  is never edited by any part of this subsystem.

## Running

See `docs/AUTONOMOUS_AGENT.md`. Short version:

```bash
node agent/cli.mjs doctor       # check prerequisites
node agent/cli.mjs scan-once    # one discover→apply cycle, then exit (safe for testing)
node agent/cli.mjs start        # the 24/7 loop
node agent/cli.mjs dashboard    # http://localhost:4141
```
