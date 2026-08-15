#!/usr/bin/env node
/**
 * check-open-forms.mjs — Open Chrome tabs auditor
 *
 * Connects to Chrome CDP (http://localhost:9222/json), inspects open tabs,
 * and cross-references form URLs against data/applications.md to report:
 * 1. Submittable / active form tabs
 * 2. Confirmation / submitted tabs
 * 3. Stale tabs (already marked Applied/Discarded in tracker)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOpenTabs } from './lib/cdp-page.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = join(__dirname, 'data', 'applications.md');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

async function main() {
  console.log(`🔍 Auditing open Chrome tabs on port 9222...\n`);
  const tabs = await getOpenTabs('localhost', 9222);

  if (tabs.length === 0) {
    console.log(`⚠️ No open Chrome tabs found or Chrome CDP not running on port 9222.`);
    console.log(`   Start Chrome with: open -a "Google Chrome" --args --remote-debugging-port=9222\n`);
    process.exit(0);
  }

  // Load tracker entries
  let apps = [];
  if (existsSync(APPS_FILE)) {
    const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length >= 8) {
          const num = parseInt(parts[1]);
          if (!isNaN(num)) {
            apps.push({
              num,
              company: parts[3],
              role: parts[4] || parts[5],
              status: parts[6] || parts[7],
            });
          }
        }
      }
    }
  }

  const jobBoardTabs = [];
  const confirmationTabs = [];
  const otherTabs = [];

  for (const tab of tabs) {
    const url = (tab.url || '').toLowerCase();
    const title = tab.title || '';

    if (url.includes('confirmation') || url.includes('/thank') || url.includes('/applied') || title.toLowerCase().includes('thank you')) {
      confirmationTabs.push(tab);
    } else if (url.includes('greenhouse.io') || url.includes('ashbyhq.com') || url.includes('lever.co') || url.includes('workday') || url.includes('careerpuck')) {
      jobBoardTabs.push(tab);
    } else {
      otherTabs.push(tab);
    }
  }

  console.log(`📊 Tab Audit Summary: Total Tabs=${tabs.length} | Form Tabs=${jobBoardTabs.length} | Confirmation Tabs=${confirmationTabs.length}\n`);

  if (confirmationTabs.length > 0) {
    console.log(`${colors.bright}${colors.green}🎉 CONFIRMED / SUBMITTED TABS:${colors.reset}`);
    for (const tab of confirmationTabs) {
      console.log(`   - [${tab.title || 'Confirmation Page'}] (${tab.url})`);
    }
    console.log('');
  }

  if (jobBoardTabs.length > 0) {
    console.log(`${colors.bright}${colors.cyan}📋 OPEN JOB BOARD FORM TABS:${colors.reset}`);
    for (const tab of jobBoardTabs) {
      const matchingApp = apps.find(a => tab.url.toLowerCase().includes(a.company.toLowerCase().replace(/[^a-z0-9]/g, '')) || tab.title.toLowerCase().includes(a.company.toLowerCase()));
      if (matchingApp) {
        const isStale = matchingApp.status === 'Applied' || matchingApp.status === 'Discarded' || matchingApp.status === 'Rejected';
        const statusBadge = isStale ? `${colors.yellow}[Stale: Tracker shows ${matchingApp.status}]${colors.reset}` : `${colors.green}[Active: #${matchingApp.num} ${matchingApp.status}]${colors.reset}`;
        console.log(`   - ${statusBadge} ${matchingApp.company} — ${matchingApp.role} (${tab.url})`);
      } else {
        console.log(`   - ${colors.cyan}[Unmatched Form]${colors.reset} ${tab.title} (${tab.url})`);
      }
    }
    console.log('');
  }
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
