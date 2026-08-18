#!/usr/bin/env node
// agent/cli.mjs — entry point for the autonomous agent.
//
// Usage:
//   node agent/cli.mjs start        # run the 24/7 loop (foreground)
//   node agent/cli.mjs scan-once    # run exactly one discover->apply cycle, then exit
//   node agent/cli.mjs dashboard    # serve the local dashboard
//   node agent/cli.mjs doctor       # check prerequisites (env, cv.md, profile.yml)
//   node agent/cli.mjs learning     # print the learning-loop report

import { loadConfig } from './config.mjs';
import { startWorker, runOnce } from './worker.mjs';
import { startDashboard } from './dashboard-server.mjs';
import { getDB } from './db.mjs';
import { analyzeOutcomes } from './learning.mjs';
import { runDoctor } from './doctor.mjs';

const cmd = process.argv[2];
const cfg = loadConfig();

switch (cmd) {
  case 'start':
    await startWorker({ config: cfg });
    break;
  case 'scan-once': {
    const result = await runOnce({ config: cfg });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
    break;
  }
  case 'dashboard':
    startDashboard({ config: cfg });
    break;
  case 'learning': {
    const db = getDB(cfg.dbPath);
    console.log(JSON.stringify(analyzeOutcomes(db), null, 2));
    break;
  }
  case 'doctor':
  default: {
    const ok = await runDoctor(cfg);
    if (!cmd) {
      console.log(
        '\nUsage: node agent/cli.mjs <start|scan-once|dashboard|learning|doctor>\n' +
          'See docs/AUTONOMOUS_AGENT.md for the full guide.',
      );
    }
    process.exit(ok ? 0 : 1);
  }
}
