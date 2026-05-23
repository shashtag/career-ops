import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/6948a0e6-a580-4e9d-b109-20652d9a1507/application?departmentId=cbb2c602-5494-4a7b-914c-8ad0a77fdc11', { waitUntil: 'networkidle' });

  const containers = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-field-path]')).map(el => {
      return {
        path: el.getAttribute('data-field-path'),
        text: el.innerText.replace(/\s+/g, ' ').trim()
      };
    });
  });

  console.log('Containers with data-field-path:');
  console.dir(containers, { depth: null, maxArrayLength: null });
  await browser.close();
}

main().catch(console.error);
