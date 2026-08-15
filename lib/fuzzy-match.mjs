/**
 * lib/fuzzy-match.mjs — Shared fuzzy matching for career-ops
 *
 * Single source of truth for company normalization and role fuzzy matching.
 * Eliminates algorithmic drift between merge-tracker and dedup-tracker.
 *
 * The algorithm here is the merge-tracker variant (refined through
 * Issues #329 and #633) with BASELINE_TOKENS discrimination and
 * SHORT_SPECIALTY allowlisting.
 *
 * Consumers:
 *   merge-tracker.mjs, dedup-tracker.mjs
 */

/**
 * Normalize a company name to a lowercase alphanumeric string (no spaces/punctuation).
 * Used for exact company-level dedup.
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tokens that almost every role shares — must NOT count as signal.
 * Includes seniority, work-mode, contract, locations, and prepositions.
 */
const ROLE_STOPWORDS = new Set([
  // seniority / level
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  // contract / mode
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'internship',
  // generic job words
  'role', 'position', 'opportunity', 'team', 'based',
  // very common locations
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  // regions / countries
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  // prepositions leaking through length filter
  'with', 'from', 'into', 'over', 'this', 'that',
  // additional from dedup-tracker (not in original merge set)
  'director', 'manager', 'engineering', 'global',
  'angeles', 'denver',
]);

/**
 * Short specialty acronyms that ARE discriminating despite their length.
 * Without this allowlist, `length > 3` strips them out, leaving only the
 * generic "Software Engineer" baseline (see Issue #633).
 */
const SHORT_SPECIALTY = new Set([
  'api', 'sre', 'sdk', 'cli', 'gpu', 'cpu',
  'ios', 'qa', 'ux', 'ui', 'ar', 'vr',
  'ocr', 'crm', 'erp', 'go',
]);

/**
 * Generic role-level descriptors. Two roles whose ONLY overlap is in this
 * set (e.g. [software, engineer]) are NOT the same role — they're just
 * labelled at the same altitude. See Issue #633.
 */
const BASELINE_TOKENS = new Set([
  'software', 'engineer', 'developer', 'manager', 'architect',
  'analyst', 'designer', 'consultant', 'specialist',
  'platform', 'systems', 'services',
  'backend', 'frontend', 'fullstack',
  'solutions', 'support', 'success', 'operations', 'ops',
  'technical', 'tech', 'growth', 'value',
]);

/**
 * Extract meaningful tokens from a role title.
 * Strips stopwords, keeps short specialty acronyms, lowercases everything.
 * @param {string} s — Raw role title
 * @returns {string[]}
 */
export function roleTokens(s) {
  return s
    .toLowerCase()
    .replace(/full[- ]stack/g, 'fullstack')
    .replace(/front[- ]end/g, 'frontend')
    .replace(/back[- ]end/g, 'backend')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => (w.length > 3 || SHORT_SPECIALTY.has(w)) && !ROLE_STOPWORDS.has(w));
}

/**
 * Fuzzy-match two role titles to determine if they refer to the same position.
 *
 * Requirements for a match:
 *   1. Both roles produce ≥1 content token after stopword filtering
 *   2. ≥2 tokens overlap
 *   3. At least one overlapping token is NOT in the baseline set
 *   4. Overlap ratio ≥ 0.6 (Jaccard-style against smaller token set)
 *
 * @param {string} a — First role title
 * @param {string} b — Second role title
 * @returns {boolean}
 */
export function roleFuzzyMatch(a, b) {
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true;

  const wordsA = roleTokens(a);
  const wordsB = roleTokens(b);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w));
  if (overlap.length < 2) return false;

  // Require at least one non-baseline token in the overlap. Roles that
  // share only generic descriptors like [software, engineer] are NOT the
  // same role (see Issue #633).
  const discriminating = overlap.filter(w => !BASELINE_TOKENS.has(w));
  if (discriminating.length === 0) return false;

  // Jaccard-style ratio on content tokens.
  const minLen = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap.length / minLen;
  return ratio >= 0.6;
}

/**
 * Parse a score string like "4.2/5" or "**3.8/5**" into a numeric value.
 * @param {string} s — Raw score string
 * @returns {number}
 */
export function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Extract a report number from a markdown link like "[042](reports/...)".
 * @param {string} reportStr — Report column value
 * @returns {number|null}
 */
export function extractReportNum(reportStr) {
  const m = reportStr.match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}
