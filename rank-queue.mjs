#!/usr/bin/env node

/**
 * rank-queue.mjs — Dynamic Multi-Metric Priority Ranker for Career-Ops
 *
 * Implements the Composite Priority Score (CPS) formula:
 *   CPS = S_eval * M_recency * M_cap * M_trust * M_comp
 *              * M_remote * M_tier * M_geo * M_visa * M_desperation
 *
 * Designed for continuous 1-job-per-hour dispatch and 4x daily rescan workflows.
 *
 * The five multipliers after M_comp encode stated candidate preferences and are
 * configured in `config/profile.yml` (`company_tiers`, `ranking`) rather than here,
 * because they are user data and this file is system-layer (see DATA_CONTRACT.md).
 *
 * M_desperation deserves a note. A role that has been CONTINUOUSLY open for months is
 * a company that cannot fill it — less competition, more willingness to flex on
 * requirements. That is the opposite of a role REPEATEDLY REPOSTED under new URLs,
 * which signals a req refresh or a ghost job. Same-looking staleness, opposite meaning,
 * so they get opposite signs: continuously-open is a bonus, cycling-repost stays a
 * penalty under M_trust.
 *
 * Usage:
 *   node rank-queue.mjs                   # View ranked pending queue table
 *   node rank-queue.mjs --next            # Output the #1 priority job for this hour
 *   node rank-queue.mjs --reorder-pipeline # Re-sort data/pipeline.md by CPS
 *   node rank-queue.mjs --json            # Output ranked queue as JSON
 *   node rank-queue.mjs --limit 20        # Show top 20 jobs (default: 15)
 *   node rank-queue.mjs --lane=strike     # Only sub-48h postings (be-first lane)
 *   node rank-queue.mjs --lane=siege      # Only long-open survivors (desperation lane)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { claimJob, sweepStaleClaims, parkedClaims, fetchOpenTabUrls } from './lib/job-claim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_PATH = path.join(ROOT, 'data', 'applications.md');
const SCAN_RUNS_PATH = path.join(ROOT, 'data', 'scan-runs.tsv');
const SCAN_HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.tsv');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const BLACKLIST_PATH = path.join(ROOT, 'data', 'blacklist.md');

// ── Helpers ──────────────────────────────────────────────────────────

export function getLastScanInfo(now = Date.now()) {
  if (!existsSync(SCAN_RUNS_PATH)) return { ageHours: null, display: 'Never' };
  try {
    const lines = readFileSync(SCAN_RUNS_PATH, 'utf-8').trim().split('\n');
    if (lines.length <= 1) return { ageHours: null, display: 'Never' };
    const lastLine = lines[lines.length - 1];
    const tsStr = lastLine.split('\t')[0];
    const ts = Date.parse(tsStr);
    if (Number.isNaN(ts)) return { ageHours: null, display: 'Unknown' };
    const ageHours = Math.max(0, (now - ts) / (1000 * 60 * 60));
    return {
      timestamp: new Date(ts),
      ageHours: Math.round(ageHours * 10) / 10,
      display: ageHours < 1 ? `${Math.round(ageHours * 60)}m ago` : `${(Math.round(ageHours * 10) / 10)}h ago`,
      isStale: ageHours >= 4,
    };
  } catch {
    return { ageHours: null, display: 'Unknown' };
  }
}

export function normalizeCompany(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parses applications.md and counts active/applied/interview/rejected
 * applications per company within the last 30 days.
 */
export function getRecentCompanyCounts(days = 30, now = Date.now()) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const counts = new Map();

  if (!existsSync(APPLICATIONS_PATH)) return counts;

  const content = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.includes('|---|') || trimmed.includes('| # |')) {
      continue;
    }
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length < 7) continue;

    const dateStr = parts[2];
    const company = parts[3];
    const status = parts[6]?.toLowerCase() || '';

    if (!dateStr || !company) continue;

    // Skip non-counting statuses if any (e.g. pure discarded without submission)
    if (status === 'discarded' || status === 'skip') continue;

    const appDate = Date.parse(dateStr);
    if (!Number.isNaN(appDate) && appDate >= cutoff) {
      const key = normalizeCompany(company);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return counts;
}

// ── Scoring context (user-configured, loaded from config/profile.yml) ─────────

let _ctxCache = null;
let _pref = { priority: [], excludedLangs: [], negativeTitles: [], blacklist: [] };

/**
 * Loads company tiers, lane policy, and derived signals used by the new multipliers.
 * Cached per process; pass `force` in tests.
 */
export function loadScoringContext(force = false) {
  if (_ctxCache && !force) return _ctxCache;

  let tiers = [];
  let ranking = { strike_max_age_hours: 48, siege_min_age_days: 60, daily_application_budget: 24, siege_min_pct: 15 };
  try {
    const p = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
    const ct = p.company_tiers || {};
    tiers = Object.entries(ct)
      .filter(([, v]) => v && Array.isArray(v.companies) && v.companies.length)
      .map(([name, v]) => ({
        name,
        multiplier: Number(v.multiplier) || 1.0,
        needles: v.companies.map(c => String(c).toLowerCase().trim()).filter(Boolean),
      }))
      // Highest multiplier wins when a company appears in more than one tier.
      .sort((a, b) => b.multiplier - a.multiplier);
    if (p.ranking) ranking = { ...ranking, ...p.ranking };
    _pref = {
      priority: (p.priority_companies || []).map(c => String(c).toLowerCase().trim()).filter(Boolean),
      excludedLangs: (p.hard_skill_prescreen?.excluded_languages || []).map(s => String(s).toLowerCase().trim()).filter(Boolean),
    };
  } catch { /* profile missing or malformed → neutral tiers */ }

  // Negative title filters already curated in portals.yml — a role the scanner would
  // have rejected on title should not win the queue just because it slipped in.
  try {
    const pf = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    _pref.negativeTitles = (pf.title_filter?.negative || [])
      .map(s => String(s).toLowerCase().trim()).filter(Boolean);
  } catch { _pref.negativeTitles = []; }

  // Curated company names, used to label a posting's provenance. Deliberately NOT a
  // scoring input: measured 2026-09-10, curated boards had a 12% applyable rate vs 77%
  // for the unvetted reverse-ATS sweep, so "curated" is not evidence of quality. It
  // matters for LEGITIMACY instead — nobody has ever eyeballed a company that surfaced
  // from a blind sweep of every ATS tenant.
  try {
    const pf2 = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    _pref.trackedCompanies = new Set((pf2.tracked_companies || [])
      .map(c => String(c?.name || '').toLowerCase().trim()).filter(Boolean));
  } catch { _pref.trackedCompanies = new Set(); }

  // Do-not-apply companies. Opt-in file; absent means no blacklist.
  try {
    _pref.blacklist = readFileSync(BLACKLIST_PATH, 'utf-8')
      .split('\n')
      .map(l => l.replace(/^[-*|\s]+/, '').split('|')[0].trim().toLowerCase())
      .filter(l => l && !l.startsWith('#') && l.length > 1);
  } catch { _pref.blacklist = []; }

  // first_seen per URL + volume-hiring counts + per-portal watch-start, all from scan-history.
  const firstSeen = new Map();
  const volume = new Map();
  const portalOf = new Map();
  const portalWatchStart = new Map();
  try {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').trim().split('\n');
    const cols = lines[0].split('\t');
    const iUrl = cols.indexOf('url');
    const iSeen = cols.indexOf('first_seen');
    const iCompany = cols.indexOf('company');
    const iTitle = cols.indexOf('title');
    const iStatus = cols.indexOf('status');
    const iPortal = cols.indexOf('portal');
    for (const line of lines.slice(1)) {
      const p = line.split('\t');
      if (iUrl >= 0 && iSeen >= 0 && p[iUrl] && p[iSeen]) {
        const u = p[iUrl].trim();
        const seen = p[iSeen].trim();
        firstSeen.set(u, seen);
        if (iPortal >= 0 && p[iPortal]) {
          const portal = p[iPortal].trim();
          portalOf.set(u, portal);
          // Earliest date we ever saw this portal = when we started watching it.
          const prev = portalWatchStart.get(portal);
          if (!prev || seen < prev) portalWatchStart.set(portal, seen);
        }
      }
      if (iCompany >= 0 && iTitle >= 0 && p[iStatus] === 'added') {
        const key = `${(p[iCompany] || '').toLowerCase().trim()}||${(p[iTitle] || '').toLowerCase().trim()}`;
        if (!volume.has(key)) volume.set(key, new Set());
        volume.get(key).add(p[iUrl]);
      }
    }
  } catch { /* no history yet */ }

  _ctxCache = { tiers, ranking, firstSeen, volume, portalOf, portalWatchStart, pref: _pref };
  return _ctxCache;
}

/**
 * Deterministic, portal-neutral tiebreak key (FNV-1a over the URL).
 *
 * 98% of the queue shares a CPS with at least one other job — only ~84 distinct scores
 * across 1,500 postings — so the tiebreak decides most of the real ordering. Array.sort
 * is stable, which means ties previously resolved to pipeline.md line order, i.e.
 * insertion order, i.e. scan order, i.e. position in portals.yml. That handed a
 * permanent advantage to whichever board happened to be scanned first, for reasons
 * having nothing to do with job quality. Hashing the URL removes the advantage while
 * staying deterministic, so the queue does not reshuffle between runs.
 */
export function tiebreakKey(url) {
  let h = 0x811c9dc5;
  const s = String(url || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const REMOTE_RE = /\b(remote|anywhere|distributed|work from home|wfh)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const INDIA_RE = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurgaon|gurugram|chennai|kolkata)\b/i;
// Only an EXPLICIT refusal gates the job to zero. Silence on sponsorship is a
// signal to evaluate, not a dealbreaker — see modes/_profile.md location policy.
const NO_SPONSOR_RE = /\b(no (visa )?sponsorship|not (able|be able) to sponsor|cannot sponsor|without sponsorship|must (already )?have (the )?(existing )?right to work|must be (legally )?authorized to work in the (us|u\.s\.|united states)( without)?|us citizens? only|citizenship required|security clearance required)\b/i;

/**
 * Location/eligibility multipliers. Returns { remote, geo, visa, labels }.
 */
export function evaluatePlacement(job) {
  const loc = job.location || '';
  const hay = `${loc} ${job.rawLine || ''}`;
  const labels = [];

  const isRemote = REMOTE_RE.test(loc);
  const isHybrid = !isRemote && HYBRID_RE.test(hay);
  const remote = isRemote ? 1.15 : isHybrid ? 1.02 : 1.0;
  if (isRemote) labels.push('remote');
  else if (isHybrid) labels.push('hybrid');

  // Foreign is slightly preferred; a foreign REMOTE role is the ideal case because
  // it delivers the international role without needing a visa at all, and the
  // multiplication of the two multipliers already expresses that.
  const isIndia = INDIA_RE.test(loc);
  const isForeign = !isIndia && loc.trim().length > 0;
  const geo = isForeign ? 1.05 : 1.0;
  if (isForeign) labels.push('intl');

  // Hard gate: explicit refusal to sponsor, on a role that is not remote and not in India.
  let visa = 1.0;
  if (NO_SPONSOR_RE.test(hay) && !isRemote && !isIndia) {
    visa = 0.0;
    labels.push('NO-SPONSOR');
  }

  return { remote, geo, visa, labels };
}

/**
 * Desperation signals: a company that visibly cannot fill a role is an easier target.
 */
export function evaluateDesperation(job, ctx, now) {
  const reasons = [];
  let m = 1.0;

  // 1. Continuously open. Age is measured from first_seen because posted_at is not
  //    persisted in the legacy scan-history format. first_seen is a LOWER BOUND on
  //    true age, so this under-claims rather than over-claims.
  const seen = ctx.firstSeen.get(job.url);
  let knownDays = null;
  if (seen && /^\d{4}-\d{2}-\d{2}$/.test(seen)) {
    knownDays = Math.floor((now - Date.parse(`${seen}T00:00:00Z`)) / 86400000);
    const minDays = ctx.ranking.siege_min_age_days ?? 60;
    if (knownDays >= minDays) {
      m *= 1.15;
      reasons.push(`open ${knownDays}d`);
    }
  }

  // 2. Volume hiring: many concurrent reqs for one title means a broken funnel and a
  //    lower per-hire bar.
  const key = `${(job.company || '').toLowerCase().trim()}||${(job.title || '').toLowerCase().trim()}`;
  const openings = ctx.volume.get(key)?.size ?? 0;
  if (openings >= 3) {
    m *= 1.10;
    reasons.push(`${openings} openings`);
  }

  return { multiplier: Math.round(m * 1000) / 1000, knownDays, openings, reasons };
}

/**
 * Estimates baseline evaluation score if an explicit score is not yet recorded.
 */
export function estimateBaseScore(title, company) {
  const lowerTitle = (title || '').toLowerCase();

  // Tier 1 Primary Tech & Archetypes: Frontend, React, Next.js, Full Stack, Backend Go, Systems, FDE, AI
  if (
    lowerTitle.includes('react') ||
    lowerTitle.includes('next.js') ||
    lowerTitle.includes('frontend') ||
    lowerTitle.includes('front-end') ||
    lowerTitle.includes('full stack') ||
    lowerTitle.includes('fullstack') ||
    lowerTitle.includes('full-stack') ||
    lowerTitle.includes('forward deployed') ||
    lowerTitle.includes('go') ||
    lowerTitle.includes('golang') ||
    lowerTitle.includes('distributed') ||
    lowerTitle.includes('ai engineer') ||
    lowerTitle.includes('applied ai') ||
    lowerTitle.includes('agentic')
  ) {
    return 4.2;
  }

  // Tier 2: SRE, Platform, Systems, Microservices, Python/Data
  if (
    lowerTitle.includes('platform') ||
    lowerTitle.includes('sre') ||
    lowerTitle.includes('reliability') ||
    lowerTitle.includes('devops') ||
    lowerTitle.includes('infrastructure') ||
    lowerTitle.includes('backend') ||
    lowerTitle.includes('software engineer')
  ) {
    return 4.0;
  }

  // Tier 3: Solutions Architect, Integration
  if (lowerTitle.includes('architect') || lowerTitle.includes('solutions')) {
    return 3.7;
  }

  return 3.5;
}

/**
 * Parses a single pipeline.md pending line into a structured job item.
 */
export function parsePipelineLine(rawLine) {
  const line = rawLine.trim();
  if (!line.startsWith('- [ ]')) return null;

  const content = line.slice(5).trim();
  const segments = content.split('|').map(s => s.trim());

  const url = segments[0] || '';
  let company = '';
  let title = '';
  let location = '';
  let compensation = '';
  let postedDate = null;
  let note = '';
  let explicitScore = null;

  // Extract labeled tags first: posted: YYYY-MM-DD, note: ..., Score: X.X/5
  const positionalSegments = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.toLowerCase().startsWith('posted:')) {
      const dStr = seg.slice(7).trim();
      const ts = Date.parse(dStr);
      if (!Number.isNaN(ts)) postedDate = new Date(ts);
    } else if (seg.toLowerCase().startsWith('note:')) {
      note = seg.slice(5).trim();
    } else if (/score:\s*(\d+(?:\.\d+)?)\s*\/\s*5/i.test(seg)) {
      const match = seg.match(/score:\s*(\d+(?:\.\d+)?)\s*\/\s*5/i);
      if (match) explicitScore = parseFloat(match[1]);
    } else if (/^(\d+(?:\.\d+)?)\s*\/\s*5$/.test(seg)) {
      const match = seg.match(/^(\d+(?:\.\d+)?)\s*\/\s*5$/);
      if (match) explicitScore = parseFloat(match[1]);
    } else {
      positionalSegments.push(seg);
    }
  }

  if (positionalSegments.length >= 1) company = positionalSegments[0];
  if (positionalSegments.length >= 2) title = positionalSegments[1];
  if (positionalSegments.length >= 3) location = positionalSegments[2];
  if (positionalSegments.length >= 4) compensation = positionalSegments[3];

  return {
    rawLine,
    url,
    company,
    title,
    location,
    compensation,
    postedDate,
    note,
    explicitScore,
  };
}

/**
 * Computes the Multi-Metric Composite Priority Score for a job.
 */
export function calculateJobPriority(job, companyCounts, now = Date.now(), ctx = null) {
  const context = ctx || loadScoringContext();
  const baseScore = job.explicitScore !== null ? job.explicitScore : estimateBaseScore(job.title, job.company);

  // 1. Recency Multiplier (M_recency)
  let recencyMultiplier = 0.90; // Default if undated
  let ageHours = null;
  let ageDisplay = 'Undated';
  let inferredAge = false;

  // Posting dates are not uniformly available: measured 2026-09-10, amazon-api and
  // ashby-full expose them for 100% of postings, workday-api 64%, greenhouse-api 51%,
  // lever-api 24%, workable-api 0%. Undated postings default to 0.90 and therefore can
  // NEVER enter the strike lane — so a genuinely two-hour-old Lever role was invisible
  // to the be-first system purely because of its provider's API shape.
  //
  // Fall back to first_seen, which is portal-neutral, but ONLY once we have been
  // watching that portal for longer than the posting has existed in our history.
  // Otherwise a newly-added board's initial bulk load — where every posting gets
  // first_seen = today — would flood the strike lane with roles that are actually
  // months old, replacing one bias with a worse one. Inferred freshness is also capped
  // below the top tier: only a real posting date earns the 1.50 "urgent" multiplier.
  if (!job.postedDate) {
    const seen = context.firstSeen?.get(job.url);
    const portal = context.portalOf?.get(job.url);
    const watchStart = portal ? context.portalWatchStart?.get(portal) : null;
    if (seen && watchStart && seen > watchStart) {
      const t = Date.parse(`${seen}T00:00:00Z`);
      if (!Number.isNaN(t)) {
        job = { ...job, postedDate: new Date(t) };
        inferredAge = true;
      }
    }
  }

  if (job.postedDate) {
    const diffMs = now - job.postedDate.getTime();
    ageHours = Math.max(0, diffMs / (1000 * 60 * 60));
    const ageDays = ageHours / 24;

    // Spread is deliberately wide. With the tier/remote/desperation multipliers stacked,
    // a narrow spread let a 100-day-old role at a strong company outrank a same-day
    // posting — the exact inversion of the "apply early" goal. Recency must dominate.
    if (ageHours <= 24) {
      // Inferred (first_seen) freshness is capped at the 24-72h tier: day-granular
      // discovery cannot prove a posting is hours old, only that it is new to us.
      recencyMultiplier = inferredAge ? 1.25 : 1.50;
      ageDisplay = inferredAge ? '~1d ago (inferred)' : `${Math.round(ageHours)}h ago (<24h)`;
    } else if (ageHours <= 72) {
      recencyMultiplier = 1.25; // 24-72h Hot
      ageDisplay = `${Math.round(ageDays)}d ago (<72h)`;
    } else if (ageDays <= 7) {
      recencyMultiplier = 1.00; // 3-7d Active
      ageDisplay = `${Math.round(ageDays)}d ago (<7d)`;
    } else if (ageDays <= 30) {
      recencyMultiplier = 0.70; // 7-30d Saturated
      ageDisplay = `${Math.round(ageDays)}d ago (>7d)`;
    } else {
      recencyMultiplier = 0.55; // >30d — only worth it on desperation signals
      ageDisplay = `${Math.round(ageDays)}d ago (>30d)`;
    }
  }

  // 2. Company Cap Multiplier (M_cap)
  const compKey = normalizeCompany(job.company);
  const currentAppCount = companyCounts.get(compKey) || 0;
  let capMultiplier = 1.00;

  if (currentAppCount === 0) {
    capMultiplier = 1.00;
  } else if (currentAppCount === 1) {
    capMultiplier = 0.90;
  } else {
    capMultiplier = 0.00; // Capped (>= 2 in last 30d)
  }

  // 3. Trust / Legitimacy Multiplier (M_trust)
  let trustMultiplier = 1.00;
  const rawLower = job.rawLine.toLowerCase();
  if (
    rawLower.includes('dealbreaker') ||
    rawLower.includes('skip') ||
    rawLower.includes('closed') ||
    rawLower.includes('expired')
  ) {
    trustMultiplier = 0.00;
  } else if (rawLower.includes('warning') || rawLower.includes('repost')) {
    trustMultiplier = 0.80;
  }

  // 4. Comp Multiplier (M_comp)
  let compMultiplier = 1.00;
  if (job.compensation && (job.compensation.includes('LPA') || job.compensation.includes('USD') || job.compensation.includes('$'))) {
    compMultiplier = 1.05;
  }

  // 5. Placement: remote / geography / visa eligibility
  const placement = evaluatePlacement(job);

  // 6. Company tier (FAANG-GAANG + frontier labs, then elite scale-ups)
  const companyLower = (job.company || '').toLowerCase();
  let tierMultiplier = 1.0;
  let tierName = 'standard';
  if (companyLower) {
    for (const tier of context.tiers) {
      if (tier.needles.some(n => companyLower.includes(n))) {
        tierMultiplier = tier.multiplier;
        tierName = tier.name;
        break; // tiers are pre-sorted by multiplier, so the best match wins
      }
    }
  }

  // 7. Desperation (continuously open / volume hiring)
  const desperation = evaluateDesperation(job, context, now);

  // 8. Preferences already curated in the repo. These existed before CPS and were
  //    being ignored by it, which meant the ranker could surface a blacklisted
  //    company or a Java role the scanner's own title filter would have rejected.
  const pref = context.pref || { priority: [], excludedLangs: [], negativeTitles: [], blacklist: [] };
  const titleLower = (job.title || '').toLowerCase();
  let prefMultiplier = 1.0;
  const prefLabels = [];

  if (pref.blacklist.length && pref.blacklist.some(b => companyLower.includes(b))) {
    prefMultiplier = 0.0;
    prefLabels.push('BLACKLIST');
  } else {
    if (pref.priority.some(c => companyLower.includes(c))) {
      prefMultiplier *= 1.25;
      prefLabels.push('priority-co');
    }
    // Excluded stacks are a pre-screen, not a ban: the title is only a hint, and a
    // "Senior Engineer (Java)" posting may still be polyglot. Penalise hard, gate never.
    if (pref.excludedLangs.some(l => titleLower.includes(l))) {
      prefMultiplier *= 0.35;
      prefLabels.push('excluded-stack');
    }
    if (pref.negativeTitles.some(n => titleLower.includes(n))) {
      prefMultiplier *= 0.30;
      prefLabels.push('neg-title');
    }
  }

  // Provenance label. NOT a multiplier — see loadScoringContext. Downstream evaluation
  // uses it to decide how hard to scrutinise Block G (Posting Legitimacy): a company
  // nobody ever vetted needs its existence, funding and comp confirmed before applying.
  const portalId = context.portalOf?.get(job.url) || '';
  let sourceType = 'aggregator';
  if (portalId.endsWith('-full')) {
    sourceType = 'discovered-unvetted';
  } else if (context.pref?.trackedCompanies?.size) {
    const c = companyLower.trim();
    for (const t of context.pref.trackedCompanies) {
      if (c && (c.includes(t) || t.includes(c))) { sourceType = 'curated'; break; }
    }
  }

  const cps = baseScore * recencyMultiplier * capMultiplier * trustMultiplier * compMultiplier
    * placement.remote * placement.geo * placement.visa * tierMultiplier * desperation.multiplier
    * prefMultiplier;

  // Lane assignment drives the 70/30 strike-vs-siege application budget.
  const strikeMaxH = context.ranking.strike_max_age_hours ?? 48;
  const siegeMinD = context.ranking.siege_min_age_days ?? 60;
  let lane = 'backlog';
  if (ageHours !== null && ageHours <= strikeMaxH) lane = 'strike';
  else if (desperation.knownDays !== null && desperation.knownDays >= siegeMinD) lane = 'siege';

  return {
    ...job,
    baseScore,
    ageHours,
    ageDisplay,
    appCount: currentAppCount,
    lane,
    tierName,
    inferredAge,
    sourceType,
    knownDays: desperation.knownDays,
    openings: desperation.openings,
    signals: [...placement.labels, ...desperation.reasons, ...prefLabels],
    multipliers: {
      recency: recencyMultiplier,
      cap: capMultiplier,
      trust: trustMultiplier,
      comp: compMultiplier,
      remote: placement.remote,
      geo: placement.geo,
      visa: placement.visa,
      tier: tierMultiplier,
      desperation: desperation.multiplier,
      pref: Math.round(prefMultiplier * 1000) / 1000,
    },
    cps: Math.round(cps * 100) / 100,
  };
}

/**
 * Allocates the day's application budget across lanes, STRIKE-FIRST.
 *
 * Strike is perishable and siege is not: a 6-hour-old posting is not fresh tomorrow,
 * while a role that has been open 110 days will still be open next week. So strike
 * takes every slot it can use and siege absorbs the remainder, rather than strike
 * being capped at a fixed percentage while it sits idle.
 *
 * `minScore` mirrors the apply gate in AGENTS.md — below 4.0 the guidance is to
 * recommend against applying, so those roles do not consume budget.
 */
export function planDay(ranked, opts = {}) {
  const ctx = loadScoringContext();
  const budget = opts.budget ?? ctx.ranking.daily_application_budget ?? 24;
  const siegeMinPct = opts.siegeMinPct ?? ctx.ranking.siege_min_pct ?? 15;
  const minScore = opts.minScore ?? 4.0;

  const eligible = ranked.filter(j => j.cps > 0 && j.baseScore >= minScore);
  const strike = eligible.filter(j => j.lane === 'strike');
  const siege = eligible.filter(j => j.lane === 'siege');
  const backlog = eligible.filter(j => j.lane === 'backlog');

  // Floor protects the long-open lane from being starved by a burst of fresh postings.
  const siegeFloor = Math.max(0, Math.round((budget * siegeMinPct) / 100));
  const strikeTake = Math.min(strike.length, budget - Math.min(siegeFloor, siege.length));
  const siegeTake = Math.min(siege.length, budget - strikeTake);
  const backlogTake = Math.min(backlog.length, budget - strikeTake - siegeTake);

  return {
    budget,
    minScore,
    supply: { strike: strike.length, siege: siege.length, backlog: backlog.length },
    allocation: { strike: strikeTake, siege: siegeTake, backlog: backlogTake },
    unused: Math.max(0, budget - strikeTake - siegeTake - backlogTake),
    // Strike can only saturate if fresh applyable arrivals exceed the whole budget.
    strikeSaturated: strike.length > budget,
    picks: [...strike.slice(0, strikeTake), ...siege.slice(0, siegeTake), ...backlog.slice(0, backlogTake)],
  };
}

/**
 * Loads and ranks all pending jobs from data/pipeline.md.
 */
export function getRankedPipeline(now = Date.now()) {
  if (!existsSync(PIPELINE_PATH)) {
    return [];
  }

  const content = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = content.split('\n');

  const pendingLines = [];
  let inPending = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && (trimmed.toLowerCase().includes('pending') || trimmed.toLowerCase().includes('pendientes'))) {
      inPending = true;
      continue;
    }
    if (trimmed.startsWith('#') && (trimmed.toLowerCase().includes('processed') || trimmed.toLowerCase().includes('procesados'))) {
      inPending = false;
      continue;
    }
    if (trimmed.startsWith('- [ ]')) {
      pendingLines.push(line);
    }
  }

  const companyCounts = getRecentCompanyCounts(30, now);

  const parsedJobs = pendingLines
    .map(parsePipelineLine)
    .filter(Boolean)
    .map(job => calculateJobPriority(job, companyCounts, now));

  // Sort descending by CPS, then by expiry urgency, then by baseScore.
  //
  // The middle tiebreak is earliest-deadline-first and applies only WITHIN the strike
  // lane: when two fresh postings score the same, take the one closer to aging out of
  // the 48h window, since the other one will still be in-window on the next dispatch.
  // It is a tiebreaker rather than a multiplier on purpose — as a multiplier it would
  // let a mediocre expiring job outrank a strong brand-new one, which is the same
  // inversion the recency spread was widened to prevent.
  parsedJobs.sort((a, b) => {
    if (b.cps !== a.cps) return b.cps - a.cps;
    if (a.lane === 'strike' && b.lane === 'strike') {
      const aAge = a.ageHours ?? 0;
      const bAge = b.ageHours ?? 0;
      if (aAge !== bAge) return bAge - aAge; // older-within-window first: it expires sooner
    }
    const aTime = a.postedDate ? a.postedDate.getTime() : 0;
    const bTime = b.postedDate ? b.postedDate.getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    // Portal-neutral final tiebreak — never fall through to file order.
    return tiebreakKey(a.url) - tiebreakKey(b.url);
  });

  return parsedJobs;
}

/**
 * Formats ranked jobs into a clean CLI table.
 */
export function formatRankedTable(jobs, limit = 15, now = Date.now()) {
  if (jobs.length === 0) {
    return 'No pending jobs in data/pipeline.md';
  }

  const scanInfo = getLastScanInfo(now);
  const scanStatus = scanInfo.isStale
    ? `⚠️ Last scan was **${scanInfo.display}** (Rescan recommended: run \`node scan.mjs\`)`
    : `✅ Portals fresh (scanned **${scanInfo.display}**)`;

  const rows = jobs.slice(0, limit);
  const header = '| Rank | CPS | Base | Age / Window | Cap | Company | Role | URL |';
  const sep = '|---|---|---|---|---|---|---|---|';

  const body = rows.map((j, idx) => {
    const rankStr = `#${idx + 1}`;
    const cpsStr = j.cps > 0 ? `**${j.cps.toFixed(2)}**` : `~~${j.cps.toFixed(2)}~~`;
    const baseStr = `${j.baseScore.toFixed(1)}/5`;
    const capStr = `${j.appCount}/2`;
    const companyStr = j.company || '—';
    const roleStr = j.title || '—';
    const urlStr = j.url.length > 35 ? j.url.slice(0, 32) + '...' : j.url;

    return `| ${rankStr} | ${cpsStr} | ${baseStr} | ${j.ageDisplay} | ${capStr} | ${companyStr} | ${roleStr} | [Link](${j.url}) |`;
  }).join('\n');

  return `### Dynamic Hourly Dispatch Queue (Top ${rows.length}/${jobs.length} Pending Roles)\n${scanStatus}\n\n${header}\n${sep}\n${body}\n`;
}

// ── CLI Runner ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const isNext = args.includes('--next');
  const isReorder = args.includes('--reorder-pipeline');

  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;

  const laneArg = args.find(a => a.startsWith('--lane='));
  const lane = laneArg ? laneArg.split('=')[1] : null;

  let ranked = getRankedPipeline();

  if (args.includes('--plan-day')) {
    const plan = planDay(ranked);
    if (isJson) { console.log(JSON.stringify(plan, null, 2)); return; }
    console.log(`\nDaily plan — budget ${plan.budget} applications, apply gate ${plan.minScore}/5\n`);
    console.log(`  lane      eligible   allocated`);
    console.log(`  strike    ${String(plan.supply.strike).padStart(8)}   ${plan.allocation.strike}`);
    console.log(`  siege     ${String(plan.supply.siege).padStart(8)}   ${plan.allocation.siege}`);
    console.log(`  backlog   ${String(plan.supply.backlog).padStart(8)}   ${plan.allocation.backlog}`);
    if (plan.unused > 0) {
      console.log(`\n  ⚠️  ${plan.unused} slot(s) unused — supply-limited, not throughput-limited.`);
      console.log(`      Widen portals.yml title_filter or add companies to scan_tiers.hot.`);
    }
    if (plan.strikeSaturated) {
      console.log(`\n  ⚠️  strike lane exceeds the whole daily budget — fresh roles WILL age out.`);
      console.log(`      Raise daily_application_budget or the apply gate.`);
    }
    console.log('');
    plan.picks.slice(0, 15).forEach((j, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${String(j.cps).padStart(5)} [${j.lane}] ${j.company} — ${(j.title || '').slice(0, 46)}`));
    return;
  }

  if (lane) ranked = ranked.filter(j => j.lane === lane);

  if (isJson) {
    console.log(JSON.stringify(ranked, null, 2));
    return;
  }

  if (isNext) {
    const scanInfo = getLastScanInfo();

    // Concurrency is solved by an ATOMIC CLAIM, not by randomising the pick.
    //
    // Randomly choosing among the top K only *reduces* the collision probability
    // (two agents over 10 candidates still collide ~10% of the time, and it gets worse
    // as agents are added) while also costing quality, because you sometimes take the
    // 7th-best job for no reason. claimJob() writes its sentinel with O_CREAT|O_EXCL,
    // so exactly one caller can ever hold a job: agent A takes #1, agent B is refused
    // and takes #2. Zero collisions AND both get the best job still available.
    //
    // --jitter=N is offered for the case a claim cannot solve: many agents contending
    // on an identical ordering all fail-and-retry down the same list. It is opt-in and
    // still claims, so it trades a little rank quality for less contention, never
    // correctness.
    const jitterArg = args.find(a => a.startsWith('--jitter='));
    const jitter = jitterArg ? Math.max(1, parseInt(jitterArg.split('=')[1], 10) || 1) : 1;
    const noClaim = args.includes('--no-claim');

    let openUrls = null;
    if (!noClaim) {
      try { sweepStaleClaims(null); } catch { /* claim dir may not exist yet */ }
      try { openUrls = await fetchOpenTabUrls(1500); } catch { openUrls = null; }
    }

    // Unfinished work first: a parked form only needs its submit step, so starting
    // something new while one sits there wastes the work already done.
    if (!noClaim) {
      try {
        const parked = parkedClaims(openUrls);
        if (parked.length) {
          console.log(`PARKED_JOBS=${parked.length}`);
          console.log(`PARKED_FIRST_URL=${parked[0].url || parked[0].jobId}`);
        }
      } catch { /* non-fatal */ }
    }

    const eligible = ranked.filter(j => j.cps > 0);
    if (!eligible.length) {
      console.log('No valid unblocked jobs to dispatch.');
      process.exit(1);
    }

    let chosen = null;
    let claimed = null;
    if (noClaim) {
      chosen = eligible[0];
    } else {
      // Walk down the ranking, take the first job we can actually claim. With
      // --jitter=N, sample from the next N unclaimed candidates instead of the head.
      const pool = jitter > 1 ? eligible.slice(0, Math.min(jitter, eligible.length)) : eligible;
      const order = jitter > 1
        ? pool.map((j, i) => ({ j, r: Math.random(), i })).sort((a, b) => a.r - b.r).map(x => x.j).concat(eligible.slice(pool.length))
        : eligible;
      for (const cand of order) {
        const res = claimJob(cand.url, { url: cand.url, openUrls, note: `${cand.company} — ${cand.title}` });
        if (res.ok) { chosen = cand; claimed = res; break; }
      }
      if (!chosen) {
        console.log('No unclaimed jobs available — every candidate is held by another run.');
        process.exit(1);
      }
    }

    console.log(`RESCAN_RECOMMENDED=${scanInfo.isStale ? 'true' : 'false'}`);
    console.log(`LAST_SCAN_AGE=${scanInfo.display}`);
    console.log(`NEXT_JOB_URL=${chosen.url}`);
    console.log(`NEXT_JOB_COMPANY=${chosen.company}`);
    console.log(`NEXT_JOB_TITLE=${chosen.title}`);
    console.log(`NEXT_JOB_CPS=${chosen.cps}`);
    console.log(`NEXT_JOB_BASE=${chosen.baseScore}`);
    console.log(`NEXT_JOB_AGE=${chosen.ageDisplay}`);
    console.log(`NEXT_JOB_LANE=${chosen.lane}`);
    console.log(`NEXT_JOB_SOURCE=${chosen.sourceType}`);
    console.log(`NEXT_JOB_CLAIMED=${claimed ? 'true' : 'false'}`);
    return;
  }

  if (isReorder) {
    if (!existsSync(PIPELINE_PATH)) {
      console.error(`File not found: ${PIPELINE_PATH}`);
      process.exit(1);
    }

    const content = readFileSync(PIPELINE_PATH, 'utf-8');
    const lines = content.split('\n');

    const beforePending = [];
    const afterPending = [];
    let state = 'before'; // 'before' | 'pending' | 'after'

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && (trimmed.toLowerCase().includes('pending') || trimmed.toLowerCase().includes('pendientes'))) {
        state = 'pending';
        beforePending.push(line);
        continue;
      }
      if (trimmed.startsWith('#') && (trimmed.toLowerCase().includes('processed') || trimmed.toLowerCase().includes('procesados'))) {
        state = 'after';
        afterPending.push(line);
        continue;
      }

      if (state === 'before') {
        beforePending.push(line);
      } else if (state === 'after') {
        afterPending.push(line);
      }
    }

    const sortedPendingLines = ranked.map(j => j.rawLine);
    const newContent = [
      ...beforePending,
      '',
      ...sortedPendingLines,
      '',
      ...afterPending,
    ].join('\n');

    writeFileSync(PIPELINE_PATH, newContent, 'utf-8');
    console.log(`Successfully reordered ${ranked.length} pending jobs in data/pipeline.md by CPS.`);
    return;
  }

  console.log(formatRankedTable(ranked, limit));
}

if (isMainModule(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
