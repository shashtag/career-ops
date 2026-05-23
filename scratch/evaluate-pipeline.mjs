import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import yaml from 'js-yaml';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// File paths
const PATHS = {
  pipeline: join(ROOT, 'data', 'pipeline.md'),
  portals: join(ROOT, 'portals.yml'),
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  cv: join(ROOT, 'cv.md'),
  profile: join(ROOT, 'modes', '_profile.md'),
  profileYml: join(ROOT, 'config', 'profile.yml'),
  reports: join(ROOT, 'reports'),
  scanHistory: join(ROOT, 'data', 'scan-history.tsv'),
  cacheDir: join(ROOT, 'batch', 'scraped-jds'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions')
};

// Ensure directories exist
mkdirSync(PATHS.cacheDir, { recursive: true });
mkdirSync(PATHS.trackerAdditions, { recursive: true });
mkdirSync(PATHS.reports, { recursive: true });

// Read environment
const apiKey = process.env.GEMINI_API_KEY;
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let geminiModel = null;
if (apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  geminiModel = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192
    }
  });
}

// Load context files for Gemini evaluation
const sharedContext = existsSync(PATHS.shared) ? readFileSync(PATHS.shared, 'utf-8').trim() : '';
const ofertaLogic = existsSync(PATHS.oferta) ? readFileSync(PATHS.oferta, 'utf-8').trim() : '';
const cvContent = existsSync(PATHS.cv) ? readFileSync(PATHS.cv, 'utf-8').trim() : '';
const profileContent = existsSync(PATHS.profile) ? readFileSync(PATHS.profile, 'utf-8').trim() : '';
const profileYml = existsSync(PATHS.profileYml) ? readFileSync(PATHS.profileYml, 'utf-8').trim() : '';

// Parse portals.yml for company notes
const portalsDoc = existsSync(PATHS.portals) ? yaml.load(readFileSync(PATHS.portals, 'utf-8')) : {};
const companyNotesMap = new Map();
if (portalsDoc && Array.isArray(portalsDoc.tracked_companies)) {
  for (const c of portalsDoc.tracked_companies) {
    if (c && c.name) {
      companyNotesMap.set(c.name.toLowerCase().trim(), c.notes || '');
    }
  }
}

// ---------------------------------------------------------------------------
// MD5 cache helper
// ---------------------------------------------------------------------------
function getCachePath(url) {
  const hash = createHash('md5').update(url).digest('hex');
  return join(PATHS.cacheDir, `${hash}.json`);
}

// ---------------------------------------------------------------------------
// Sequential report number helper
// ---------------------------------------------------------------------------
function nextReportNumber() {
  const files = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (files.length === 0) return '001';
  return String(Math.max(...files) + 1).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// Liveness pattern matching
// ---------------------------------------------------------------------------
const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

function checkLivenessText(bodyText) {
  for (const pattern of HARD_EXPIRED_PATTERNS) {
    if (pattern.test(bodyText)) {
      return { expired: true, reason: `Pattern matched: ${pattern.source}` };
    }
  }
  if (bodyText.trim().length < 300) {
    return { expired: true, reason: 'Insufficient page content (nav/footer only)' };
  }
  return { expired: false };
}

// ---------------------------------------------------------------------------
// Smart Heuristic Classifier
// ---------------------------------------------------------------------------
function classifyJob(company, role, url, bodyText) {
  const lowerRole = role.toLowerCase();
  const lowerUrl = url.toLowerCase();
  const lowerCompany = company.toLowerCase().trim();
  const textToSearch = `${lowerRole} ${lowerUrl} ${bodyText.toLowerCase()}`;

  // 1. Check for explicit India keywords first
  if (
    lowerRole.includes('india') || lowerRole.includes('mumbai') || lowerRole.includes('bengaluru') || lowerRole.includes('bangalore') ||
    lowerUrl.includes('india') || lowerUrl.includes('mumbai') || lowerUrl.includes('bangalore') ||
    (bodyText && (
      bodyText.toLowerCase().includes('bengaluru, india') ||
      bodyText.toLowerCase().includes('bangalore, india') ||
      bodyText.toLowerCase().includes('mumbai, india') ||
      bodyText.toLowerCase().includes('office: bengaluru') ||
      bodyText.toLowerCase().includes('office: bangalore')
    ))
  ) {
    return { country: 'India', priority: 1 };
  }

  // 2. Remote / Global (if explicitly remote-first or remote-friendly without local limits)
  const isRemoteRole = lowerRole.includes('remote') || lowerUrl.includes('remote') || (bodyText && bodyText.toLowerCase().includes('remote globally'));
  
  // Specific list of remote companies
  const remoteCompanies = [
    'elevenlabs', 'perplexity', 'supabase', 'zapier', 'arize ai', 
    'deepgram', 'hightouch', 'vercel', 'airtable', 'runpod', 'pinecone',
    'stability ai', 'inngest', 'planetscale', 'weights & biases (coreweave)'
  ];

  // 3. Germany check
  if (
    lowerRole.includes('berlin') || lowerRole.includes('munich') || lowerRole.includes('germany') || lowerRole.includes('deutschland') || lowerRole.includes('german') ||
    lowerUrl.includes('berlin') || lowerUrl.includes('munich') || lowerUrl.includes('germany') ||
    (bodyText && (
      bodyText.toLowerCase().includes('berlin, germany') ||
      bodyText.toLowerCase().includes('munich, germany') ||
      bodyText.toLowerCase().includes('münchen, de') ||
      bodyText.toLowerCase().includes('germany / remote') ||
      bodyText.toLowerCase().includes('deutschland')
    ))
  ) {
    // If it's a global company like ElevenLabs but Berlin/Germany is specified, Germany priority wins.
    return { country: 'Germany', priority: 2 };
  }

  // 4. France check
  if (
    lowerRole.includes('paris') || lowerRole.includes('france') || lowerRole.includes('french') ||
    lowerUrl.includes('paris') || lowerUrl.includes('france') ||
    (bodyText && (
      bodyText.toLowerCase().includes('paris, france') ||
      bodyText.toLowerCase().includes('france / remote') ||
      bodyText.toLowerCase().includes('paris office')
    ))
  ) {
    return { country: 'France', priority: 2 };
  }

  // 5. UK check
  if (
    lowerRole.includes('london') || lowerRole.includes('uk') || lowerRole.includes('united kingdom') || lowerRole.includes('england') ||
    lowerUrl.includes('london') || lowerUrl.includes('uk') ||
    (bodyText && (
      bodyText.toLowerCase().includes('london, uk') ||
      bodyText.toLowerCase().includes('london, united kingdom') ||
      bodyText.toLowerCase().includes('united kingdom / remote') ||
      bodyText.toLowerCase().includes('london office')
    ))
  ) {
    return { country: 'UK', priority: 2 };
  }

  // Fallbacks based on company notes or hardcoding
  const companyNotes = companyNotesMap.get(lowerCompany) || '';
  const notesLower = companyNotes.toLowerCase();

  if (notesLower.includes('india') || notesLower.includes('bangalore') || notesLower.includes('bengaluru')) {
    return { country: 'India', priority: 1 };
  }
  
  if (isRemoteRole || remoteCompanies.includes(lowerCompany) || notesLower.includes('remote') || notesLower.includes('global')) {
    return { country: 'Remote/Global', priority: 1 };
  }

  if (lowerCompany === 'mistral ai') return { country: 'France', priority: 2 };
  if (lowerCompany === 'spotify') return { country: 'UK', priority: 2 };
  if (lowerCompany === 'sumup') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'helsing') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'wayve') return { country: 'UK', priority: 2 };
  if (lowerCompany === 'physicsx') return { country: 'UK', priority: 2 };
  if (lowerCompany === 'faculty') return { country: 'UK', priority: 2 };
  if (lowerCompany === 'synthesia') return { country: 'UK', priority: 2 };
  if (lowerCompany === 'speechmatics') return { country: 'UK', priority: 2 };

  if (lowerCompany === 'celonis') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'trade republic') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'hellofresh') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'n26') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'aleph alpha') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'parloa') return { country: 'Germany', priority: 2 };
  if (lowerCompany === 'contentful') return { country: 'Germany', priority: 2 };

  if (lowerCompany === 'photoroom') return { country: 'France', priority: 2 };
  if (lowerCompany === 'pigment') return { country: 'France', priority: 2 };
  if (lowerCompany === 'qonto') return { country: 'France', priority: 2 };

  if (notesLower.includes('berlin') || notesLower.includes('munich') || notesLower.includes('germany')) {
    return { country: 'Germany', priority: 2 };
  }
  if (notesLower.includes('paris') || notesLower.includes('france')) {
    return { country: 'France', priority: 2 };
  }
  if (notesLower.includes('london') || notesLower.includes('uk')) {
    return { country: 'UK', priority: 2 };
  }

  // If we can't find any explicit matches, but it has "remote" anywhere in description, it is Remote/Global priority 1
  if (textToSearch.includes('remote') || textToSearch.includes('anywhere')) {
    return { country: 'Remote/Global', priority: 1 };
  }

  return { country: 'Other', priority: 3 };
}

// ---------------------------------------------------------------------------
// Parse pipeline.md
// ---------------------------------------------------------------------------
function loadPipeline() {
  if (!existsSync(PATHS.pipeline)) {
    console.error(`❌ Pipeline file not found at: ${PATHS.pipeline}`);
    process.exit(1);
  }
  const content = readFileSync(PATHS.pipeline, 'utf-8');
  const lines = content.split('\n');
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
  return { lines, pendingJobs };
}

// ---------------------------------------------------------------------------
// Run Gemini Evaluation
// ---------------------------------------------------------------------------
async function evaluateJobWithGemini(company, role, url, bodyText) {
  const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
CANDIDATE PROFILE & TARGETS (config/profile.yml)
═══════════════════════════════════════════════════════
${profileYml}

═══════════════════════════════════════════════════════
USER ARCHETYPES & NARRATIVE (_profile.md)
═══════════════════════════════════════════════════════
${profileContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

  const result = await geminiModel.generateContent([
    { text: systemPrompt },
    { text: `\n\nJOB URL TO EVALUATE: ${url}\n\nJOB DESCRIPTION TO EVALUATE:\n\n${bodyText}` }
  ]);
  
  return result.response.text();
}

// ---------------------------------------------------------------------------
// Append to scan-history.tsv helper
// ---------------------------------------------------------------------------
function logExpiredToScanHistory(url, company, title) {
  const date = new Date().toISOString().slice(0, 10);
  if (!existsSync(PATHS.scanHistory)) {
    writeFileSync(PATHS.scanHistory, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const line = `${url}\t${date}\tverify-eval\t${title}\t${company}\tskipped_expired\t\n`;
  appendFileSync(PATHS.scanHistory, line, 'utf-8');
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const priorityArgIdx = args.indexOf('--priority');
  const targetPriority = priorityArgIdx !== -1 ? parseInt(args[priorityArgIdx + 1]) : null;
  const classifyOnly = args.includes('--classify-only');
  const limitArgIdx = args.indexOf('--limit');
  const limit = limitArgIdx !== -1 ? parseInt(args[limitArgIdx + 1]) : null;

  if (!classifyOnly && targetPriority === null) {
    console.error('❌ Please specify a priority target: --priority [1|2|3] or use --classify-only');
    process.exit(1);
  }

  if (!classifyOnly && !apiKey) {
    console.error('❌ GEMINI_API_KEY is not set in environment or .env file. Real evaluation cannot proceed. Please run with --classify-only or set GEMINI_API_KEY.');
    process.exit(1);
  }

  console.log('📌 Parsing data/pipeline.md...');
  const { lines, pendingJobs } = loadPipeline();
  console.log(`📊 Found ${pendingJobs.length} pending unchecked job(s) in pipeline.`);

  let browser = null;
  let evaluatedCount = 0;
  let expiredCount = 0;
  let skippedCount = 0;

  try {
    const classificationCounts = { 1: 0, 2: 0, 3: 0 };
    const countryCounts = {};

    console.log('\n🔍 Processing jobs...');

    for (let i = 0; i < pendingJobs.length; i++) {
      const job = pendingJobs[i];
      const { rawLine, url, company, role, lineIndex } = job;

      // 1. Check cache first
      const cachePath = getCachePath(url);
      let cacheData = null;

      if (existsSync(cachePath)) {
        try {
          cacheData = JSON.parse(readFileSync(cachePath, 'utf-8'));
        } catch {
          // ignore error, re-fetch
        }
      }

      // 2. Fetch via Playwright if not cached
      if (!cacheData) {
        if (!browser) {
          console.log('🌐 Launching Playwright browser...');
          browser = await chromium.launch({ headless: true });
        }
        console.log(`🌐 [Scraping] [${i+1}/${pendingJobs.length}] ${company} | ${role}...`);
        const page = await browser.newPage();
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000); // hydration wait
          const finalUrl = page.url();
          const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
          
          cacheData = {
            url,
            finalUrl,
            bodyText,
            timestamp: new Date().toISOString()
          };
          writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
        } catch (err) {
          console.warn(`  ⚠️ Failed to scrape ${url}: ${err.message.split('\n')[0]}`);
          await page.close();
          continue; // skip to next
        }
        await page.close();
      }

      const bodyText = cacheData.bodyText || '';
      
      // 3. Check liveness based on text
      const liveness = checkLivenessText(bodyText);
      if (liveness.expired) {
        expiredCount++;
        console.log(`  ❌ [Expired] ${company} | ${role} (${liveness.reason})`);
        
        if (!classifyOnly) {
          // Mark as expired in pipeline.md memory representation
          lines[lineIndex] = `- [x] ~~${url} | ${company} | ${role}~~ [Expired]`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');
          // Log to scan-history.tsv so we never scan/process it again
          logExpiredToScanHistory(url, company, role);
        }
        continue;
      }

      // 4. Classify location & priority
      const classification = classifyJob(company, role, url, bodyText);
      classificationCounts[classification.priority]++;
      countryCounts[classification.country] = (countryCounts[classification.country] || 0) + 1;

      console.log(`  ✅ [Active] [Priority ${classification.priority}] [${classification.country}] ${company} | ${role}`);

      if (classifyOnly) {
        continue;
      }

      // 5. Evaluate if priority matches target
      if (classification.priority === targetPriority) {
        if (limit !== null && evaluatedCount >= limit) {
          console.log(`⏱️ Limit of ${limit} evaluations reached. Stopping.`);
          break;
        }

        console.log(`  🤖 [Evaluating] calling Gemini-2.5-flash for ${company}...`);
        try {
          const evaluationText = await evaluateJobWithGemini(company, role, url, bodyText);
          
          // Parse score summary from Gemini response
          const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
          let score = '?';
          let parsedCompany = company;
          let parsedRole = role;
          let parsedArchetype = 'Unknown';
          let parsedLegitimacy = 'High Confidence';

          if (summaryMatch) {
            const block = summaryMatch[1];
            const extract = (key) => {
              const prefix = `${key}:`;
              for (const l of block.split('\n')) {
                if (l.trimStart().startsWith(prefix)) return l.slice(prefix.length).trim();
              }
              return 'Unknown';
            };
            score = extract('SCORE');
            parsedCompany = extract('COMPANY');
            parsedRole = extract('ROLE');
            parsedArchetype = extract('ARCHETYPE');
            parsedLegitimacy = extract('LEGITIMACY');
          }

          // Generate sequential report file
          const num = nextReportNumber();
          const today = new Date().toISOString().split('T')[0];
          const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const filename = `${num}-${companySlug}-${today}.md`;
          const reportPath = join(PATHS.reports, filename);

          const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${url}
**Archetype:** ${parsedArchetype}
**Score:** ${score}/5
**Legitimacy:** ${parsedLegitimacy}
**PDF:** pending
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

          writeFileSync(reportPath, reportContent, 'utf-8');
          console.log(`  💾 Report saved to reports/${filename}`);

          // Create TSV tracker addition
          const tsvContent = `${num}\t${today}\t${company}\t${role}\tEvaluated\t${score}/5\t❌\t[${num}](reports/${filename})\tGemini auto-evaluated`;
          const tsvPath = join(PATHS.trackerAdditions, `${num}-${companySlug}.tsv`);
          writeFileSync(tsvPath, tsvContent, 'utf-8');

          // Run merge-tracker.mjs to integrate into applications.md immediately
          execSync('node merge-tracker.mjs', { cwd: ROOT, stdio: 'inherit' });

          // Update pipeline.md to mark complete
          lines[lineIndex] = `- [x] ${url} | ${company} | ${role} | Score: ${score}/5 | [Report ${num}](reports/${filename})`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');

          evaluatedCount++;
          console.log(`  🎉 Successfully processed [${evaluatedCount}] evaluations in this run!\n`);
        } catch (err) {
          console.error(`  ❌ Gemini evaluation failed for ${company}: ${err.message}`);
        }
      } else {
        skippedCount++;
      }
    }

    console.log('\n--- Summary statistics ---');
    console.log('Priority Counts:');
    console.log(`  Priority 1 (India + Remote/Global): ${classificationCounts[1]}`);
    console.log(`  Priority 2 (UK, Germany, France):   ${classificationCounts[2]}`);
    console.log(`  Priority 3 (Other regions):          ${classificationCounts[3]}`);
    
    console.log('\nCountry Counts:');
    for (const [country, count] of Object.entries(countryCounts)) {
      console.log(`  ${country}: ${count}`);
    }

    console.log('\nRun Statistics:');
    console.log(`  Evaluated: ${evaluatedCount}`);
    console.log(`  Expired / Closed: ${expiredCount}`);
    console.log(`  Skipped (lower priority): ${skippedCount}`);

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
