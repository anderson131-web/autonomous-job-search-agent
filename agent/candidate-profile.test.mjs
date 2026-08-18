import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithProfileYaml, ResumeExtractSchema } from './candidate-profile.mjs';
import { CandidateProfileSchema } from './schemas.mjs';

const extract = ResumeExtractSchema.parse({
  education: [{ degree: 'B.Tech', field: 'Information Technology', institution: 'VJCET', graduationDate: '2026-05' }],
  certifications: [],
  workExperience: [
    { title: 'Business Associate', company: 'Quinnox', location: 'Chicago, IL', startDate: '2026-01', endDate: null, isCurrent: true, bullets: ['Built a scoring engine.'] },
  ],
  yearsOfExperience: 1,
  skills: { languages: ['Python'], frameworks: ['FastAPI'], databases: ['MySQL'], cloud: [], tools: ['Git'], other: [] },
  projects: [{ name: 'AURA', technologies: ['Python', 'Computer Vision'], bullets: ['Built a wearable AR prototype.'] }],
  achievements: ['Best Paper Presentation Award'],
  industries: [],
});

const yaml = {
  candidate: { full_name: 'Anderson Abraham', email: 'a@example.com', phone: '+1-331-000-0000', location: 'Naperville, IL', linkedin: 'linkedin.com/in/x', portfolio_url: 'https://x.dev', github: '' },
  target_roles: { primary: ['Software Engineer', 'AI Engineer'] },
  work_preferences: { remote: true, hybrid: true, onsite: true, relocation_open: true, seniority: ['Entry-level'] },
  compensation: { location_flexibility: 'Remote-first', target_range: '' },
  location: { country: 'United States', visa_status: 'Green Card', authorized_in: ['United States'], needs_sponsorship: false },
};

test('mergeWithProfileYaml never lets Claude-derived data override contact/work-auth fields', () => {
  const merged = mergeWithProfileYaml(extract, yaml);
  assert.equal(merged.fullName, 'Anderson Abraham');
  assert.equal(merged.email, 'a@example.com');
  assert.equal(merged.workAuthorization.needsSponsorship, false);
  assert.deepEqual(merged.workAuthorization.authorizedIn, ['United States']);
  assert.deepEqual(merged.preferences.targetRoles, ['Software Engineer', 'AI Engineer']);
});

test('merged profile validates against the full CandidateProfileSchema', () => {
  const merged = mergeWithProfileYaml(extract, yaml);
  assert.doesNotThrow(() => CandidateProfileSchema.parse(merged));
});

test('mergeWithProfileYaml defaults work preferences to permissive when profile.yml omits them', () => {
  const merged = mergeWithProfileYaml(extract, { candidate: {}, location: {} });
  assert.equal(merged.preferences.remoteAllowed, true);
  assert.equal(merged.preferences.hybridAllowed, true);
  assert.equal(merged.preferences.onsiteAllowed, true);
  assert.equal(merged.workAuthorization.needsSponsorship, false);
});
