#!/usr/bin/env node
/**
 * scan-hot.mjs — high-frequency scan of the "hot" company list only.
 *
 * WHY: being first to apply is decided by scan frequency, not by ranking. On
 * 2026-09-10 the pipeline held 1,513 pending roles and ZERO under 48 hours old,
 * because the full scan (153 portals, ~19k postings) is too heavy to run often and
 * had last completed ~98 hours earlier. No ranker can fix that; there is simply
 * nothing fresh to rank.
 *
 * The fix is tiering. The companies actually worth applying to sit on direct ATS
 * boards (Greenhouse / Lever / Ashby) whose APIs are cheap, fast, and zero-token, so
 * that subset can be polled hourly while the long tail stays on a slower cycle.
 *
 * Reads `scan_tiers.hot` from config/profile.yml and runs `scan.mjs --company <name>`
 * for each. scan.mjs owns all writes (pipeline, scan-history, scan-runs), so this is
 * only a scheduler — it adds no new write paths and no new dedup logic.
 *
 * Usage:
 *   node scan-hot.mjs                 # scan every hot company
 *   node scan-hot.mjs --dry-run       # preview, write nothing
 *   node scan-hot.mjs --quiet         # only the final summary line
 *   node scan-hot.mjs --json          # machine-readable summary
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const PROFILE = resolve(DATA_ROOT, 'config/profile.yml');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const QUIET = args.includes('--quiet');
const AS_JSON = args.includes('--json');
const log = (...m) => { if (!QUIET && !AS_JSON) console.log(...m); };

let hot = [];
try {
  const p = yaml.load(readFileSync(PROFILE, 'utf8')) || {};
  hot = (p.scan_tiers?.hot || []).map(String).filter(Boolean);
} catch (e) {
  console.error(`could not read scan_tiers.hot from config/profile.yml: ${e.message}`);
  process.exit(1);
}

if (!hot.length) {
  console.error('scan_tiers.hot is empty — nothing to scan. Add companies to config/profile.yml.');
  process.exit(1);
}

log(`hot-scanning ${hot.length} companies${DRY ? ' (dry run)' : ''}...\n`);

const started = Date.now();
const results = [];
for (const company of hot) {
  const argv = ['scan.mjs', '--company', company, '--quiet'];
  if (DRY) argv.push('--dry-run');
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const ok = r.status === 0;
  // scan.mjs ends with generic Discord/next-step footers, so the last line is noise.
  // The lines that matter are the `+ Company | Role | Location` additions.
  const out = (r.stdout || '').split('\n');
  const added = out.filter(l => l.trim().startsWith('+ ')).length;
  const detail = added ? `${added} new` : 'no new postings';
  results.push({ company, ok, added, detail: ok ? detail : (r.stderr || '').trim().slice(0, 120) });
  log(`  ${ok ? '✅' : '❌'} ${company.padEnd(16)} ${detail}`);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(0);
const failed = results.filter(r => !r.ok);

if (AS_JSON) {
  console.log(JSON.stringify({ companies: hot.length, failed: failed.length, elapsedSec: Number(elapsed), dryRun: DRY, results }, null, 2));
} else {
  const totalAdded = results.reduce((n, r) => n + (r.added || 0), 0);
  console.log(`\nhot scan done: ${hot.length - failed.length}/${hot.length} ok, ${totalAdded} new postings, ${elapsed}s${failed.length ? ` — failed: ${failed.map(f => f.company).join(', ')}` : ''}`);
}

process.exit(failed.length === hot.length ? 1 : 0);
