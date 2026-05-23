import { chromium } from 'playwright';

async function main() {
  console.log('🌐 Launching browser to print all textareas and labels...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/6948a0e6-a580-4e9d-b109-20652d9a1507/application?departmentId=cbb2c602-5494-4a7b-914c-8ad0a77fdc11', { waitUntil: 'networkidle' });

  const textareas = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map(el => {
      let labelText = '';
      
      // Look for a label matching this input id
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) labelText = label.innerText;
      }
      
      // Look for parent label
      if (!labelText) {
        const parentLabel = el.closest('label');
        if (parentLabel) labelText = parentLabel.innerText;
      }
      
      // Look for container label/heading
      if (!labelText) {
        const container = el.closest('.field, .question, .form-group, [class*="field"], [class*="question"]');
        if (container) {
          const titleEl = container.querySelector('label, .label, .title, h1, h2, h3, h4, span');
          if (titleEl) labelText = titleEl.innerText;
        }
      }

      return {
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        labelText: labelText.replace(/\s+/g, ' ').trim()
      };
    });
  });

  console.log('Textareas found on page:');
  console.dir(textareas, { depth: null, maxArrayLength: null });
  await browser.close();
}

main().catch(console.error);
