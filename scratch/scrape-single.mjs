import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const cacheDir = join(ROOT, 'batch', 'scraped-jds');

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node scrape-single.mjs <URL>');
    process.exit(1);
  }

  console.log(`🌐 Scrape URL: ${url}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000); // SPA hydration wait
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');

    const hash = createHash('md5').update(url).digest('hex');
    const cachePath = join(cacheDir, `${hash}.json`);

    const cacheData = {
      url,
      finalUrl,
      bodyText,
      timestamp: new Date().toISOString()
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
    console.log(`✅ Successfully scraped!`);
    console.log(`💾 Saved to cache: batch/scraped-jds/${hash}.json`);
    
    // Print first 500 characters of text for immediate inspection
    console.log('\n--- TEXT PREVIEW ---');
    console.log(bodyText.slice(0, 800) + '...\n');
  } catch (err) {
    console.error(`❌ Error scraping: ${err.message}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
});
