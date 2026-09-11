#!/usr/bin/env node

/**
 * jurisdiction-lookup.mjs — resolve the jurisdiction-keyed compliance tables in
 * `templates/` down to the rows that actually apply.
 *
 * WHY THIS EXISTS. Block G signals 6-15 in `modes/oferta.md` (and the
 * equivalents in `apply`, `interview-redflag`, `offer-prep`) all open with the
 * same two steps:
 *
 *   1. Read `templates/<table>.yml` — a jurisdiction-keyed table.
 *   2. Derive the candidate's jurisdiction key from `config/profile.yml` →
 *      `location`. No table entry for that jurisdiction → the signal is not
 *      evaluated; say nothing.
 *
 * Step 2 is a key match: deterministic, and specified as such. Until now the
 * agent performed it by reading every table in full — ~8.4k tokens for the four
 * tables `oferta` consults — usually to conclude that nothing applies. For an
 * India-based candidate that is the outcome for all six tables, because the
 * tables between them cover CA-ON, UK, EU, US, US-CA, US-IL, US-NY-NYC, DE and
 * JP, and none of them has an IN row.
 *
 * This tool does the key match and prints only the matching rows. The judgment
 * each signal then applies — does the JD text actually demand a status, does
 * the posting actually disclose AI screening — is untouched and stays with the
 * agent. Nothing here decides whether a signal fires.
 *
 * WHAT IT REFUSES TO DO. It never answers "nothing applies" from a guess. When
 * the candidate's country cannot be resolved to a code, it exits 2 and says to
 * read the tables directly; when the country resolves but a table carries rows
 * keyed BELOW the resolved level (a US-IL row against a bare `US` candidate),
 * those rows are returned under `needs_subdivision` rather than dropped. A
 * quiet "none" is the only way this tool could lose a signal, so every
 * uncertain case is surfaced instead.
 *
 * ZERO-FETCH, same as the tables themselves: it reads local YAML and nothing
 * else. It never contacts a registry, and the `registry.url` / `sources` fields
 * it echoes are for the candidate to click, never for this process to open.
 *
 * Table discovery is automatic: any `templates/*.yml` holding a collection of
 * jurisdiction-keyed entries is picked up, in either of the two shapes the
 * existing tables use (a `jurisdictions:` map keyed by code, or a list whose
 * items carry a `jurisdiction:` field). Adding a seventh table, or a new
 * jurisdiction to an existing one, never requires editing this file — the same
 * property the table headers promise about the rule text in `modes/`.
 *
 * Usage:
 *   node jurisdiction-lookup.mjs                        # candidate from config/profile.yml, all tables
 *   node jurisdiction-lookup.mjs --summary              # one line per table
 *   node jurisdiction-lookup.mjs --json                 # machine-readable, full matching rows
 *   node jurisdiction-lookup.mjs --mode oferta          # only the tables that mode consults
 *   node jurisdiction-lookup.mjs --table immigration-status-requirements
 *   node jurisdiction-lookup.mjs --candidate US-NY-NYC  # override the derived key
 *   node jurisdiction-lookup.mjs --posting CA-ON        # also match the employer's jurisdiction
 *
 * Exit codes: 0 = resolved (matches or a definite none) · 2 = jurisdiction
 * could not be resolved, read the tables yourself · 1 = usage or read error.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const TEMPLATES_DIR = join(ROOT, 'templates');

// ---------------------------------------------------------------------------
// Jurisdiction codes
// ---------------------------------------------------------------------------

/**
 * Country name → ISO 3166-1 alpha-2, for the names a `config/profile.yml`
 * realistically carries. Deliberately NOT exhaustive: an unlisted country
 * resolves to `unresolved` and the caller is told to read the tables, which is
 * the safe failure. Adding a country here is a one-line change; guessing one is
 * how a real Ontario candidate silently loses four signals.
 *
 * @type {Record<string, string>}
 */
export const COUNTRY_CODES = {
  'india': 'IN', 'bharat': 'IN',
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'canada': 'CA',
  'united kingdom': 'UK', 'uk': 'UK', 'great britain': 'UK', 'britain': 'UK',
  'england': 'UK', 'scotland': 'UK', 'wales': 'UK', 'northern ireland': 'UK',
  'germany': 'DE', 'deutschland': 'DE',
  'japan': 'JP', 'nippon': 'JP',
  'france': 'FR', 'spain': 'ES', 'italy': 'IT', 'netherlands': 'NL',
  'ireland': 'IE', 'poland': 'PL', 'portugal': 'PT', 'belgium': 'BE',
  'austria': 'AT', 'sweden': 'SE', 'denmark': 'DK', 'finland': 'FI',
  'czechia': 'CZ', 'czech republic': 'CZ', 'romania': 'RO', 'greece': 'GR',
  'hungary': 'HU', 'bulgaria': 'BG', 'croatia': 'HR', 'slovakia': 'SK',
  'slovenia': 'SI', 'lithuania': 'LT', 'latvia': 'LV', 'estonia': 'EE',
  'luxembourg': 'LU', 'malta': 'MT', 'cyprus': 'CY',
  'australia': 'AU', 'new zealand': 'NZ', 'singapore': 'SG',
  'switzerland': 'CH', 'norway': 'NO', 'israel': 'IL', 'brazil': 'BR',
  'mexico': 'MX', 'argentina': 'AR', 'south africa': 'ZA',
  'united arab emirates': 'AE', 'uae': 'AE',
};

/**
 * EU member states, by ISO code. A table keyed `EU` applies to a candidate in
 * any of them — the AI-screening table's EU row is the EU AI Act, which binds
 * member states rather than a single country.
 * @type {Set<string>}
 */
export const EU_MEMBERS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

/**
 * Subdivision name → code suffix, for the countries whose tables key below the
 * country. Same discipline as COUNTRY_CODES: unlisted means unresolved, never
 * guessed. Cities appear only where a table keys a city (NYC).
 * @type {Record<string, Record<string, string>>}
 */
export const SUBDIVISIONS = {
  US: {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
    'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE',
    'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
    'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR',
    'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
    'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
    'district of columbia': 'DC', 'washington dc': 'DC',
  },
  CA: {
    'alberta': 'AB', 'british columbia': 'BC', 'manitoba': 'MB',
    'new brunswick': 'NB', 'newfoundland and labrador': 'NL',
    'nova scotia': 'NS', 'ontario': 'ON', 'prince edward island': 'PE',
    'quebec': 'QC', 'québec': 'QC', 'saskatchewan': 'SK',
    'northwest territories': 'NT', 'nunavut': 'NU', 'yukon': 'YT',
  },
};

/**
 * City name → full jurisdiction key, for the handful of cities a table keys
 * directly. Only cities with their own row belong here.
 * @type {Record<string, string>}
 */
export const CITY_KEYS = {
  'new york city': 'US-NY-NYC',
  'new york': 'US-NY-NYC',
  'nyc': 'US-NY-NYC',
  'brooklyn': 'US-NY-NYC',
  'manhattan': 'US-NY-NYC',
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolve a free-text location into a jurisdiction key.
 *
 * Returns the most specific key it can justify, plus the pieces it could not
 * resolve. `key` is null when even the country is unknown — the caller must
 * then fall back to reading the tables rather than treating the answer as
 * "nothing applies".
 *
 * @param {{country?: string, city?: string, state?: string, province?: string, region?: string}} loc
 * @returns {{key: string|null, country: string|null, subdivision: string|null,
 *   city: string|null, unresolved: string[], eu: boolean}}
 */
export function resolveJurisdiction(loc = {}) {
  const unresolved = [];
  const countryRaw = loc.country;
  const country = countryRaw ? (COUNTRY_CODES[norm(countryRaw)] ?? null) : null;
  if (countryRaw && !country) unresolved.push(`country "${countryRaw}"`);
  if (!countryRaw) unresolved.push('country (absent from location)');

  const cityRaw = loc.city;
  const regionRaw = loc.state ?? loc.province ?? loc.region;

  // A city with its own table row wins, but only when it agrees with the
  // country we resolved — "New York" in a profile whose country is India is a
  // data error, not a jurisdiction.
  let cityKey = null;
  if (cityRaw) {
    const hit = CITY_KEYS[norm(cityRaw)];
    if (hit && country && hit.startsWith(`${country}-`)) cityKey = hit;
  }
  if (cityKey) {
    return { key: cityKey, country, subdivision: cityKey.split('-')[1], city: cityRaw, unresolved, eu: country ? EU_MEMBERS.has(country) : false };
  }

  let subdivision = null;
  if (country && regionRaw) {
    subdivision = SUBDIVISIONS[country]?.[norm(regionRaw)] ?? null;
    if (!subdivision) unresolved.push(`region "${regionRaw}"`);
  }

  const key = country ? (subdivision ? `${country}-${subdivision}` : country) : null;
  return { key, country, subdivision, city: cityRaw ?? null, unresolved, eu: country ? EU_MEMBERS.has(country) : false };
}

/**
 * Does a table's jurisdiction key apply to a resolved query key?
 *
 * Broader-or-equal only: a `US` federal row applies to a US-IL candidate, an
 * Illinois row does not apply to a Texan. `EU` applies to any member state.
 *
 * @param {string} tableKey - The key as written in the table.
 * @param {string} queryKey - The resolved jurisdiction key.
 * @param {boolean} eu - Whether the query country is an EU member state.
 * @returns {boolean}
 */
export function keyApplies(tableKey, queryKey, eu = false) {
  if (!tableKey || !queryKey) return false;
  if (tableKey === queryKey) return true;
  if (tableKey === 'EU' && eu) return true;
  return queryKey.startsWith(`${tableKey}-`);
}

/**
 * Is a table key strictly BELOW the query key — i.e. a row we cannot rule in or
 * out because the profile never said which state/province the candidate is in?
 *
 * @param {string} tableKey
 * @param {string} queryKey
 * @returns {boolean}
 */
export function keyNeedsSubdivision(tableKey, queryKey) {
  if (!tableKey || !queryKey) return false;
  return tableKey.startsWith(`${queryKey}-`);
}

// ---------------------------------------------------------------------------
// Table discovery
// ---------------------------------------------------------------------------

const JURISDICTION_KEY_RE = /^[A-Z]{2}(-[A-Z0-9]{2,4})*$/;

/**
 * Find the jurisdiction-keyed collection inside a parsed table, in either
 * shape the templates use. Returns null when the document holds no such
 * collection, which is how non-table YAML in `templates/` is skipped.
 *
 * @param {unknown} doc - Parsed YAML document.
 * @returns {{collection: string, shape: 'map'|'list', entries: Array<{jurisdiction: string, entry: object}>}|null}
 */
export function findJurisdictionCollection(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  for (const [collection, value] of Object.entries(doc)) {
    if (Array.isArray(value)) {
      const items = value.filter((v) => v && typeof v === 'object' && typeof v.jurisdiction === 'string');
      if (items.length && items.length === value.length) {
        return {
          collection,
          shape: 'list',
          entries: items.map((entry) => ({ jurisdiction: entry.jurisdiction, entry })),
        };
      }
      continue;
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length && keys.every((k) => JURISDICTION_KEY_RE.test(k))) {
        return {
          collection,
          shape: 'map',
          entries: keys.map((k) => ({ jurisdiction: k, entry: value[k] })),
        };
      }
    }
  }
  return null;
}

/**
 * Every jurisdiction table under `templates/`, discovered rather than listed.
 *
 * @param {string} [dir=TEMPLATES_DIR]
 * @returns {Array<{name: string, file: string, collection: string, shape: string, entries: Array}>}
 */
export function discoverTables(dir = TEMPLATES_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    let doc;
    try {
      doc = yaml.load(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      continue; // A malformed template is check-table-freshness's problem, not ours.
    }
    const found = findJurisdictionCollection(doc);
    if (!found) continue;
    out.push({
      name: basename(file).replace(/\.ya?ml$/, '').replace(/^jurisdiction-/, ''),
      file: `templates/${file}`,
      collection: found.collection,
      shape: found.shape,
      entries: found.entries,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Match every discovered table against one or more jurisdiction keys.
 *
 * @param {{candidate?: string|null, posting?: string|null, eu?: boolean,
 *   tables?: Array, only?: string[]}} opts
 * @returns {{keys: object, tables: Array}}
 */
export function lookup({ candidate = null, posting = null, eu = false, tables = null, only = null } = {}) {
  const all = tables ?? discoverTables();
  const wanted = only && only.length
    ? all.filter((t) => only.some((o) => t.name === o || t.file.includes(o)))
    : all;

  const queries = [];
  if (candidate) queries.push({ role: 'candidate', key: candidate, eu });
  if (posting) queries.push({ role: 'posting', key: posting, eu: false });

  const results = wanted.map((t) => {
    const matches = [];
    const needsSubdivision = [];
    for (const { jurisdiction, entry } of t.entries) {
      for (const q of queries) {
        if (keyApplies(jurisdiction, q.key, q.eu)) {
          matches.push({ jurisdiction, matched: q.role, matched_key: q.key, entry });
          break;
        }
        if (keyNeedsSubdivision(jurisdiction, q.key)) {
          needsSubdivision.push({ jurisdiction, matched: q.role, matched_key: q.key, entry });
          break;
        }
      }
    }
    return {
      table: t.name,
      file: t.file,
      jurisdictions_in_table: t.entries.map((e) => e.jurisdiction),
      matches,
      needs_subdivision: needsSubdivision,
      verdict: matches.length ? 'applies' : (needsSubdivision.length ? 'needs-subdivision' : 'none'),
    };
  });

  return { keys: { candidate, posting, eu }, tables: results };
}

/**
 * Read `config/profile.yml` → `location`. Returns an empty object when the file
 * is missing or unreadable, which resolves to `unresolved` downstream.
 * @param {string} [dataRoot=DATA_ROOT]
 * @returns {object}
 */
export function readProfileLocation(dataRoot = DATA_ROOT) {
  const file = join(dataRoot, 'config', 'profile.yml');
  if (!existsSync(file)) return {};
  try {
    const doc = yaml.load(readFileSync(file, 'utf-8'));
    return (doc && typeof doc === 'object' && doc.location) || {};
  } catch {
    return {};
  }
}

/**
 * Which tables a mode consults, read from the mode file itself so the mapping
 * can never drift from the prose.
 * @param {string} mode - e.g. 'oferta', 'apply', 'interview-redflag'.
 * @param {Array} tables - Discovered tables.
 * @returns {string[]} Table names named by that mode file.
 */
export function tablesForMode(mode, tables) {
  const file = join(ROOT, 'modes', `${mode}.md`);
  if (!existsSync(file)) return [];
  let text;
  try { text = readFileSync(file, 'utf-8'); } catch { return []; }
  return tables.filter((t) => text.includes(basename(t.file))).map((t) => t.name);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node jurisdiction-lookup.mjs [options]

  --candidate <key>   Jurisdiction key for the candidate (default: derived from config/profile.yml)
  --posting <key>     Jurisdiction key for the employer/posting (optional)
  --mode <name>       Restrict to the tables that modes/<name>.md consults
  --table <name>      Restrict to one table (repeatable substring match)
  --json              Full matching rows as JSON
  --summary           One line per table (default)
  --help

Exit 0 = resolved · 2 = jurisdiction unresolved, read the tables yourself · 1 = usage/read error.`;

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    return 0;
  }

  const tables = discoverTables();
  if (!tables.length) {
    console.error('No jurisdiction tables found under templates/.');
    return 1;
  }

  const loc = readProfileLocation();
  const resolved = resolveJurisdiction(loc);
  const candidate = flagValue(args, '--candidate') ?? resolved.key;
  const posting = flagValue(args, '--posting') ?? null;
  const overridden = Boolean(flagValue(args, '--candidate'));

  const only = [];
  for (const t of args.filter((a, i) => args[i - 1] === '--table')) only.push(t);
  for (const a of args) if (a.startsWith('--table=')) only.push(a.slice('--table='.length));
  const mode = flagValue(args, '--mode');
  if (mode) {
    const names = tablesForMode(mode, tables);
    if (!names.length) {
      console.error(`modes/${mode}.md names no jurisdiction table — nothing to look up.`);
      return 1;
    }
    only.push(...names);
  }

  if (!candidate && !posting) {
    const why = resolved.unresolved.length ? resolved.unresolved.join('; ') : 'no location in config/profile.yml';
    if (hasFlag(args, '--json')) {
      console.log(JSON.stringify({ status: 'unresolved', reason: why, tables: tables.map((t) => t.file) }, null, 2));
    } else {
      console.log(`⚠️  Jurisdiction unresolved (${why}).`);
      console.log('    Read these tables directly rather than treating this as "nothing applies":');
      for (const t of tables) console.log(`      ${t.file}`);
    }
    return 2;
  }

  const result = lookup({ candidate, posting, eu: overridden ? false : resolved.eu, tables, only: only.length ? only : null });

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({
      status: 'resolved',
      location: loc,
      resolved: { ...resolved, candidate_key: candidate, posting_key: posting, overridden },
      ...result,
    }, null, 2));
    return 0;
  }

  const label = [candidate && `candidate ${candidate}`, posting && `posting ${posting}`].filter(Boolean).join(' · ');
  console.log(`Jurisdiction: ${label}${resolved.eu && !overridden ? ' (EU member state)' : ''}`);
  if (resolved.unresolved.length && !overridden) {
    console.log(`  ⚠️  partially resolved — ${resolved.unresolved.join('; ')}`);
  }
  console.log('');
  for (const t of result.tables) {
    if (t.verdict === 'none') {
      console.log(`  none        ${t.table} — no row for this jurisdiction (table covers: ${t.jurisdictions_in_table.join(', ')})`);
    } else if (t.verdict === 'needs-subdivision') {
      console.log(`  UNCERTAIN   ${t.table} — ${t.needs_subdivision.map((m) => m.jurisdiction).join(', ')} sit below the resolved key; read ${t.file} for these`);
    } else {
      for (const m of t.matches) {
        const name = m.entry?.jurisdiction_name ?? m.jurisdiction;
        console.log(`  APPLIES     ${t.table} — ${m.jurisdiction} (${name}) via ${m.matched}`);
      }
      if (t.needs_subdivision.length) {
        console.log(`              …plus ${t.needs_subdivision.map((m) => m.jurisdiction).join(', ')} below the resolved key — read ${t.file}`);
      }
    }
  }
  const applying = result.tables.filter((t) => t.verdict !== 'none').length;
  console.log('');
  console.log(applying
    ? `${applying}/${result.tables.length} table(s) have rows to read — run with --json for the rows.`
    : `0/${result.tables.length} tables apply. The signals backed by them are not evaluated; say nothing about them.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv);
}
