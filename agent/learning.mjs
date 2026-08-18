// agent/learning.mjs — the learning loop (spec section 17).
//
// Reads outcomes already recorded in agent/db.mjs (Applied -> Rejected /
// Interview / Offer / Hired) and surfaces patterns: which titles/companies/
// sources/score-ranges correlate with interviews. This NEVER writes back
// into the candidate profile or cv.md — "do not modify factual candidate
// information based on outcomes" is a hard rule from the spec. It only
// informs future ranking (agent/scoring.mjs prompts can be hand-tuned by a
// human using this report; nothing here does it automatically).

const ADVANCED_OUTCOMES = new Set(['INTERVIEW', 'OFFER', 'HIRED']);

/**
 * @param {import('./db.mjs').AgentDB} db
 * @returns {{
 *   totalTrackedApplications: number,
 *   overallAdvanceRate: number,
 *   byTitle: Array<{title: string, applications: number, advanced: number, rate: number}>,
 *   byCompany: Array<{company: string, applications: number, advanced: number, rate: number}>,
 *   bySource: Array<{source: string, applications: number, advanced: number, rate: number}>,
 *   byScoreBand: Array<{band: string, applications: number, advanced: number, rate: number}>,
 * }}
 */
export function analyzeOutcomes(db) {
  const rows = db.outcomesForLearning();
  const group = (keyFn) => {
    const map = new Map();
    for (const r of rows) {
      const key = keyFn(r);
      if (key == null) continue;
      const bucket = map.get(key) || { applications: 0, advanced: 0 };
      bucket.applications++;
      if (ADVANCED_OUTCOMES.has(r.outcome)) bucket.advanced++;
      map.set(key, bucket);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v, rate: v.applications ? round(v.advanced / v.applications) : 0 }))
      .sort((a, b) => b.rate - a.rate || b.applications - a.applications);
  };

  const byTitle = group((r) => r.title).map((x) => ({ title: x.key, applications: x.applications, advanced: x.advanced, rate: x.rate }));
  const byCompany = group((r) => r.company).map((x) => ({ company: x.key, applications: x.applications, advanced: x.advanced, rate: x.rate }));
  const bySource = group((r) => r.source).map((x) => ({ source: x.key, applications: x.applications, advanced: x.advanced, rate: x.rate }));
  const byScoreBand = group((r) => scoreBand(r.match_score)).map((x) => ({ band: x.key, applications: x.applications, advanced: x.advanced, rate: x.rate }));

  const advanced = rows.filter((r) => ADVANCED_OUTCOMES.has(r.outcome)).length;

  return {
    totalTrackedApplications: rows.length,
    overallAdvanceRate: rows.length ? round(advanced / rows.length) : 0,
    byTitle,
    byCompany,
    bySource,
    byScoreBand,
  };
}

function scoreBand(score) {
  if (score == null) return null;
  if (score >= 90) return '90-100';
  if (score >= 80) return '80-89';
  if (score >= 70) return '70-79';
  if (score >= 60) return '60-69';
  return '<60';
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
