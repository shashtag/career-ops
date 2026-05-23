import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log('Navigating directly to Release Engineering application page...');
  await page.goto('https://jobs.ashbyhq.com/zapier/6948a0e6-a580-4e9d-b109-20652d9a1507/application?departmentId=cbb2c602-5494-4a7b-914c-8ad0a77fdc11', { waitUntil: 'networkidle' });

  const inputs = await page.evaluate(() => {
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
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        placeholder: el.getAttribute('placeholder') || '',
        labelText: labelText.replace(/\s+/g, ' ').trim()
      };
    });
  });

  const usefulFields = inputs.filter(f => {
    const text = f.labelText.toLowerCase();
    return !text.includes('prefer not to disclose') &&
           !text.includes('veteran') &&
           !text.includes('disability') &&
           !text.includes('gender') &&
           !text.includes('race') &&
           !text.includes('asian') &&
           !text.includes('man') &&
           !text.includes('woman') &&
           !text.includes('straight') &&
           !text.includes('white') &&
           !text.includes('black') &&
           !text.includes('latino') &&
           !text.includes('lgbtq');
  });

  const fs = await import('fs/promises');
  await fs.writeFile('scratch/useful-fields.json', JSON.stringify(usefulFields, null, 2), 'utf-8');
  console.log('✅ Wrote useful fields to scratch/useful-fields.json');
  await browser.close();
}

main().catch(console.error);
