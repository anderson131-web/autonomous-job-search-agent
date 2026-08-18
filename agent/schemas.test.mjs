import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JobMatchSchema,
  ApplicationDecisionSchema,
  CompanySchema,
  STATUSES,
  ApplicationResultSchema,
} from './schemas.mjs';

test('JobMatchSchema rejects a score outside 0-100', () => {
  const bad = { score: 150, breakdown: { requiredQualifications: 50, preferredQualifications: 50, practicalFactors: 50, resumeAlignment: 50 }, tier: 'strong', strengths: [], gaps: [], reasoning: 'x' };
  assert.throws(() => JobMatchSchema.parse(bad));
});

test('JobMatchSchema accepts a well-formed match', () => {
  const good = {
    score: 87,
    breakdown: { requiredQualifications: 90, preferredQualifications: 80, practicalFactors: 85, resumeAlignment: 88 },
    tier: 'strong',
    strengths: ['Strong Python match'],
    gaps: ['No direct healthcare experience'],
    reasoning: 'Solid overall fit.',
  };
  const parsed = JobMatchSchema.parse(good);
  assert.equal(parsed.score, 87);
});

test('ApplicationDecisionSchema only accepts the three defined decisions', () => {
  assert.throws(() =>
    ApplicationDecisionSchema.parse({ decision: 'MAYBE', score: 50, reasons: [], gaps: [], eligibilityIssues: [], notes: null }),
  );
  assert.doesNotThrow(() =>
    ApplicationDecisionSchema.parse({ decision: 'APPLY', score: 91, reasons: ['x'], gaps: [], eligibilityIssues: [], notes: null }),
  );
});

test('CompanySchema requires a valid legitimacyTier enum', () => {
  assert.throws(() =>
    CompanySchema.parse({
      name: 'Acme', website: null, industry: null, sizeEstimate: null, headquarters: null,
      description: null, recentHiringActivity: null, postingAgeDays: null, salaryInfo: null,
      legitimacyTier: 'definitely-real', redFlags: [], qualityScore: 50,
    }),
  );
});

test('STATUSES covers the full spec §14 lifecycle', () => {
  for (const s of [
    'DISCOVERED', 'ANALYZING', 'QUALIFIED', 'APPROVED', 'APPLYING', 'SUBMITTED',
    'HUMAN_REVIEW', 'FAILED', 'SKIPPED', 'REJECTED', 'INTERVIEW', 'OFFER',
  ]) {
    assert.ok(STATUSES.includes(s), `missing status ${s}`);
  }
});

test('ApplicationResultSchema rejects an unknown status', () => {
  assert.throws(() =>
    ApplicationResultSchema.parse({
      jobId: 'j1', status: 'GHOSTED', submittedAt: null, applicationUrl: null,
      resumeVersion: null, coverLetterVersion: null, notes: null, failureReason: null,
    }),
  );
});
