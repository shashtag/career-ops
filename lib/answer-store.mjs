/**
 * answer-store.mjs — resolve a form field label to the candidate's canonical answer.
 *
 * Pure: no browser, no network, no CDP. Everything here is a function of
 * (config/application-answers.yml, config/profile.yml, a field descriptor), which
 * is what makes it testable and what keeps the risky part of applying — deciding
 * *what to say* — out of throwaway per-form scripts.
 *
 * The matcher is deliberately specificity-first. A generic "are you authorized to
 * work" entry must never beat a country-qualified one; that inversion is a real
 * bug this store exists to make impossible.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STORE_PATH = join(ROOT, 'config', 'application-answers.yml');
export const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');

/** Lowercase, collapse whitespace, drop decoration. Keeps '.' so "u.s." survives. */
export function normalizeLabel(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[*_`>#\[\]()]/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve ${profile.a.b} against the loaded profile. Unknown paths stay literal. */
export function interpolate(value, profile) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{profile\.([a-zA-Z0-9_.]+)\}/g, (whole, path) => {
    let node = profile;
    for (const key of path.split('.')) {
      if (node == null || typeof node !== 'object') return whole;
      node = node[key];
    }
    return node == null ? whole : String(node);
  });
}

export function loadStore({ storePath = STORE_PATH, profilePath = PROFILE_PATH } = {}) {
  if (!existsSync(storePath)) {
    throw new Error(`answer store not found: ${storePath}`);
  }
  const store = yaml.load(readFileSync(storePath, 'utf8')) || {};
  const profile = existsSync(profilePath)
    ? yaml.load(readFileSync(profilePath, 'utf8')) || {}
    : {};

  const fields = (store.fields || []).map(entry => ({
    ...entry,
    answer: interpolate(entry.answer, profile),
  }));
  const essays = store.essays || [];
  return { fields, essays, profile, version: store.version ?? 1 };
}

/**
 * Score one match spec against a normalized label.
 * Returns null when the spec does not apply, otherwise a specificity score.
 */
export function scoreMatch(spec, label) {
  if (!spec) return null;
  const any = spec.any || [];
  const require = spec.require || [];
  const exclude = spec.exclude || [];

  for (const term of exclude) {
    if (label.includes(normalizeLabel(term))) return null;
  }
  for (const term of require) {
    if (!label.includes(normalizeLabel(term))) return null;
  }

  let best = 0;
  for (const term of any) {
    const t = normalizeLabel(term);
    if (t && label.includes(t)) best = Math.max(best, t.length);
  }
  if (any.length && best === 0) return null;

  // Specificity: qualifiers dominate, then the length of the phrase that hit.
  return require.length * 1000 + exclude.length * 100 + best;
}

/** Map a canonical answer onto one of the field's real options. */
export function matchOption(answer, options) {
  if (!options || !options.length) return { option: null, how: 'no-options' };
  const a = normalizeLabel(answer);
  if (!a) return { option: null, how: 'no-answer' };

  const norm = options.map(o => ({ raw: o, n: normalizeLabel(o) }));

  const exact = norm.find(o => o.n === a);
  if (exact) return { option: exact.raw, how: 'exact' };

  const startsWith = norm.find(o => wordStartsWith(o.n, a) || wordStartsWith(a, o.n));
  if (startsWith) return { option: startsWith.raw, how: 'prefix' };

  // Word-boundary containment, not raw substring: "Female" contains "male",
  // and answering a gender question with the wrong option is not recoverable.
  const contains = norm.filter(o => wordContains(o.n, a) || wordContains(a, o.n));
  if (contains.length === 1) return { option: contains[0].raw, how: 'contains' };
  if (contains.length > 1) {
    // Prefer the shortest containing option — "Yes" over "Yes, with conditions".
    const shortest = contains.reduce((m, o) => (o.n.length < m.n.length ? o : m));
    return { option: shortest.raw, how: 'contains-ambiguous' };
  }

  // Token overlap as a last resort.
  const aTokens = new Set(a.split(' ').filter(t => t.length > 2));
  let best = null, bestScore = 0;
  for (const o of norm) {
    const oTokens = o.n.split(' ').filter(t => t.length > 2);
    const hits = oTokens.filter(t => aTokens.has(t)).length;
    if (hits > bestScore) { bestScore = hits; best = o.raw; }
  }
  return bestScore > 0 ? { option: best, how: 'tokens' } : { option: null, how: 'none' };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `needle` appears in `hay` on word boundaries, not mid-word. */
function wordContains(hay, needle) {
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`, 'i').test(hay);
}

/** True when `hay` begins with `needle` and the match ends on a word boundary. */
function wordStartsWith(hay, needle) {
  if (!needle || !hay.startsWith(needle)) return false;
  const next = hay[needle.length];
  return next === undefined || !/[a-z0-9]/i.test(next);
}

const LONG_FORM_TYPES = new Set(['textarea']);

/**
 * Resolve one collected field.
 *
 * status:
 *   resolved   — deterministic answer, safe to fill as-is
 *   essay      — stored long-form answer; honour `adapt` before using it
 *   generate   — a known question with NO stored answer (e.g. "why us"); the
 *                agent must write it from the report + cv.md
 *   unresolved — nothing in the store covers this; a human decision
 */
/**
 * Legal agreements, consents and certifications. These are never auto-answered:
 * accepting terms on someone's behalf is the user's call, not the agent's, and a
 * wrong click here is not recoverable. Seen live on Greenhouse as "Agreement to
 * Arbitrate*" and "Please read the arbitration agreement below*".
 */
const CONSENT_RE = /\b(?:arbitrat\w*|agreement\s+to|i\s+agree|terms\s+(?:and|&)\s+conditions|privacy\s+(?:notice|policy)|consent\w*|acknowledg\w*|certif\w*|e-?signature|electronic\s+signature|opt[-\s]?in)\b/i;

export function resolveField(field, store) {
  const label = normalizeLabel(field.label);
  const isLongForm = field.multiline || LONG_FORM_TYPES.has(field.type);

  // A file input is a known, handled thing — the tailored CV — not an unknown question.
  if (field.type === 'file') {
    return {
      status: 'file',
      id: 'resume_upload',
      label: field.label,
      answer: null,
      confidence: 'high',
      note: 'Attach the tailored CV PDF for this report number from output/.',
    };
  }

  if (CONSENT_RE.test(String(field.label ?? ''))) {
    return {
      status: 'consent',
      id: null,
      label: field.label,
      answer: null,
      confidence: 'none',
      reason: 'legal agreement or consent — the candidate decides this, never the agent',
    };
  }

  // Long-form fields consult the essay bank first — a textarea asking
  // "why do you want to work here" must not be answered by a one-word field entry.
  const essayFirst = isLongForm || (field.maxLength && field.maxLength > 300);

  const bestEssay = pickBest(store.essays, e => scoreMatch(e.asked_as, label));
  const bestField = pickBest(store.fields, e => scoreMatch(e.match, label));

  if (essayFirst && bestEssay) return essayResult(bestEssay, field);
  if (bestField) return fieldResult(bestField, field);
  if (bestEssay) return essayResult(bestEssay, field);

  return {
    status: 'unresolved',
    id: null,
    label: field.label,
    answer: null,
    confidence: 'none',
    reason: 'no store entry matched this label',
  };
}

function pickBest(entries, scorer) {
  let best = null, bestScore = -1;
  for (const entry of entries || []) {
    const score = scorer(entry);
    if (score == null) continue;
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return best;
}

function fieldResult(entry, field) {
  const out = {
    status: 'resolved',
    id: entry.id,
    label: field.label,
    answer: entry.answer,
    confidence: entry.confidence || 'high',
    note: entry.note || null,
  };

  // How the agent must interact, not just what to say. Greenhouse and Ashby render
  // every dropdown as <input role="combobox">, so a control that must be opened and
  // picked from looks exactly like a text box unless we say otherwise. Typing into
  // one leaves the underlying value unset and the submit bounces.
  if (field.combobox) {
    out.interaction = 'combobox';
    if (!field.options || !field.options.length) {
      // Options mount lazily in a detached listbox, so we usually cannot see them
      // until the control is open. Answer is still known; selection is unverified.
      out.confidence = out.confidence === 'high' ? 'medium' : out.confidence;
      out.optionMatch = 'unverifiable-until-open';
      out.note = [out.note, 'Open the control, wait for the listbox, then click the option matching this answer — do not type it.']
        .filter(Boolean).join(' ');
      return out;
    }
  }

  if (field.options && field.options.length) {
    const { option, how } = matchOption(entry.answer, field.options);
    out.option = option;
    out.optionMatch = how;

    // A truncated list is a *partial* view of the control, so the option the
    // answer really wants may be the one the cap cut. An exact hit stays sound —
    // that option demonstrably exists — but every fuzzier tier is choosing from a
    // list that is missing its own best answer, and it does so silently:
    // "United States" against a list cut before it resolves to "United Arab
    // Emirates" by token overlap, status `resolved`, confidence `medium`. Refuse,
    // and send the agent to select by label against the real control instead.
    if (field.optionsTruncated && how !== 'exact') {
      out.status = 'unresolved';
      out.confidence = 'none';
      out.option = null;
      out.optionMatch = 'truncated-list';
      out.reason = `the option list was truncated at ${field.options.length} entries and "${entry.answer}" is not an exact match among them — the intended option may not have been collected. Open the control and select by label; do not trust a partial-list match.`;
      return out;
    }

    if (!option) {
      out.status = 'unresolved';
      out.confidence = 'none';
      out.reason = `answer "${entry.answer}" matches none of the ${field.options.length} available options`;
    } else if (how === 'contains-ambiguous' || how === 'tokens') {
      out.confidence = 'medium';
    }
  }
  return out;
}

function essayResult(entry, field) {
  const text = String(entry.answer || '').trim();
  if (!text) {
    return {
      status: 'generate',
      id: entry.id,
      label: field.label,
      answer: null,
      adapt: entry.adapt || 'required',
      confidence: 'none',
      note: entry.note || null,
    };
  }
  const adapt = entry.adapt || 'light';
  return {
    status: 'essay',
    id: entry.id,
    label: field.label,
    answer: text,
    adapt,
    confidence: adapt === 'none' ? 'high' : 'medium',
    note: entry.note || null,
    overLength: field.maxLength && text.length > field.maxLength ? field.maxLength : null,
  };
}

/** Resolve a whole collected form. */
export function resolveForm(fields, store) {
  return fields.map(f => ({ field: f, resolution: resolveField(f, store) }));
}

/** Roll a resolved form up into the numbers that decide whether to proceed. */
export function summarize(resolved) {
  const counts = { resolved: 0, essay: 0, generate: 0, unresolved: 0, file: 0, consent: 0 };
  let requiredBlockers = 0;
  for (const { field, resolution } of resolved) {
    counts[resolution.status] = (counts[resolution.status] || 0) + 1;
    if (field.required && ['unresolved', 'generate', 'consent'].includes(resolution.status)) {
      requiredBlockers++;
    }
  }
  return { total: resolved.length, ...counts, requiredBlockers };
}
