// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

// Adzuna provider — hits the public Adzuna Job Search REST API
// (https://developer.adzuna.com/).
//
// Endpoint format:
//   https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
//
// Supports country-specific job searching across UK (gb), US (us), India (in),
// Germany (de), France (fr), Australia (au), Canada (ca), and other supported regions.
//
// Wire in via a `job_boards:` (or `tracked_companies:`) entry with `provider: adzuna`:
//
//   - name: Adzuna — India Tech
//     provider: adzuna
//     country: in
//     app_id: YOUR_APP_ID       # or set ADZUNA_APP_ID env var
//     app_key: YOUR_APP_KEY     # or set ADZUNA_APP_KEY env var
//     searchKeywords: "Software Engineer"
//     searchLocation: "Bengaluru"
//     pageSize: 50              # 1-50 (default 50)
//     maxPages: 3               # 1-20 (default 3)
//     days: 30                  # max_days_old filter (optional)
//     enabled: true

import { decodeEntities } from './_html-entities.mjs';

const DEFAULT_API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const TRUSTED_HOST = 'api.adzuna.com';
const DEFAULT_COUNTRY = 'gb';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 20;

/** @param {string} url */
function assertAdzunaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`adzuna: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`adzuna: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`adzuna: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Strip HTML tags (e.g. <strong> highlight tags) and decode HTML entities.
 * @param {any} str
 * @returns {string}
 */
export function stripHtml(str) {
  if (typeof str !== 'string') return '';
  return decodeEntities(str.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Convert ISO date string or timestamp to epoch milliseconds.
 * @param {any} value
 * @returns {number|undefined}
 */
function toEpochMs(value) {
  if (!value) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Clamp an integer to a specified range [min, max].
 * @param {any} val
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intInRange(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Parse a single Adzuna API result item into the normalized Job shape.
 * Exported for unit tests.
 *
 * @param {any} item - Raw job item from Adzuna API response
 * @param {string} [fallbackCompany] - Fallback company name from entry
 * @returns {Job|null}
 */
export function parseAdzunaItem(item, fallbackCompany) {
  if (!item || typeof item !== 'object') return null;

  const title = stripHtml(item.title);
  if (!title) return null;

  const url = typeof item.redirect_url === 'string' ? item.redirect_url.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const company =
    (typeof item.company?.display_name === 'string' && item.company.display_name.trim())
      ? stripHtml(item.company.display_name)
      : (fallbackCompany || 'Adzuna');

  let location = '';
  if (typeof item.location?.display_name === 'string' && item.location.display_name.trim()) {
    location = stripHtml(item.location.display_name);
  } else if (Array.isArray(item.location?.area)) {
    location = item.location.area
      .filter((/** @type {any} */ a) => typeof a === 'string' && a.trim())
      .map(stripHtml)
      .join(', ');
  }

  const description = typeof item.description === 'string' && item.description.trim()
    ? stripHtml(item.description)
    : undefined;

  const postedAt = toEpochMs(item.created);

  /** @type {Job} */
  const job = {
    title,
    url,
    company,
    location,
    ...(description ? { description } : {}),
    ...(postedAt != null ? { postedAt } : {}),
  };

  return job;
}

/**
 * Parse an Adzuna API response object.
 * Exported for unit tests.
 *
 * @param {any} json - Parsed JSON response from Adzuna
 * @param {string} [fallbackCompany]
 * @returns {Job[]}
 */
export function parseAdzunaResponse(json, fallbackCompany) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) return [];
  const jobs = [];
  for (const item of json.results) {
    const job = parseAdzunaItem(item, fallbackCompany);
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * Extract and sanitize configuration for an Adzuna entry.
 * @param {any} entry
 */
export function parseAdzunaConfig(entry) {
  const cfg = (entry && entry.adzuna) || {};
  const countryRaw = entry?.country || entry?.countryCode || cfg.country || cfg.countryCode || DEFAULT_COUNTRY;
  const country = typeof countryRaw === 'string' && /^[a-zA-Z]{2}$/.test(countryRaw.trim())
    ? countryRaw.trim().toLowerCase()
    : DEFAULT_COUNTRY;

  const appId = String(
    entry?.app_id || entry?.appId || cfg.app_id || cfg.appId || process.env.ADZUNA_APP_ID || ''
  ).trim();

  const appKey = String(
    entry?.app_key || entry?.appKey || cfg.app_key || cfg.appKey || process.env.ADZUNA_APP_KEY || process.env.ADZUNA_API_KEY || ''
  ).trim();

  const keywordsRaw = entry?.searchKeywords ?? entry?.what ?? entry?.keywords ?? cfg.what ?? cfg.keywords ?? '';
  const keywords = Array.isArray(keywordsRaw)
    ? keywordsRaw.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()).join(' ')
    : (typeof keywordsRaw === 'string' ? keywordsRaw.trim() : '');

  const locationRaw = entry?.searchLocation ?? entry?.where ?? entry?.location ?? cfg.where ?? cfg.location ?? '';
  const location = typeof locationRaw === 'string' ? locationRaw.trim() : '';

  const pageSize = intInRange(entry?.pageSize || entry?.results_per_page || cfg.pageSize || cfg.results_per_page, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const maxPages = intInRange(entry?.maxPages || entry?.max_pages || cfg.maxPages || cfg.max_pages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP);
  const days = entry?.days || entry?.max_days_old || cfg.days || cfg.max_days_old;
  const maxDaysOld = days != null ? intInRange(days, 30, 1, 365) : undefined;
  const category = typeof (entry?.category || cfg.category) === 'string' ? (entry?.category || cfg.category).trim() : undefined;
  const sortBy = (entry?.sortBy || entry?.sort_by || cfg.sortBy || cfg.sort_by || 'date').trim();

  return {
    country,
    appId,
    appKey,
    keywords,
    location,
    pageSize,
    maxPages,
    maxDaysOld,
    category,
    sortBy,
  };
}

/** @type {Provider} */
export default {
  id: 'adzuna',

  detect(entry) {
    if (entry?.provider === 'adzuna') return { url: DEFAULT_API_BASE };
    if (typeof entry?.careers_url === 'string' && /adzuna\.(com|co\.uk|in|de|fr|com\.au|ca)/i.test(entry.careers_url)) {
      return { url: entry.careers_url };
    }
    return null;
  },

  /**
   * Fetches and normalizes job postings from the Adzuna Search API.
   * @param {any} entry - The portal entry being processed.
   * @param {import('./_types.js').Context} ctx - HTTP context.
   * @returns {Promise<Job[]>}
   */
  async fetch(entry, ctx) {
    const config = parseAdzunaConfig(entry);
    const { country, appId, appKey, keywords, location, pageSize, maxPages, maxDaysOld, category, sortBy } = config;

    if (!appId || !appKey) {
      throw new Error(
        `adzuna: missing app_id or app_key for "${entry?.name || 'Adzuna'}". ` +
        `Configure app_id/app_key on the portal entry or set ADZUNA_APP_ID / ADZUNA_APP_KEY environment variables.`
      );
    }

    const fallbackCompany = entry?.name || 'Adzuna';
    const allJobs = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(`${DEFAULT_API_BASE}/${encodeURIComponent(country)}/search/${page}`);
      url.searchParams.set('app_id', appId);
      url.searchParams.set('app_key', appKey);
      url.searchParams.set('content-type', 'application/json');
      url.searchParams.set('results_per_page', String(pageSize));
      if (keywords) url.searchParams.set('what', keywords);
      if (location) url.searchParams.set('where', location);
      if (maxDaysOld != null) url.searchParams.set('max_days_old', String(maxDaysOld));
      if (category) url.searchParams.set('category', category);
      if (sortBy) url.searchParams.set('sort_by', sortBy);

      const targetUrl = assertAdzunaUrl(url.href);
      let json;
      try {
        json = /** @type {any} */ (await ctx.fetchJson(targetUrl, { redirect: 'error' }));
      } catch (err) {
        if (page === 1) throw err;
        console.error(`adzuna: page ${page} fetch failed — ${err.message}`);
        break;
      }

      if (!json || !Array.isArray(json.results)) {
        if (page === 1) {
          throw new Error(
            `adzuna: unexpected API response — expected { results: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`
          );
        }
        break;
      }

      const jobs = parseAdzunaResponse(json, fallbackCompany);
      allJobs.push(...jobs);

      // Stop if fewer results than requested or no more available
      if (json.results.length < pageSize) break;
      if (typeof json.count === 'number' && allJobs.length >= json.count) break;

      // Rate limit pacing delay
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return allJobs;
  },
};
