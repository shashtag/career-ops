/**
 * blacklist.mjs — the candidate's do-not-apply company list.
 *
 * `data/blacklist.md` is user layer and opt-in: an absent file means no gate,
 * and nothing ever adds a company to it automatically (DATA_CONTRACT.md).
 *
 * WHY THIS IS SHARED. The parser lived inline in rank-queue.mjs, so the gate
 * existed exactly where that file ran. The headless evaluator
 * (scratch/evaluate-pipeline.mjs) never had it, and the model it calls has no
 * file tools — so `modes/oferta.md`'s "Blacklist gate" could not run there
 * either from the script side or the prompt side. A company the candidate had
 * explicitly recorded as do-not-apply got a full evaluation, a report, and a
 * tracker row.
 *
 * The gate is not a scoring input. It is absolute: `modes/_custom.md` gives it
 * a 0.0x multiplier and calls it the one hard gate among the preference
 * signals.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PATH = join(ROOT, 'data', 'blacklist.md');

/**
 * Rows that are table furniture rather than companies. A markdown table's
 * header and separator would otherwise parse as entries — and an entry of
 * "company" matches every company name by substring, blacklisting the entire
 * pipeline from a header row.
 * @type {Set<string>}
 */
const NOT_A_COMPANY = new Set(['company', 'companies', 'name', 'since', 'reason', 'notes', 'date']);

/**
 * Parse blacklist text into lowercase company fragments.
 *
 * An entry must be MARKED as one — a bullet (`- Acme`) or a table row
 * (`| Acme | 2026-01-01 | ghosted |`). A bare prose line is documentation and
 * is ignored.
 *
 * That rule is not fussiness. Entries match by substring, so any line that
 * slips through becomes a filter over every company name: the prose sentence
 * "matched case-insensitively as a substring of the company name" parsed as an
 * entry the first time this file was written, and a header row yields
 * "company", which matches everything. rank-queue.mjs's original inline parser
 * accepted bare lines and had exactly this hole. Requiring a marker means a
 * blacklist can only ever contain things somebody deliberately listed.
 *
 * Only the first cell is the company; everything after the first `|` is
 * context for the human.
 *
 * @param {string} text
 * @returns {string[]} Lowercase fragments, matched as substrings of a company name.
 */
export function parseBlacklist(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    // Must be a bullet or a table row. Anything else is prose.
    if (!/^([-*]\s|\|)/.test(line)) continue;
    // A markdown separator row (|---|---|) carries no company.
    if (/^\|?[\s:|-]+\|?$/.test(line)) continue;
    const cell = line.replace(/^[-*|\s]+/, '').split('|')[0].trim().toLowerCase();
    if (!cell || cell.length < 2) continue;
    if (NOT_A_COMPANY.has(cell)) continue;
    out.push(cell);
  }
  return [...new Set(out)];
}

/**
 * Load the blacklist. Absent file → empty list → no gate.
 * @param {string} [path=DEFAULT_PATH]
 * @returns {string[]}
 */
export function loadBlacklist(path = DEFAULT_PATH) {
  if (!existsSync(path)) return [];
  try {
    return parseBlacklist(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Is this company blacklisted? Substring match on a normalized name, so
 * "Acme Corp." on the list catches a JD that says "acme corp" — the
 * case- and punctuation-insensitive matching `modes/oferta.md` specifies.
 *
 * @param {string} company
 * @param {string[]} blacklist - From loadBlacklist().
 * @returns {string|null} The matching entry, or null.
 */
export function blacklistMatch(company, blacklist) {
  if (!blacklist?.length) return null;
  const name = String(company ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  for (const entry of blacklist) {
    const e = entry.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (e && name.includes(e)) return entry;
  }
  return null;
}
