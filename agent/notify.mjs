// agent/notify.mjs — configurable notifications (spec section 16).
//
// Notifies on: high-quality job found, human input required, application
// succeeded/failed, interview invitation detected, persistent system error.
// Deliberately does NOT notify on every low-value job (spec: "avoid
// notifying me for every low-value job").
//
// Channels are additive and optional — console always logs; webhook and
// email fire only when configured in .env.

import { loadConfig } from './config.mjs';

/** @typedef {'high_value_job'|'human_review'|'application_submitted'|'application_failed'|'interview_detected'|'system_error'} NotificationKind */

const EMOJI = {
  high_value_job: '🎯',
  human_review: '🙋',
  application_submitted: '✅',
  application_failed: '⚠️',
  interview_detected: '📅',
  system_error: '🔴',
};

/**
 * @param {object} opts
 * @param {NotificationKind} opts.kind
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {object} [opts.meta]
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 */
export async function notify({ kind, title, body = '', meta = {}, config }) {
  const cfg = config || loadConfig();
  const line = `${EMOJI[kind] || 'ℹ️'} [${kind}] ${title}${body ? ` — ${body}` : ''}`;
  // eslint-disable-next-line no-console
  console.log(line);

  const tasks = [];
  if (cfg.notifyWebhookUrl) tasks.push(sendWebhook(cfg, { kind, title, body, meta }));
  if (cfg.notifyEmailTo && cfg.smtp.host) tasks.push(sendEmail(cfg, { kind, title, body, meta }));

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error(`  ⚠️  notification delivery failed: ${r.reason?.message || r.reason}`);
    }
  }
}

async function sendWebhook(cfg, { kind, title, body, meta }) {
  const res = await fetch(cfg.notifyWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `${EMOJI[kind] || ''} *${title}*\n${body}`.trim(), kind, meta }),
  });
  if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
}

async function sendEmail(cfg, { title, body }) {
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    console.warn('  ⚠️  NOTIFY_EMAIL_TO/SMTP configured but the "nodemailer" package is not ' +
      'installed — run `npm install nodemailer` to enable email notifications.');
    return;
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  await transport.sendMail({
    from: cfg.smtp.user || cfg.notifyEmailTo,
    to: cfg.notifyEmailTo,
    subject: `career-ops agent: ${title}`,
    text: body,
  });
}
