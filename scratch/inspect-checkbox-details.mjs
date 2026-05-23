import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });

  const checkboxMarkup = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    return inputs.map(el => {
      const field = el.closest('.field') || el.closest('[class*="field"]');
      if (!field) return null;
      // Get the label text of this field
      const text = field.innerText || '';
      if (text.includes('building or maintaining integrations') || text.includes('OAuth') || text.includes('Values')) {
        return {
          text: text.replace(/\s+/g, ' ').trim(),
          outerHTML: field.outerHTML
        };
      }
      return null;
    }).filter(x => x !== null);
  });

  console.dir(checkboxMarkup, { depth: null });
  await browser.close();
}

main().catch(console.error);
