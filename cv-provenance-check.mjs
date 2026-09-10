#!/usr/bin/env node

/**
 * Trace every numeric magnitude in a generated CV back to a source-of-truth file.
 *
 * This is the companion to `verify-cv-facts.mjs`, not a replacement for it.
 * That gate compares metric PHRASES (`16+ services`, `$2M contract`, `4 years`)
 * against the sources as text. Because the comparison is textual, a magnitude
 * written in a different notation than its source is not matched — and an
 * unmatched magnitude is silently ignored rather than flagged. Two shapes slip
 * through in practice:
 *
 *   1. Abbreviated magnitudes. `cv.md` says "3 million daily visits"; the
 *      rendered CV says "3M daily visits". The strings differ, so the phrase
 *      never lines up with a source phrase, and editing it to "30M" changes
 *      nothing the gate can see.
 *   2. Grouped magnitudes whose trailing noun is not one of the gate's metric
 *      nouns — "10,000+ concurrent streaming connections" among them.
 *
 * This checker compares NUMBERS, not strings. Every magnitude on both sides is
 * normalized to a numeric value first (`3M` / `3 million` / `3,000,000` all
 * become 3000000), so notation stops mattering and the only question left is
 * whether the value itself appears in a source the user actually wrote.
 *
 * Read-only and advisory by default: it prints findings and exits 0 so it can
 * be run against existing artifacts without breaking a flow. Pass `--strict` to
 * exit 1 on any unsourced magnitude, which is the form to wire into a gate.
 *
 * Usage:
 *   node cv-provenance-check.mjs <generated-cv.html|md|tex>
 *   node cv-provenance-check.mjs <generated-cv> --source cv.md --source article-digest.md
 *   node cv-provenance-check.mjs <generated-cv> --summary
 *   node cv-provenance-check.mjs <generated-cv> --json
 *   node cv-provenance-check.mjs <generated-cv> --strict
 *   node cv-provenance-check.mjs --self-test
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, basename } from 'path';
import { stripMarkup } from './verify-cv-facts.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_SOURCES = ['cv.md', 'article-digest.md'];
const FACTS_CONFIG = join(DATA_ROOT, 'config', 'cv-facts.json');

/**
 * Words that turn a bare number into a magnitude of that many units.
 * `3M` and `3 million` have to land on the same value or the whole check is
 * just the string comparison it exists to replace.
 */
const SCALE_WORDS = new Map([
  ['k', 1e3], ['thousand', 1e3],
  ['m', 1e6], ['mn', 1e6], ['million', 1e6],
  ['b', 1e9], ['bn', 1e9], ['billion', 1e9],
  ['lakh', 1e5], ['crore', 1e7],
]);

/**
 * Tokens that make a following `N.N` a version or standard designation rather
 * than a quantity. "OAuth 2.0" is not a claim that anything numbered two
 * happened, so it must not be demanded of the sources.
 */
const VERSION_CONTEXT = /\b(?:oauth|http|https?\/|tls|ssl|soc|iso|pci|hipaa|gdpr|wcag|python|node|java|es|c#|\.net|v|version|vue|angular|react|next|go|php|ruby|rust|http\/)\s*$/i;

/**
 * Units that are part of page furniture rather than a claim about the
 * candidate. Rendered CVs carry no CSS by the time markup is stripped, but a
 * `.tex` or a markdown source can still mention them inline.
 */
const LAYOUT_UNIT = /^(?:px|pt|em|rem|in|cm|mm|vh|vw)\b/i;

const MAGNITUDE_RE = new RegExp(
  [
    '(?<![\\w.])',                       // not mid-identifier, not a decimal tail
    '(?<currency>[$₹€£¥])?\\s?',
    '(?<num>\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)',
    '(?<plus>\\s?\\+)?',
    '\\s?(?<scale>k|m|mn|b|bn|thousand|million|billion|lakh|crore)?',
    '(?![\\w,.])',                       // scale word must end cleanly
  ].join(''),
  'giu',
);

/** Strip HTML entities that `stripMarkup` leaves behind, so context reads cleanly. */
export function decodeEntities(text) {
  return String(text)
    .replace(/&(?:mdash|ndash|minus);/gi, '-')
    .replace(/&(?:middot|bull);/gi, '·')
    .replace(/&(?:lsquo|rsquo|apos|#39);/gi, "'")
    .replace(/&(?:ldquo|rdquo|quot);/gi, '"')
    .replace(/&hellip;/gi, '...')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** Turn a matched magnitude into a single numeric value, or null if it is not one. */
export function toValue({ num, scale }) {
  const base = Number(String(num).replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const factor = scale ? SCALE_WORDS.get(String(scale).toLowerCase()) : 1;
  return factor ? base * factor : base;
}

/**
 * Decide whether a matched number is a claim about the candidate at all.
 *
 * Years, phone digits, version numbers and layout units are all numbers on the
 * page that no source is obliged to corroborate. Excluding them here is what
 * keeps the report short enough that a real finding is visible in it.
 */
export function isClaimMagnitude(match, text) {
  const { num, scale, currency, plus } = match.groups;
  const value = toValue(match.groups);
  if (value === null) return false;

  const start = match.index;
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(start + match[0].length, start + match[0].length + 24);

  // A bare 4-digit number in the calendar range is a year, unless it is
  // explicitly money or a scaled magnitude.
  const bare = !scale && !currency && !plus;
  if (bare && /^\d{4}$/.test(num) && value >= 1900 && value <= 2100) return false;

  // Month-name adjacency catches the rest of the date forms ("Sep 2026", "2019 - June 2023").
  if (bare && /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i.test(before)) return false;

  // Phone numbers: a long run of digits, a national-prefix lead-in, or the
  // country code itself — `+91` leads a further group, where `+50%` does not.
  if (/\+\s?\d[\d\s-]*$/.test(before) && String(num).replace(/\D/g, '').length >= 5) return false;
  if (/\+$/.test(before) && /^[\s-]*\d/.test(after)) return false;
  if (bare && String(num).replace(/\D/g, '').length >= 9) return false;

  // Version and standard designations.
  if (!scale && !currency && /\./.test(num) && VERSION_CONTEXT.test(before)) return false;

  // Layout units.
  if (LAYOUT_UNIT.test(after.trimStart())) return false;

  return true;
}

/** Every magnitude value a piece of text asserts. */
export function collectValues(text) {
  const clean = decodeEntities(stripMarkup(text));
  const out = new Set();
  for (const m of clean.matchAll(MAGNITUDE_RE)) {
    if (!isClaimMagnitude(m, clean)) continue;
    const v = toValue(m.groups);
    if (v !== null) out.add(v);
  }
  return out;
}

/** Every magnitude a generated document asserts, each with the phrase around it. */
export function collectClaims(text) {
  const clean = decodeEntities(stripMarkup(text));
  const claims = [];
  for (const m of clean.matchAll(MAGNITUDE_RE)) {
    if (!isClaimMagnitude(m, clean)) continue;
    const value = toValue(m.groups);
    if (value === null) continue;
    const from = Math.max(0, m.index - 45);
    const to = Math.min(clean.length, m.index + m[0].length + 45);
    claims.push({
      text: m[0].trim(),
      value,
      context: (from > 0 ? '…' : '') + clean.slice(from, to).trim() + (to < clean.length ? '…' : ''),
    });
  }
  return claims;
}

/** Values the user has explicitly allow-listed in config/cv-facts.json. */
export function allowlistValues(configPath = FACTS_CONFIG) {
  if (!existsSync(configPath)) return new Set();
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return collectValues((cfg.allow_metrics || []).join('\n'));
  } catch {
    return new Set();
  }
}

function resolveSource(p) {
  return isAbsolute(p) ? p : join(DATA_ROOT, p);
}

/**
 * Check one generated document against the source-of-truth files.
 * Returns findings rather than printing, so callers can gate on it.
 */
export function checkProvenance(docText, { sources = DEFAULT_SOURCES, configPath = FACTS_CONFIG } = {}) {
  const sourceFiles = [];
  let sourceText = '';
  for (const s of sources) {
    const p = resolveSource(s);
    if (!existsSync(p)) continue;
    sourceFiles.push(s);
    sourceText += '\n' + readFileSync(p, 'utf-8');
  }

  const sourced = collectValues(sourceText);
  const allowed = allowlistValues(configPath);
  const claims = collectClaims(docText);

  const seen = new Set();
  const unsourced = [];
  for (const c of claims) {
    if (sourced.has(c.value) || allowed.has(c.value)) continue;
    const key = `${c.value}|${c.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unsourced.push(c);
  }

  return {
    sourceFiles,
    checked: claims.length,
    distinct: new Set(claims.map(c => c.value)).size,
    unsourced,
  };
}

// ---------------------------------------------------------------- self-test --

function selfTest() {
  const cases = [];
  const t = (name, got, want) => cases.push({ name, ok: got === want, got, want });

  t('3M and 3 million are the same value',
    [...collectValues('3M daily visits')][0], [...collectValues('3 million daily visits')][0]);
  t('grouped magnitude normalizes',
    [...collectValues('10,000+ connections')][0], 10000);
  t('currency magnitude normalizes',
    [...collectValues('a $2M contract')][0], 2000000);
  t('a year is not a claim', collectValues('Sep 2026 - Present').size, 0);
  t('a phone number is not a claim', collectValues('+91 9898027295').size, 0);
  t('a version is not a claim', collectValues('OAuth 2.0 PKCE').size, 0);

  const drift = checkProvenance('Scaled to 30M daily visits.', {
    sources: ['cv.md'], configPath: '/nonexistent',
  });
  t('an inflated magnitude is caught', drift.unsourced.length >= 1, true);

  const truthful = checkProvenance('Comcast Xfinity at 3M daily visits.', {
    sources: ['cv.md'], configPath: '/nonexistent',
  });
  t('a truthful magnitude in other notation passes', truthful.unsourced.length, 0);

  let failed = 0;
  for (const c of cases) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ` (got ${c.got}, want ${c.want})`}`);
    if (!c.ok) failed++;
  }
  console.log(failed === 0 ? '\nself-test passed' : `\n${failed} self-test failure(s)`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------- CLI --

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const sources = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') { sources.push(argv[++i]); continue; }
    if (argv[i].startsWith('--')) continue;
    positional.push(argv[i]);
  }

  const target = positional[0];
  if (!target) {
    console.error('usage: node cv-provenance-check.mjs <generated-cv> [--source f]… [--summary|--json] [--strict]');
    return 2;
  }
  const path = resolveSource(target);
  if (!existsSync(path)) {
    console.error(`not found: ${target}`);
    return 2;
  }

  const result = checkProvenance(readFileSync(path, 'utf-8'), {
    sources: sources.length ? sources : DEFAULT_SOURCES,
  });
  result.document = basename(path);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.unsourced.length === 0) {
    console.log(`✅ ${result.document}: all ${result.distinct} magnitude(s) trace to ${result.sourceFiles.join(', ') || 'no source file'}`);
  } else {
    console.log(`⚠️  ${result.document}: ${result.unsourced.length} magnitude(s) with no source in ${result.sourceFiles.join(', ')}\n`);
    for (const u of result.unsourced) {
      console.log(`  ${u.text}`);
      if (!argv.includes('--summary')) console.log(`    ${u.context}\n`);
    }
    console.log(`Each is either a real claim missing from your sources — add it to cv.md if true —`);
    console.log(`or a number that drifted during tailoring. Neither should ship unreviewed.`);
  }

  return argv.includes('--strict') && result.unsourced.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
