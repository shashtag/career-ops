import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const cacheDir = join(ROOT, 'batch', 'scraped-jds');
mkdirSync(cacheDir, { recursive: true });

const urls = [
  "https://job-boards.eu.greenhouse.io/parloa/jobs/4694431101",
  "https://job-boards.eu.greenhouse.io/parloa/jobs/4873079101",
  "https://job-boards.eu.greenhouse.io/parloa/jobs/4824273101",
  "https://job-boards.eu.greenhouse.io/polyai/jobs/4658649101",
  "https://job-boards.eu.greenhouse.io/polyai/jobs/4853250101",
  "https://job-boards.greenhouse.io/airtable/jobs/8462421002",
  "https://job-boards.greenhouse.io/airtable/jobs/8341413002",
  "https://job-boards.greenhouse.io/vercel/jobs/5995789004",
  "https://job-boards.greenhouse.io/vercel/jobs/5796302004",
  "https://jobs.ashbyhq.com/elevenlabs/5881bc5d-765a-430e-9d28-7d598a0e1a03"
];

function getCachePath(url) {
  const hash = createHash('md5').update(url).digest('hex');
  return join(cacheDir, `${hash}.json`);
}

async function scrapeAll() {
  console.log(`🌐 Launching Playwright browser to scrape ${urls.length} URLs...`);
  const browser = await chromium.launch({ headless: true });
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const cachePath = getCachePath(url);
    const hash = createHash('md5').update(url).digest('hex');
    
    if (existsSync(cachePath)) {
      console.log(`[${i+1}/${urls.length}] Already cached: ${hash}.json (${url})`);
      continue;
    }
    
    console.log(`[${i+1}/${urls.length}] Scraping ${url}...`);
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000); // SPA hydration wait
      const finalUrl = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
      
      const cacheData = {
        url,
        finalUrl,
        bodyText,
        timestamp: new Date().toISOString()
      };
      
      writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      console.log(`  ✅ Saved cache/batch/scraped-jds/${hash}.json`);
    } catch (err) {
      console.error(`  ❌ Error scraping: ${err.message}`);
    } finally {
      await page.close();
    }
  }
  
  await browser.close();
  console.log('🎉 Done scraping batch!');
}

scrapeAll().catch(console.error);
