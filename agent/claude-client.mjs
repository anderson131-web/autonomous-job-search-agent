// agent/claude-client.mjs — the reasoning-engine wrapper (spec section 2).
//
// Two backends, selected by CLAUDE_BACKEND (see agent/config.mjs):
//   - 'cli' (default) — shells out to the `claude` CLI headlessly
//     (`claude -p`), so reasoning runs on your logged-in Claude Pro/Max
//     subscription with no separate API billing. This is the same mechanism
//     career-ops's own batch workers use (AGENTS.md "Headless / Batch Mode").
//     Since the CLI has no native structured-output constraint, the schema
//     is embedded in the prompt as a JSON Schema and the response is
//     parsed + Zod-validated on our side, with the validation error fed
//     back into a retry prompt on failure.
//   - 'api' — calls the Anthropic API directly via @anthropic-ai/sdk with
//     native structured outputs (pay-per-token, needs ANTHROPIC_API_KEY).
//
// Both paths retry transient failures with exponential backoff + jitter
// ("if Claude fails, retry safely" — spec section 20) and throw a typed
// error for anything else, so callers can route a persistent failure to
// HUMAN_REVIEW instead of looping forever.

import { z } from 'zod';
import { loadConfig, assertReadyForLiveCalls } from './config.mjs';
import { runClaudeCli, extractJson } from './claude-cli.mjs';

export class ClaudeCallError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message);
    this.name = 'ClaudeCallError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Claude and validate the response against `schema`.
 *
 * @param {object} opts
 * @param {string} opts.system - System prompt (kept short on the 'cli' backend).
 * @param {string} opts.prompt - User-turn content (the volatile part).
 * @param {import('zod').ZodTypeAny} opts.schema - Schema the response must satisfy.
 * @param {string} [opts.schemaName] - Human-readable name, used in the 'cli' backend's prompt.
 * @param {import('./config.mjs').AgentConfig} [opts.config]
 * @param {number} [opts.maxRetries]
 * @param {'low'|'medium'} [opts.tier] - 'low' routes to the cheaper triage
 *   model when CLAUDE_TRIAGE_MODEL is configured (high-volume first pass).
 * @returns {Promise<any>} The parsed, schema-validated object.
 */
export async function structuredCall({
  system,
  prompt,
  schema,
  schemaName = 'Response',
  config,
  maxRetries = 4,
  tier = 'medium',
}) {
  const cfg = config || loadConfig();
  assertReadyForLiveCalls(cfg);
  const model = tier === 'low' && cfg.claudeTriageModel ? cfg.claudeTriageModel : cfg.claudeModel;

  return cfg.claudeBackend === 'api'
    ? structuredCallApi({ system, prompt, schema, model, cfg, maxRetries })
    : structuredCallCli({ system, prompt, schema, schemaName, model, cfg, maxRetries });
}

// ── 'cli' backend — claude -p, your Pro/Max subscription ───────────────────

async function structuredCallCli({ system, prompt, schema, schemaName, model, cfg, maxRetries }) {
  const jsonSchema = JSON.stringify(schemaToJson(schema), null, 2);
  const cliSystem =
    (system ? `${system}\n\n` : '') +
    `Respond with ONLY a single JSON object matching this JSON Schema (named "${schemaName}") — ` +
    `no markdown code fences, no prose before or after, just the raw JSON object:\n${jsonSchema}`;

  let lastErr;
  let feedback = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { text } = await runClaudeCli({
        prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
        system: cliSystem,
        model,
        effort: cfg.claudeEffort,
        tools: '',
      });
      let data;
      try {
        data = JSON.parse(extractJson(text));
      } catch (err) {
        throw new ClaudeCallError(`claude CLI did not return valid JSON: ${text.slice(0, 300)}`, {
          retryable: true,
          cause: err,
        });
      }
      const result = schema.safeParse(data);
      if (!result.success) {
        throw new ClaudeCallError(`Response did not match the ${schemaName} schema: ${result.error.message}`, {
          retryable: true,
        });
      }
      return result.data;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      if (!retryable || attempt === maxRetries) {
        throw err instanceof ClaudeCallError ? err : new ClaudeCallError(`claude CLI call failed: ${err.message}`, { retryable, cause: err });
      }
      feedback = `Your previous response was invalid: ${err.message}. Reply again with ONLY the corrected JSON object.`;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

function schemaToJson(schema) {
  // zod v4 ships JSON Schema conversion natively.
  return z.toJSONSchema(schema, { reused: 'ref' });
}

// ── 'api' backend — direct Anthropic API call, pay-per-token ───────────────

async function structuredCallApi({ system, prompt, schema, model, cfg, maxRetries }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // NOTE on API shape: the installed @anthropic-ai/sdk build's beta
      // `.parse()` helper does its own local JSON-schema parsing keyed off
      // the top-level `output_format` param (see node_modules/@anthropic-ai/sdk/
      // lib/beta-parser.mjs) — that's what populates `response.parsed_output`
      // below, so it must stay `output_format`, not `output_config.format`.
      // `output_config.effort` and `thinking: {type:'adaptive'}` are real,
      // current server-side parameters (this SDK build's TypeScript defs
      // just predate them) — they're forwarded to the API untouched and the
      // server honors them regardless of local SDK version.
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: cfg.claudeEffort },
        output_format: betaZodOutputFormat(schema),
        system: [{ type: 'text', text: system }],
        messages: [{ role: 'user', content: prompt }],
      });

      if (response.stop_reason === 'refusal') {
        throw new ClaudeCallError(
          `Claude declined the request (category: ${response.stop_details?.category ?? 'unknown'})`,
          { retryable: false },
        );
      }
      if (response.parsed_output == null) {
        throw new ClaudeCallError('Claude response did not parse against the schema', { retryable: true });
      }
      return response.parsed_output;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      if (!retryable || attempt === maxRetries) {
        throw err instanceof ClaudeCallError ? err : new ClaudeCallError(`Claude call failed: ${err.message}`, { retryable, cause: err });
      }
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

function backoff(attempt) {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
}

function isRetryable(err) {
  if (err instanceof ClaudeCallError) return err.retryable;
  // Anthropic SDK typed errors expose `.status`.
  const status = err?.status;
  if (status === 429 || status === 529 || (status >= 500 && status < 600)) return true;
  if (err?.name === 'APIConnectionError') return true;
  return false;
}
