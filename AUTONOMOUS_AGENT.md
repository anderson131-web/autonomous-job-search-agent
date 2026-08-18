# 24/7 Autonomous Job-Search Agent

This is a new subsystem under [`agent/`](../agent/) built on top of the
existing career-ops project. It runs unattended, continuously: discovers
jobs, scores them against your resume, researches companies, tailors your
resume per job, and (only when you explicitly enable it, and only on
CAPTCHA-free forms) submits applications — with hard limits on what it will
ever do without you.

**It does not replace anything.** `/career-ops scan`, `oferta`, `apply`,
etc. still work in your AI CLI exactly as documented in the main
[README](../README.md). This is a separate, always-on worker process.

---

## 1. What this is (and isn't)

| It IS | It is NOT |
|---|---|
| A 0-100 match scorer, company researcher, and resume tailorer that runs continuously in the background | A "spray and pray" bot — the default threshold (80/100) rejects most postings |
| Able to auto-submit on plain Greenhouse/Lever/Ashby forms, when you turn that on | Able to touch LinkedIn — its Terms of Service ban automation, so LinkedIn jobs always route to you |
| Able to fill in your name/email/phone/resume/LinkedIn/portfolio automatically | Able to answer salary, work-authorization, EEO/demographic, or free-text questions for you — those always stop and ask |
| Safe to leave running with `DRY_RUN=true` (the default) — it does everything except click Submit | Going to click Submit on anything with a CAPTCHA, a login wall, or a field it isn't confident about |

Read [`agent/README.md`](../agent/README.md) for the module-by-module
architecture and the exact safety boundaries in the code.

---

## 2. Prerequisites (what needs YOUR credentials/setup)

**No separate API key or billing required by default.** The agent's
reasoning (`CLAUDE_BACKEND=cli`, the default) runs by shelling out to the
`claude` CLI headlessly — the same subscription your interactive Claude Code
sessions already use, not pay-per-token API billing.

| Requirement | Why | How |
|---|---|---|
| **Node.js 22+** | The agent uses the built-in `node:sqlite` module (no native dependency to compile) | [nodejs.org](https://nodejs.org) — check with `node --version` |
| **Claude Code installed + logged in** (Pro, Max, or any plan) | `CLAUDE_BACKEND=cli` (default) drives `claude -p` headlessly under your subscription | You already have this — it's what you're reading this in. Just needs to be on `PATH` as `claude`. If a headless call fails despite being logged in interactively, run `claude setup-token` once and put the printed token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN` |
| **`cv.md` + `config/profile.yml`** | Your real resume and preferences — the agent never invents these | Already created for you in this repo. If you ever need to redo it: paste your resume to your AI CLI, or edit these files directly |
| **`portals.yml`** | The curated company list `discovery.mjs` polls | Already created (customized for entry-level SWE/AI roles). Add companies any time. |
| **Playwright Chromium** | Needed for resume-PDF rendering and (if enabled) application form filling | `npx playwright install chromium` (the repo's own `npm install` already runs this via `postinstall`) |
| *(optional)* `NOTIFY_WEBHOOK_URL` | Slack/Discord-style incoming webhook for notifications | Only if you want push notifications instead of just console/dashboard |
| *(optional)* `SMTP_*` + `nodemailer` | Email notifications | `npm install nodemailer`, then set `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`NOTIFY_EMAIL_TO` |
| *(optional)* `ANTHROPIC_API_KEY` | Only if you set `CLAUDE_BACKEND=api` instead — direct pay-per-token API access, useful for higher parallelism or environments with no interactive login | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

Nothing else needs your credentials. The agent never asks for your
LinkedIn password, never logs into anything requiring 2FA, and never stores
a secret anywhere but `.env` (gitignored).

> **Why a CLI subprocess instead of the API SDK?** Claude Pro/Max
> subscriptions cover claude.ai and Claude Code usage (interactive *and*
> headless `claude -p`, which is also what career-ops's own batch workers
> use — see `AGENTS.md` "Headless / Batch Mode"); they don't include
> separate API credits. Calling the raw Messages API instead would require
> its own pay-per-token billing regardless of your subscription. `CLAUDE_BACKEND=cli`
> uses the subscription you already have; `CLAUDE_BACKEND=api` is there for
> when you'd rather pay per token (e.g. running many parallel workers).

---

## 3. Run it locally

```bash
cd career-ops
npm install                    # installs zod, playwright, @anthropic-ai/sdk, etc.
cp .env.example .env           # CLAUDE_BACKEND=cli by default — no key needed
node agent/cli.mjs doctor      # confirms every prerequisite above
```

You should see all ✅. `doctor` actually calls `claude -p` once (a trivial,
near-zero-cost prompt) to confirm headless auth works end to end, not just
that the binary exists.

### Dry run (default, safe) — one cycle

```bash
node agent/cli.mjs scan-once
```

This discovers jobs, scores them, researches companies for the strong
matches, tailors a resume for anything that clears your threshold, and
fills out application forms **without ever clicking Submit** (`DRY_RUN=true`
by default in `.env.example`). Check the output and:

```bash
node agent/cli.mjs dashboard    # http://localhost:4141
```

to see what it found, scored, and staged.

### Staying within your Pro plan's usage limits

On `CLAUDE_BACKEND=cli` (the default), every score/decision/company-research/
resume-tailoring call spends against your subscription's usage allowance —
same as any other Claude Code session. Claude Pro's allowance is meaningfully
smaller than Max's, and each job evaluated here costs several calls (a match
score, sometimes company research, sometimes a full resume tailoring).
Running many jobs per cycle on `claude-opus-5` at `CLAUDE_EFFORT=high` can
burn through a Pro plan's window faster than you'd expect. If `doctor` or
`scan-once` starts failing with rate-limit-looking errors:

- Set `CLAUDE_MODEL=claude-sonnet-5` or `claude-haiku-4-5` in `.env` — much
  cheaper per call, still solid for scoring/tailoring.
- Lower `CLAUDE_EFFORT` to `low` or `medium`.
- Raise `SEARCH_INTERVAL_MINUTES` so fewer cycles run per day.
- If you do want `claude-opus-5`-quality scoring at volume, that's exactly
  what `CLAUDE_BACKEND=api` + `ANTHROPIC_API_KEY` is for — pay-per-token,
  no subscription-window ceiling.

### Let it run continuously

```bash
node agent/cli.mjs start
```

This runs `scan-once`'s cycle in a loop every `SEARCH_INTERVAL_MINUTES`
(default 30) forever, until you stop it (Ctrl+C) or it crashes — and even a
crash just waits for the next interval and retries rather than exiting (see
`agent/worker.mjs`'s `startWorker()`).

### Turning on real submission

Only after you've reviewed at least one dry run and are comfortable with
what it's producing:

```env
# .env
DRY_RUN=false
AUTO_APPLY_ENABLED=true
AUTO_APPLY_THRESHOLD=80        # raise this if you want it more conservative
MAX_APPLICATIONS_PER_DAY=20
MAX_APPLICATIONS_PER_HOUR=5
```

Even with both flags on, most real applications will still land in
`HUMAN_REVIEW` — the guarded auto-submit path only fires when *every*
visible field on the form was one the agent could fill with high confidence
(name/email/phone/resume/LinkedIn/portfolio) on Greenhouse, Lever, or Ashby.
Anything with a cover-letter box, a custom question, a salary field, a
work-authorization dropdown, or a CAPTCHA stops and waits for you — that's
intentional, not a bug.

---

## 4. Configuration reference

Every setting lives in `.env` (copy from `.env.example`, which documents
each one inline). The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | Do everything except submit |
| `AUTO_APPLY_ENABLED` | `false` | Master switch for the guarded auto-submit path |
| `AUTO_APPLY_THRESHOLD` | `80` | 0-100 score floor for APPLY (below → SKIP; eligibility issues → always HUMAN_REVIEW regardless of score) |
| `MAX_APPLICATIONS_PER_DAY` | `20` | Hard daily cap on real submissions |
| `MAX_APPLICATIONS_PER_HOUR` | `5` | Hard hourly cap |
| `SEARCH_INTERVAL_MINUTES` | `30` | Time between cycles in `start` mode |
| `REMOTE_ALLOWED` / `HYBRID_ALLOWED` / `ONSITE_ALLOWED` | `true` | Work-mode filters (also set in `config/profile.yml` → `work_preferences`) |
| `CLAUDE_BACKEND` | `cli` | `cli` = your Pro/Max subscription via `claude -p`; `api` = pay-per-token via `ANTHROPIC_API_KEY` |
| `CLAUDE_MODEL` | `claude-opus-5` | Reasoning model for scoring/decisions/tailoring — accepts a full ID (`claude-sonnet-5`) or, on the `cli` backend, a short alias (`sonnet`, `haiku`) |
| `CLAUDE_TRIAGE_MODEL` | *(unset)* | Cheaper model for a first-pass filter over large batches, if you want one |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(unset)* | Only needed if `doctor` reports the `cli` backend can't authenticate headlessly despite being logged in — output of `claude setup-token` |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_EMAIL_TO` | *(unset)* | Notification channels |

`AUTO_APPLY_THRESHOLD`, target roles, and location preferences can also be
adjusted directly in `config/profile.yml` — the same file the interactive
CLI modes read, so changing it there affects both.

---

## 5. Discovery sources

Every cycle pulls from three kinds of sources:

1. **Indeed + ZipRecruiter** (`agent/job-boards.mjs`) — via their official
   Claude MCP connectors (`claude mcp list` shows them as `Connected`),
   queried headlessly for each of your target roles from
   `config/profile.yml`. Not scraping — these are the boards' own hosted
   APIs, reached the same way any Claude Code tool call is.
2. **`portals.yml`**'s curated `tracked_companies` list, via the existing
   `providers/*.mjs` registry (Greenhouse/Lever/Ashby/Workday/etc.).
3. **`data/pipeline.md`**, ingested from whatever `scan.mjs` /
   `scan-ats-full.mjs` already staged there.

**LinkedIn and Glassdoor are not connected** — no official connector exists
for either, and LinkedIn's Terms of Service explicitly prohibit automated
access, so it's excluded on principle, not just by omission.

`portals.yml`'s curated company list is comparatively small (originally
curated for AI-native/senior roles) — Indeed/ZipRecruiter and the reverse-ATS
sweep below are the higher-volume sources for a broad, entry-level search.
Run the existing reverse-ATS scanner periodically — it searches entire
public ATS datasets by keyword instead of a fixed company list:

```bash
node scan-ats-full.mjs           # broad keyword sweep, writes to data/pipeline.md
# or narrower:
node scan-ats-full.mjs --seeds yc     # YC-funded companies only
```

The autonomous agent automatically ingests whatever lands in
`data/pipeline.md` on its next cycle (`agent/discovery.mjs` →
`importFromPipelineMd()`), so you don't need to do anything else — just run
that scan periodically (see the scheduling options below), or add more
companies directly to `portals.yml`.

---

## 6. Deploying it 24/7

Pick whichever fits how you already run things. All of them just need to
keep `node agent/cli.mjs start` running and restart it if it exits.

### Windows Task Scheduler (simplest on Windows)

1. Open Task Scheduler → **Create Task**.
2. **General**: name it `career-ops-agent`; "Run whether user is logged on
   or not"; check "Run with highest privileges" if needed.
3. **Triggers**: New → "At startup" (and optionally "Daily, repeat every 1
   minute indefinitely" as a self-healing check — the loop itself doesn't
   need this since it never exits on a bad cycle, but it protects against
   the whole process dying).
4. **Actions**: New →
   - Program/script: `node`
   - Arguments: `agent/cli.mjs start`
   - Start in: `C:\Users\ander\career-ops` (your actual repo path)
5. **Settings**: "If the task fails, restart every 1 minute", "Stop the
   task if it runs longer than" → leave unchecked (it's meant to run
   forever).

Or from an elevated PowerShell, non-interactively:

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "agent/cli.mjs start" -WorkingDirectory "C:\Users\ander\career-ops"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName "career-ops-agent" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

### PM2 (cross-platform, if you already use Node process managers)

```bash
npm install -g pm2
pm2 start agent/cli.mjs --name career-ops-agent -- start
pm2 save
pm2 startup     # prints the command to auto-start PM2 itself on boot
```

`pm2 logs career-ops-agent` tails the loop's output; `pm2 restart
career-ops-agent` picks up a `.env` change.

### Docker / systemd (Linux server)

The repo already ships a `Dockerfile` and `docker-compose.yml` for the base
project (see `DOCKER.md`) — extend the compose service's command, or add a
second service:

```yaml
services:
  career-ops-agent:
    build: .
    command: node agent/cli.mjs start
    env_file: .env
    volumes:
      - ./agent/data:/app/agent/data
      - ./resumes:/app/resumes
    restart: unless-stopped
```

`restart: unless-stopped` gives you the "if the process crashes, restart"
behavior (spec: never lose application state — `agent/data/agent.db` is a
mounted volume, so a container restart resumes from where it left off).

For bare systemd instead of Docker:

```ini
# /etc/systemd/system/career-ops-agent.service
[Unit]
Description=career-ops autonomous job-search agent
After=network-online.target

[Service]
WorkingDirectory=/opt/career-ops
ExecStart=/usr/bin/node agent/cli.mjs start
Restart=always
RestartSec=10
EnvironmentFile=/opt/career-ops/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now career-ops-agent
journalctl -u career-ops-agent -f     # tail logs
```

---

## 7. Monitoring

- **Dashboard**: `node agent/cli.mjs dashboard` → http://localhost:4141.
  KPI cards (discovered/analyzed/qualified/submitted/awaiting you/interviews/
  offers/rejected/avg score), a match-score distribution chart, a
  discovery-sources breakdown (Indeed vs ZipRecruiter vs portal vs
  pipeline-import), the human-actions-required queue, top opportunities,
  recent applications, and the learning-loop table — auto-refreshes client-side
  every 15s via `/api/stats` (no page reload).
- **Notifications**: configure `NOTIFY_WEBHOOK_URL` (Slack/Discord-style
  incoming webhook) and/or `NOTIFY_EMAIL_TO` + SMTP in `.env`. You'll hear
  about high-value finds, anything needing you, submitted/failed
  applications, and detected interview invites — never every low-value job.
- **Learning loop**: `node agent/cli.mjs learning` prints interview/offer
  rates by title, company, source, and score band, from what's actually
  been tracked — useful for hand-tuning `config/profile.yml`'s target
  roles over time. It never edits your candidate facts automatically.

---

## 8. Failure recovery

- One job source failing (a dead ATS API, a network blip) never stops the
  cycle — `discovery.mjs` isolates errors per company and keeps going.
- A Claude API failure retries with exponential backoff
  (`agent/claude-client.mjs`); a persistent failure surfaces as a normal
  error for that one job, not a crash.
- An application-automation failure moves that application to `FAILED`,
  and failures older than an hour are escalated to `HUMAN_REVIEW` rather
  than retried silently forever.
- The worker loop itself never exits on a bad cycle — see
  `agent/worker.mjs`'s `startWorker()` — it logs, notifies, and waits for
  the next interval.
- All state lives in `agent/data/agent.db` (SQLite, WAL mode). A process
  restart (crash, redeploy, reboot) resumes from exactly where it left off
  — nothing is held only in memory.

---

## 9. Testing

```bash
npm run agent:test        # node --test agent/*.test.mjs — no API key needed,
                           # no network calls, no real applications touched
node agent/cli.mjs doctor # prerequisite check
node agent/cli.mjs scan-once   # end-to-end dry run against real job sources
                           # (DRY_RUN=true by default — never submits)
```

The test suite covers config parsing, every Zod schema, the full SQLite
state machine, the decision pipeline's no-network branches (duplicate/
blacklist checks), notification delivery (including a local mock webhook
server), the status state machine, and the learning-loop aggregation. It
never calls the live Claude API or submits a real application — anything
that requires a live key is exercised instead via `scan-once` with
`DRY_RUN=true`, which you run yourself once you have a key.

---

## 10. What's intentionally out of scope

- **LinkedIn automation.** Its Terms of Service prohibit bots. `contacto`
  mode (in the interactive CLI) already drafts ≤300-character LinkedIn
  outreach messages for you to send by hand — that's the supported path.
- **CAPTCHA/2FA bypass of any kind.** Not a corner that got cut for time —
  it's a hard rule (see `agent/apply-worker.mjs`).
- **A from-scratch discovery engine.** `agent/discovery.mjs` deliberately
  reuses the existing `providers/*.mjs` registry (55+ ATS/board modules)
  rather than re-scraping the web itself.
