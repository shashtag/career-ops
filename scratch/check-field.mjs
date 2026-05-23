import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });

  const details = await page.evaluate(() => {
    const el = document.querySelector('[data-field-path="39e89696-4e2c-4f59-9ad2-792ba158fb4c"]');
    return el ? { text: el.innerText, outerHTML: el.outerHTML } : 'Element not found';
  });

  console.dir(details, { depth: null });
  await browser.close();
}

main().catch(console.error);
