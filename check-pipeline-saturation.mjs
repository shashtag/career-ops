#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCompanyCaps, normalizeCompanyKey } from './lib/company-caps.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PATHS = {
  pipeline: join(__dirname, 'data', 'pipeline.md'),
};

function main() {
  if (!existsSync(PATHS.pipeline)) {
    console.error(`Error: pipeline.md not found at ${PATHS.pipeline}`);
    process.exit(1);
  }

  // 1. Get 30-day company caps (now includes Rejected status too)
  const caps = getCompanyCaps(2, 30);

  // 2. Read unchecked items from pipeline.md
  const pipelineContent = readFileSync(PATHS.pipeline, 'utf-8');
  const lines = pipelineContent.split('\n');

  const pendingCompanies = new Set();
  let inPendientes = false;
  let totalUnchecked = 0;

  for (const line of lines) {
    if (line.trim().startsWith('## Pendientes') || line.trim().startsWith('## Pending')) {
      inPendientes = true;
      continue;
    }
    if (line.trim().startsWith('## Procesadas') || line.trim().startsWith('## Processed')) {
      inPendientes = false;
    }

    if (inPendientes && line.trim().startsWith('- [ ]')) {
      totalUnchecked++;
      const parts = line.trim().slice(5).split('|').map(p => p.trim());
      const company = parts[1];
      if (company && !company.startsWith('http') && company.length < 50) {
        pendingCompanies.add(company.trim());
      }
    }
  }

  const cappedCompanies = [];
  const eligibleCompanies = [];
  const capBreakdown = {};

  for (const company of pendingCompanies) {
    // Normalized key, not the raw lowercase name: caps are grouped by company,
    // not by spelling (lib/company-caps.mjs).
    const compKey = normalizeCompanyKey(company);
    const count = caps[compKey]?.count || 0;
    capBreakdown[company.toLowerCase()] = count;

    if (count >= 2) {
      cappedCompanies.push(company);
    } else {
      eligibleCompanies.push(company);
    }
  }

  // Sort lists alphabetically for clean output
  cappedCompanies.sort();
  eligibleCompanies.sort();

  const output = {
    total_unchecked: totalUnchecked,
    total_unique_pending_companies: pendingCompanies.size,
    capped_companies: cappedCompanies,
    eligible_companies: eligibleCompanies,
    cap_breakdown: capBreakdown
  };

  const isSummary = process.argv.includes('--summary');

  if (isSummary) {
    console.log(`=========================================`);
    console.log(`📊 PIPELINE SATURATION SUMMARY`);
    console.log(`=========================================`);
    console.log(`Total Unchecked Positions: ${totalUnchecked}`);
    console.log(`Unique Pending Companies:  ${pendingCompanies.size}`);
    console.log(`Eligible Companies:       ${eligibleCompanies.length}`);
    console.log(`Capped Companies:         ${cappedCompanies.length}`);
    console.log(`=========================================`);
    if (eligibleCompanies.length > 0) {
      console.log(`🟢 Eligible:\n  - ${eligibleCompanies.join('\n  - ')}`);
    } else {
      console.log(`🔴 NO ELIGIBLE COMPANIES FOUND IN PIPELINE BACKLOG!`);
    }
    console.log(`=========================================`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  if (eligibleCompanies.length === 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main();
