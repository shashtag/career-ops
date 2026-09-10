#!/usr/bin/env node
/**
 * clean-output.mjs — reclaim space in output/ without destroying the audit trail.
 *
 * output/ was 172M on 2026-09-10, of which 170.5M was apply-run screenshots — 368 files,
 * only 9 of them referenced anywhere. Those are debug artifacts and are worth deleting.
 *
 * `output/fills/` is the opposite case and is NEVER auto-deleted. Each fill receipt is a
 * ~5KB record of exactly what was typed into an employer's form, and the whole directory
 * is 624K — deleting it saves nothing and destroys the only record of what was actually
 * submitted. Its value is not hypothetical: these receipts are what revealed that 76
 * applications went out under shashwatsatna@gmail.com while config/profile.yml declares
 * shashwatvg@gmail.com. No screenshot would have shown that.
 *
 * PROTECTED (never deleted):
 *   - anything referenced by reports/, data/, or the memory dir
 *   - output/fills/** (audit trail, negligible size)
 *   - files newer than --keep-days (default 7)
 *   - PDFs (CVs and cover letters — cheap, and often still in flight)
 *   - any job with a live claim in data/cache/claims
 *
 * Usage:
 *   node clean-output.mjs                 # dry run — show what would go
 *   node clean-output.mjs --apply         # delete
 *   node clean-output.mjs --keep-days=14  # widen the recency window
 *   node clean-output.mjs --json
 */

import { readdirSync, statSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isNestedCheckout } from './lib/mjs-files.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const OUT = join(DATA_ROOT, 'output');
const CLAIMS = join(DATA_ROOT, 'data', 'cache', 'claims');
const MEMORY = `${process.env.HOME}/.claude/projects/-Users-shashwatguta-Desktop-career-ops/memory`;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const AS_JSON = args.includes('--json');
const keepArg = args.find(a => a.startsWith('--keep-days='));
const KEEP_DAYS = keepArg ? Number(keepArg.split('=')[1]) : 7;
const log = (...m) => { if (!AS_JSON) console.log(...m); };

if (!existsSync(OUT)) { console.error('output/ not found'); process.exit(1); }

/** Every output/... path mentioned anywhere that could be an audit reference. */
function referencedPaths() {
  const where = ['reports/', 'data/', existsSync(MEMORY) ? MEMORY : ''].filter(Boolean).join(' ');
  let raw = '';
  try {
    raw = execSync(`grep -rhoE "output/[A-Za-z0-9._/-]+" ${where} 2>/dev/null || true`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
  } catch { /* grep found nothing */ }
  return new Set(raw.split('\n').map(s => s.trim().replace(/^output\//, '')).filter(Boolean));
}

/** URLs currently claimed — their artifacts belong to work in progress. */
function claimedIds() {
  const ids = new Set();
  if (!existsSync(CLAIMS)) return ids;
  for (const f of readdirSync(CLAIMS)) {
    if (!f.endsWith('.claim')) continue;
    try {
      const c = JSON.parse(readFileSync(join(CLAIMS, f), 'utf8'));
      const m = String(c.url || '').match(/(\d{2,5})/g);
      if (m) m.forEach(x => ids.add(x));
    } catch { /* skip unreadable claim */ }
  }
  return ids;
}

// Does not descend into a nested checkout. A worktree, submodule or stray clone
// parked under output/ is somebody else's source tree, and every path this walk
// returns is a deletion candidate below — so descending would offer another
// repository's files up for removal on an age rule that says nothing about them.
// The root itself is never tested: its own marker is what makes it the root
// (see isNestedCheckout, #3499/#3762).
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (isNestedCheckout(p)) continue;
      walk(p, acc);
    } else acc.push(p);
  }
  return acc;
}

const refs = referencedPaths();
const claims = claimedIds();
const now = Date.now();
const DAY = 86400000;

const keep = [];
const remove = [];

for (const abs of walk(OUT)) {
  const rel = relative(OUT, abs);
  if (rel === '.gitkeep') { keep.push({ rel, why: 'gitkeep' }); continue; }

  const st = statSync(abs);
  const ageDays = (now - st.mtimeMs) / DAY;
  const entry = { rel, bytes: st.size, ageDays: Math.floor(ageDays) };

  // Audit trail — the whole point of the directory.
  if (rel.startsWith('fills/')) { keep.push({ ...entry, why: 'fill receipt (audit trail)' }); continue; }
  if (refs.has(rel)) { keep.push({ ...entry, why: 'referenced' }); continue; }
  if (/\.pdf$/i.test(rel)) { keep.push({ ...entry, why: 'pdf' }); continue; }
  if (ageDays <= KEEP_DAYS) { keep.push({ ...entry, why: `newer than ${KEEP_DAYS}d` }); continue; }
  if ([...claims].some(id => rel.includes(id))) { keep.push({ ...entry, why: 'active claim' }); continue; }

  remove.push(entry);
}

const sum = a => a.reduce((n, x) => n + (x.bytes || 0), 0);
const mb = b => (b / 1048576).toFixed(1) + 'M';

log(`output/  ${keep.length + remove.length} files, ${mb(sum(keep) + sum(remove))} total`);
log(`  keep   ${String(keep.length).padStart(4)}  ${mb(sum(keep)).padStart(7)}`);
log(`  delete ${String(remove.length).padStart(4)}  ${mb(sum(remove)).padStart(7)}`);

const byWhy = {};
for (const k of keep) byWhy[k.why] = (byWhy[k.why] || 0) + 1;
log('\nkept because:');
for (const [w, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${w}`);

if (APPLY) {
  let freed = 0;
  for (const r of remove) { try { unlinkSync(join(OUT, r.rel)); freed += r.bytes; } catch { /* already gone */ } }
  log(`\n✅ deleted ${remove.length} files, freed ${mb(freed)}`);
} else if (remove.length) {
  log(`\n(dry run — re-run with --apply to free ${mb(sum(remove))})`);
}

if (AS_JSON) {
  console.log(JSON.stringify({
    kept: keep.length, keptBytes: sum(keep),
    removed: remove.length, removedBytes: sum(remove),
    applied: APPLY, keepDays: KEEP_DAYS,
  }, null, 2));
}
