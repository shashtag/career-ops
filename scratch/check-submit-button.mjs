import { chromium } from 'playwright';

async function main() {
  console.log('🌐 Launching headless browser to find buttons...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });

  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(btn => ({
      text: btn.innerText.replace(/\s+/g, ' ').trim(),
      type: btn.getAttribute('type') || '',
      class: btn.getAttribute('class') || '',
      id: btn.id || '',
      disabled: btn.disabled
    }));
  });

  console.log('All buttons found on page:');
  console.dir(buttons, { depth: null, maxArrayLength: null });
  await browser.close();
}

main().catch(console.error);
