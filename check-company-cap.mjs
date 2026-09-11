#!/usr/bin/env node

/**
 * check-company-cap.mjs — "does this company have room under the 2-per-30-days
 * cap?", answered without grepping the tracker by hand.
 *
 * The cap is 2 roles per company per 30 days (modes/_profile.md is the
 * authority). Until now this script keyed counts on the literal company string,
 * so `Sarvam` and `Sarvam AI` — or `NVIDIA` and `Nvidia`, both live in this
 * tracker right now — read as two different companies at 1/2 each when the real
 * count was 2/2. That is why modes/_run.md, modes/_custom.md and
 * modes/_profile.md all told the agent to ignore this script and recount by
 * hand, against a 330KB tracker whose rows can run to 6KB of notes apiece.
 *
 * lib/company-caps.mjs now normalizes the name (see normalizeCompanyKey), and
 * this prints the rows that make up the count, so the hand-recount has nothing
 * left to add. `Rejected` has always counted here and still does — only
 * `Evaluated`, `Discarded` and `SKIP` are free.
 *
 * Usage:
 *   node check-company-cap.mjs                 # every company, worst first
 *   node check-company-cap.mjs "Sarvam"        # one company, with its rows
 *   node check-company-cap.mjs "Sarvam" --json
 *   node check-company-cap.mjs --at-cap        # only the companies with no room
 *
 * Exit 0 = has room (or listing mode) · 3 = at or over cap.
 */

import { getCompanyCaps, getCompanyCap } from './lib/company-caps.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const LIMIT = 2;
const DAYS = 30;

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log('Usage: node check-company-cap.mjs ["Company Name"] [--json] [--at-cap]\n\n'
      + `Cap is ${LIMIT} roles per company per ${DAYS} days. Name matching is variant-aware\n`
      + '("Sarvam" and "Sarvam AI" are one company). Exit 3 = at or over cap.');
    return 0;
  }

  const json = hasFlag(args, '--json');
  const target = args.find((a) => !a.startsWith('--'))
    ?? flagValue(args, '--company');

  if (target) {
    const cap = getCompanyCap(target, LIMIT, DAYS);
    if (json) {
      console.log(JSON.stringify(cap, null, 2));
      return cap.atCap ? 3 : 0;
    }
    const verdict = cap.atCap ? 'AT CAP, pick another company' : 'OK to apply';
    console.log(`${cap.name}: ${cap.count}/${LIMIT} applications in the past ${DAYS} days — ${verdict}`);
    for (const r of cap.rows) {
      console.log(`  ${r.date}  ${r.status.padEnd(10)} #${String(r.num).padEnd(4)} ${r.role}`);
    }
    if (cap.variants.length > 1) {
      console.log(`  counted across name variants: ${cap.variants.join(' | ')}`);
    }
    if (!cap.rows.length) console.log('  (no consuming rows in the window)');
    return cap.atCap ? 3 : 0;
  }

  const caps = getCompanyCaps(LIMIT, DAYS);
  const rows = Object.values(caps)
    .filter((c) => (hasFlag(args, '--at-cap') ? c.count >= LIMIT : true))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const c of rows) {
    const variants = c.variants.length > 1 ? `  (${c.variants.join(' | ')})` : '';
    console.log(`${c.count >= LIMIT ? '🔴' : '🟢'} ${c.name}: ${c.count}${variants}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv);
}
