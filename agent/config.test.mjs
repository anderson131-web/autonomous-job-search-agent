import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, applyRuntimeOverrides } from './config.mjs';
import { AgentDB } from './db.mjs';

test('loadConfig applies sane defaults with an empty env', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.claudeModel, 'claude-opus-5');
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.autoApplyEnabled, false);
  assert.equal(cfg.autoApplyThreshold, 80);
  assert.equal(cfg.maxApplicationsPerDay, 20);
  assert.equal(cfg.searchIntervalMinutes, 30);
  assert.equal(cfg.remoteAllowed, true);
});

test('loadConfig parses booleans from common truthy/falsy strings', () => {
  assert.equal(loadConfig({ DRY_RUN: 'false' }).dryRun, false);
  assert.equal(loadConfig({ DRY_RUN: '0' }).dryRun, false);
  assert.equal(loadConfig({ AUTO_APPLY_ENABLED: 'true' }).autoApplyEnabled, true);
  assert.equal(loadConfig({ AUTO_APPLY_ENABLED: 'yes' }).autoApplyEnabled, true);
});

test('loadConfig clamps AUTO_APPLY_THRESHOLD to [0, 100]', () => {
  assert.equal(loadConfig({ AUTO_APPLY_THRESHOLD: '150' }).autoApplyThreshold, 100);
  assert.equal(loadConfig({ AUTO_APPLY_THRESHOLD: '-5' }).autoApplyThreshold, 0);
  assert.equal(loadConfig({ AUTO_APPLY_THRESHOLD: '73' }).autoApplyThreshold, 73);
});

test('loadConfig falls back to medium effort on an invalid value', () => {
  assert.equal(loadConfig({ CLAUDE_EFFORT: 'ludicrous' }).claudeEffort, 'medium');
  assert.equal(loadConfig({ CLAUDE_EFFORT: 'xhigh' }).claudeEffort, 'xhigh');
});

test('loadConfig never throws when ANTHROPIC_API_KEY is unset', () => {
  assert.doesNotThrow(() => loadConfig({}));
});

test('applyRuntimeOverrides leaves .env config untouched when the dashboard has set nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-config-test-'));
  const db = new AgentDB(path.join(dir, 'test.db'));
  try {
    const cfg = loadConfig({});
    const merged = applyRuntimeOverrides(cfg, db);
    assert.equal(merged.dryRun, true);
    assert.equal(merged.autoApplyEnabled, false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyRuntimeOverrides lets a dashboard-set value override .env, clamped to valid ranges', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-config-test-'));
  const db = new AgentDB(path.join(dir, 'test.db'));
  try {
    const cfg = loadConfig({ DRY_RUN: 'true', AUTO_APPLY_ENABLED: 'false' });
    db.setSetting('dryRun', false);
    db.setSetting('autoApplyEnabled', true);
    db.setSetting('autoApplyThreshold', 150); // out of range — must clamp
    const merged = applyRuntimeOverrides(cfg, db);
    assert.equal(merged.dryRun, false);
    assert.equal(merged.autoApplyEnabled, true);
    assert.equal(merged.autoApplyThreshold, 100);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
