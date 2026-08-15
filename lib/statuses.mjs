/**
 * lib/statuses.mjs — Shared status constants and normalization for career-ops
 *
 * Single source of truth for canonical statuses, aliases, ranking,
 * and normalization logic used across the pipeline scripts.
 *
 * Consumers:
 *   verify-pipeline.mjs, followup-cadence.mjs, analyze-patterns.mjs,
 *   dedup-tracker.mjs, merge-tracker.mjs, normalize-statuses.mjs
 */

/**
 * Canonical status values as defined in templates/states.yml.
 * All lowercase for comparison purposes.
 * @type {string[]}
 */
export const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip',
];

/**
 * Maps lowercase alias → lowercase canonical status.
 * Superset of all aliases used across every pipeline script.
 * @type {Record<string, string>}
 */
export const STATUS_ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

/**
 * Pipeline advancement rank for each status (higher = further along).
 * Used by dedup-tracker to decide which entry's status to keep.
 * Includes both English canonical and Spanish alias forms.
 * @type {Record<string, number>}
 */
export const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,   // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
};

/**
 * Regex pattern string that matches all known statuses (canonical + aliases).
 * Anchored at start-of-string. Used by merge-tracker for column detection.
 * @type {string}
 */
export const STATUS_REGEX_PATTERN = '^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)';

/**
 * Proper-case lookup: lowercase canonical → display form (e.g. 'evaluated' → 'Evaluated').
 * @type {Record<string, string>}
 */
const PROPER_CASE = {
  'evaluated': 'Evaluated',
  'applied': 'Applied',
  'responded': 'Responded',
  'interview': 'Interview',
  'offer': 'Offer',
  'rejected': 'Rejected',
  'discarded': 'Discarded',
  'skip': 'SKIP',
};

/**
 * Resolve a raw status string to its lowercase canonical form.
 *
 * Strips markdown bold (`**`) and trailing dates (`YYYY-MM-DD…`),
 * then looks up in STATUS_ALIASES. Returns the cleaned input if
 * no alias is found.
 *
 * @param {string} raw — The raw status value (e.g. `"**Evaluada 2025-01-15**"`)
 * @returns {string} Lowercase canonical status (e.g. `"evaluated"`)
 */
export function resolveStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return STATUS_ALIASES[clean] || clean;
}

/**
 * Resolve a raw status string to its proper-case canonical form.
 *
 * Same cleaning as {@link resolveStatus}, but returns the display form
 * used in applications.md (e.g. `"Evaluated"`, `"SKIP"`).
 *
 * Falls back through: direct canonical match → alias lookup → DUPLICADO/Repost
 * special cases → default `"Evaluated"` with a console warning.
 *
 * @param {string} raw — The raw status value
 * @returns {string} Proper-case canonical status
 */
export function resolveStatusProperCase(raw) {
  const clean = raw.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  // Direct canonical match
  if (PROPER_CASE[lower]) return PROPER_CASE[lower];

  // Alias → canonical → proper case
  const aliased = STATUS_ALIASES[lower];
  if (aliased && PROPER_CASE[aliased]) return PROPER_CASE[aliased];

  // DUPLICADO/Repost → Discarded
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  console.warn(`⚠️  Non-canonical status "${raw}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}
