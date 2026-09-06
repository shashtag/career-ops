#!/usr/bin/env node

/**
 * rank-queue.mjs — Dynamic Multi-Metric Priority Ranker for Career-Ops
 *
 * Implements the Composite Priority Score (CPS) formula:
 *   CPS = S_eval * M_recency * M_cap * M_trust * M_comp
 *
 * Designed for continuous 1-job-per-hour dispatch and 4x daily rescan workflows.
 *
 * Usage:
 *   node rank-queue.mjs                   # View ranked pending queue table
 *   node rank-queue.mjs --next            # Output the #1 priority job for this hour
 *   node rank-queue.mjs --reorder-pipeline # Re-sort data/pipeline.md by CPS
 *   node rank-queue.mjs --json            # Output ranked queue as JSON
 *   node rank-queue.mjs --limit 20        # Show top 20 jobs (default: 15)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_PATH = path.join(ROOT, 'data', 'applications.md');
const SCAN_RUNS_PATH = path.join(ROOT, 'data', 'scan-runs.tsv');

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
export function calculateJobPriority(job, companyCounts, now = Date.now()) {
  const baseScore = job.explicitScore !== null ? job.explicitScore : estimateBaseScore(job.title, job.company);

  // 1. Recency Multiplier (M_recency)
  let recencyMultiplier = 0.90; // Default if undated
  let ageHours = null;
  let ageDisplay = 'Undated';

  if (job.postedDate) {
    const diffMs = now - job.postedDate.getTime();
    ageHours = Math.max(0, diffMs / (1000 * 60 * 60));
    const ageDays = ageHours / 24;

    if (ageHours <= 24) {
      recencyMultiplier = 1.25; // Tier 1: < 24h Urgent
      ageDisplay = `${Math.round(ageHours)}h ago (<24h)`;
    } else if (ageHours <= 72) {
      recencyMultiplier = 1.10; // Tier 2: 24-72h Hot
      ageDisplay = `${Math.round(ageDays)}d ago (<72h)`;
    } else if (ageDays <= 7) {
      recencyMultiplier = 1.00; // Tier 3: 3-7d Active
      ageDisplay = `${Math.round(ageDays)}d ago (<7d)`;
    } else {
      recencyMultiplier = 0.80; // Tier 4: > 7d Saturated
      ageDisplay = `${Math.round(ageDays)}d ago (>7d)`;
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

  // Composite Priority Score
  const cps = baseScore * recencyMultiplier * capMultiplier * trustMultiplier * compMultiplier;

  return {
    ...job,
    baseScore,
    ageHours,
    ageDisplay,
    appCount: currentAppCount,
    multipliers: {
      recency: recencyMultiplier,
      cap: capMultiplier,
      trust: trustMultiplier,
      comp: compMultiplier,
    },
    cps: Math.round(cps * 100) / 100,
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

  // Sort descending by CPS, then by recency, then by baseScore
  parsedJobs.sort((a, b) => {
    if (b.cps !== a.cps) return b.cps - a.cps;
    const aTime = a.postedDate ? a.postedDate.getTime() : 0;
    const bTime = b.postedDate ? b.postedDate.getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return b.baseScore - a.baseScore;
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

function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const isNext = args.includes('--next');
  const isReorder = args.includes('--reorder-pipeline');

  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;

  const ranked = getRankedPipeline();

  if (isJson) {
    console.log(JSON.stringify(ranked, null, 2));
    return;
  }

  if (isNext) {
    const scanInfo = getLastScanInfo();
    const top = ranked.find(j => j.cps > 0);
    if (!top) {
      console.log('No valid unblocked jobs to dispatch.');
      process.exit(1);
    }
    console.log(`RESCAN_RECOMMENDED=${scanInfo.isStale ? 'true' : 'false'}`);
    console.log(`LAST_SCAN_AGE=${scanInfo.display}`);
    console.log(`NEXT_JOB_URL=${top.url}`);
    console.log(`NEXT_JOB_COMPANY=${top.company}`);
    console.log(`NEXT_JOB_TITLE=${top.title}`);
    console.log(`NEXT_JOB_CPS=${top.cps}`);
    console.log(`NEXT_JOB_BASE=${top.baseScore}`);
    console.log(`NEXT_JOB_AGE=${top.ageDisplay}`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
