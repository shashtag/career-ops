#!/usr/bin/env node
/**
 * prune-pending-review.mjs — Prune expired/closed postings from pending-review.yml
 *
 * Reads data/pending-review.yml, performs lightweight HTTP liveness checks on form URLs,
 * removes dead/expired postings, and updates data/applications.md status to "Discarded".
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { updateApplicationStatus } from './scratch/apply_automator.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PENDING_FILE = join(DATA_ROOT, 'data', 'pending-review.yml');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

async function checkUrlLive(url) {
  if (!url || !url.startsWith('http')) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    clearTimeout(timer);
    if (res.status === 404 || res.status === 410) return false;
    if (res.ok) {
      const text = (await res.text()).toLowerCase();
      if (text.includes('no longer accepting applications') || text.includes('position has been filled') || text.includes('job is no longer available')) {
        return false;
      }
      return true;
    }
    return true;
  } catch (e) {
    return true; // Keep uncertain network errors
  }
}

async function main() {
  console.log(`${colors.bright}${colors.cyan}🧹 Checking data/pending-review.yml for expired postings...${colors.reset}\n`);

  if (!existsSync(PENDING_FILE)) {
    console.log(`✅ No data/pending-review.yml file found.`);
    process.exit(0);
  }

  const content = readFileSync(PENDING_FILE, 'utf-8').trim();
  if (!content) {
    console.log(`✅ data/pending-review.yml is empty.`);
    process.exit(0);
  }

  let list = [];
  try {
    list = yaml.load(content) || [];
  } catch (e) {
    console.error(`❌ Failed to parse data/pending-review.yml: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(list) || list.length === 0) {
    console.log(`✅ No items pending review.`);
    process.exit(0);
  }

  console.log(`Found ${list.length} pending review entries.`);
  const remaining = [];
  let prunedCount = 0;

  for (const item of list) {
    const isLive = await checkUrlLive(item.url);
    if (isLive) {
      remaining.push(item);
    } else {
      prunedCount++;
      console.log(`${colors.yellow}❌ Pruning expired posting #${item.id}: ${item.company} — ${item.role}${colors.reset}`);
      updateApplicationStatus(item.id, 'Discarded');
    }
  }

  if (prunedCount > 0) {
    writeFileSync(PENDING_FILE, yaml.dump(remaining), 'utf-8');
    console.log(`\n${colors.green}🎉 Successfully pruned ${prunedCount} expired postings from pending-review.yml (marked Discarded).${colors.reset}\n`);
  } else {
    console.log(`\n${colors.green}✅ All ${list.length} pending review postings are live.${colors.reset}\n`);
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
