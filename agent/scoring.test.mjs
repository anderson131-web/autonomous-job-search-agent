import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierForScore } from './scoring.mjs';

test('tierForScore matches the spec §6 bands', () => {
  assert.equal(tierForScore(100), 'excellent');
  assert.equal(tierForScore(90), 'excellent');
  assert.equal(tierForScore(89), 'strong');
  assert.equal(tierForScore(80), 'strong');
  assert.equal(tierForScore(79), 'possible');
  assert.equal(tierForScore(70), 'possible');
  assert.equal(tierForScore(69), 'weak');
  assert.equal(tierForScore(60), 'weak');
  assert.equal(tierForScore(59), 'reject');
  assert.equal(tierForScore(0), 'reject');
});
