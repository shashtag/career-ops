// tests/jurisdiction-lookup.test.mjs — the jurisdiction key match that Block G
// signals 6-15 used to perform by reading every table in full.
//
// The property that matters here is NOT "does it find the rows" — it is "can it
// ever quietly answer none when a row does apply". A false `none` deletes a
// compliance signal from an evaluation with nothing in the output to show for
// it, which is strictly worse than the token cost this tool exists to remove.
// So the unresolved and below-the-resolved-key cases are asserted as hard as
// the matching cases.
//
// Run:  node --test tests/jurisdiction-lookup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveJurisdiction,
  keyApplies,
  keyNeedsSubdivision,
  findJurisdictionCollection,
  discoverTables,
  lookup,
} from '../jurisdiction-lookup.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('resolveJurisdiction maps the shapes a real profile.yml carries', () => {
  assert.equal(resolveJurisdiction({ country: 'India', city: 'Bengaluru' }).key, 'IN');
  assert.equal(resolveJurisdiction({ country: 'Canada', province: 'Ontario' }).key, 'CA-ON');
  assert.equal(resolveJurisdiction({ country: 'United States', state: 'California' }).key, 'US-CA');
  assert.equal(resolveJurisdiction({ country: 'USA', city: 'New York City' }).key, 'US-NY-NYC');
  assert.equal(resolveJurisdiction({ country: 'United Kingdom' }).key, 'UK');
  // `region` is accepted as a synonym for state/province.
  assert.equal(resolveJurisdiction({ country: 'Canada', region: 'Québec' }).key, 'CA-QC');
});

test('an unknown country resolves to null, never to a guess', () => {
  const r = resolveJurisdiction({ country: 'Wakanda', city: 'Birnin Zana' });
  assert.equal(r.key, null);
  assert.equal(r.country, null);
  assert.ok(r.unresolved.some((u) => u.includes('Wakanda')));
});

test('a missing location resolves to null and says why', () => {
  const r = resolveJurisdiction({});
  assert.equal(r.key, null);
  assert.ok(r.unresolved.some((u) => u.includes('country')));
});

test('an unknown region keeps the country key and records the gap', () => {
  const r = resolveJurisdiction({ country: 'United States', state: 'Puerto Rico' });
  assert.equal(r.key, 'US', 'falls back to the country, never to a wrong state');
  assert.ok(r.unresolved.some((u) => u.includes('Puerto Rico')));
});

test('a city key is only honoured when it agrees with the country', () => {
  // "New York" as a city on an India profile is a data error, not a jurisdiction.
  assert.equal(resolveJurisdiction({ country: 'India', city: 'New York' }).key, 'IN');
});

test('EU membership is flagged for member states only', () => {
  assert.equal(resolveJurisdiction({ country: 'Germany' }).eu, true);
  assert.equal(resolveJurisdiction({ country: 'United Kingdom' }).eu, false);
  assert.equal(resolveJurisdiction({ country: 'India' }).eu, false);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('keyApplies matches broader-or-equal, never narrower', () => {
  assert.equal(keyApplies('US', 'US', false), true);
  assert.equal(keyApplies('US', 'US-IL', false), true, 'a federal row applies to a state resident');
  assert.equal(keyApplies('US-IL', 'US', false), false, 'a state row does not apply to a bare US key');
  assert.equal(keyApplies('US-IL', 'US-TX', false), false, 'Illinois law does not reach Texas');
  assert.equal(keyApplies('US-NY-NYC', 'US-NY', false), false);
  assert.equal(keyApplies('US-NY', 'US-NY-NYC', false), true);
  assert.equal(keyApplies('CA-ON', 'CA-ON', false), true);
  // The prefix test must not match on a bare string prefix: US is not a prefix
  // of USX-1, and CA (Canada) must never match a California key.
  assert.equal(keyApplies('US', 'USX-1', false), false);
});

test('an EU row applies to a member state and to nobody else', () => {
  assert.equal(keyApplies('EU', 'DE', true), true);
  assert.equal(keyApplies('EU', 'UK', false), false);
  assert.equal(keyApplies('EU', 'IN', false), false);
});

test('keyNeedsSubdivision flags rows below the resolved key', () => {
  assert.equal(keyNeedsSubdivision('US-IL', 'US'), true);
  assert.equal(keyNeedsSubdivision('US', 'US-IL'), false);
  assert.equal(keyNeedsSubdivision('CA-ON', 'US'), false);
});

// ---------------------------------------------------------------------------
// Table shapes
// ---------------------------------------------------------------------------

test('findJurisdictionCollection handles both shapes the templates use', () => {
  const asMap = findJurisdictionCollection({ jurisdictions: { 'CA-ON': { a: 1 }, UK: { a: 2 } } });
  assert.equal(asMap.shape, 'map');
  assert.deepEqual(asMap.entries.map((e) => e.jurisdiction), ['CA-ON', 'UK']);

  const asList = findJurisdictionCollection({ entries: [{ jurisdiction: 'US' }, { jurisdiction: 'CA-ON' }] });
  assert.equal(asList.shape, 'list');
  assert.deepEqual(asList.entries.map((e) => e.jurisdiction), ['US', 'CA-ON']);
});

test('non-jurisdiction YAML in templates/ is skipped, not mis-parsed', () => {
  assert.equal(findJurisdictionCollection({ states: { applied: {}, rejected: {} } }), null);
  assert.equal(findJurisdictionCollection({ entries: [{ name: 'x' }] }), null);
  assert.equal(findJurisdictionCollection(null), null);
  assert.equal(findJurisdictionCollection([1, 2]), null);
});

test('a new table is discovered without editing this tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-jur-'));
  try {
    writeFileSync(join(dir, 'invented-regime.yml'), 'jurisdictions:\n  IN:\n    jurisdiction_name: "India"\n');
    writeFileSync(join(dir, 'not-a-table.yml'), 'colours:\n  - red\n  - blue\n');
    const found = discoverTables(dir);
    assert.deepEqual(found.map((t) => t.name), ['invented-regime']);
    assert.deepEqual(found[0].entries.map((e) => e.jurisdiction), ['IN']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Against the real tables
// ---------------------------------------------------------------------------

test('every shipped jurisdiction table is discovered', () => {
  const names = discoverTables().map((t) => t.name).sort();
  for (const expected of [
    'agency-licensing',
    'ai-screening-disclosure',
    'immigration-status-requirements',
    'prohibited-content',
    'protected-grounds',
    'restrictive-covenants',
  ]) {
    assert.ok(names.includes(expected), `${expected} not discovered (got ${names.join(', ')})`);
  }
});

test('Ontario matches the rows a hand-read of the tables would find', () => {
  const { tables } = lookup({ candidate: 'CA-ON' });
  const applying = tables.filter((t) => t.verdict === 'applies').map((t) => t.table).sort();
  assert.deepEqual(applying, [
    'agency-licensing',
    'immigration-status-requirements',
    'prohibited-content',
    'protected-grounds',
    'restrictive-covenants',
  ]);
});

test('a bare US key surfaces state rows as uncertain rather than dropping them', () => {
  const { tables } = lookup({ candidate: 'US' });
  const byName = Object.fromEntries(tables.map((t) => [t.table, t]));
  // The federal immigration row applies outright.
  assert.equal(byName['immigration-status-requirements'].verdict, 'applies');
  // Illinois and NYC sit below `US`: they must be surfaced, never called none.
  assert.equal(byName['ai-screening-disclosure'].verdict, 'needs-subdivision');
  assert.deepEqual(
    byName['ai-screening-disclosure'].needs_subdivision.map((m) => m.jurisdiction).sort(),
    ['US-IL', 'US-NY-NYC'],
  );
  assert.equal(byName['restrictive-covenants'].verdict, 'needs-subdivision');
});

test('no shipped table has an India row — the signals are genuinely not evaluated', () => {
  const { tables } = lookup({ candidate: 'IN' });
  assert.ok(tables.length >= 6);
  for (const t of tables) {
    assert.equal(t.verdict, 'none', `${t.table} unexpectedly matched IN`);
  }
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, 'jurisdiction-lookup.mjs'), ...args], {
      encoding: 'utf-8', timeout: 30_000, ...opts,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

test('CLI exits 2 and names the tables when the jurisdiction is unresolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-jur-root-'));
  try {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.yml'), 'location:\n  country: "Wakanda"\n');
    const { code, stdout } = runCli([], { env: { ...process.env, CAREER_OPS_ROOT: dir } });
    assert.equal(code, 2, 'an unresolved jurisdiction must never exit 0 with "nothing applies"');
    assert.match(stdout, /unresolved/i);
    assert.match(stdout, /templates\//, 'must name the tables to read instead');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--mode restricts to the tables that mode file actually names', () => {
  const { code, stdout } = runCli(['--mode', 'oferta', '--candidate', 'IN']);
  assert.equal(code, 0);
  assert.match(stdout, /0\/4 tables apply/);
  assert.doesNotMatch(stdout, /protected-grounds/, 'oferta does not consult the interview table');
});

test('--json is parseable and carries the matching rows', () => {
  const { code, stdout } = runCli(['--candidate', 'CA-ON', '--table', 'agency-licensing', '--json']);
  assert.equal(code, 0);
  const doc = JSON.parse(stdout);
  assert.equal(doc.status, 'resolved');
  assert.equal(doc.tables.length, 1);
  assert.equal(doc.tables[0].matches[0].jurisdiction, 'CA-ON');
  assert.ok(doc.tables[0].matches[0].entry.registry, 'the row itself must come through, not just its key');
});
