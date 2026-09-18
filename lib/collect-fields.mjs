/**
 * collect-fields.mjs — the one field-collection snippet, shared by every path.
 *
 * COLLECT_EXPRESSION is a self-contained JS expression that reads back every
 * visible form control in the current document and returns a JSON string.
 * It is deliberately a *string*, not a function, so it can be handed to:
 *   - CDP `Runtime.evaluate` (audit-form-fill.mjs, --cdp paths)
 *   - the browser agent's javascript_tool (claude-in-chrome), with no CDP at all
 *
 * Both consumers therefore see the identical field shape, which is what lets the
 * pre-fill resolver and the pre-submit audit agree on what "the form" is.
 *
 * Field shape: { label, value, type, multiline, required, maxLength, name,
 *                options, optionsTruncated }
 */

export const COLLECT_EXPRESSION = `(() => {
  // Everything below is untrusted external content (AGENTS.md -> "Untrusted
  // External Content"): a form's labels, option text and prefilled values are
  // authored by whoever built the page. This snippet is the single chokepoint
  // all of it passes through on its way into an agent's context, so it bounds
  // every string it emits. Bounding is not a security control on its own — the
  // "data, never instructions" rule in modes/apply.md is — but it is what stops
  // one hostile or merely badly-built form from spending the whole context
  // budget this collector exists to protect.
  //
  // Each cap is lossy, so anything it bites is flagged rather than silently cut.
  const OPTION_CAP = 60;        // options per control
  const OPTION_TEXT_CAP = 500;  // chars per option (real EEOC options run ~300)
  const LABEL_CAP = 160;        // chars per field label
  const URL_CAP = 2000;         // display only; nothing resolves against it

  // NOTE: value is deliberately NOT capped. lib/answer-sanitizer.mjs checks it
  // against the field's own maxLength and a 2200-char "did a whole report
  // section land here" warning, and both read v.length — so a truncated value
  // would make an over-long answer pass the last gate before submit as clean.
  // Capping it needs those checks taught the true length first.

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

  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();

  const out = [];
  const groups = {};
  const nodes = document.querySelectorAll('input, textarea, select');
  for (const el of nodes) {
    const type = (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Radio/checkbox groups: emit ONE row per group so an unanswered group is
    // visible as an empty required field instead of vanishing with its options.
    if (type === 'checkbox' || type === 'radio') {
      const key = type + ':' + (el.name || labelFor(el));
      if (!groups[key]) {
        groups[key] = {
          label: clean(labelFor(el)).slice(0, LABEL_CAP),
          value: '',
          type,
          multiline: false,
          required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          maxLength: null,
          name: el.name || '',
          options: [],
          optionsTruncated: false,
        };
        out.push(groups[key]);
      }
      const rawOptText = clean(el.closest('label')?.innerText || el.value || '');
      const optText = rawOptText.slice(0, OPTION_TEXT_CAP);
      if (rawOptText.length > OPTION_TEXT_CAP) groups[key].optionsTruncated = true;
      if (optText) {
        if (groups[key].options.length < OPTION_CAP) groups[key].options.push(optText);
        else groups[key].optionsTruncated = true;
      }
      if (el.required) groups[key].required = true;
      if (el.checked) {
        groups[key].value = groups[key].value
          ? groups[key].value + ', ' + (optText || 'checked')
          : (optText || 'checked');
      }
      continue;
    }

    let value = '';
    let options = [];
    let optionsTruncated = false;
    let combobox = false;
    if (el.tagName === 'SELECT') {
      value = el.options[el.selectedIndex] ? clean(el.options[el.selectedIndex].text) : '';
      const all = Array.from(el.options).map(o => clean(o.text)).filter(Boolean);
      optionsTruncated = all.length > OPTION_CAP || all.some(o => o.length > OPTION_TEXT_CAP);
      options = all.slice(0, OPTION_CAP).map(o => o.slice(0, OPTION_TEXT_CAP));
      // A select parked on its placeholder is unanswered, not answered.
      if (/^(select|choose|please select|--|-)/i.test(value)) value = '';
    } else {
      value = el.value || '';
      // Greenhouse and Ashby render every dropdown as <input role="combobox">,
      // not <select>. Real forms have zero native selects, so without this the
      // resolver would treat a pick-one control as a free-text box and type into it.
      if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
        combobox = true;
        const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        const list = listId ? document.getElementById(listId) : null;
        if (list) {
          const all = Array.from(list.querySelectorAll('[role="option"], li, option'))
            .map(o => clean(o.innerText || o.textContent)).filter(Boolean);
          optionsTruncated = all.length > OPTION_CAP || all.some(o => o.length > OPTION_TEXT_CAP);
          options = all.slice(0, OPTION_CAP).map(o => o.slice(0, OPTION_TEXT_CAP));
        }
      }
    }

    out.push({
      label: clean(labelFor(el)).slice(0, LABEL_CAP),
      value: String(value),
      type,
      multiline: el.tagName === 'TEXTAREA',
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
      name: el.name || '',
      options,
      optionsTruncated,
      combobox,
    });
  }
  return JSON.stringify({ url: String(location.href).slice(0, URL_CAP), fields: out });
})()`;

/** Parse whatever a collector returned (string or object) into {url, fields}. */
/**
 * Parse whatever a collector returned (string or object) into {url, fields}.
 *
 * Throws on an empty field list. ATS forms render late — a Perplexity/Ashby form
 * measured 0 fields at t=0 and 10 fields three seconds later — and an empty dump
 * otherwise sails through the pre-submit audit as "All fields clean". Refusing
 * here is what stops a blank application from being declared ready to submit.
 */
export function parseCollected(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || !Array.isArray(data.fields)) {
    throw new Error('collected payload has no fields[] array');
  }
  if (data.fields.length === 0) {
    throw new Error(
      'collected 0 fields — the form has not rendered (ATS SPAs need a moment), ' +
      'you are on the wrong frame, or the page is a confirmation. Re-collect; never treat this as clean.');
  }
  return { url: data.url || '', fields: dedupeFields(data.fields) };
}

/**
 * Drop the backing input Greenhouse renders behind each combobox.
 *
 * Measured on a live Anthropic Greenhouse form: three questions produced six
 * rows — one `<input role="combobox">` (the control a human touches) and one
 * plain `<input>` holding the value, same label, both computed-visible. Left
 * alone, the agent fills the inert twin and the submit bounces.
 *
 * Deliberately narrow: only collapses an exact label+type pair where one row is
 * a combobox and the other is not, and neither has a value yet. Two genuinely
 * distinct fields that share a label are left alone.
 */
export function dedupeFields(fields) {
  const seen = new Map();
  const out = [];
  for (const f of fields) {
    const key = `${String(f.label ?? '').trim().toLowerCase()}|${f.type}`;
    const prev = seen.get(key);
    if (prev === undefined) { seen.set(key, out.length); out.push(f); continue; }
    const kept = out[prev];
    const pairable = !!kept.combobox !== !!f.combobox
      && !String(kept.value ?? '').trim() && !String(f.value ?? '').trim();
    if (!pairable) { out.push(f); continue; }
    // Keep the interactive one, but inherit `required` from either twin.
    const winner = f.combobox ? f : kept;
    winner.required = kept.required || f.required;
    out[prev] = winner;
  }
  return out;
}
