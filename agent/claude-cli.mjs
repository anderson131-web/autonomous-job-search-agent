// agent/claude-cli.mjs — headless reasoning via the `claude` CLI binary
// itself, so the agent runs on a Claude Pro/Max subscription instead of
// separate pay-per-token API billing. This is the same mechanism
// career-ops's own batch workers use (see AGENTS.md "Headless / Batch Mode"
// and batch/batch-runner.sh) — `claude -p` — just driven from agent/ instead
// of a shell script.
//
// The prompt is written to the child process's stdin rather than passed as
// a CLI argument, so large prompts (a full candidate profile + job
// description + JSON schema) never risk hitting a Windows/shell command-line
// length limit.

import { spawn } from 'node:child_process';

export class ClaudeCliError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message);
    this.name = 'ClaudeCliError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.prompt - Sent via stdin.
 * @param {string} [opts.system] - Passed as --system-prompt (short — keep the
 *   large/variable content in `prompt`, not here).
 * @param {string} [opts.model] - e.g. "claude-opus-5", "sonnet", "haiku".
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [opts.effort]
 * @param {string} [opts.tools] - "" disables all tools (default — pure text
 *   generation, no side effects); "WebSearch" for company research; an MCP
 *   tool name (e.g. "mcp__claude_ai_Indeed__search_jobs") for job-board
 *   connectors — those additionally need `permissionMode`, below.
 * @param {string} [opts.permissionMode] - MCP-sourced tools need explicit
 *   permission even in headless mode; pass "bypassPermissions" when calling
 *   one (never needed for built-ins like "" or "WebSearch").
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{text: string, costUsd: number|null, isError: boolean}>}
 */
export async function runClaudeCli({
  prompt,
  system,
  model = 'sonnet',
  effort = 'medium',
  tools = '',
  permissionMode,
  timeoutMs = 180_000,
}) {
  const args = ['-p', '--output-format', 'json', '--model', model, '--effort', effort, '--tools', tools];
  if (system) args.push('--system-prompt', system);
  if (permissionMode) args.push('--permission-mode', permissionMode);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClaudeCliError(`claude CLI timed out after ${timeoutMs}ms`, { retryable: true }));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new ClaudeCliError(
            'The `claude` CLI was not found on PATH. Install Claude Code (https://claude.com/claude-code) ' +
              'and run `claude` once to log in, or set CLAUDE_BACKEND=api and ANTHROPIC_API_KEY in .env instead.',
            { retryable: false, cause: err },
          ),
        );
        return;
      }
      reject(new ClaudeCliError(`Failed to spawn claude CLI: ${err.message}`, { retryable: true, cause: err }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ClaudeCliError(`claude CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`, {
            retryable: true,
          }),
        );
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        reject(new ClaudeCliError(`claude CLI produced non-JSON output: ${stdout.slice(0, 500)}`, {
          retryable: true, cause: err,
        }));
        return;
      }
      if (parsed.is_error) {
        reject(new ClaudeCliError(`claude CLI reported an error: ${parsed.result || parsed.subtype || 'unknown'}`, {
          retryable: true,
        }));
        return;
      }
      resolve({ text: parsed.result ?? '', costUsd: parsed.total_cost_usd ?? null, isError: false });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Strip a ```json ... ``` (or bare ```) fence if the model wrapped its JSON in one. */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  return candidate.trim();
}
