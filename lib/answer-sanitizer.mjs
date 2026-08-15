/**
 * answer-sanitizer.mjs — turn a report's Section H draft answer into clean plain
 * text for an ATS form field, and audit what actually landed in the field.
 *
 * Two exports:
 *   sanitizeAnswer(text)        → plain-text string safe to type into a form
 *   auditAnswer(label, value, opts) → array of {code, severity, detail} problems
 *
 * The sanitizer is deliberately conservative: it strips markdown *syntax* and
 * never rewrites the candidate's words. Anything it cannot confidently clean is
 * left alone and caught by auditAnswer instead, so a human-visible problem
 * surfaces rather than a silent corruption.
 */

// ── Preamble / meta-commentary that models emit around a real answer ──────────

const PREAMBLE_RE =
  /^\s*(?:(?:\*\*)?(?:draft\s*)?(?:response|answer|answers)(?:\*\*)?\s*[:\-–—]\s*|(?:sure|certainly|absolutely|of course)[,!]?\s+(?:here(?:'s| is)|I'd|I would)[^\n]*[:\n]\s*|here(?:'s| is)\s+(?:my|the|a)\s+[^\n]{0,60}?[:\n]\s*|as an ai[^\n]*\n)/i;

// Trailing commentary the model appends *about* the answer.
const TRAILING_META_RE =
  /\n+\s*(?:\*\*)?(?:why this (?:works|answer works)|note to (?:self|user)|word count|character count|rationale)\b[\s\S]*$/i;

/**
 * Strip markdown syntax while preserving the text and any URLs.
 *
 * @param {string} input - Raw answer body from a report's Section H.
 * @returns {string} Plain text suitable for a textarea or input.
 */
export function sanitizeAnswer(input) {
  let t = String(input ?? '');
  if (!t.trim()) return '';

  // Normalize line endings and remove zero-width/BOM characters that survive
  // copy-paste and show up as invisible junk inside ATS fields.
  t = t.replace(/\r\n?/g, '\n').replace(/[​-‍﻿]/g, '');

  // Fenced code blocks → keep the code, drop the fences and language tag.
  t = t.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, '$1');
  t = t.replace(/^[ \t]*```[^\n]*$/gm, '');

  // Images first (they look like links): ![alt](url) → alt
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Links: keep the URL, because portfolio/GitHub links are often the point of
  // the answer. [text](url) → "text (url)", collapsing when they duplicate.
  t = t.replace(/\[([^\]]*)\]\(\s*(<)?([^)\s>]+)(>)?[^)]*\)/g, (_m, text, _lt, url) => {
    const label = String(text).trim();
    if (!label) return url;
    if (!/^(https?:|mailto:)/i.test(url)) return label;
    const bare = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (label === url || label === bare) return url;
    return `${label} (${url})`;
  });

  // Reference-style link definitions on their own line.
  t = t.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '');

  // Headings, blockquotes, horizontal rules.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '');

  // Model preamble and trailing self-commentary. Runs *after* block markers are
  // stripped, so a "> **Draft Response:** …" blockquote is caught too.
  t = t.replace(PREAMBLE_RE, '');
  t = t.replace(TRAILING_META_RE, '');

  // Tables: drop separator rows entirely, turn body rows into comma-joined
  // prose. Done line-by-line so removing a separator can't splice two rows
  // together ("Metric, ValueLatency, 15ms").
  t = t
    .split('\n')
    .filter(line => !/^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/.test(line) || !/-/.test(line))
    .map(line => {
      const m = line.match(/^\s*\|(.+)\|\s*$/);
      if (!m) return line;
      return m[1].split('|').map(c => c.trim()).filter(Boolean).join(', ');
    })
    .join('\n');

  // Inline code — do this before emphasis so backticked *text* is left alone.
  t = t.replace(/`([^`\n]+)`/g, '$1');

  // Bold, then italic. Emphasis markers must hug non-space content, which stops
  // a lone asterisk mid-sentence from swallowing the rest of the line.
  t = t.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '$1');
  t = t.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '$1');
  t = t.replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1');

  // Underscore italics ONLY at word boundaries. Without this guard, the old
  // /_(.*?)_/ turned "apply_automator.mjs" into "applyautomator.mjs" and
  // "experience_start_date" into "experiencestart_date" — silent corruption of
  // exactly the technical identifiers these answers are made of.
  t = t.replace(/(^|[\s(["'])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s.,;:!?)\]"']|$)/g, '$1$2');

  // List markers: strip bullets, keep numbered lists (they read as prose).
  t = t.replace(/^\s*[-*+]\s+/gm, '');

  // Escaped markdown characters back to literals.
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

  // Leftover stray emphasis markers the paired rules could not match.
  t = t.replace(/\*\*/g, '').replace(/(^|\s)\*(\s|$)/g, '$1$2');

  // Whitespace normalization.
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.trim();

  // Strip quotes wrapping the entire answer.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    if (!inner.includes(t[0])) t = inner.trim();
  }

  return t;
}

// ── Audit ────────────────────────────────────────────────────────────────────

const MARKDOWN_RESIDUE = [
  [/\*\*/, 'bold markers (**)'],
  [/^\s{0,3}#{1,6}\s/m, 'heading marker (#)'],
  [/`/, 'backtick'],
  [/\]\(/, 'markdown link syntax'],
  [/^\s*\|.*\|/m, 'table pipes'],
  [/^\s{0,3}>\s/m, 'blockquote marker'],
  [/^\s*[-*+]\s+\S/m, 'bullet marker'],
  [/^\s{0,3}(?:[-*_]\s*){3,}$/m, 'horizontal rule'],
];

const PLACEHOLDER_RE =
  /(\{\{[^}]*\}\}|\[(?:COMPANY|ROLE|NAME|INSERT|X+)\]|<insert[^>]*>|\bTODO\b|\bTBD\b|\bLorem ipsum\b|\bXXXX\b)/i;

const SPILLAGE_RE = /(^|\n)\s*#{2,6}\s+\S|(^|\n)\s*\*\*[^*\n]{4,}\*\*\s*\n/;

/**
 * Inspect one filled field for content that should not be there.
 *
 * @param {string} label - The field's visible label.
 * @param {string} value - What is actually in the field right now.
 * @param {{multiline?: boolean, required?: boolean, maxLength?: number}} [opts]
 * @returns {Array<{code: string, severity: 'error'|'warn', detail: string}>}
 */
export function auditAnswer(label, value, opts = {}) {
  const problems = [];
  const v = String(value ?? '');
  const l = String(label ?? '').trim();
  const add = (code, severity, detail) => problems.push({ code, severity, detail });

  if (opts.required && !v.trim()) {
    add('empty-required', 'error', 'required field is empty');
    return problems;
  }
  if (!v.trim()) return problems;

  for (const [re, what] of MARKDOWN_RESIDUE) {
    if (re.test(v)) add('markdown-residue', 'error', `contains ${what}`);
  }

  if (PLACEHOLDER_RE.test(v)) {
    add('placeholder', 'error', `unfilled placeholder: ${v.match(PLACEHOLDER_RE)[0]}`);
  }

  if (PREAMBLE_RE.test(v)) {
    add('preamble', 'error', 'starts with model preamble ("Here is my answer", "Draft Response:", …)');
  }

  // The field echoes its own question back at the reader.
  if (l.length > 12) {
    const stem = l.replace(/[*:?]/g, '').trim().split(/\s+/).slice(0, 6).join(' ').toLowerCase();
    if (stem.length > 10 && v.toLowerCase().replace(/[*:?]/g, '').trim().startsWith(stem)) {
      add('label-echo', 'warn', 'answer repeats the question text');
    }
  }

  // More than one question's worth of content in a single field. Checked two
  // ways, because sanitizing strips the '###' markers that make it obvious —
  // after sanitizing, the tell is several short interrogative lines.
  if (SPILLAGE_RE.test(v)) {
    add('multi-answer-spillage', 'error', 'looks like more than one Q/A block was pasted in');
  } else {
    const questionLines = v
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.endsWith('?') && s.length >= 6 && s.length < 140);
    if (questionLines.length >= 2) {
      add('multi-answer-spillage', 'error',
        `${questionLines.length} question-like lines — another question's block may have bled in`);
    }
  }

  if (opts.multiline === false && /\n/.test(v)) {
    add('newline-in-single-line', 'error', 'newline inside a single-line input');
  }

  if (opts.maxLength && v.length > opts.maxLength) {
    add('over-max-length', 'error', `${v.length} chars exceeds field max of ${opts.maxLength}`);
  }

  if (v.length > 2200) {
    add('suspiciously-long', 'warn', `${v.length} chars — check a whole report section did not land here`);
  }

  if (/\b(as an ai|language model|I cannot|I'm unable to)\b/i.test(v)) {
    add('model-voice', 'error', 'contains assistant-voice text');
  }

  return problems;
}

/**
 * Convenience: sanitize, then audit the sanitized result.
 *
 * @returns {{value: string, problems: Array}}
 */
export function prepareAnswer(label, raw, opts = {}) {
  const value = sanitizeAnswer(raw);
  return { value, problems: auditAnswer(label, value, opts) };
}
