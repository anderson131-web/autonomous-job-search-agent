// agent/dashboard-server.mjs — local dashboard (spec section 15) with
// controls (spec section 12/19: run a cycle and flip auto-apply on/off
// without touching .env or a terminal).
//
// Deliberately plain: node:http + one HTML page with a small amount of
// client-side JS (fetch + re-render), no framework, no build step.
// career-ops already has a fuller experimental Next.js web UI at web/
// (reads data/applications.md directly) — this is a small, standalone view
// purpose-built for the autonomous agent's own SQLite state, so running it
// never requires `npm ci` inside web/ or a Next dev server.
//
// Safety: turning off DRY_RUN or turning on AUTO_APPLY_ENABLED from here is
// a real, consequential change — real applications can get submitted after
// it. The frontend confirms before sending it, and the backend independently
// refuses the request unless it's marked confirmed (defense in depth against
// a stray/scripted POST). Actual submission is still gated by every check in
// agent/apply-worker.mjs regardless of this toggle.

import http from 'node:http';
import { getDB } from './db.mjs';
import { loadConfig, applyRuntimeOverrides, RUNTIME_OVERRIDABLE_KEYS } from './config.mjs';
import { analyzeOutcomes } from './learning.mjs';
import { runOnce } from './worker.mjs';

// In-memory only — cross-process mutual exclusion for the cycle itself is
// the file lock in agent/scan-lock.mjs (see worker.mjs); this just lets the
// dashboard answer "is a scan running" instantly without waiting on it, and
// holds the AbortController a "Stop scanning" click signals.
const scanState = {
  running: false,
  stopping: false,
  startedAt: null,
  lastResult: null,
  lastError: null,
  controller: null,
};

function triggerScan(cfg) {
  if (scanState.running) return { started: false, reason: 'A scan is already running.' };
  scanState.running = true;
  scanState.stopping = false;
  scanState.startedAt = new Date().toISOString();
  scanState.lastError = null;
  scanState.controller = new AbortController();
  runOnce({ config: cfg, signal: scanState.controller.signal })
    .then((result) => {
      scanState.lastResult = result;
    })
    .catch((err) => {
      scanState.lastError = err.message;
    })
    .finally(() => {
      scanState.running = false;
      scanState.stopping = false;
      scanState.controller = null;
    });
  return { started: true };
}

/**
 * Only stops a cycle THIS dashboard process triggered via "Run scan now" —
 * it has no way to reach into a separately-running `node agent/cli.mjs
 * start` process in another terminal (different OS process, no shared
 * memory). Stopping is cooperative: the running job finishes, then the loop
 * checks the signal and exits before starting the next one — see the
 * `signal` checkpoints in agent/worker.mjs and agent/discovery.mjs.
 */
function stopScan() {
  if (!scanState.running || !scanState.controller) {
    return { stopping: false, reason: 'No scan is running.' };
  }
  scanState.stopping = true;
  scanState.controller.abort();
  return { stopping: true };
}

/** JSON-safe view of scanState (drops the AbortController). */
function scanStatePayload() {
  const { running, stopping, startedAt, lastResult, lastError } = scanState;
  return { running, stopping, startedAt, lastResult, lastError };
}

function buildPayload(db, cfg) {
  return {
    generatedAt: new Date().toISOString(),
    stats: db.getStats(),
    sources: db.countJobsBySource(),
    scoreHistogram: db.matchScoreHistogram(),
    topOpportunities: db.listTopOpportunities(20),
    recentApplications: db.listRecentApplications(20),
    humanReviewQueue: db.listApplicationsByStatus('HUMAN_REVIEW', 50),
    learning: analyzeOutcomes(db),
    settings: effectiveSettings(db, cfg),
    scan: scanStatePayload(),
  };
}

function effectiveSettings(db, cfg) {
  const merged = applyRuntimeOverrides(cfg, db);
  return {
    dryRun: merged.dryRun,
    autoApplyEnabled: merged.autoApplyEnabled,
    autoApplyThreshold: merged.autoApplyThreshold,
    maxApplicationsPerDay: merged.maxApplicationsPerDay,
    maxApplicationsPerHour: merged.maxApplicationsPerHour,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>career-ops — autonomous agent</title>
<style>
:root{
  --bg:#0b0e14; --panel:#141924; --panel-2:#1a2130; --border:#242c3d;
  --text:#e8eaf0; --muted:#8a93a6; --accent:#7aa2f7;
  --green:#3fb984; --amber:#e0af68; --red:#e06c75; --blue:#61afef;
}
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,"Segoe UI",Inter,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:28px 32px 60px;min-width:320px}
h1{font-size:19px;margin:0;font-weight:650;letter-spacing:-0.01em}
.topbar{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:22px}
.sub{color:var(--muted);font-size:12.5px}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:6px;animation:pulse 2s infinite}
.dot.busy{background:var(--amber)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:26px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.card .n{font-size:25px;font-weight:650;letter-spacing:-0.02em}
.card .l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.card.accent .n{color:var(--accent)} .card.green .n{color:var(--green)} .card.amber .n{color:var(--amber)} .card.red .n{color:var(--red)}
.row2{display:grid;grid-template-columns:1.3fr 1fr;gap:16px;margin-bottom:26px}
@media (max-width:820px){.row2{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px}
h2{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 12px;font-weight:600}
.bar-row{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12.5px}
.bar-label{width:64px;flex-shrink:0;color:var(--muted);text-align:right}
.bar-track{flex:1;background:var(--panel-2);border-radius:4px;height:16px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--blue))}
.bar-n{width:34px;flex-shrink:0;color:var(--text);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:22px}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px}
th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.04em;background:var(--panel-2)}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--panel-2)}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;background:#232a3a;color:var(--muted)}
.badge.SUBMITTED,.badge.OFFER{background:rgba(63,185,132,.15);color:var(--green)}
.badge.HUMAN_REVIEW{background:rgba(224,175,104,.15);color:var(--amber)}
.badge.INTERVIEW{background:rgba(97,175,239,.15);color:var(--blue)}
.badge.REJECTED,.badge.FAILED{background:rgba(224,108,117,.15);color:var(--red)}
.score{font-variant-numeric:tabular-nums;font-weight:600}
.empty{color:var(--muted);font-size:12.5px;padding:6px 2px}
.section{margin-bottom:8px}
.controls-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:820px){.controls-grid{grid-template-columns:1fr}}
.ctl-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)}
.ctl-row:last-child{border-bottom:none}
.ctl-label{font-size:13px}
.ctl-hint{color:var(--muted);font-size:11.5px;margin-top:1px}
.switch{position:relative;display:inline-block;width:38px;height:22px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#2a3244;border-radius:22px;transition:.15s}
.slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:#8a93a6;border-radius:50%;transition:.15s}
input:checked + .slider{background:var(--green)}
input:checked + .slider:before{background:#0b0e14;transform:translateX(16px)}
input:disabled + .slider{opacity:.5;cursor:not-allowed}
.num-input{width:60px;background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 8px;font-size:13px;text-align:center}
.btn{background:var(--accent);color:#0b0e14;border:none;border-radius:7px;padding:9px 16px;font-size:13px;font-weight:650;cursor:pointer}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.secondary{background:var(--panel-2);color:var(--text);border:1px solid var(--border)}
.scan-status{color:var(--muted);font-size:12px;margin-top:8px}
.live-warning{background:rgba(224,108,117,.12);border:1px solid rgba(224,108,117,.3);color:var(--red);border-radius:8px;padding:8px 12px;font-size:12px;margin-top:10px;display:none}
.live-warning.show{display:block}
</style></head><body>

<div class="topbar">
  <h1>career-ops — autonomous agent</h1>
  <div class="sub"><span class="dot" id="liveDot"></span><span id="liveLabel">live</span> · generated <span id="ts">—</span></div>
</div>

<div class="row2">
  <div class="panel">
    <h2>Run</h2>
    <button class="btn" id="scanBtn">Run scan now</button>
    <button class="btn secondary" id="stopBtn" style="display:none;margin-left:8px">Stop scanning</button>
    <button class="btn secondary" id="clearBtn" style="margin-left:8px">Clear data</button>
    <div class="scan-status" id="scanStatus"></div>
  </div>
  <div class="panel">
    <h2>Controls</h2>
    <div class="ctl-row">
      <div><div class="ctl-label">Dry run</div><div class="ctl-hint">On = never submits, even if auto-apply is on</div></div>
      <label class="switch"><input type="checkbox" id="dryRunToggle"><span class="slider"></span></label>
    </div>
    <div class="ctl-row">
      <div><div class="ctl-label">Auto-apply enabled</div><div class="ctl-hint">Guarded — see docs/AUTONOMOUS_AGENT.md</div></div>
      <label class="switch"><input type="checkbox" id="autoApplyToggle"><span class="slider"></span></label>
    </div>
    <div class="ctl-row">
      <div><div class="ctl-label">Score threshold</div><div class="ctl-hint">0-100, min score to APPLY</div></div>
      <input type="number" class="num-input" id="thresholdInput" min="0" max="100">
    </div>
    <div class="live-warning" id="liveWarning">⚠️ Dry run is OFF and auto-apply is ON — the next cycle can submit real applications on CAPTCHA-free forms that pass every check.</div>
  </div>
</div>

<div class="grid" id="kpis"></div>

<div class="row2">
  <div class="panel">
    <h2>Match score distribution</h2>
    <div id="histogram"></div>
  </div>
  <div class="panel">
    <h2>Discovery sources</h2>
    <div id="sources"></div>
  </div>
</div>

<div class="section">
  <h2 style="margin:0 0 8px">Human actions required</h2>
  <div id="humanReview"></div>
</div>

<div class="section">
  <h2 style="margin:0 0 8px">Top opportunities</h2>
  <div id="topOpportunities"></div>
</div>

<div class="section">
  <h2 style="margin:0 0 8px">Recent applications</h2>
  <div id="recentApplications"></div>
</div>

<div class="section">
  <h2 style="margin:0 0 8px">Learning loop — advance rate by score band</h2>
  <div id="learning"></div>
</div>

<script>
function esc(s){return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function badge(status){return '<span class="badge ' + esc(status) + '">' + esc(status || 'DISCOVERED') + '</span>';}
function table(headers, rows, emptyMsg){
  if (!rows.length) return '<div class="empty">' + esc(emptyMsg) + '</div>';
  return '<table><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr>' +
    rows.join('') + '</table>';
}

let settingsLoaded = false;

function renderSettings(s){
  const dryRunEl = document.getElementById('dryRunToggle');
  const autoApplyEl = document.getElementById('autoApplyToggle');
  const thresholdEl = document.getElementById('thresholdInput');
  // Don't stomp on a value the user is actively editing.
  if (document.activeElement !== dryRunEl) dryRunEl.checked = s.dryRun;
  if (document.activeElement !== autoApplyEl) autoApplyEl.checked = s.autoApplyEnabled;
  if (document.activeElement !== thresholdEl) thresholdEl.value = s.autoApplyThreshold;
  settingsLoaded = true;
  document.getElementById('liveWarning').classList.toggle('show', !s.dryRun && s.autoApplyEnabled);
}

function renderScan(scan){
  const dot = document.getElementById('liveDot');
  const label = document.getElementById('liveLabel');
  const btn = document.getElementById('scanBtn');
  const stopBtn = document.getElementById('stopBtn');
  const status = document.getElementById('scanStatus');
  dot.className = 'dot' + (scan.running ? ' busy' : '');
  label.textContent = scan.running ? 'scan running' : 'live';
  btn.disabled = scan.running;
  btn.textContent = scan.running ? 'Scanning…' : 'Run scan now';
  stopBtn.style.display = scan.running ? 'inline-block' : 'none';
  stopBtn.disabled = scan.stopping;
  stopBtn.textContent = scan.stopping ? 'Stopping…' : 'Stop scanning';
  if (scan.stopping) {
    status.textContent = 'Stopping — finishing the job currently being scored, then it will end the cycle.';
  } else if (scan.running) {
    status.textContent = 'Started ' + new Date(scan.startedAt).toLocaleTimeString() + ' — this can take a few minutes.';
  } else if (scan.lastError) {
    status.textContent = 'Last run failed: ' + scan.lastError;
  } else if (scan.lastResult) {
    const r = scan.lastResult;
    status.textContent = r.skipped
      ? 'Skipped — another process was already running a cycle.'
      : (r.stopped ? 'Stopped early. ' : 'Last run: ') + r.jobsFound + ' found, ' + r.jobsNew + ' new, ' +
        r.evaluated + ' evaluated, ' + r.applied + ' applied, ' + r.humanReview + ' need review, ' +
        r.errors.length + ' errors.';
  } else {
    status.textContent = 'No scan run yet this session.';
  }
}

function render(d){
  document.getElementById('ts').textContent = new Date(d.generatedAt).toLocaleTimeString();
  if (!settingsLoaded) renderSettings(d.settings);
  renderScan(d.scan);
  const s = d.stats;
  const kpis = [
    ['jobsDiscovered','Discovered',''], ['jobsAnalyzed','Analyzed',''], ['jobsQualified','Qualified','accent'],
    ['applicationsSubmitted','Submitted','green'], ['awaitingHumanReview','Awaiting you','amber'],
    ['interviews','Interviews','blue'], ['offers','Offers','green'], ['rejected','Rejected','red'],
  ];
  document.getElementById('kpis').innerHTML =
    kpis.map(([k,l,c]) => '<div class="card ' + c + '"><div class="n">' + (s[k] ?? 0) + '</div><div class="l">' + l + '</div></div>').join('') +
    '<div class="card"><div class="n">' + (s.avgMatchScore ? Math.round(s.avgMatchScore) : '—') + '</div><div class="l">Avg score</div></div>' +
    '<div class="card"><div class="n">' + s.applicationsThisWeek + '</div><div class="l">This week</div></div>' +
    '<div class="card"><div class="n">' + s.applicationsThisMonth + '</div><div class="l">This month</div></div>';

  const maxHist = Math.max(1, ...d.scoreHistogram.map(b => b.count));
  document.getElementById('histogram').innerHTML = d.scoreHistogram.map(b =>
    '<div class="bar-row"><div class="bar-label">' + b.band + '</div>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + (b.count/maxHist*100) + '%"></div></div>' +
    '<div class="bar-n">' + b.count + '</div></div>'
  ).join('') || '<div class="empty">No jobs scored yet.</div>';

  const maxSrc = Math.max(1, ...d.sources.map(x => x.n));
  document.getElementById('sources').innerHTML = d.sources.length ? d.sources.map(x =>
    '<div class="bar-row"><div class="bar-label">' + esc(x.source) + '</div>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + (x.n/maxSrc*100) + '%"></div></div>' +
    '<div class="bar-n">' + x.n + '</div></div>'
  ).join('') : '<div class="empty">No jobs discovered yet — click "Run scan now" above.</div>';

  document.getElementById('humanReview').innerHTML = table(
    ['Company','Position','Updated','Notes','Apply'],
    d.humanReviewQueue.map(a => {
      const link = a.application_url || a.job_url;
      const applyCell = link
        ? '<a href="' + esc(link) + '" target="_blank" rel="noopener" class="btn secondary" style="padding:4px 12px;font-size:11.5px;text-decoration:none;display:inline-block">Apply manually →</a>'
        : '<span class="empty">no link</span>';
      return '<tr><td>' + esc(a.company) + '</td><td>' + esc(a.position) + '</td><td>' +
        esc((a.updated_at||'').slice(0,16).replace('T',' ')) + '</td><td>' + esc(a.notes) + '</td><td>' + applyCell + '</td></tr>';
    }),
    'Nothing waiting on you right now.',
  );

  document.getElementById('topOpportunities').innerHTML = table(
    ['Company','Position','Location','Salary','Match','Status'],
    d.topOpportunities.map(o => {
      const position = o.url
        ? '<a href="' + esc(o.url) + '" target="_blank" rel="noopener" style="color:inherit">' + esc(o.title) + '</a>'
        : esc(o.title);
      const location = esc(o.location) || (o.remote ? 'Remote' : '—');
      return '<tr><td>' + esc(o.company) + '</td><td>' + position + '</td><td>' + location + '</td><td>' +
        esc(o.salary || '—') + '</td><td class="score">' + Math.round(o.match_score) + '/100</td><td>' +
        badge(o.status) + '</td></tr>';
    }),
    'No jobs scored yet.',
  );

  document.getElementById('recentApplications').innerHTML = table(
    ['Company','Position','Date','Status'],
    d.recentApplications.map(a => '<tr><td>' + esc(a.company) + '</td><td>' + esc(a.position) + '</td><td>' +
      esc((a.date_applied || a.updated_at || '').slice(0,10)) + '</td><td>' + badge(a.status) + '</td></tr>'),
    'No applications yet.',
  );

  document.getElementById('learning').innerHTML = table(
    ['Score band','Applications','Advanced','Rate'],
    d.learning.byScoreBand.map(b => '<tr><td>' + esc(b.band) + '</td><td>' + b.applications + '</td><td>' +
      b.advanced + '</td><td>' + Math.round(b.rate*100) + '%</td></tr>'),
    'No outcomes tracked yet (needs applications that reached Interview/Offer/Rejected).',
  );
}

async function refresh(){
  try {
    const res = await fetch('/api/stats');
    render(await res.json());
  } catch (e) { /* keep showing last good render */ }
}

async function postSettings(patch, confirmMsg){
  if (confirmMsg && !window.confirm(confirmMsg)) { refresh(); return; }
  await fetch('/api/settings', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ ...patch, confirm: true }),
  });
  refresh();
}

document.getElementById('scanBtn').addEventListener('click', async () => {
  const res = await fetch('/api/scan', { method: 'POST' });
  const j = await res.json();
  if (!j.started) alert(j.reason || 'Could not start a scan.');
  refresh();
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  const res = await fetch('/api/scan/stop', { method: 'POST' });
  const j = await res.json();
  if (!j.stopping) alert(j.reason || 'Could not stop the scan.');
  refresh();
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!window.confirm('Clear ALL discovered jobs, scores, and applications? This cannot be undone. (Your dry-run/auto-apply settings are kept.)')) return;
  const res = await fetch('/api/clear', {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ confirm: true }),
  });
  const j = await res.json();
  if (!j.cleared) alert(j.reason || j.error || 'Could not clear data.');
  refresh();
});

document.getElementById('dryRunToggle').addEventListener('change', (e) => {
  const turningOff = !e.target.checked;
  postSettings(
    { dryRun: e.target.checked },
    turningOff ? 'Turn OFF dry run? The agent may then submit real applications (still gated by every other safety check).' : null,
  );
});
document.getElementById('autoApplyToggle').addEventListener('change', (e) => {
  const turningOn = e.target.checked;
  postSettings(
    { autoApplyEnabled: e.target.checked },
    turningOn ? 'Turn ON auto-apply? Combined with Dry run = OFF, the agent can submit real applications on CAPTCHA-free forms it is fully confident about.' : null,
  );
});
document.getElementById('thresholdInput').addEventListener('change', (e) => {
  postSettings({ autoApplyThreshold: Number(e.target.value) }, null);
});

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;

export function createDashboardServer({ config } = {}) {
  const cfg = config || loadConfig();
  const db = getDB(cfg.dbPath);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(buildPayload(db, cfg)));
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(effectiveSettings(db, cfg)));
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const goingLive =
        (body.dryRun === false) || (body.autoApplyEnabled === true);
      if (goingLive && body.confirm !== true) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Confirmation required to disable dry-run or enable auto-apply.' }));
        return;
      }
      for (const key of RUNTIME_OVERRIDABLE_KEYS) {
        if (body[key] === undefined) continue;
        if (key === 'autoApplyThreshold') {
          const n = Number(body[key]);
          if (!Number.isFinite(n)) continue;
          db.setSetting(key, Math.min(100, Math.max(0, n)));
        } else {
          db.setSetting(key, !!body[key]);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(effectiveSettings(db, cfg)));
      return;
    }

    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const result = triggerScan(cfg);
      res.writeHead(result.started ? 200 : 409, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === '/api/scan/stop' && req.method === 'POST') {
      const result = stopScan();
      res.writeHead(result.stopping ? 200 : 409, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === '/api/clear' && req.method === 'POST') {
      if (scanState.running) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cleared: false, reason: 'Stop the running scan before clearing data.' }));
        return;
      }
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Confirmation required to clear all job data.' }));
        return;
      }
      db.clearJobData();
      scanState.lastResult = null;
      scanState.lastError = null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cleared: true }));
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });
}

export function startDashboard({ config } = {}) {
  const cfg = config || loadConfig();
  const server = createDashboardServer({ config: cfg });
  server.listen(cfg.dashboardPort, () => {
    console.log(`Dashboard running at http://localhost:${cfg.dashboardPort}`);
  });
  return server;
}
