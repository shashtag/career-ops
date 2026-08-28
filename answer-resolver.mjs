#!/usr/bin/env node

/**
 * answer-resolver.mjs — given a collected application form, say what the
 * candidate's answer is for every field, before anything is typed.
 *
 * This is the pre-fill counterpart to audit-form-fill.mjs. Together they bracket
 * the browser work: resolve -> (agent fills) -> audit -> submit. The agent drives
 * the DOM; these two decide and verify. No per-form script in between.
 *
 * Usage:
 *   node answer-resolver.mjs --collector           # print the JS to run in the page
 *   node answer-resolver.mjs --stdin < fields.json # resolve an agent-collected dump
 *   node answer-resolver.mjs --cdp [--url <substr>]# collect over CDP :9222 and resolve
 *   node answer-resolver.mjs --ask "Expected CTC"  # resolve one label, ad hoc
 *   node answer-resolver.mjs --stdin --learn      # paste-ready store stubs for every gap
 *   ... add --summary for a human table instead of JSON
 *
 * Exit codes: 0 = every required field has an answer, 1 = required gaps, 2 = error.
 */

import { readFileSync } from 'fs';
import { COLLECT_EXPRESSION, parseCollected } from './lib/collect-fields.mjs';
import { loadStore, resolveForm, resolveField, summarize } from './lib/answer-store.mjs';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };

const summary = has('--summary');

function die(msg, code = 2) {
  if (summary) console.error(`resolver: ${msg}`);
  else console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(code);
}

if (has('--collector')) {
  // Printed so the browser agent can evaluate the exact same snippet the CDP
  // path uses — one definition of "what the form is".
  console.log(COLLECT_EXPRESSION);
  process.exit(0);
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

async function collectOverCdp(urlFilter) {
  const CDP = 'http://localhost:9222';
  let targets;
  try {
    targets = await (await fetch(`${CDP}/json/list`)).json();
  } catch {
    die('Chrome CDP not reachable on :9222 (use --stdin with an agent-collected dump instead)');
  }
  const evaluable = targets.filter(t =>
    t.webSocketDebuggerUrl && t.url?.startsWith('http') &&
    (t.type === 'page' || t.type === 'iframe') &&
    (!urlFilter || t.url.includes(urlFilter)));
  if (!evaluable.length) die(urlFilter ? `no target matching "${urlFilter}"` : 'no http targets open');

  let best = null;
  for (const t of evaluable) {
    try {
      const raw = await evalInTarget(t.webSocketDebuggerUrl, COLLECT_EXPRESSION);
      const parsed = parseCollected(raw);
      if (!best || parsed.fields.length > best.fields.length) best = parsed;
    } catch { /* not evaluable — skip */ }
  }
  if (!best || !best.fields.length) die('no form fields found in any frame');
  return best;
}

function evalInTarget(wsUrl, expression) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('timeout')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false },
    }));
    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer); try { ws.close(); } catch {}
      if (msg.error) return rej(new Error(msg.error.message));
      const r = msg.result?.result;
      if (!r || r.value === undefined) return rej(new Error('no result'));
      res(r.value);
    };
    ws.onerror = () => { clearTimeout(timer); rej(new Error('ws error')); };
  });
}

const ICON = { resolved: 'OK  ', essay: 'TEXT', generate: 'WRITE', unresolved: 'ASK ', file: 'FILE', consent: 'YOU ' };

function printSummary(url, resolved, counts) {
  if (url) console.log(`Form: ${url}`);
  console.log(`Fields: ${counts.total}   answered: ${counts.resolved}   essays: ${counts.essay}   to write: ${counts.generate}   uploads: ${counts.file}   consent: ${counts.consent}   needs you: ${counts.unresolved}`);
  if (counts.requiredBlockers) console.log(`\n!! ${counts.requiredBlockers} REQUIRED field(s) have no stored answer.\n`);
  else console.log('');

  for (const { field, resolution: r } of resolved) {
    const req = field.required ? '*' : ' ';
    console.log(`${ICON[r.status] || '?   '}${req} ${field.label}`);
    if (r.status === 'resolved') {
      const shown = r.option ?? r.answer;
      const how = r.optionMatch && !['exact', 'no-options'].includes(r.optionMatch) ? `   [option match: ${r.optionMatch}]` : '';
      const via = r.interaction === 'combobox' ? '   [combobox: open + click, do NOT type]' : '';
      console.log(`         -> ${String(shown).slice(0, 100)}${how}${via}`);
    } else if (r.status === 'essay') {
      console.log(`         -> [${r.id}] ${r.answer.length} chars, adapt: ${r.adapt}`);
      if (r.overLength) console.log(`            !! exceeds maxLength ${r.overLength} — trim before filling`);
    } else if (r.status === 'file') {
      console.log('         -> attach the tailored CV PDF from output/');
    } else if (r.status === 'consent') {
      console.log(`         -> ${r.reason}`);
    } else if (r.status === 'generate') {
      console.log(`         -> [${r.id}] write this one; no stored text by design`);
    } else {
      console.log(`         -> ${r.reason}`);
      if (field.options?.length) console.log(`            options: ${field.options.slice(0, 8).join(' | ')}`);
    }
    if (r.note) console.log(`            note: ${String(r.note).replace(/\s+/g, ' ').slice(0, 160)}`);
    if (r.confidence === 'medium') console.log('            confidence: medium — check this one');
  }
}

const STOPWORDS = new Set(['the','a','an','and','or','of','to','in','for','on','at','is','are','do','does',
  'you','your','yours','we','our','us','this','that','with','have','has','if','it','be','been','was','were',
  'what','which','how','why','when','where','please','select','choose','enter','provide','tell','describe',
  'any','all','from','by','as','not','no','yes','will','would','can','could','may','about','their','there']);

/** Distinctive phrase from a label, for a match term that will not collide. */
function matchTerms(label) {
  const words = normalizeLabelish(label).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w));
  const bigrams = [];
  for (let i = 0; i < words.length - 1 && bigrams.length < 3; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
  return bigrams.length ? bigrams : words.slice(0, 3);
}

function normalizeLabelish(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(label) {
  return normalizeLabelish(label).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 4).join('_').replace(/\./g, '') || 'unnamed';
}

/**
 * Print store entries for everything the resolver could not answer.
 *
 * This is the step that makes the next application cheaper. The agent has just
 * decided each of these answers in order to fill the form, so filling in
 * `answer:` here costs seconds — and the question never has to be decided again.
 */
function printLearnStubs(url, resolved) {
  const gaps = resolved.filter(({ resolution: r }) => r.status === 'unresolved');
  const consents = resolved.filter(({ resolution: r }) => r.status === 'consent');
  const today = new Date().toISOString().slice(0, 10);

  if (!gaps.length) {
    console.log(`# nothing to learn — every field resolved${consents.length ? ` (${consents.length} consent gate(s) intentionally left to you)` : ''}`);
    return;
  }

  console.log(`# Append to config/application-answers.yml under fields:`);
  console.log(`# Replace each REPLACE_ME with the answer you actually used, then run`);
  console.log(`#   node tests/answer-resolver.test.mjs`);
  console.log(`# Seen on ${url || 'this form'} (${today})\n`);

  for (const { field, resolution } of gaps) {
    const isLong = field.multiline || (field.maxLength && field.maxLength > 300);
    const terms = matchTerms(field.label).map(t => JSON.stringify(t)).join(', ');
    if (isLong) {
      console.log(`  # essays[] entry — long-form (${field.maxLength ? `max ${field.maxLength}` : 'no limit'})`);
      console.log(`  - id: ${slugify(field.label)}`);
      console.log(`    adapt: light            # none | light | required`);
      console.log(`    asked_as:`);
      console.log(`      any: [${terms}]`);
      console.log(`    answer: |`);
      console.log(`      REPLACE_ME`);
    } else {
      console.log(`  - id: ${slugify(field.label)}`);
      console.log(`    answer: "REPLACE_ME"`);
      console.log(`    match:`);
      console.log(`      any: [${terms}]`);
      if (field.options?.length) console.log(`    # options seen: ${field.options.slice(0, 6).join(' | ')}`);
      if (field.combobox) console.log(`    # combobox — open and click, options mount lazily`);
    }
    console.log(`    # ${field.required ? 'REQUIRED' : 'optional'} — "${String(field.label).replace(/\s+/g, ' ').slice(0, 100)}"`);
    console.log('');
  }
  console.log(`# ${gaps.length} gap(s). Leaving these unfilled means deciding them again next time.`);
}

async function main() {
  let store;
  try { store = loadStore(); } catch (e) { die(e.message); }

  if (has('--ask')) {
    const label = val('--ask');
    if (!label) die('--ask needs a label');
    const r = resolveField({ label, type: 'text', options: [], required: true }, store);
    console.log(summary ? `${r.status}: ${r.answer ?? r.reason ?? ''}` : JSON.stringify(r, null, 2));
    process.exit(r.status === 'unresolved' ? 1 : 0);
  }

  let collected;
  if (has('--stdin')) {
    const raw = readStdin().trim();
    if (!raw) die('--stdin given but nothing on stdin');
    try { collected = parseCollected(raw); } catch (e) { die(`bad stdin payload: ${e.message}`); }
  } else if (has('--cdp')) {
    collected = await collectOverCdp(val('--url'));
  } else {
    die('pick an input: --stdin, --cdp, --ask "<label>", or --collector');
  }

  const resolved = resolveForm(collected.fields, store);
  const counts = summarize(resolved);

  if (has('--learn')) { printLearnStubs(collected.url, resolved); process.exit(0); }

  if (summary) printSummary(collected.url, resolved, counts);
  else console.log(JSON.stringify({
    ok: counts.requiredBlockers === 0,
    url: collected.url,
    counts,
    fields: resolved.map(({ field, resolution }) => ({
      label: field.label, required: field.required, type: field.type,
      maxLength: field.maxLength, options: field.options?.length ? field.options : undefined,
      ...resolution,
    })),
  }, null, 2));

  process.exit(counts.requiredBlockers ? 1 : 0);
}

main().catch(e => die(e.message));
