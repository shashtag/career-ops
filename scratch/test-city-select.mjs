import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });

  const cityMarkup = await page.evaluate(() => {
    // Find the city question container
    const labels = Array.from(document.querySelectorAll('label, div, span'));
    const cityLabel = labels.find(el => el.innerText && el.innerText.includes('What city/country will you work from?'));
    if (!cityLabel) return 'City label not found';
    
    // Get the parent container
    let container = cityLabel.parentElement;
    for (let i = 0; i < 4 && container; i++) {
      if (container.querySelector('input')) break;
      container = container.parentElement;
    }
    
    if (!container) return 'City container not found';
    
    return {
      containerOuterHTML: container.outerHTML.substring(0, 1000),
      inputs: Array.from(container.querySelectorAll('input')).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        name: el.name || '',
        className: el.className || ''
      }))
    };
  });

  console.dir(cityMarkup, { depth: null });
  await browser.close();
}

main().catch(console.error);
