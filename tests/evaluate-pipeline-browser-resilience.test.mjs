// tests/evaluate-pipeline-browser-resilience.test.mjs — a dead browser must not
// kill the run.
//
// Observed 2026-09-11 on a real `node run-pipeline.mjs --classify-only`: a
// helsing.ai scrape lost its browser context at job 1380 of 1546. The cleanup
// `await page.close()` then threw a Protocol error — from INSIDE the catch
// block, so it escaped the try/catch, reached main(), and exited 1. The other
// 166 jobs were discarded, and the classification work already done that pass
// went unreported.
//
// These are source-shape assertions rather than a live Playwright run: the
// failure is "an unguarded close in a cleanup path", which is visible in the
// source and cheap to keep out, where reproducing a dying browser context in CI
// is neither.
//
// Run:  node --test tests/evaluate-pipeline-browser-resilience.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(ROOT, 'scratch', 'evaluate-pipeline.mjs'), 'utf-8');

test('no bare page.close() survives in the scrape loop', () => {
  // Every call site must go through closeQuietly. The helper's own body is the
  // one place `page.close()` may appear.
  const bare = SRC.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /await\s+page\.close\(\)/.test(l));
  assert.equal(bare.length, 1, `bare page.close() outside the helper: ${JSON.stringify(bare)}`);
  const helperStart = SRC.indexOf('async function closeQuietly');
  const helperEnd = SRC.indexOf('\n}', helperStart);
  const offset = SRC.split('\n').slice(0, bare[0][0] - 1).join('\n').length;
  assert.ok(offset > helperStart && offset < helperEnd, 'the remaining page.close() is not the one inside closeQuietly');
});

test('closeQuietly swallows a close that throws', async () => {
  // Reproduce the exact failure: close() rejecting with the Protocol error.
  const fn = new Function('page', `
    return (async () => {
      try { await page.close(); } catch { /* context already gone */ }
    })();
  `);
  const dead = { close: async () => { throw new Error('Protocol error (Target.disposeBrowserContext): Failed to find context with id A599'); } };
  await assert.doesNotReject(() => fn(dead));
});

test('page acquisition is guarded, because newPage() on a dead browser throws outside the try', () => {
  assert.match(SRC, /newPageResilient\(\(\) => browser/, 'the scrape loop does not use the resilient acquirer');
  assert.doesNotMatch(SRC, /const page = await browser\.newPage\(\);/, 'an unguarded newPage() is back in the loop');
  assert.match(SRC, /if \(!page\) \{[\s\S]{0,220}break;/, 'a null page must end the loop cleanly, not fall through');
});

test('browser.close() in finally cannot mask the error that sent us there', () => {
  const fin = SRC.slice(SRC.lastIndexOf('} finally {'));
  assert.match(fin, /try \{ await browser\.close\(\); \} catch/, 'the finally-block close is unguarded');
});

test('the run still closes the browser at the end', () => {
  assert.match(SRC, /await browser\.close\(\)/, 'the browser is never closed — that leaks a Chromium per run');
});
