#!/usr/bin/env node
/**
 * verify-backlog.mjs — liveness-sweep the pending pipeline, zero tokens, no browser.
 *
 * WHY: sampling on 2026-09-10 found ~75-85% of pipeline entries older than 30 days were
 * already dead (404 from the ATS API). A queue that is mostly corpses makes every
 * downstream decision worse: ranking wastes slots on dead links, the backlog looks far
 * richer than it is, and the genuinely hard-to-fill roles that ARE still open after
 * months — the most valuable thing in the queue — are buried under them.
 *
 * This checks each pending posting against its own ATS API (`checkLivenessViaApi`),
 * which is free, needs no Playwright, and returns `expired` only when the API is
 * authoritative about a 404/410.
 *
 * SAFETY:
 *   - Read-only unless `--apply` is passed.
 *   - `--apply` flips dead entries from `- [ ]` to `- [x]` in place and appends a marker.
 *     Nothing is deleted; the line and its notes stay in the file, and `rank-queue.mjs`
 *     stops picking them up because it only reads `- [ ]`.
 *   - A timestamped backup is written before the first mutation.
 *   - `uncertain` and non-ATS URLs are NEVER culled — inconclusive is not dead.
 *
 * Usage:
 *   node verify-backlog.mjs                        # dry run, whole pending queue
 *   node verify-backlog.mjs --min-age-days=30      # only entries first seen >= 30d ago
 *   node verify-backlog.mjs --limit=200            # cap the number checked this run
 *   node verify-backlog.mjs --apply                # write the cull
 *   node verify-backlog.mjs --json                 # machine-readable summary
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { checkLivenessViaApi, isAtsPosting } from './liveness-api.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PIPELINE = resolve(DATA_ROOT, 'data/pipeline.md');
const HISTORY = resolve(DATA_ROOT, 'data/scan-history.tsv');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => {
  const a = args.find(x => x.startsWith(`${f}=`));
  return a ? a.slice(f.length + 1) : d;
};

const APPLY = has('--apply');
const AS_JSON = has('--json');
const MIN_AGE_DAYS = Number(val('--min-age-days', '0'));
const LIMIT = Number(val('--limit', '0'));
const CONCURRENCY = Math.max(1, Number(val('--concurrency', '6')));

const log = (...m) => { if (!AS_JSON) console.log(...m); };

/** first_seen per URL, so --min-age-days can work without a posted_at column. */
function loadFirstSeen() {
  const map = new Map();
  if (!existsSync(HISTORY)) return map;
  const lines = readFileSync(HISTORY, 'utf8').trim().split('\n');
  const cols = lines[0].split('\t');
  const iUrl = cols.indexOf('url');
  const iSeen = cols.indexOf('first_seen');
  if (iUrl < 0 || iSeen < 0) return map;
  for (const line of lines.slice(1)) {
    const p = line.split('\t');
    if (p[iUrl] && p[iSeen]) map.set(p[iUrl].trim(), p[iSeen].trim());
  }
  return map;
}

function ageDays(dateStr, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  return Math.floor((now - Date.parse(`${dateStr}T00:00:00Z`)) / 86400000);
}

async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

async function main() {
  if (!existsSync(PIPELINE)) {
    console.error('data/pipeline.md not found');
    process.exit(1);
  }
  const now = Date.now();
  const firstSeen = loadFirstSeen();
  const raw = readFileSync(PIPELINE, 'utf8');
  const lines = raw.split('\n');

  // Collect pending entries with their line index so we can rewrite precisely.
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('- [ ]')) continue;
    const url = (t.slice(5).trim().split('|')[0] || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const seen = firstSeen.get(url) || null;
    pending.push({ lineIdx: i, url, firstSeen: seen, age: ageDays(seen, now) });
  }

  let targets = pending.filter(p => isAtsPosting(p.url));
  const nonAts = pending.length - targets.length;
  if (MIN_AGE_DAYS > 0) targets = targets.filter(p => p.age !== null && p.age >= MIN_AGE_DAYS);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  log(`pending entries      : ${pending.length}`);
  log(`  checkable via ATS  : ${targets.length}${MIN_AGE_DAYS ? ` (age >= ${MIN_AGE_DAYS}d)` : ''}`);
  log(`  not an ATS posting : ${nonAts} (never culled — cannot verify cheaply)`);
  log(`checking with concurrency ${CONCURRENCY}...\n`);

  let done = 0;
  const results = await pool(targets, CONCURRENCY, async (t) => {
    let r = null;
    try { r = await checkLivenessViaApi(t.url); } catch { r = null; }
    done++;
    if (!AS_JSON && done % 100 === 0) log(`  ...${done}/${targets.length}`);
    return { ...t, result: r?.result ?? 'unknown', reason: r?.reason ?? 'no ATS API verdict' };
  });

  const dead = results.filter(r => r.result === 'expired');
  const alive = results.filter(r => r.result === 'active');
  const unsure = results.filter(r => r.result !== 'expired' && r.result !== 'active');

  log(`\n  active    ${alive.length}`);
  log(`  expired   ${dead.length}`);
  log(`  uncertain ${unsure.length}  (kept)`);

  // Long-open survivors are the desperation signal: still live after months.
  const survivors = alive
    .filter(r => r.age !== null && r.age >= 60)
    .sort((a, b) => b.age - a.age);
  if (survivors.length && !AS_JSON) {
    log(`\n=== still live after 60+ days (${survivors.length}) — hard-to-fill candidates ===`);
    for (const s of survivors.slice(0, 25)) log(`  ${String(s.age).padStart(3)}d  ${s.url}`);
    if (survivors.length > 25) log(`  ... and ${survivors.length - 25} more`);
  }

  if (APPLY && dead.length) {
    copyFileSync(PIPELINE, `${PIPELINE}.bak-${new Date().toISOString().slice(0, 10)}`);
    const stamp = new Date().toISOString().slice(0, 10);
    for (const d of dead) {
      const orig = lines[d.lineIdx];
      lines[d.lineIdx] = orig.replace('- [ ]', '- [x]').trimEnd() +
        ` | ❌ dead ${stamp} (ATS API 404 — verified by verify-backlog.mjs)`;
    }
    writeFileSync(PIPELINE, lines.join('\n'), 'utf8');
    log(`\n✅ culled ${dead.length} dead entries (backup: pipeline.md.bak-${stamp})`);
  } else if (dead.length) {
    log(`\n(dry run — re-run with --apply to cull ${dead.length} dead entries)`);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      pending: pending.length, checked: targets.length, nonAts,
      active: alive.length, expired: dead.length, uncertain: unsure.length,
      longOpenSurvivors: survivors.map(s => ({ url: s.url, ageDays: s.age })),
      applied: APPLY,
    }, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
