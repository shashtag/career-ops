import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log('Navigating directly to application page...');
  await page.goto('https://jobs.ashbyhq.com/zapier/6948a0e6-a580-4e9d-b109-20652d9a1507/application?departmentId=cbb2c602-5494-4a7b-914c-8ad0a77fdc11', { waitUntil: 'networkidle' });

  // Let's print out some input fields and textareas
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea, select')).map(el => {
      // Find a nearby label or text
      let labelText = '';
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) labelText = labelEl.innerText;
      }
      if (!labelText) {
        labelText = el.closest('label')?.innerText || el.closest('.field')?.querySelector('label')?.innerText || '';
      }
      if (!labelText) {
        // Look up parent hierarchy
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
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        labelText: labelText.replace(/\s+/g, ' ').trim()
      };
    });
  });

  console.log('Found fields:', JSON.stringify(inputs, null, 2));
  await browser.close();
}

main().catch(console.error);
