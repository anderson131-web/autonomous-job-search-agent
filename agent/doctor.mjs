// agent/doctor.mjs — prerequisite checks for the autonomous agent, in the
// same spirit as the repo-root doctor.mjs (which checks the interactive
// CLI's prerequisites — cv.md/profile.yml/portals.yml). This one adds the
// checks specific to running a 24/7 unattended worker: Node version
// (node:sqlite needs 22+), the Claude API key, and Playwright's browser.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';
import { runClaudeCli } from './claude-cli.mjs';

export async function runDoctor(cfg) {
  const checks = [];
  const add = (ok, label, hint) => checks.push({ ok, label, hint });

  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 22, `Node.js ${process.versions.node} (>= 22 required for node:sqlite)`,
    'Install Node 22+ (https://nodejs.org) — the agent uses the built-in node:sqlite module.');

  if (cfg.claudeBackend === 'api') {
    add(!!cfg.anthropicApiKey, 'ANTHROPIC_API_KEY set (CLAUDE_BACKEND=api)',
      'Copy .env.example to .env and add your key from https://console.anthropic.com/settings/keys, ' +
        'or set CLAUDE_BACKEND=cli to use your Claude Pro/Max subscription instead (no API key needed).');
  } else {
    let cliOk = false;
    let cliHint = 'Install Claude Code (https://claude.com/claude-code) and run `claude` once to log in.';
    try {
      await runClaudeCli({
        prompt: 'Reply with exactly: ok',
        model: cfg.claudeModel,
        effort: 'low',
        tools: '',
        timeoutMs: 30_000,
      });
      cliOk = true;
    } catch (err) {
      cliHint =
        `${err.message} If you're already logged in interactively but this still fails, run ` +
        '`claude setup-token` once and put the printed token in .env as CLAUDE_CODE_OAUTH_TOKEN — ' +
        'headless `claude -p` calls need that even when the interactive CLI is logged in.';
    }
    add(cliOk, 'claude CLI reachable and authenticated (CLAUDE_BACKEND=cli, uses your Pro/Max subscription)', cliHint);
  }

  add(existsSync(path.join(REPO_ROOT, 'cv.md')), 'cv.md exists',
    'Create cv.md at the project root (career-ops onboarding does this — see AGENTS.md).');

  add(existsSync(path.join(REPO_ROOT, 'config', 'profile.yml')), 'config/profile.yml exists',
    'Copy config/profile.example.yml to config/profile.yml and fill it in.');

  const portalsExists = existsSync(path.join(REPO_ROOT, 'portals.yml'));
  add(portalsExists, 'portals.yml exists (job discovery source list)',
    'Copy templates/portals.example.yml to portals.yml and customize title_filter for your target roles. ' +
      'Without it, discoverFromPortals() has nothing to scan — the agent can still ingest data/pipeline.md ' +
      'from `node scan.mjs` / `node scan-ats-full.mjs` runs in the meantime.');
  // portals.yml is a soft requirement — warn but don't fail doctor on it.
  if (!portalsExists) checks[checks.length - 1].warn = true;

  let playwrightOk = false;
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true }).catch(() => null);
    playwrightOk = !!browser;
    await browser?.close();
  } catch {
    playwrightOk = false;
  }
  add(playwrightOk, 'Playwright Chromium launches',
    'Run `npx playwright install chromium` (career-ops\'s own postinstall does this already for most setups).');

  console.log('career-ops autonomous agent — doctor\n');
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? '✅' : c.warn ? '⚠️ ' : '❌';
    console.log(`${icon} ${c.label}`);
    if (!c.ok) {
      console.log(`   → ${c.hint}`);
      if (!c.warn) allOk = false;
    }
  }
  console.log(allOk ? '\nAll required checks passed.' : '\nFix the ❌ items above before running `start`.');
  return allOk;
}
