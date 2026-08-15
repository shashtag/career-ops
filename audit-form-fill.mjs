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
 *   node audit-form-fill.mjs                 # audit the active tab, JSON out
 *   node audit-form-fill.mjs --summary       # human-readable table
 *   node audit-form-fill.mjs --url <substr>  # pick the tab whose URL contains substr
 *
 * Exit codes: 0 = clean, 1 = problems found, 2 = could not audit.
 */

import { auditAnswer } from './lib/answer-sanitizer.mjs';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const urlIdx = args.indexOf('--url');
const urlFilter = urlIdx !== -1 ? args[urlIdx + 1] : null;

const CDP = 'http://localhost:9222';

/** Collect field label/value/type from every frame, in the page's own context. */
const COLLECT = `(() => {
  const labelFor = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const ref = el.getAttribute('aria-labelledby');
    if (ref) {
      const t = ref.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean)
        .map(n => n.innerText).join(' ').trim();
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    let n = el.parentElement, hops = 0;
    while (n && hops < 4) {
      const l = n.querySelector('label, legend, .label, [class*="label"]');
      if (l && l.innerText.trim()) return l.innerText.trim();
      n = n.parentElement; hops++;
    }
    return el.name || el.placeholder || '(unlabelled)';
  };

  const out = [];
  const nodes = document.querySelectorAll('input, textarea, select');
  for (const el of nodes) {
    const type = (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    let value = '';
    if (type === 'checkbox' || type === 'radio') { if (!el.checked) continue; value = el.value || 'checked'; }
    else if (el.tagName === 'SELECT') value = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
    else value = el.value || '';
    out.push({
      label: String(labelFor(el)).replace(/\\s+/g, ' ').trim().slice(0, 160),
      value: String(value),
      type,
      multiline: el.tagName === 'TEXTAREA',
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
    });
  }
  return JSON.stringify({ url: location.href, fields: out });
})()`;

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

async function main() {
  let targets;
  try {
    targets = await cdp('/json/list');
  } catch {
    fail('Chrome CDP not reachable on :9222');
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

  const rows = [];
  for (const f of best.fields) {
    const problems = auditAnswer(f.label, f.value, {
      multiline: f.multiline,
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
