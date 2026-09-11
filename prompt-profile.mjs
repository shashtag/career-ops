#!/usr/bin/env node

/**
 * prompt-profile.mjs — trim the evaluation prompt to what the caller can
 * actually do.
 *
 * `modes/oferta.md` is written for the agent path, where the model has a
 * browser, web search and file tools. `scratch/evaluate-pipeline.mjs` calls a
 * bare Gemini model with none of them, and says so in its own operating rules:
 *
 *   "You do NOT have access to WebSearch, Playwright, or file writing tools.
 *    For Block G: analyze the JD text only; skip URL/page freshness checks.
 *    Post-evaluation file saving is handled by the script, not by you."
 *
 * It then ships the full 20k-token mode file anyway. This module removes the
 * blocks that caller provably cannot execute, and nothing else.
 *
 * WHAT IS AND IS NOT REMOVED — every entry below was checked against the 294
 * Gemini-written reports already in `reports/`, because "the model can't do
 * this" is a claim about behaviour, not about tool lists:
 *
 *   REMOVED — the four jurisdiction-table signals (10, 11, 12) and the two
 *   tool-only gates. Signals 10-12 each open with "read templates/<x>.yml";
 *   with no file tools the model cannot read the table and cannot run
 *   jurisdiction-lookup.mjs either, so the signal cannot fire on evidence.
 *   It does not fall silent, which would be harmless — report 878 lists
 *   "Immigration-Status Requirement Overreach: clear" and
 *   "Jurisdiction-Prohibited Content: clear" having consulted no table at all.
 *   Removing them replaces an unsupported all-clear with an honest absence.
 *
 *   KEPT — everything the model demonstrably does do. Signal 6 carries its
 *   jurisdiction terms inline rather than in a YAML file (8 reports fire it);
 *   signals 7, 13 and 15(a) are JD-text judgements needing no table (23, 1 and
 *   3 reports); and the report template lives INSIDE "### 1. Save report .md",
 *   so removing that heading for being a file-write instruction would take the
 *   required output format with it. The two Cover Letter Draft sections read
 *   as file appends the model cannot perform — but 73 of 294 reports carry an
 *   inline cover-letter draft, so removing them would delete real content from
 *   a quarter of reports. Both stay.
 *
 * DRIFT IS LOUD. `modes/oferta.md` is system-layer and upstream renames
 * headings; a marker that no longer matches is returned in `missing` and the
 * caller warns. `tests/prompt-profile.test.mjs` fails the suite when any
 * marker stops matching, so a silent no-op trim is not a state this can reach.
 * The failure direction is safe either way: an unmatched marker means the
 * prompt keeps a block, never that it loses one.
 */

import { readFileSync } from 'fs';

/**
 * Blocks that a caller without browser / web-search / file-write tools cannot
 * execute. `marker` matches a whole trimmed line.
 *
 * `kind: 'heading'` — a markdown heading; the block runs to the next heading of
 * the same or higher level.
 * `kind: 'signal'` — a bold-numbered Block G signal (`**11. Title** (...)`);
 * the block runs to the next such signal or the next heading.
 *
 * @type {Array<{id: string, marker: string, kind: 'heading'|'signal', needs: string, why: string}>}
 */
export const TOOL_GATED_BLOCKS = [
  {
    id: 'liveness-gate',
    marker: '## Liveness gate (URL inputs)',
    kind: 'heading',
    needs: 'browser',
    why: 'needs Playwright; the caller runs its own liveness (checkUrlLivenessApi + checkLivenessText) before the model is invoked',
  },
  {
    id: 'research-budget',
    marker: '## Bounded Research Budget',
    kind: 'heading',
    needs: 'webSearch',
    why: 'budgets WebSearch queries; with no search tool there is nothing to budget',
  },
  {
    id: 'jurisdiction-lookup-preamble',
    marker: '**Jurisdiction resolution for signals 6–15',
    kind: 'signal',
    needs: 'fileRead',
    why: 'tells the reader to run jurisdiction-lookup.mjs, which a model with no tools cannot run; the signals it governs are removed below',
  },
  {
    id: 'signal-10-agency-licensing',
    marker: '**10. Agency Licensing Check**',
    kind: 'signal',
    needs: 'fileRead',
    why: 'requires templates/agency-licensing.yml; fires in 0 of 294 Gemini reports',
  },
  {
    id: 'signal-11-immigration-status',
    marker: '**11. Immigration-Status Requirement Overreach**',
    kind: 'signal',
    needs: 'fileRead',
    why: 'requires templates/immigration-status-requirements.yml; the one report that names it reports an all-clear it could not have established',
  },
  {
    id: 'signal-12-prohibited-content',
    marker: '**12. Jurisdiction-Prohibited Content**',
    kind: 'signal',
    needs: 'fileRead',
    why: 'requires templates/jurisdiction-prohibited-content.yml; same unsupported all-clear',
  },
];

const headingLevel = (line) => (line.match(/^(#{1,6})\s/)?.[1].length ?? 0);
const isSignalStart = (line) => /^\*\*\d+\.\s/.test(line.trim());

/**
 * Find one block's line range: `[start, end)`.
 *
 * @param {string[]} lines - The document, split on newlines.
 * @param {{marker: string, kind: string}} block
 * @returns {{start: number, end: number}|null} null when the marker is absent.
 */
export function findBlock(lines, block) {
  const start = lines.findIndex((l) => l.trim().startsWith(block.marker));
  if (start === -1) return null;

  if (block.kind === 'heading') {
    const level = headingLevel(lines[start]);
    for (let i = start + 1; i < lines.length; i += 1) {
      const lv = headingLevel(lines[i]);
      if (lv > 0 && lv <= level) return { start, end: i };
    }
    return { start, end: lines.length };
  }

  // signal: ends at the next bold-numbered signal or any heading
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isSignalStart(lines[i]) || headingLevel(lines[i]) > 0) return { start, end: i };
  }
  return { start, end: lines.length };
}

/**
 * Remove every listed block the caller's capabilities cannot support.
 *
 * @param {string} md - The mode file's text.
 * @param {object} [opts]
 * @param {Record<string, boolean>} [opts.capabilities] - e.g. `{browser: false,
 *   webSearch: false, fileRead: false}`. A capability absent from the object is
 *   treated as PRESENT, so an unknown caller keeps everything.
 * @param {Array} [opts.blocks=TOOL_GATED_BLOCKS]
 * @returns {{text: string, removed: Array<{id: string, lines: number, chars: number}>, missing: string[]}}
 */
export function stripToolGatedBlocks(md, { capabilities = {}, blocks = TOOL_GATED_BLOCKS } = {}) {
  if (typeof md !== 'string' || md === '') return { text: md ?? '', removed: [], missing: [] };

  const gated = blocks.filter((b) => capabilities[b.needs] === false);
  if (!gated.length) return { text: md, removed: [], missing: [] };

  const lines = md.split('\n');
  const drop = new Set();
  const removed = [];
  const missing = [];

  for (const block of gated) {
    const range = findBlock(lines, block);
    if (!range) { missing.push(block.id); continue; }
    let chars = 0;
    for (let i = range.start; i < range.end; i += 1) {
      if (!drop.has(i)) { drop.add(i); chars += lines[i].length + 1; }
    }
    removed.push({ id: block.id, lines: range.end - range.start, chars });
  }

  const text = lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{4,}/g, '\n\n\n');
  return { text, removed, missing };
}

/**
 * Convenience wrapper: read a mode file and strip it in one call.
 * @param {string} path
 * @param {Record<string, boolean>} capabilities
 * @returns {{text: string, removed: Array, missing: string[]}}
 */
export function readStripped(path, capabilities) {
  return stripToolGatedBlocks(readFileSync(path, 'utf-8').trim(), { capabilities });
}
