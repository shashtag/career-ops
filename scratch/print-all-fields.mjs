import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });

  const fields = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea, select')).map(el => {
      let labelText = '';
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) labelText = labelEl.innerText;
      }
      if (!labelText) {
        labelText = el.closest('label')?.innerText || el.closest('.field')?.querySelector('label')?.innerText || '';
      }
      if (!labelText) {
        let p = el.parentElement;
        for (let j = 0; j < 4 && p; j++) {
          const text = p.innerText || '';
          if (text.length > 0 && text.length < 200) {
            labelText = text;
            break;
          }
          p = p.parentElement;
        }
      }
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.name || '',
        labelText: labelText.replace(/\s+/g, ' ').trim()
      };
    });
  });

  const usefulFields = fields.filter(f => {
    const text = f.labelText.toLowerCase();
    return !text.includes('prefer not to disclose') &&
           !text.includes('veteran') &&
           !text.includes('disability') &&
           !text.includes('gender') &&
           !text.includes('race');
  });

  // Print only first 20 fields to avoid truncation
  console.log('First 25 Fields:');
  console.dir(usefulFields.slice(0, 25), { maxArrayLength: null, depth: null });
  await browser.close();
}

main().catch(console.error);
