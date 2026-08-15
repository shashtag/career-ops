#!/usr/bin/env node

/**
 * run-pipeline.mjs — Single unified orchestrator for career-ops job search.
 *
 * Coordinates:
 *   1. Scan (Optional) — Run portal scanner to fetch fresh jobs into pipeline.md
 *   2. Liveness — Check Playwright status to identify closed/expired offers
 *   3. Evaluate — Scrape JD, run Gemini 7-Block scoring, and auto-tailor CV
 *   4. Apply — Autocomplete standard and custom questions inside Chrome (CDP 9222)
 *
 * Usage:
 *   node run-pipeline.mjs --scan --priority 1
 *   node run-pipeline.mjs --priority 1 --limit 5
 *   node run-pipeline.mjs --classify-only
 */

import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync, writeFileSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const LOCK_FILE = '/tmp/career-ops.lock';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bgBlue: '\x1b[44m'
};

// Check single-flight lock
if (existsSync(LOCK_FILE)) {
  const stats = statSync(LOCK_FILE);
  const ageMs = Date.now() - stats.mtimeMs;
  if (ageMs < 90 * 60 * 1000) {
    console.warn(`${colors.yellow}⚠️ Another career-ops run is active (lock file age: ${Math.round(ageMs / 60000)}m) — skipping this cycle to prevent process overlap.${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`${colors.cyan}ℹ️ Stale lock file found (age: ${Math.round(ageMs / 60000)}m) — breaking lock.${colors.reset}`);
  }
}

// Create lock file
try {
  writeFileSync(LOCK_FILE, process.pid.toString(), 'utf-8');
} catch (e) {
  console.warn(`${colors.yellow}⚠️ Failed to create lock file: ${e.message}${colors.reset}`);
}

// Setup exit cleanup
function cleanup() {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch (e) {}
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  cleanup();
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);

  // Help flag safety handler
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node run-pipeline.mjs [options]

Options:
  --scan             Run the portal scanner (scan.mjs) before evaluation
  --india            Filter pipeline entries for India-eligible roles only
  --priority <1|2>   Set the candidate priority level (default: 1)
  --limit <number>   Limit the number of evaluations to run
  --classify-only    Run only classification without full evaluations
  --help, -h         Show this help message
    `);
    process.exit(0);
  }

  console.log(`\n${colors.bright}${colors.bgBlue}          CAREER-OPS PIPELINE ORCHESTRATOR           ${colors.reset}\n`);

  // 1. Scan Phase (Optional)
  if (args.includes('--scan')) {
    console.log(`${colors.bright}${colors.cyan}--- Phase 1: Scanning Portals ---${colors.reset}`);
    const scanResult = spawnSync('node', ['scan.mjs'], { cwd: ROOT, stdio: 'inherit' });
    
    if (scanResult.status !== 0) {
      console.warn(`${colors.yellow}⚠️  Scan warning or failure encountered. Proceeding to evaluation phase.${colors.reset}\n`);
    } else {
      console.log(`${colors.green}✅ Portal scan completed successfully.${colors.reset}\n`);
    }
  }

  // Filter out the --scan flag to pass the remaining flags down to the evaluator
  const passedArgs = args.filter(arg => arg !== '--scan');

  // If no priority is specified and we are not doing classify-only, default to priority 1 (India + Remote/Global)
  if (!passedArgs.includes('--priority') && !passedArgs.includes('--classify-only')) {
    passedArgs.push('--priority', '1');
    console.log(`${colors.yellow}ℹ️  No priority specified. Defaulting to Priority 1 (India + Remote/Global).${colors.reset}`);
  }

  // If no interactive flag is passed and it's not a dry run, run non-interactively
  if (!passedArgs.includes('--non-interactive')) {
    passedArgs.push('--non-interactive');
  }

  console.log(`${colors.bright}${colors.cyan}--- Phase 2: Liveness, Evaluation & Apply ---${colors.reset}`);
  console.log(`Running: node scratch/evaluate-pipeline.mjs ${passedArgs.join(' ')}\n`);

  const evalResult = spawnSync('node', ['scratch/evaluate-pipeline.mjs', ...passedArgs], {
    cwd: ROOT,
    stdio: 'inherit'
  });

  if (evalResult.status !== 0) {
    console.error(`\n❌ Pipeline execution encountered an error (exit code: ${evalResult.status}).`);
    process.exit(evalResult.status || 1);
  }

  console.log(`\n${colors.green}🎉 Pipeline execution completed successfully.${colors.reset}\n`);
}

main().catch(err => {
  console.error('Fatal orchestrator error:', err);
  process.exit(1);
});
