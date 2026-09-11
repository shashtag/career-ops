// tests/company-caps-normalize.test.mjs — company-name normalization for the
// 2-per-30-days cap.
//
// This normalization sits under a gate, so its two failure modes are not
// symmetric and both are asserted:
//
//   UNDER-MERGING is the bug this fixes. `NVIDIA` and `Nvidia` are both live in
//   data/applications.md right now, and keying counts on the literal string
//   reported 1/2 for each when the real count was 2/2 — a cap breach the tool
//   called clear. That is why three mode files told the agent to ignore the
//   script and recount by hand.
//
//   OVER-MERGING is the risk introduced by fixing it: folding two genuinely
//   different companies together blocks an application the policy allows. So
//   only TRAILING generic tokens are stripped, the suffix list is narrow, and
//   the pairs that must stay apart are asserted by name.
//
// Run:  node --test tests/company-caps-normalize.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCompanyKey } from '../lib/company-caps.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('the variants that caused the hand-recount rule now collapse', () => {
  const same = [
    ['NVIDIA', 'Nvidia'],
    ['Sarvam AI', 'Sarvam'],
    ['Temporal', 'Temporal Technologies'],
    ['Agoda', 'Agoda (Booking Holdings)'],
    ['Emergent Labs', 'Emergent Labs (S24)'],
    ['Glacis AI', 'Glacis'],
    ['Astronomer', 'astronomer'],
    ['Amazon', 'Amazon (ADCI Karnataka)'],
    ['Stripe', 'Stripe, Inc.'],
    ['SumUp', 'SumUp GmbH'],
  ];
  for (const [a, b] of same) {
    assert.equal(normalizeCompanyKey(a), normalizeCompanyKey(b), `${a} and ${b} must count as one company`);
  }
});

test('companies that merely share a prefix stay apart', () => {
  const different = [
    ['Apple', 'Apple Bank'],
    ['Palo Alto Networks', 'Palo Alto'],
    ['Level AI', 'Level Home'],
    ['Meta', 'Metabase'],
    ['Coram AI', 'Coram Deo Academy'],
    ['Together AI', 'Together Labs Interactive'],
  ];
  for (const [a, b] of different) {
    assert.notEqual(normalizeCompanyKey(a), normalizeCompanyKey(b), `${a} and ${b} must stay separate companies`);
  }
});

test('a name that is only a generic token survives', () => {
  // "AI" and "Labs" as whole company names must not normalize to nothing —
  // the stripper only ever pops a trailing token when something is left.
  assert.equal(normalizeCompanyKey('AI'), 'ai');
  assert.equal(normalizeCompanyKey('Labs'), 'labs');
  assert.equal(normalizeCompanyKey('Group'), 'group');
});

test('placeholder employers are never cap-counted', () => {
  // "?" is the documented marker for an agency posting whose end employer is
  // unknown (#1596). Two such rows are usually two DIFFERENT employers, so
  // folding them into one company would block a permitted application.
  for (const p of ['?', 'unknown', 'Unknown', 'n/a', 'TBD', '—', '', '   ']) {
    assert.equal(normalizeCompanyKey(p), '', `${JSON.stringify(p)} must not produce a cap key`);
  }
});

test('diacritics, punctuation and case do not split a company', () => {
  assert.equal(normalizeCompanyKey('Zürich Insurance'), normalizeCompanyKey('Zurich Insurance'));
  assert.equal(normalizeCompanyKey('L&T Technology'), normalizeCompanyKey('L & T'));
  assert.equal(normalizeCompanyKey('  MongoDB  '), 'mongodb');
});

test('null-ish input does not throw', () => {
  assert.equal(normalizeCompanyKey(undefined), '');
  assert.equal(normalizeCompanyKey(null), '');
});

test('no two distinct companies in the real tracker collide', () => {
  // The guard that matters: run the normalizer over every company spelling the
  // tracker has ever held and assert that each merged group is one company
  // under several spellings, not several companies under one key. Anything new
  // that merges has to be added here deliberately.
  const expectedMerges = new Set([
    'nvidia', 'sarvam', 'temporal', 'astronomer', 'emergent', 'agoda', 'glacis',
  ]);

  const names = new Set();
  for (const line of readFileSync(join(ROOT, 'data', 'applications.md'), 'utf-8').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 8 || !/^\d{4}-/.test(parts[2]) || !parts[3]) continue;
    names.add(parts[3]);
  }
  assert.ok(names.size > 50, `expected a populated tracker, saw ${names.size} companies`);

  const groups = new Map();
  for (const n of names) {
    const k = normalizeCompanyKey(n);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }

  const unexpected = [...groups.entries()]
    .filter(([k, v]) => v.length > 1 && !expectedMerges.has(k))
    .map(([k, v]) => `${k} <- ${v.join(' | ')}`);
  assert.deepEqual(unexpected, [], 'new company names merged — confirm they are the same company, then add the key above');
});
