import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { load } from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const pipelinePath = join(ROOT, 'data', 'pipeline.md');
const portalsPath = join(ROOT, 'portals.yml');
const cacheDir = join(ROOT, 'batch', 'scraped-jds');
mkdirSync(cacheDir, { recursive: true });

// Load portals.yml
const portalsDoc = load(readFileSync(portalsPath, 'utf-8'));
const companies = portalsDoc.tracked_companies || [];
const companyMap = new Map();
for (const c of companies) {
  if (c && c.name) {
    companyMap.set(c.name.toLowerCase().trim(), c);
  }
}

// Load pipeline.md
const pipelineContent = readFileSync(pipelinePath, 'utf-8');
const lines = pipelineContent.split('\n');
const pendingJobs = [];
let inPendientes = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trim().startsWith('## Pendientes') || line.trim().startsWith('## Pending')) {
    inPendientes = true;
    continue;
  }
  if (line.trim().startsWith('## Procesadas') || line.trim().startsWith('## Processed')) {
    inPendientes = false;
  }

  if (inPendientes && line.trim().startsWith('- [ ]')) {
    const rawLine = line.trim();
    const parts = rawLine.slice(5).split('|').map(p => p.trim());
    const url = parts[0] || '';
    const company = parts[1] || '';
    const role = parts[2] || '';
    pendingJobs.push({ lineIndex: i, rawLine, url, company, role });
  }
}

// Classification function with company-to-country map
function classify(job) {
  const { url, company, role } = job;
  const lowerRole = role.toLowerCase();
  const lowerUrl = url.toLowerCase();
  const lowerCompany = company.toLowerCase().trim();

  if (
    lowerRole.includes('india') || lowerRole.includes('mumbai') || lowerRole.includes('bengaluru') || lowerRole.includes('bangalore') ||
    lowerUrl.includes('india') || lowerUrl.includes('mumbai') || lowerUrl.includes('bangalore')
  ) {
    return 'India';
  }

  if (
    lowerRole.includes('berlin') || lowerRole.includes('munich') || lowerRole.includes('germany') || lowerRole.includes('deutschland') || lowerRole.includes('german') ||
    lowerUrl.includes('berlin') || lowerUrl.includes('munich') || lowerUrl.includes('germany')
  ) {
    return 'Germany';
  }

  if (
    lowerRole.includes('paris') || lowerRole.includes('france') || lowerRole.includes('french') ||
    lowerUrl.includes('paris') || lowerUrl.includes('france')
  ) {
    return 'France';
  }

  if (
    lowerRole.includes('london') || lowerRole.includes('uk') || lowerRole.includes('united kingdom') || lowerRole.includes('england') ||
    lowerUrl.includes('london') || lowerUrl.includes('uk')
  ) {
    return 'UK';
  }

  if (
    lowerRole.includes('remote') || lowerRole.includes('global') || lowerRole.includes('worldwide') || lowerRole.includes('anywhere') ||
    lowerUrl.includes('remote') || lowerUrl.includes('global')
  ) {
    return 'Remote/Global';
  }

  const companyInfo = companyMap.get(lowerCompany);
  if (companyInfo && companyInfo.notes) {
    const notes = companyInfo.notes.toLowerCase();
    if (notes.includes('india') || notes.includes('bangalore') || notes.includes('bengaluru') || notes.includes('mumbai')) return 'India';
    if (notes.includes('germany') || notes.includes('de') || notes.includes('berlin') || notes.includes('munich')) return 'Germany';
    if (notes.includes('france') || notes.includes('fr') || notes.includes('paris')) return 'France';
    if (notes.includes('uk') || notes.includes('london') || notes.includes('united kingdom')) return 'UK';
    if (notes.includes('remote') || notes.includes('global') || notes.includes('worldwide')) return 'Remote/Global';
  }

  // hardcoded company fallbacks
  if (lowerCompany === 'mistral ai') return 'France';
  if (lowerCompany === 'spotify') return 'UK';
  if (lowerCompany === 'sumup') return 'Germany';
  if (lowerCompany === 'helsing') return 'Germany';
  if (lowerCompany === 'cohere') return 'UK';
  if (lowerCompany === 'wayve') return 'UK';
  if (lowerCompany === 'physicsx') return 'UK';
  if (lowerCompany === 'faculty') return 'UK';
  if (lowerCompany === 'synthesia') return 'UK';
  if (lowerCompany === 'speechmatics') return 'UK';
  if (lowerCompany === 'polyai') return 'UK';
  if (lowerCompany === 'celonis') return 'Germany';
  if (lowerCompany === 'trade republic') return 'Germany';
  if (lowerCompany === 'hellofresh') return 'Germany';
  if (lowerCompany === 'n26') return 'Germany';
  if (lowerCompany === 'aleph alpha') return 'Germany';
  if (lowerCompany === 'parloa') return 'Germany';
  if (lowerCompany === 'contentful') return 'Germany';
  if (lowerCompany === 'getyourguide') return 'Germany';
  if (lowerCompany === 'photoroom') return 'France';
  if (lowerCompany === 'pigment') return 'France';
  if (lowerCompany === 'qonto') return 'France';

  return 'Other';
}

const p2Jobs = [];
for (const job of pendingJobs) {
  const country = classify(job);
  if (country === 'Germany' || country === 'France' || country === 'UK') {
    p2Jobs.push({ ...job, country });
  }
}

const targetJobs = p2Jobs.slice(0, 10);
console.log(`Found ${p2Jobs.length} Priority 2 pending jobs. Scraping next ${targetJobs.length}...`);

function getCachePath(url) {
  const hash = createHash('md5').update(url).digest('hex');
  return join(cacheDir, `${hash}.json`);
}

async function scrapeAll() {
  if (targetJobs.length === 0) {
    console.log('No pending P2 jobs to scrape!');
    return;
  }
  
  console.log(`🌐 Launching Playwright browser to scrape ${targetJobs.length} URLs...`);
  const browser = await chromium.launch({ headless: true });
  
  for (let i = 0; i < targetJobs.length; i++) {
    const job = targetJobs[i];
    const url = job.url;
    const cachePath = getCachePath(url);
    const hash = createHash('md5').update(url).digest('hex');
    
    if (existsSync(cachePath)) {
      console.log(`[${i+1}/${targetJobs.length}] Already cached: ${hash}.json (${job.company} - ${job.role})`);
      continue;
    }
    
    console.log(`[${i+1}/${targetJobs.length}] Scraping ${job.company} - ${job.role} (${url})...`);
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
