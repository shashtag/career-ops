import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });

  const checkboxes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="checkbox"]')).map(el => {
      let labelText = '';
      // Find the closest field container
      const field = el.closest('.field') || el.closest('[class*="field"]') || el.parentElement;
      if (field) {
        labelText = field.innerText || '';
      }
      return {
        id: el.id,
        name: el.name,
        labelText: labelText.replace(/\s+/g, ' ').trim()
      };
    }).filter(c => c.labelText.length > 0 && !c.labelText.includes('race') && !c.labelText.includes('veteran') && !c.labelText.includes('disability'));
  });

  console.dir(checkboxes, { depth: null });
  await browser.close();
}

main().catch(console.error);
