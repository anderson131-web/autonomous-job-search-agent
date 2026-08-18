// agent/config.mjs — central configuration for the 24/7 autonomous agent.
//
// Every important setting is an env var (see .env.example) so behavior can
// change without touching source code (spec section 19). Values are parsed
// and validated once here; the rest of agent/ imports loadConfig() instead of
// reading process.env directly.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ROOT = __dirname;
export const REPO_ROOT = path.resolve(__dirname, '..');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @typedef {object} AgentConfig
 * @property {string} anthropicApiKey
 * @property {string} claudeModel
 * @property {string|null} claudeTriageModel
 * @property {'low'|'medium'|'high'|'xhigh'|'max'} claudeEffort
 * @property {string} jobSearchCountry
 * @property {boolean} dryRun
 * @property {boolean} autoApplyEnabled
 * @property {number} autoApplyThreshold
 * @property {number} maxApplicationsPerDay
 * @property {number} maxApplicationsPerHour
 * @property {number} searchIntervalMinutes
 * @property {boolean} remoteAllowed
 * @property {boolean} hybridAllowed
 * @property {boolean} onsiteAllowed
 * @property {string} dbPath
 * @property {number} dashboardPort
 * @property {string|null} notifyWebhookUrl
 * @property {string|null} notifyEmailTo
 */

/**
 * Load and validate configuration from process.env.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AgentConfig}
 */
export function loadConfig(env = process.env) {
  const cfg = {
    // 'cli' (default) drives the `claude` CLI binary headlessly (`claude -p`)
    // — reasoning runs on your logged-in Claude Pro/Max subscription, no
    // separate API billing. 'api' uses ANTHROPIC_API_KEY directly against
    // the Anthropic API instead (pay-per-token) — useful for higher
    // throughput/parallelism or running where an interactive login isn't
    // available (e.g. some container setups).
    claudeBackend: /^(api)$/i.test(env.CLAUDE_BACKEND || '') ? 'api' : 'cli',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    claudeModel: env.CLAUDE_MODEL || 'claude-opus-5',
    claudeTriageModel: env.CLAUDE_TRIAGE_MODEL || null,
    // Cheap/fast first-pass floor (spec §12: keep volume manageable without
    // spending a full evaluation on obvious non-matches). Independent of
    // AUTO_APPLY_THRESHOLD on purpose — triage only needs to catch clearly
    // wrong-ballpark postings (wrong seniority/domain that slipped past
    // title filtering), not replicate the full scoring nuance, so it stays
    // low and permissive even when the apply threshold is raised.
    triageThreshold: clamp(num(env.TRIAGE_THRESHOLD, 30), 0, 100),
    claudeEffort: /** @type {any} */ (env.CLAUDE_EFFORT || 'medium'),
    jobSearchCountry: env.JOB_SEARCH_COUNTRY || 'United States',
    dryRun: bool(env.DRY_RUN, true),
    autoApplyEnabled: bool(env.AUTO_APPLY_ENABLED, false),
    autoApplyThreshold: clamp(num(env.AUTO_APPLY_THRESHOLD, 80), 0, 100),
    maxApplicationsPerDay: Math.max(0, num(env.MAX_APPLICATIONS_PER_DAY, 20)),
    maxApplicationsPerHour: Math.max(0, num(env.MAX_APPLICATIONS_PER_HOUR, 5)),
    searchIntervalMinutes: Math.max(1, num(env.SEARCH_INTERVAL_MINUTES, 30)),
    remoteAllowed: bool(env.REMOTE_ALLOWED, true),
    hybridAllowed: bool(env.HYBRID_ALLOWED, true),
    onsiteAllowed: bool(env.ONSITE_ALLOWED, true),
    dbPath: env.AGENT_DB_PATH
      ? path.resolve(REPO_ROOT, env.AGENT_DB_PATH)
      : path.join(AGENT_ROOT, 'data', 'agent.db'),
    dashboardPort: num(env.AGENT_DASHBOARD_PORT, 4141),
    notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || null,
    notifyEmailTo: env.NOTIFY_EMAIL_TO || null,
    smtp: {
      host: env.SMTP_HOST || null,
      port: num(env.SMTP_PORT, 587),
      user: env.SMTP_USER || null,
      pass: env.SMTP_PASS || null,
    },
  };

  const validEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  if (!validEfforts.has(cfg.claudeEffort)) cfg.claudeEffort = 'medium';

  return cfg;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// Keys the dashboard is allowed to override at runtime, persisted in the
// database (agent/db.mjs → settings table) rather than requiring an .env
// edit + process restart. Deliberately a small, explicit allowlist — not
// every setting should be flippable from a web UI with no auth.
export const RUNTIME_OVERRIDABLE_KEYS = ['dryRun', 'autoApplyEnabled', 'autoApplyThreshold'];

/**
 * Overlay any dashboard-set overrides on top of the .env-loaded config.
 * Called fresh at the top of every worker cycle (agent/worker.mjs), so a
 * toggle flipped in the dashboard takes effect on the next cycle without
 * restarting the `start` loop process.
 *
 * @param {AgentConfig} cfg
 * @param {import('./db.mjs').AgentDB} db
 * @returns {AgentConfig}
 */
export function applyRuntimeOverrides(cfg, db) {
  const overrides = db.getAllSettings();
  const merged = { ...cfg };
  for (const key of RUNTIME_OVERRIDABLE_KEYS) {
    if (overrides[key] !== undefined) merged[key] = overrides[key];
  }
  if (typeof merged.autoApplyThreshold === 'number') {
    merged.autoApplyThreshold = clamp(merged.autoApplyThreshold, 0, 100);
  }
  return merged;
}

/** Throws with a clear, actionable message if required credentials are missing. */
export function assertReadyForLiveCalls(cfg) {
  if (cfg.claudeBackend === 'api' && !cfg.anthropicApiKey) {
    throw new Error(
      'CLAUDE_BACKEND=api but ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key ' +
        '(https://console.anthropic.com/settings/keys), export it in your shell, or set ' +
        'CLAUDE_BACKEND=cli to use your Claude Pro/Max subscription via the `claude` CLI instead.',
    );
  }
}
