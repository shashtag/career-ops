import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveStatus } from './statuses.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const CACHE_PATH = join(ROOT, 'data', 'company-caps.json');

// Bump when the cached shape changes; a cache without this version is ignored
// rather than read as the old shape.
const CACHE_VERSION = 2;

/**
 * Trailing tokens that name a legal form or a generic descriptor rather than
 * the company. Stripped from the END of a name only, so "Palo Alto Networks"
 * keeps "Networks" (not listed) and "Apple Bank" keeps "Bank" (not listed),
 * while "Sarvam AI" and "Temporal Technologies" collapse onto their roots.
 * @type {Set<string>}
 */
const GENERIC_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'plc', 'corp', 'corporation', 'co',
  'gmbh', 'sa', 'sas', 'bv', 'nv', 'ab', 'oy', 'pty', 'pvt', 'private',
  'holdings', 'group', 'labs', 'lab', 'ai', 'technologies', 'technology',
  'tech', 'systems', 'software', 'solutions',
]);

/**
 * Company names that are placeholders, not companies. Rows carrying one are
 * never cap-counted: "?" is the documented marker for an agency posting whose
 * end employer is unknown (#1596), and two such rows are usually two DIFFERENT
 * employers — counting them as one company would block an application the cap
 * policy allows.
 * @type {Set<string>}
 */
const PLACEHOLDER_NAMES = new Set(['', '?', 'unknown', 'n/a', 'tbd', '-', '—']);

/**
 * Canonical key for a company name, for cap counting.
 *
 * WHY THIS EXISTS. The cap is "2 roles per company per 30 days", and the
 * tracker spells one company several ways over time — `NVIDIA` and `Nvidia`,
 * `Sarvam AI` and `Sarvam`, `Temporal` and `Temporal Technologies`,
 * `Agoda` and `Agoda (Booking Holdings)`. Keying counts on the literal string
 * split those into separate companies, each reading 1/2 when the real count was
 * 2/2 — which is why modes/_run.md, _custom.md and _profile.md all told the
 * agent to recount by hand against a 330KB tracker on every run.
 *
 * Over-merging two genuinely different companies would block an application the
 * policy allows; under-merging lets a cap breach through. Both are bad, so the
 * suffix list is deliberately narrow and only trailing tokens are stripped.
 * Checked against all 205 distinct company spellings in this tracker: 8 groups
 * merge, and every one of them is the same company under two spellings.
 *
 * @param {string} name - Company name as written in a tracker row.
 * @returns {string} Normalized key; '' for a placeholder name.
 */
export function normalizeCompanyKey(name) {
  const raw = String(name ?? '').trim();
  if (PLACEHOLDER_NAMES.has(raw.toLowerCase())) return '';

  const flat = raw
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip diacritics
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')                          // "Agoda (Booking Holdings)"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const parts = flat.split(' ').filter(Boolean);
  while (parts.length > 1 && GENERIC_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && parts[0] === 'the') parts.shift();
  const key = parts.join('');
  return PLACEHOLDER_NAMES.has(key) ? '' : key;
}

/**
 * Statuses that do NOT consume a cap slot. Everything else does — `rejected`
 * included, because a rejection still used an application at that company
 * within the window.
 * @type {Set<string>}
 */
const NON_CONSUMING = new Set(['skip', 'discarded', 'evaluated']);

/**
 * Company cap counts over the last `days`, keyed by normalized company.
 *
 * @param {number} [limit=2] - Cap per company (carried through for callers).
 * @param {number} [days=30] - Window length.
 * @returns {Record<string, {name: string, count: number, variants: string[],
 *   rows: Array<{date: string, status: string, role: string, num: string}>,
 *   last_updated: string}>}
 */
export function getCompanyCaps(limit = 2, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // 1. Cache, when it is fresh AND written by this version of the shape.
  try {
    if (existsSync(CACHE_PATH) && existsSync(APPLICATIONS_PATH)) {
      const cacheStat = statSync(CACHE_PATH);
      const appsStat = statSync(APPLICATIONS_PATH);
      const pipeStat = existsSync(PIPELINE_PATH) ? statSync(PIPELINE_PATH) : null;
      const pipeMtime = pipeStat ? pipeStat.mtimeMs : 0;
      const cacheAgeMs = Date.now() - cacheStat.mtimeMs;

      if (cacheStat.mtimeMs > appsStat.mtimeMs && cacheStat.mtimeMs > pipeMtime && cacheAgeMs < 4 * 60 * 60 * 1000) {
        const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
        if (cached && cached.__version === CACHE_VERSION && cached.__window === `${limit}/${days}` && cached.entries) {
          return cached.entries;
        }
      }
    }
  } catch {
    // Ignore cache read errors — recompute below.
  }

  // 2. Recompute from the tracker.
  /** @type {Record<string, {name: string, count: number, variants: Set<string>, rows: Array}>} */
  const groups = {};

  if (existsSync(APPLICATIONS_PATH)) {
    try {
      for (const line of readFileSync(APPLICATIONS_PATH, 'utf-8').split('\n')) {
        if (!line.trim().startsWith('|') || line.includes('|---|') || line.includes('| # |')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 7) continue;

        const num = parts[1];
        const dateStr = parts[2];
        const company = parts[3];
        const role = parts[4];
        const status = parts[6];
        if (!dateStr || !company) continue;

        if (NON_CONSUMING.has(resolveStatus(status))) continue;

        const date = new Date(dateStr);
        if (isNaN(date.getTime()) || date < cutoff) continue;

        const key = normalizeCompanyKey(company);
        if (!key) continue; // placeholder / unknown employer — never cap-counted

        const g = (groups[key] ??= { name: company.trim(), count: 0, variants: new Set(), rows: [] });
        g.count += 1;
        g.variants.add(company.trim());
        g.rows.push({ date: dateStr, status: status.trim(), role: (role || '').trim(), num });
        // Display the longest spelling seen — "Sarvam AI" reads better than "Sarvam".
        if (company.trim().length > g.name.length) g.name = company.trim();
      }
    } catch (err) {
      console.warn(`⚠️ Warning: Failed to parse applications.md for company caps: ${err.message}`);
    }
  }

  // Seed from pipeline.md so never-applied companies appear at 0.
  if (existsSync(PIPELINE_PATH)) {
    try {
      for (const l of readFileSync(PIPELINE_PATH, 'utf-8').split('\n')) {
        if (!l.trim().startsWith('- [ ]')) continue;
        const parts = l.split('|').map((s) => s.trim());
        if (parts.length < 2) continue;
        const company = parts[1];
        if (!company || company.startsWith('http') || company.length >= 50) continue;
        const key = normalizeCompanyKey(company);
        if (!key) continue;
        groups[key] ??= { name: company.trim(), count: 0, variants: new Set([company.trim()]), rows: [] };
      }
    } catch {
      // Ignore pipeline errors — it only seeds zeroes.
    }
  }

  const today = new Date().toISOString().split('T')[0];
  /** @type {Record<string, object>} */
  const entries = {};
  for (const [key, g] of Object.entries(groups)) {
    entries[key] = {
      name: g.name,
      count: g.count,
      variants: [...g.variants].sort(),
      rows: g.rows.sort((a, b) => (a.date < b.date ? 1 : -1)),
      last_updated: today,
    };
  }

  try {
    writeFileSync(CACHE_PATH, JSON.stringify({
      __version: CACHE_VERSION,
      __window: `${limit}/${days}`,
      __cutoff: cutoffStr,
      entries,
    }, null, 2), 'utf-8');
  } catch {
    // Ignore cache write errors.
  }

  return entries;
}

/**
 * One company's cap state, matched through the same normalization the counts
 * use — so "Sarvam" and "Sarvam AI" ask the same question.
 *
 * @param {string} company
 * @param {number} [limit=2]
 * @param {number} [days=30]
 * @returns {{key: string, name: string, count: number, limit: number,
 *   atCap: boolean, variants: string[], rows: Array}}
 */
export function getCompanyCap(company, limit = 2, days = 30) {
  const key = normalizeCompanyKey(company);
  const caps = getCompanyCaps(limit, days);
  const hit = key ? caps[key] : null;
  return {
    key,
    name: hit?.name ?? String(company ?? '').trim(),
    count: hit?.count ?? 0,
    limit,
    atCap: (hit?.count ?? 0) >= limit,
    variants: hit?.variants ?? [],
    rows: hit?.rows ?? [],
  };
}
