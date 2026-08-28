/**
 * job-claim.mjs — stop two concurrent runs from working the same job.
 *
 * Job selection is deterministic: every run reads the same tracker, applies the
 * same priority order, and picks the same top job. Overlapping runs therefore
 * converge on identical work rather than diverging onto different work — which
 * is how the same application gets filled twice in two tabs.
 *
 * A claim is a sentinel file created with O_CREAT|O_EXCL, the same atomic
 * primitive reserve-report-num.mjs uses for report slots: exactly one caller
 * can create it, everyone else gets EEXIST and moves to the next job.
 *
 * Claims are advisory and self-healing, so a crashed run never wedges a job:
 *   - a working claim expires after STALE_MS, or when its process exits
 *   - a tab-held claim (a filled form parked in a tab) lives as long as the tab
 *     does, and frees TAB_GONE_GRACE_MS after the tab stops being visible
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

const CLAIM_DIR = 'data/cache/claims';
const STALE_MS = 45 * 60 * 1000;        // an active fill+submit is minutes, not tens of minutes
// Grace period after a claimed job's tab stops being visible. The point of a
// tab-held claim is "this job is open in a tab, leave it alone" — so the moment
// the tab is gone the job should come back into play. The grace exists only to
// absorb transient blips (browser restart, Chrome mid-relaunch returning a
// partial tab list), not to reserve the job for any length of time. A hard CDP
// failure is handled separately: openUrls === null never frees a claim.
const TAB_GONE_GRACE_MS = 30 * 60 * 1000;

/**
 * URLs of every tab currently open in Chrome, or null if Chrome can't be
 * reached. null and "no tabs" mean different things: if CDP is down we must NOT
 * conclude a tab was closed, or a run would steal a job that's still sitting
 * filled in a tab we simply couldn't see.
 */
export async function fetchOpenTabUrls(timeoutMs = 2000) {
  try {
    const res = await fetch('http://localhost:9222/json/list', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const tabs = await res.json();
    return new Set(tabs.filter(t => t.url).map(t => t.url));
  } catch {
    return null;
  }
}

/** Tabs match loosely — ATS URLs pick up /apply suffixes and query strings. */
function tabOpenFor(url, openUrls) {
  if (!openUrls || !url) return false;
  const base = String(url).split('?')[0].replace(/\/(apply|application)?\/?$/, '');
  for (const t of openUrls) {
    const tb = String(t).split('?')[0];
    if (tb === url || tb.startsWith(base) || base.startsWith(tb.replace(/\/(apply|application)?\/?$/, ''))) {
      return true;
    }
  }
  return false;
}

function claimPath(jobId) {
  return join(CLAIM_DIR, `${String(jobId).replace(/[^\w.-]/g, '_')}.claim`);
}

/** Is a pid still running? Signal 0 tests existence without delivering. */
function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readClaim(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

/**
 * A claim is dead when it ages out — and, only if it opted into `bindToPid`,
 * when its owning process is gone.
 *
 * Pid-liveness must not be a blanket staleness trigger: the CLI claims in one
 * short-lived process while the agent does the work in another, so a pid-bound
 * claim would evaporate the instant `node lib/job-claim.mjs claim NNN` exited
 * and two runs would both think they won. Time is the honest guarantee; pid
 * liveness is an opt-in optimisation for callers that hold the claim in-process
 * and can guarantee release() on exit.
 */
function isStale(claim, openUrls = null) {
  if (!claim) return true;

  // A filled form sitting in an open tab stays claimed for exactly as long as
  // that tab exists — it's unsubmitted work nobody else should touch. Once the
  // tab is gone the job comes back into play; the grace window below only
  // absorbs transient blips, it does not reserve the job.
  if (claim.holdWhileTabOpen) {
    // CDP unreachable: we cannot tell whether the tab is there, so we must not
    // conclude it is gone. Hold.
    if (!openUrls) return false;
    if (tabOpenFor(claim.url || claim.jobId, openUrls)) return false;
    // Tab is genuinely absent — free it once the blip window has passed.
    const lastSeen = claim.lastSeenAt || claim.at || 0;
    return Date.now() - lastSeen > TAB_GONE_GRACE_MS;
  }

  if (Date.now() - (claim.at || 0) > (claim.ttlMs || STALE_MS)) return true;
  if (claim.bindToPid && !pidAlive(claim.pid)) return true;
  return false;
}

/**
 * Try to take exclusive ownership of a job.
 *
 * @param {string|number} jobId - Report number, or any stable job identifier.
 * @param {{note?: string, ttlMs?: number, bindToPid?: boolean}} [opts]
 *   ttlMs      - how long the claim stays valid without release (default 45min)
 *   bindToPid  - also release the claim as soon as this process exits. Only set
 *                this when the claiming process is the one doing the work.
 *   holdWhileTabOpen - the job has a filled form parked in a browser tab. The
 *                claim survives for as long as that tab is open, then frees
 *                TAB_GONE_GRACE_MS (30min) after the tab stops being visible.
 *   url        - the job URL to match tabs against (defaults to jobId).
 *   openUrls   - Set from fetchOpenTabUrls(), needed to evaluate an existing
 *                holdWhileTabOpen claim.
 * @returns {{ok: true, release: () => void} | {ok: false, heldBy: object|null, reason: string}}
 */
export function claimJob(jobId, opts = {}) {
  mkdirSync(CLAIM_DIR, { recursive: true });
  const path = claimPath(jobId);
  const payload = JSON.stringify({
    jobId: String(jobId),
    pid: process.pid,
    at: Date.now(),
    ttlMs: opts.ttlMs || STALE_MS,
    lastSeenAt: Date.now(),
    bindToPid: !!opts.bindToPid,
    holdWhileTabOpen: !!opts.holdWhileTabOpen,
    url: opts.url || String(jobId),
    note: opts.note || '',
  });

  const write = () => {
    // 'wx' → O_CREAT|O_EXCL: fails if the file already exists. This is the
    // whole mutual-exclusion guarantee; nothing here is a check-then-act race.
    writeFileSync(path, payload, { flag: 'wx' });
  };

  try {
    write();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = readClaim(path);
    if (!isStale(existing, opts.openUrls)) {
      // A parked form (tab-held, no live process) is not "someone else's work
      // in progress" — it is unfinished work waiting to be completed. A run
      // that explicitly asks to resume may take it over; only a live working
      // claim blocks. Without this, a form filled by run N could never be
      // submitted by run N+1 and would sit forever.
      // A tab-held claim is parked by definition: holdForOpenTab() writes it
      // exactly when a run finishes filling and hands the form to the tab. Its
      // recorded pid is informational only — checking pidAlive() here would be
      // wrong, because the OS reuses pids and a recycled one would make the
      // claim look permanently "live" and never resumable.
      const parked = existing?.holdWhileTabOpen === true;
      if (!(opts.resume && parked)) {
        return {
          ok: false,
          heldBy: existing,
          reason: parked ? 'parked in a tab (pass resume:true to take it over)' : 'held by a live run',
        };
      }
    }
    // Reclaim: drop the dead sentinel, then re-create exclusively. If another
    // run wins that gap, we lose cleanly rather than double-claiming.
    try { unlinkSync(path); } catch { /* someone else already reclaimed it */ }
    try {
      write();
    } catch (e2) {
      if (e2.code === 'EEXIST') return { ok: false, heldBy: readClaim(path), reason: 'lost reclaim race' };
      throw e2;
    }
  }

  return {
    ok: true,
    release: () => { try { unlinkSync(path); } catch { /* already gone */ } },
  };
}

/**
 * Convert a claim we already own into a tab-held claim, or create one.
 *
 * Called once a form has been filled and parked in a browser tab: from then on
 * the job belongs to that tab, not to the run that filled it, so the claim must
 * outlive the process. Force-writes rather than using O_EXCL because the caller
 * already holds this slot.
 *
 * @param {string} jobId
 * @param {{note?: string, url?: string, ttlMs?: number}} [opts]
 */
export function holdForOpenTab(jobId, opts = {}) {
  mkdirSync(CLAIM_DIR, { recursive: true });
  writeFileSync(claimPath(jobId), JSON.stringify({
    jobId: String(jobId),
    pid: process.pid,
    at: Date.now(),
    ttlMs: opts.ttlMs || STALE_MS,
    lastSeenAt: Date.now(),
    bindToPid: false,
    holdWhileTabOpen: true,
    url: opts.url || String(jobId),
    note: opts.note || 'form filled, awaiting submit/human step',
  }), 'utf-8');
}

/**
 * Refresh `lastSeenAt` on every tab-held claim whose tab is still open, so the
 * grace window is measured from when the tab actually disappeared rather than
 * from when the claim was created. No-op when Chrome is unreachable.
 *
 * @param {Set<string>|null} openUrls
 */
export function touchTabClaims(openUrls) {
  if (!openUrls || !existsSync(CLAIM_DIR)) return 0;
  let touched = 0;
  for (const f of readdirSync(CLAIM_DIR)) {
    if (!f.endsWith('.claim')) continue;
    const p = join(CLAIM_DIR, f);
    const claim = readClaim(p);
    if (!claim?.holdWhileTabOpen) continue;
    if (!tabOpenFor(claim.url || claim.jobId, openUrls)) continue;
    claim.lastSeenAt = Date.now();
    try { writeFileSync(p, JSON.stringify(claim), 'utf-8'); touched++; } catch { /* raced */ }
  }
  return touched;
}

/** Job ids currently claimed by a live, non-stale run. */
export function activeClaims(openUrls = null) {
  if (!existsSync(CLAIM_DIR)) return [];
  const out = [];
  for (const f of readdirSync(CLAIM_DIR)) {
    if (!f.endsWith('.claim')) continue;
    const claim = readClaim(join(CLAIM_DIR, f));
    if (claim && !isStale(claim, openUrls)) out.push(claim);
  }
  return out;
}

/**
 * Jobs parked mid-flight: a form was filled and left in a tab, and no live
 * process is working it. This is the most-complete unfinished work in the
 * system — a run should finish these before starting anything new, since only
 * the submit step is left. Take one over with claimJob(id, { resume: true }).
 *
 * @param {Set<string>|null} openUrls
 */
export function parkedClaims(openUrls = null) {
  return activeClaims(openUrls).filter(c => c.holdWhileTabOpen === true);
}

/** Remove sentinels whose owner is gone. Safe to call at run start. */
export function sweepStaleClaims(openUrls = null) {
  if (!existsSync(CLAIM_DIR)) return 0;
  let swept = 0;
  for (const f of readdirSync(CLAIM_DIR)) {
    if (!f.endsWith('.claim')) continue;
    const p = join(CLAIM_DIR, f);
    if (isStale(readClaim(p), openUrls)) { try { unlinkSync(p); swept++; } catch { /* raced */ } }
  }
  return swept;
}

// CLI: node lib/job-claim.mjs <list|parked|sweep|claim ID [--resume|--hold-tab]|park ID [--url U] [--note N]|release ID>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const holdTab = process.argv.includes('--hold-tab');
  const resume = process.argv.includes('--resume');
  const openUrls = await fetchOpenTabUrls();
  touchTabClaims(openUrls);

  if (cmd === 'list') console.log(JSON.stringify(activeClaims(openUrls), null, 2));
  else if (cmd === 'parked') console.log(JSON.stringify(parkedClaims(openUrls), null, 2));
  else if (cmd === 'sweep') console.log(`swept ${sweepStaleClaims(openUrls)} stale claim(s)`);
  else if (cmd === 'claim') {
    const r = claimJob(arg, { openUrls, holdWhileTabOpen: holdTab, resume });
    console.log(JSON.stringify({ jobId: arg, ...r, release: undefined }));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'park') {
    // Hand a filled-but-unsubmitted form over to the browser tab holding it, so
    // the claim outlives this process. Without this the next scheduled run sees
    // no claim, picks the same job, and fills it a second time in a second tab.
    const urlIdx = process.argv.indexOf('--url');
    const noteIdx = process.argv.indexOf('--note');
    if (!arg) { console.error('park needs a job id (report number)'); process.exit(2); }
    holdForOpenTab(arg, {
      url: urlIdx !== -1 ? process.argv[urlIdx + 1] : undefined,
      note: noteIdx !== -1 ? process.argv[noteIdx + 1] : undefined,
    });
    console.log(JSON.stringify({ jobId: arg, parked: true, note: 'held while the tab stays open' }));
  } else if (cmd === 'release') {
    try { unlinkSync(claimPath(arg)); console.log(`released ${arg}`); } catch { console.log(`no claim for ${arg}`); }
  } else {
    console.log('usage: node lib/job-claim.mjs <list|parked|sweep|claim ID [--resume|--hold-tab]|park ID [--url U] [--note N]|release ID>');
    process.exit(2);
  }
}
