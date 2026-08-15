#!/usr/bin/env node

/**
 * audit-applied-without-confirmation.mjs — zero-LLM-token tracker-integrity audit.
 *
 * data/applications.md rows are supposed to move to status=Applied only once a
 * human has reviewed and clicked Submit. apply_automator.mjs (and manual fill
 * runs) sometimes write status=Applied right after a successful *fill*, before
 * any submit confirmation — those rows carry their own "REMAINING for user...
 * then review and submit" / "verified NOT submitted" language in the Notes
 * column but never get a later note confirming the actual submission. This
 * script greps for exactly that mismatch so it doesn't have to be re-derived
 * by hand every run (see suggestions/2026-06-28-1404-apply-pause-plus-tracker-integrity-finding.md).
 *
 * Read-only: does not modify data/applications.md. No network, no Chrome/CDP.
 *
 * Usage: node audit-applied-without-confirmation.mjs
 */

import { readFileSync, existsSync } from 'fs';

const FILE = 'data/applications.md';

if (!existsSync(FILE)) {
  console.error(`${FILE} not found`);
  process.exit(1);
}

const UNCONFIRMED_PATTERNS = [
  /REMAINING for user/i,
  /NOT YET SUBMITTED/i,
  /verified NOT submitted/i,
  /left in Chrome for user review/i,
  /awaiting (user )?review/i,
];

const CONFIRMED_PATTERNS = [
  /reviewed and submitted/i,
  /user confirmed/i,
  /confirmed via/i,
  /confirmed submission/i,
  /\*\*APPLIED \d{4}-\d{2}-\d{2}\*\*/,
];

const REVERTED_CORRECTION_PATTERN = /corrected from ["']?Applied["']? to ["']?Evaluated["']?/i;

const lines = readFileSync(FILE, 'utf8').split('\n');
const flagged = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || trimmed.includes('---') || /\|\s*#\s*\|/.test(trimmed)) continue;

  const cols = trimmed.split('|').map(s => s.trim());
  // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
  const [, num, date, company, role, , status, , , notes] = cols;
  if (!num || status !== 'Applied' || !notes) continue;

  const hasUnconfirmedLanguage = UNCONFIRMED_PATTERNS.some(p => p.test(notes));
  const hasConfirmedLanguage = CONFIRMED_PATTERNS.some(p => p.test(notes));
  const revertedCorrection = REVERTED_CORRECTION_PATTERN.test(notes);

  if (revertedCorrection) {
    flagged.push({ num, date, company, role, reason: 'REVERTED CORRECTION — note documents Applied→Evaluated fix that did not stick' });
  } else if (hasUnconfirmedLanguage && !hasConfirmedLanguage) {
    flagged.push({ num, date, company, role, reason: 'unconfirmed — fill-only language, no later submit confirmation' });
  }
}

if (flagged.length === 0) {
  console.log('No unconfirmed Applied rows found.');
} else {
  console.log(`${flagged.length} Applied row(s) with no confirmed-submission language:\n`);
  for (const f of flagged) {
    console.log(`#${f.num}\t${f.date}\t${f.company} — ${f.role}`);
    console.log(`\t${f.reason}\n`);
  }
}
