#!/usr/bin/env node
import { getCompanyCaps } from './lib/company-caps.mjs';

// Counts "Applied" rows per company in the past 30 days from data/applications.md.
// Also includes never-applied-to companies that still have pending rows in data/pipeline.md.
// Usage: node check-company-cap.mjs ["Company Name"]

const counts = {};
const caps = getCompanyCaps();
for (const [companyLower, info] of Object.entries(caps)) {
  counts[info.name] = info.count;
}

const target = process.argv[2];
if (target) {
  const match = Object.keys(counts).find(c => c.toLowerCase() === target.toLowerCase());
  const n = match ? counts[match] : 0;
  console.log(`${target}: ${n}/2 applications in past 30 days${n >= 2 ? ' — AT CAP, pick another company' : ' — OK to apply'}`);
} else {
  // Sort by count descending, then alphabetically by company name
  const sorted = Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  for (const [company, n] of sorted) {
    console.log(`${n >= 2 ? '🔴' : '🟢'} ${company}: ${n}`);
  }
}
