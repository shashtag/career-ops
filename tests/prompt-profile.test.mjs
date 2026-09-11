// tests/prompt-profile.test.mjs — the prompt trim for tool-less evaluators.
//
// Two failure modes, and only one of them is loud on its own:
//
//   1. The trim removes something load-bearing. `modes/oferta.md` keeps the
//      report OUTPUT TEMPLATE inside "### 1. Save report .md", so a rule that
//      looked like a pure file-write instruction would have taken the required
//      report format with it. Those survivals are asserted by name.
//   2. The trim silently stops working. oferta.md is system-layer and upstream
//      renames headings; a marker that no longer matches would make the trim a
//      no-op with nothing in the output to show for it. Every marker is
//      asserted against the real file here, so drift fails the suite.
//
// Run:  node --test tests/prompt-profile.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripToolGatedBlocks, findBlock, TOOL_GATED_BLOCKS } from '../prompt-profile.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OFERTA = readFileSync(join(ROOT, 'modes', 'oferta.md'), 'utf-8').trim();
const NO_TOOLS = { browser: false, webSearch: false, fileRead: false, fileWrite: false };

test('every marker still matches the real oferta.md', () => {
  const { missing } = stripToolGatedBlocks(OFERTA, { capabilities: NO_TOOLS });
  assert.deepEqual(missing, [], 'a marker stopped matching — the trim would silently no-op');
});

test('the blocks the tool-less caller cannot execute are gone', () => {
  const { text } = stripToolGatedBlocks(OFERTA, { capabilities: NO_TOOLS });
  for (const gone of [
    '## Liveness gate (URL inputs)',
    '## Bounded Research Budget',
    'Jurisdiction resolution for signals',
    '**10. Agency Licensing Check**',
    '**11. Immigration-Status Requirement Overreach**',
    '**12. Jurisdiction-Prohibited Content**',
  ]) {
    assert.ok(!text.includes(gone), `${gone} survived the trim`);
  }
});

test('everything load-bearing survives — especially the report template', () => {
  const { text } = stripToolGatedBlocks(OFERTA, { capabilities: NO_TOOLS });
  for (const kept of [
    // The report format the caller saves verbatim. It lives INSIDE a heading
    // that reads like a file-write instruction, which is why it is asserted.
    '### 1. Save report .md',
    '# Evaluation: {Company} — {Role}',
    '## Machine Summary',
    '## Job Description (archived verbatim)',
    // 73 of 294 Gemini reports carry an inline cover-letter draft.
    '## Cover Letter Draft',
    // Signals that need no table and do fire in practice.
    '**6. Employment Classification Risk**',
    '**7. AI-Buzzword vs. Infrastructure Mismatch**',
    '**8. Benefits/Employment Terminology Country Mismatch**',
    '**9. Third-Party Platform Location Tag',
    '**13. Pay-Transparency Range-Width Check**',
    '**14. Minimum-Wage Lawyer Question**',
    '**15. AI-Screening Disclosure**',
    // Blocks A-G themselves.
    '## Block A — Role Summary',
    '## Block D — Comp and Demand',
    '## Block G — Posting Legitimacy',
    '## Risk Summary',
  ]) {
    assert.ok(text.includes(kept), `${kept} was removed — the trim is too aggressive`);
  }
});

test('the trim is worth doing and does not run away', () => {
  const { text } = stripToolGatedBlocks(OFERTA, { capabilities: NO_TOOLS });
  const cut = OFERTA.length - text.length;
  assert.ok(cut > 10_000, `expected a meaningful cut, got ${cut} chars`);
  assert.ok(cut < OFERTA.length * 0.35, `cut ${cut} of ${OFERTA.length} chars — too much to be only tool-gated blocks`);
});

test('a caller with tools keeps the whole file', () => {
  const withTools = stripToolGatedBlocks(OFERTA, { capabilities: { browser: true, webSearch: true, fileRead: true } });
  assert.equal(withTools.text, OFERTA);
  assert.deepEqual(withTools.removed, []);
});

test('an unknown capability is treated as present, so nothing is lost by default', () => {
  assert.equal(stripToolGatedBlocks(OFERTA, {}).text, OFERTA);
  assert.equal(stripToolGatedBlocks(OFERTA, { capabilities: {} }).text, OFERTA);
});

test('heading blocks end at the next same-or-higher heading', () => {
  const lines = ['## Keep', 'a', '## Target', 'b', '### deeper', 'c', '## After', 'd'];
  const r = findBlock(lines, { marker: '## Target', kind: 'heading' });
  assert.deepEqual(r, { start: 2, end: 6 }, 'must swallow the deeper heading but stop at the next ##');
});

test('signal blocks end at the next signal or heading', () => {
  const lines = ['**10. A** (x)', 'body', 'more', '**11. B** (y)', 'other'];
  assert.deepEqual(findBlock(lines, { marker: '**10. A**', kind: 'signal' }), { start: 0, end: 3 });

  const toHeading = ['**12. C** (z)', 'body', '### Output format:', 'x'];
  assert.deepEqual(findBlock(toHeading, { marker: '**12. C**', kind: 'signal' }), { start: 0, end: 2 });
});

test('an absent marker is reported, never guessed at', () => {
  const r = stripToolGatedBlocks('# nothing here\n\nbody\n', {
    capabilities: { fileRead: false },
    blocks: [{ id: 'ghost', marker: '## Not Present', kind: 'heading', needs: 'fileRead', why: 'test' }],
  });
  assert.deepEqual(r.missing, ['ghost']);
  assert.equal(r.text, '# nothing here\n\nbody\n', 'an unmatched marker must leave the text byte-identical');
  assert.deepEqual(r.removed, []);
});

test('every block declares why it is safe to remove', () => {
  for (const b of TOOL_GATED_BLOCKS) {
    assert.ok(b.id && b.marker && b.kind && b.needs, `incomplete block: ${JSON.stringify(b)}`);
    assert.ok(b.why && b.why.length > 20, `${b.id} has no justification`);
  }
});

test('empty and non-string input is handled', () => {
  assert.equal(stripToolGatedBlocks('', { capabilities: NO_TOOLS }).text, '');
  assert.equal(stripToolGatedBlocks(null, { capabilities: NO_TOOLS }).text, '');
});
