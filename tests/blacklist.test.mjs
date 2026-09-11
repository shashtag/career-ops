// tests/blacklist.test.mjs — the do-not-apply gate.
//
// data/blacklist.md is opt-in and usually absent, so the dangerous failure is
// not "the gate is too strict" — it is a gate that silently does nothing. That
// is what happened in the headless path: rank-queue.mjs had the parser inline,
// scratch/evaluate-pipeline.mjs never had it, and the model it calls has no
// file tools, so a company the candidate had recorded as do-not-apply got a
// full evaluation, a report and a tracker row.
//
// The second failure mode is a parser that reads table furniture as a company:
// a header row yields an entry "company", which matches every company name by
// substring and blacklists the whole pipeline.
//
// Run:  node --test tests/blacklist.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlacklist, loadBlacklist, blacklistMatch } from '../lib/blacklist.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('a bullet list parses', () => {
  assert.deepEqual(parseBlacklist('- Acme Corp\n- Globex\n'), ['acme corp', 'globex']);
});

test('a markdown table parses, and its furniture does not', () => {
  const table = [
    '# Do not apply',
    '',
    '| Company | Since | Reason |',
    '|---------|-------|--------|',
    '| Acme Corp. | 2026-01-01 | ghosted twice |',
    '| Globex | 2026-02-02 | bad process |',
  ].join('\n');
  assert.deepEqual(parseBlacklist(table), ['acme corp.', 'globex']);
});

test('a header row can never blacklist every company', () => {
  // "company" as an entry matches "Composio", "Company X", everything.
  const entries = parseBlacklist('| Company | Since |\n|---|---|\n');
  assert.deepEqual(entries, []);
  assert.equal(blacklistMatch('Composio', entries), null);
});

test('comments, quotes and blank lines are ignored', () => {
  assert.deepEqual(parseBlacklist('# note\n\n> quoted\n-\n- Acme\n'), ['acme']);
});

test('prose in the file is documentation, not a filter over every company', () => {
  // Found by smoke-testing the real file: its own explanatory paragraph parsed
  // as entries. Substring matching turns any stray line into a global filter.
  const withProse = [
    '# Do-not-apply companies',
    '',
    'Matched case-insensitively as a substring of the company name, so',
    'listing "Acme Corp." also catches a posting that says "acme corp".',
    '',
    '| Company | Since | Reason |',
    '|---|---|---|',
    '| Intercom | 2026-09-11 | permanent skip |',
  ].join('\n');
  assert.deepEqual(parseBlacklist(withProse), ['intercom']);
});

test('duplicates collapse', () => {
  assert.deepEqual(parseBlacklist('- Acme\n- acme\n- ACME\n'), ['acme']);
});

test('matching is case- and punctuation-insensitive, as oferta.md specifies', () => {
  const bl = parseBlacklist('- Acme Corp.\n');
  assert.equal(blacklistMatch('acme corp', bl), 'acme corp.');
  assert.equal(blacklistMatch('ACME  Corp', bl), 'acme corp.');
  assert.equal(blacklistMatch('Acme Corporation', bl), 'acme corp.');
});

test('an unrelated company is not matched', () => {
  const bl = parseBlacklist('- Acme Corp.\n- Intercom\n');
  assert.equal(blacklistMatch('Stripe', bl), null);
  assert.equal(blacklistMatch('MongoDB', bl), null);
});

test('an absent file means no gate, never an error', () => {
  const none = loadBlacklist(join(ROOT, 'data', 'definitely-not-here.md'));
  assert.deepEqual(none, []);
  assert.equal(blacklistMatch('Anything', none), null);
});

test('empty and null-ish input is safe', () => {
  assert.deepEqual(parseBlacklist(''), []);
  assert.deepEqual(parseBlacklist(null), []);
  assert.equal(blacklistMatch('', ['acme']), null);
  assert.equal(blacklistMatch('Acme', []), null);
  assert.equal(blacklistMatch('Acme', undefined), null);
});

test('both pipelines gate on the same list', () => {
  // The regression this exists for: the gate living in one path only. Assert
  // that both entrypoints reach lib/blacklist.mjs rather than re-deriving it.
  for (const f of ['rank-queue.mjs', 'scratch/evaluate-pipeline.mjs']) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    assert.match(src, /from '\.\.?\/(lib\/)?blacklist\.mjs'|lib\/blacklist\.mjs/, `${f} does not use the shared blacklist`);
  }
  const evalSrc = readFileSync(join(ROOT, 'scratch', 'evaluate-pipeline.mjs'), 'utf-8');
  assert.match(evalSrc, /blacklistMatch\(company, BLACKLIST\)/, 'the headless evaluator does not actually call the gate');
  assert.match(evalSrc, /\[Blacklisted\]/, 'a blacklisted job must be marked in pipeline.md, not silently dropped');
});
