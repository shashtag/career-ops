#!/usr/bin/env node

/**
 * audit-form-fill.mjs — read back every field of the live application form and
 * report what is wrong with it, before anyone clicks Submit.
 *
 * Read-only. It never types, clicks, or navigates. It attaches to Chrome over
 * CDP (port 9222), finds the frame that actually holds the form, and checks
 * each field's current value with lib/answer-sanitizer.mjs.
 *
 * Usage:
 *   node audit-form-fill.mjs                 # audit the active tab over CDP, JSON out
 *   node audit-form-fill.mjs --summary       # human-readable table
 *   node audit-form-fill.mjs --url <substr>  # pick the tab whose URL contains substr
 *   node audit-form-fill.mjs --stdin         # audit an agent-collected dump (no CDP)
 *   node audit-form-fill.mjs --collector     # print the JS the agent should evaluate
 *
 * --stdin is the browser-agent path: the agent evaluates the snippet from
 * --collector in the page and pipes the JSON back here, so the same gate runs
 * whether or not Chrome was started with a debug port.
 *
 * Exit codes: 0 = clean, 1 = problems found, 2 = could not audit.
 */

import { readFileSync } from 'fs';
import { auditAnswer } from './lib/answer-sanitizer.mjs';
import { COLLECT_EXPRESSION, parseCollected } from './lib/collect-fields.mjs';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const useStdin = args.includes('--stdin');
const urlIdx = args.indexOf('--url');
const urlFilter = urlIdx !== -1 ? args[urlIdx + 1] : null;

if (args.includes('--collector')) {
  console.log(COLLECT_EXPRESSION);
  process.exit(0);
}

const CDP = 'http://localhost:9222';

// The collector lives in lib/collect-fields.mjs so the pre-fill resolver and this
// pre-submit gate always see the identical field shape.
const COLLECT = COLLECT_EXPRESSION;

async function cdp(path) {
  const res = await fetch(CDP + path);
  if (!res.ok) throw new Error(`CDP ${path} → ${res.status}`);
  return res.json();
}

/** Evaluate an expression in one target via a short-lived CDP websocket. */
function evalInTarget(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false },
    }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(msg.error.message));
      const r = msg.result && msg.result.result;
      if (!r || r.value === undefined) return reject(new Error('no result'));
      resolve(r.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

function fail(msg, code = 2) {
  if (summary) console.error(`audit: ${msg}`);
  else console.log(JSON.stringify({ ok: false, error: msg, fields: [], problems: [] }, null, 2));
  process.exit(code);
}

async function collectFromStdin() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8').trim(); } catch { /* no stdin */ }
  if (!raw) fail('--stdin given but nothing on stdin');
  try {
    return parseCollected(raw);
  } catch (e) {
    fail(`bad stdin payload: ${e.message}`);
  }
}

async function collectOverCdp() {
  let targets;
  try {
    targets = await cdp('/json/list');
  } catch {
    fail('Chrome CDP not reachable on :9222 (use --collector + --stdin via the browser agent instead)');
  }

  let pages = targets.filter(t => t.type === 'page' && t.url && t.url.startsWith('http'));
  if (urlFilter) pages = pages.filter(t => t.url.includes(urlFilter));
  if (!pages.length) fail(urlFilter ? `no tab matching "${urlFilter}"` : 'no http tabs open');

  // The form usually lives in the tab with the most fields — including
  // cross-origin iframes, which show up as their own CDP targets.
  const iframes = targets.filter(t => t.type === 'iframe' && t.url && t.url.startsWith('http'));
  const candidates = [...pages, ...(urlFilter ? iframes.filter(t => t.url.includes(urlFilter)) : iframes)];

  let best = null;
  for (const t of candidates) {
    if (!t.webSocketDebuggerUrl) continue;
    try {
      const raw = await evalInTarget(t.webSocketDebuggerUrl, COLLECT);
      const parsed = JSON.parse(raw);
      if (!best || parsed.fields.length > best.fields.length) best = parsed;
    } catch { /* target not evaluable — skip */ }
  }

  if (!best || !best.fields.length) fail('no form fields found in any frame');
  return best;
}

async function main() {
  const best = useStdin ? await collectFromStdin() : await collectOverCdp();

  const rows = [];
  for (const f of best.fields) {
    const problems = auditAnswer(f.label, f.value, {
      // lib/collect-fields.mjs sets `multiline` from the tag name, but --stdin
      // accepts whatever JSON it is handed. A payload without the key would
      // leave `multiline` undefined, and the newline-in-single-line check only
      // fires on an explicit false — so the gate would quietly drop a check on
      // the last step before a submit. Fall back to the field's own type.
      multiline: f.multiline ?? (String(f.type ?? '').toLowerCase() === 'textarea'),
      required: f.required,
      maxLength: f.maxLength,
    });
    if (problems.length) rows.push({ ...f, problems });
  }

  const errors = rows.filter(r => r.problems.some(p => p.severity === 'error'));

  if (summary) {
    console.log(`Form: ${best.url}`);
    console.log(`Fields: ${best.fields.length}   Flagged: ${rows.length}   Errors: ${errors.length}\n`);
    for (const r of rows) {
      const worst = r.problems.some(p => p.severity === 'error') ? 'ERROR' : 'warn ';
      console.log(`${worst}  ${r.label}`);
      for (const p of r.problems) console.log(`        - ${p.code}: ${p.detail}`);
      const preview = r.value.replace(/\n/g, '\\n').slice(0, 110);
      console.log(`        value: ${preview}${r.value.length > 110 ? '…' : ''}\n`);
    }
    if (!rows.length) console.log('All fields clean.');
  } else {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      url: best.url,
      fieldCount: best.fields.length,
      flagged: rows.length,
      errors: errors.length,
      problems: rows,
    }, null, 2));
  }

  process.exit(errors.length ? 1 : 0);
}

main().catch(e => fail(e.message));
