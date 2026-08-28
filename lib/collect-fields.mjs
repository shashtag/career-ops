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
 * Field shape: { label, value, type, multiline, required, maxLength, name, options }
 */

export const COLLECT_EXPRESSION = `(() => {
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
          label: clean(labelFor(el)).slice(0, 160),
          value: '',
          type,
          multiline: false,
          required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          maxLength: null,
          name: el.name || '',
          options: [],
        };
        out.push(groups[key]);
      }
      const optText = clean(el.closest('label')?.innerText || el.value || '');
      if (optText) groups[key].options.push(optText);
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
    let combobox = false;
    if (el.tagName === 'SELECT') {
      value = el.options[el.selectedIndex] ? clean(el.options[el.selectedIndex].text) : '';
      options = Array.from(el.options).map(o => clean(o.text)).filter(Boolean).slice(0, 60);
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
          options = Array.from(list.querySelectorAll('[role="option"], li, option'))
            .map(o => clean(o.innerText || o.textContent)).filter(Boolean).slice(0, 60);
        }
      }
    }

    out.push({
      label: clean(labelFor(el)).slice(0, 160),
      value: String(value),
      type,
      multiline: el.tagName === 'TEXTAREA',
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
      name: el.name || '',
      options,
      combobox,
    });
  }
  return JSON.stringify({ url: location.href, fields: out });
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
