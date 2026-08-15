/**
 * lib/tracker.mjs — Shared tracker parsing for career-ops
 *
 * Single source of truth for parsing applications.md markdown table rows.
 * Eliminates duplication across merge-tracker, dedup-tracker, verify-pipeline,
 * analyze-patterns, and followup-cadence.
 *
 * Consumers:
 *   merge-tracker.mjs, dedup-tracker.mjs, verify-pipeline.mjs,
 *   analyze-patterns.mjs, followup-cadence.mjs
 */

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a single markdown table row from applications.md into a structured object.
 *
 * Expected column layout (pipe-delimited):
 *   | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
 *
 * @param {string} line — A single line from applications.md
 * @returns {{ num: number, date: string, company: string, role: string,
 *             score: string, status: string, pdf: string, report: string,
 *             notes: string, raw: string } | null}
 *   Parsed entry or null if the line is not a valid data row.
 */
export function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    report: parts[8],
    notes: parts[9] || '',
    raw: line,
  };
}

/**
 * Read and parse all data rows from an applications.md file.
 *
 * Skips header rows (containing `---`, `#`, `Company`, `Empresa`),
 * blank lines, and non-table lines.
 *
 * @param {string} filePath — Absolute or relative path to applications.md
 * @returns {Array<{ num: number, date: string, company: string, role: string,
 *                    score: string, status: string, pdf: string, report: string,
 *                    notes: string, raw: string }>}
 */
export function parseTrackerFile(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    // Skip header/separator rows
    if (line.includes('---') || line.includes('| # |') || line.includes('Empresa')) continue;
    const entry = parseAppLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}
