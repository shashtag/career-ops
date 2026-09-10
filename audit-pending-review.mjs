#!/usr/bin/env node

/**
 * audit-pending-review.mjs — zero-LLM-token liveness audit of data/pending-review.yml
 *
 * The pending-review queue holds applications the automator already filled
 * (name/email/resume/etc.) that are just waiting on a human glance + Submit.
 * Entries can sit for days; some postings close in the meantime. This re-checks
 * every URL with the same Playwright liveness logic as check-liveness.mjs (its
 * own isolated headless browser instance — does not touch the user's live,
 * CDP-connected Chrome session) and reports which entries are now dead, so the
 * user doesn't spend review time on a posting that no longer exists.
 *
 * Read-only: does not modify pending-review.yml. Print the result and let the
 * user (or a future run) decide what to mark Discarded.
 *
 * Usage: node audit-pending-review.mjs
 * Exit code: 0 if all active, 1 if any expired/uncertain found
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import * as yaml from 'js-yaml';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  newLivenessPage,
  jitteredDelayMs,
  sleep,
} from './liveness-browser.mjs';

const PENDING_REVIEW_PATH = new URL('./data/pending-review.yml', import.meta.url);

async function main() {
  const args = process.argv.slice(2);
  const noFallback = args.includes('--no-fallback');
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;

  const text = await readFile(PENDING_REVIEW_PATH, 'utf-8');
  const entries = yaml.load(text) || [];

  if (entries.length === 0) {
    console.log('data/pending-review.yml is empty — nothing to audit.');
    return;
  }

  console.log(`Auditing ${entries.length} pending-review entr${entries.length === 1 ? 'y' : 'ies'}...\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await newLivenessPage(browser);
  const headed = noFallback ? null : createHeadedPageProvider(chromium);
  const getHeadedPage = headed ? () => headed.get() : undefined;

  const stale = [];
  let active = 0;

  // Sequential — project rule: never Playwright in parallel
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { result, reason } = await checkUrlLivenessWithFallback(page, entry.url, { getHeadedPage });
    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    console.log(`${icon} ${result.padEnd(10)} #${entry.id} ${entry.company} — ${entry.role}`);
    if (result !== 'active') {
      console.log(`           ${reason}`);
      stale.push({ ...entry, result, reason });
    } else {
      active++;
    }

    const wait = i < entries.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
    if (wait) await sleep(wait);
  }

  if (headed) await headed.close();
  await browser.close();

  console.log(`\nResults: ${active} active  ${stale.length} stale (expired/uncertain) of ${entries.length} total\n`);

  if (stale.length > 0) {
    console.log('Stale entries (recommend reviewing — likely safe to mark Discarded and drop from pending-review.yml):');
    for (const s of stale) {
      console.log(`  #${s.id} ${s.company} (${s.result}: ${s.reason}) — ${s.url}`);
    }
  }

  process.exit(stale.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
