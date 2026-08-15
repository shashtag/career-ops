import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import readline from 'readline';
import { checkDuplicate } from './check-duplicate.mjs';
import { getCompanyCaps } from '../lib/company-caps.mjs';
import { claimJob, sweepStaleClaims, holdForOpenTab, fetchOpenTabUrls } from '../lib/job-claim.mjs';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const LOCK_FILE = '/tmp/career-ops-run.lock';
if (existsSync(LOCK_FILE)) {
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8'));
    if (pid) {
      process.kill(pid, 0); // Throws if process is dead
      console.error(`⚠️ Another instance is running (PID ${pid}). Exiting.`);
      process.exit(0);
    }
  } catch (e) {
    // Process is dead or lockfile is stale, continue
  }
}
try {
  writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCK_FILE); } catch {} });
} catch (e) {
  // Ignore lock writing errors
}

// File paths
const PATHS = {
  pipeline: join(ROOT, 'data', 'pipeline.md'),
  portals: join(ROOT, 'portals.yml'),
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  cv: join(ROOT, 'cv.md'),
  cvTemplate: join(ROOT, 'templates', 'cv-template.html'),
  profile: join(ROOT, 'modes', '_profile.md'),
  profileYml: join(ROOT, 'config', 'profile.yml'),
  reports: join(ROOT, 'reports'),
  scanHistory: join(ROOT, 'data', 'scan-history.tsv'),
  cacheDir: join(ROOT, 'batch', 'scraped-jds'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions'),
  output: join(ROOT, 'output'),
  classifiedJobs: join(ROOT, 'data', 'classified-jobs.json'),
  applications: join(ROOT, 'data', 'applications.md')
};

// Ensure directories exist
mkdirSync(PATHS.cacheDir, { recursive: true });
mkdirSync(PATHS.trackerAdditions, { recursive: true });
mkdirSync(PATHS.reports, { recursive: true });
mkdirSync(PATHS.output, { recursive: true });

// Read environment
const apiKey = process.env.GEMINI_API_KEY;
const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

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
const profileDoc = profileYml ? yaml.load(profileYml) : {};
const candidateCountry = profileDoc?.location?.country || 'India';

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
/**
 * Reserve the next report number atomically.
 *
 * Computing max+1 locally is the #749 race: two concurrent runs both read the
 * same highest slot and both write the same report number, so one silently
 * overwrites the other. reserve-report-num.mjs claims the slot with
 * O_CREAT|O_EXCL, which is the only thing that makes this safe under
 * concurrency. Falls back to max+1 only if the reserver itself is unavailable.
 */
function nextReportNumber() {
  const res = spawnSync('node', ['reserve-report-num.mjs', '--count', '1'], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  const claimed = String(res.stdout || '').trim().split('-')[0];
  if (res.status === 0 && /^\d{3}$/.test(claimed)) return claimed;

  console.warn('⚠️  reserve-report-num.mjs unavailable — falling back to max+1 (unsafe if runs overlap).');
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

function normalizeUrlForTabCheck(u) {
  if (!u) return '';
  try {
    const parsed = new URL(u);
    let host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let path = parsed.pathname.replace(/\/$/, '').toLowerCase();
    return `${host}${path}`;
  } catch (e) {
    return u.toLowerCase().replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  }
}

// ---------------------------------------------------------------------------
// Company Application Cap check helper
// ---------------------------------------------------------------------------
function getOverAppliedCompanies(applicationsPath, limit = 2, days = 30) {
  const overApplied = new Set();
  try {
    const caps = getCompanyCaps(limit, days);
    for (const [companyLower, info] of Object.entries(caps)) {
      if (info.count >= limit) {
        overApplied.add(companyLower.toLowerCase().replace(/[^a-z0-9]/g, ''));
      }
    }
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to retrieve company caps cache: ${err.message}`);
  }
  return overApplied;
}

// ---------------------------------------------------------------------------
// Smart Heuristic Classifier
// ---------------------------------------------------------------------------
function classifyJob(company, role, url, bodyText, locationType, overAppliedCompanies, cachedLocation = '') {
  const baseClassification = (() => {
    const lowerRole = role.toLowerCase();
    const lowerUrl = url.toLowerCase();
    const lowerCompany = company.toLowerCase().trim();
    const textToSearch = `${lowerRole} ${lowerUrl} ${bodyText.toLowerCase()}`;

    if (cachedLocation && cachedLocation.toLowerCase().includes('remote')) {
      return { country: 'Remote/Global', priority: 1 };
    }

    // 1. Check for explicit India keywords/cities first
    const indiaKeywords = ['india', 'bangalore', 'bengaluru', 'mumbai', 'hyderabad', 'chennai', 'pune', 'noida', 'gurgaon', 'gurugram', 'delhi'];
    const hasIndiaKeyword = indiaKeywords.some(keyword => 
      lowerRole.includes(keyword) || 
      lowerUrl.includes(keyword) || 
      (bodyText && bodyText.toLowerCase().includes(keyword))
    );

    if (hasIndiaKeyword) {
      return { country: 'India', priority: 1 };
    }

    // 2. Remote / Global (if explicitly remote-first or remote-friendly without local limits)
    const isRemoteRole = lowerRole.includes('remote') || lowerUrl.includes('remote') || (bodyText && bodyText.toLowerCase().includes('remote globally'));
    
    // Specific list of remote companies
    const remoteCompanies = [
      'elevenlabs', 'perplexity', 'supabase', 'zapier', 'arize ai', 
      'deepgram', 'hightouch', 'vercel', 'airtable', 'runpod', 'pinecone',
      'stability ai', 'inngest', 'planetscale', 'weights & biases (coreweave)',
      'braintrust', 'braintrustdata'
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
  })();

  if (baseClassification.country !== candidateCountry && (locationType === 'hybrid' || locationType === 'onsite')) {
    baseClassification.priority = 3;
  }

  const normCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (overAppliedCompanies && overAppliedCompanies.has(normCompany)) {
    baseClassification.priority = 3;
    baseClassification.overApplied = true;
  }

  return baseClassification;
}

// Helper for context-aware language pre-screening
function buildWordRegex(lang) {
  const escaped = lang.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  let pattern = '';
  if (/^\w/.test(lang)) pattern += '\\b';
  pattern += escaped;
  if (/\w$/.test(lang)) pattern += '\\b';
  return new RegExp(pattern, 'i');
}

function getCandidateLanguages(cv) {
  if (!cv) return [];
  const match = cv.match(/(?:-\s*\*\*Languages:\*\*|-\s*Languages:)\s*([^\n\r]+)/i);
  if (!match) return [];
  const list = match[1].split(',').map(lang => lang.trim().toLowerCase()).filter(Boolean);
  const expanded = [];
  for (const item of list) {
    if (item === 'c/c++') {
      expanded.push('c', 'c++', 'cpp');
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}

function isBlockedByLanguage(jdText, excludedLang, cv) {
  const langRegex = buildWordRegex(excludedLang);
  if (!langRegex.test(jdText)) return false;

  const candidateLanguages = getCandidateLanguages(cv);
  const sentences = jdText.split(/[.!?\n]/);

  for (const sentence of sentences) {
    if (!langRegex.test(sentence)) continue;

    // Check if this sentence contains any candidate languages (other than the excluded one)
    const hasCandidateLang = candidateLanguages.some(lang => {
      if (lang === excludedLang.toLowerCase()) return false;
      const candRegex = buildWordRegex(lang);
      return candRegex.test(sentence);
    });

    if (hasCandidateLang) {
      console.log(`  ℹ️ Language "${excludedLang}" found in JD, but rescued by candidate language in the same sentence: "${sentence.trim()}"`);
      continue; // Not a dealbreaker for this sentence
    }

    return true; // Found sentence where excluded lang is required without candidate alternatives
  }

  return false; // All occurrences were rescued
}

// ---------------------------------------------------------------------------
// Check Location/Visa Dealbreakers
// ---------------------------------------------------------------------------
function checkHardDealbreakers(bodyText, classification, profileDoc) {
  // 1. Experience floor check
  const expRegex = /\b(?:minimum\s+of|min\s+of|at\s+least|minimum|min|require[sd]?)\s*(\d+)(?:\s*(?:-\s*|\s+to\s+)\d+)?\s*(?:years?|yrs?)\b|\b(\d+)\s*(?:\+|plus)\s*(?:years?|yrs?)\b|\b(\d+)\s*(?:-|to)\s*\d+\s*(?:years?|yrs?)\b|\b(\d+)\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|industry\s+|work\s+)?(?:software\s+)?experience\b/gi;
  let maxRequired = 0;
  let match;
  while ((match = expRegex.exec(bodyText)) !== null) {
    const numStr = match[1] || match[2] || match[3] || match[4];
    if (numStr) {
      const val = parseInt(numStr, 10);
      if (!isNaN(val) && val > maxRequired) {
        maxRequired = val;
      }
    }
  }

  if (maxRequired > 0) {
    const expStartDateStr = profileDoc?.candidate?.experience_start_date || '2021-06-01';
    const expStartDate = new Date(expStartDateStr);
    const today = new Date();
    const diffMs = today.getTime() - expStartDate.getTime();
    const candidateExperienceYears = Math.max(4.0, diffMs / (1000 * 60 * 60 * 24 * 365.25));
    const maxAllowedYears = candidateExperienceYears + 2;

    const maxYoeLimit = typeof profileDoc?.candidate?.max_yoe_limit === 'number' ? profileDoc.candidate.max_yoe_limit : 7;
    if (maxRequired >= maxYoeLimit) {
      return `Experience floor check: JD requires ${maxRequired}+ years of experience, exceeding candidate's limit of ${maxYoeLimit} years`;
    }
    if (maxRequired > maxAllowedYears) {
      return `Experience floor check: JD requires ${maxRequired}+ years of experience, exceeding candidate's ${candidateExperienceYears.toFixed(2)} years by more than 2 years`;
    }
  }

  // 2. Hard-skill programming language pre-screen (Suggestion Spotify #249)
  const hardSkillConfig = profileDoc?.hard_skill_prescreen || {};
  const excludedLanguages = hardSkillConfig.excluded_languages || [];
  for (const lang of excludedLanguages) {
    if (isBlockedByLanguage(bodyText, lang, cvContent)) {
      return `Hard-skill pre-screen: JD requires "${lang}" but candidate CV does not list it`;
    }
  }

  const candidateCountry = profileDoc?.location?.country || 'India';
  const visaStatus = profileDoc?.location?.visa_status || '';
  const needsSponsorship = visaStatus.toLowerCase().includes('needs') && (visaStatus.toLowerCase().includes('sponsorship') || visaStatus.toLowerCase().includes('visa'));

  if (!needsSponsorship) {
    return null;
  }

  // Regex patterns from the user's proposal
  const sponsorshipRegexes = [
    /no visa sponsorship/i,
    /not eligible for visa sponsorship/i,
    /must be authorized to work in [^.\n]+ without sponsorship/i,
    /must be authorized to work without sponsorship/i,
    /citizenship required/i,
    /security clearance required/i,
    /unable to sponsor/i,
    /cannot sponsor/i
  ];

  // If the job's country is not the candidate's country, check if sponsorship/work authorization constraints exist
  if (classification.country !== candidateCountry) {
    for (const regex of sponsorshipRegexes) {
      if (regex.test(bodyText)) {
        return `Sponsorship/authorization requirement found: "${bodyText.match(regex)[0]}"`;
      }
    }
  }

  // Pre-screen check: if role is international (not India and not Remote/Global), JD must mention visa/sponsorship/relocation
  if (classification.country !== 'India' && classification.country !== 'Remote/Global') {
    const sponsorshipKeywordsRegex = /visa|sponsor|relocat|work\s*permit|transfer/i;
    if (!sponsorshipKeywordsRegex.test(bodyText)) {
      return `Silent on visa sponsorship/relocation for international role (classification: ${classification.country})`;
    }
  }

  // Location/Visa dealbreaker pattern: "must be based/located in"
  const locationRegex = /must be (currently\s+)?(based|located)\s+in\s+([A-Za-z\s,]+)/i;
  const locMatch = bodyText.match(locationRegex);
  if (locMatch) {
    const loc = locMatch[3].toLowerCase();
    // Check if the candidate's home location matches
    const isIndia = loc.includes('india') || loc.includes('bengaluru') || loc.includes('bangalore');
    const isRemoteGlobal = loc.includes('remote') || loc.includes('anywhere') || loc.includes('global') || loc.includes('contractor');
    if (!isIndia && !isRemoteGlobal && classification.country !== candidateCountry && classification.country !== 'Remote/Global') {
      return `Location dealbreaker: must be based/located in "${locMatch[3].trim()}"`;
    }
  }

  return null;
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
  
  let responseText = result.response.text();
  
  // Degenerate Repetition Guard
  if (responseText.length > 15000 || responseText.split('\n').some(line => line.length > 5000)) {
    console.warn(`⚠️ Detected degenerate Gemini output (length: ${responseText.length}). Retrying evaluation exactly once...`);
    const retryResult = await geminiModel.generateContent([
      { text: systemPrompt },
      { text: `\n\nJOB URL TO EVALUATE: ${url}\n\nJOB DESCRIPTION TO EVALUATE:\n\n${bodyText}` }
    ]);
    responseText = retryResult.response.text();
  }
  
  return responseText;
}

// ---------------------------------------------------------------------------
// Dynamic CV Tailoring & PDF Generation (Score >= 3.0)
// ---------------------------------------------------------------------------
// Define structured JSON Schema for CV Tailoring using SchemaType
const cvSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary_text: {
      type: SchemaType.STRING,
      description: "Sophisticated, single-paragraph professional summary of exactly 3 sentences (max 4 lines) highlighting the target role and core experience."
    },
    competencies: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Exactly 6 to 8 core technical competency tags tailored to the job description."
    },
    experience: {
      type: SchemaType.ARRAY,
      description: "Exactly 2 chronological jobs matching cv.md: realfast.ai and ProPro Productions.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          company: { type: SchemaType.STRING },
          role: { type: SchemaType.STRING },
          period: { type: SchemaType.STRING },
          location: { type: SchemaType.STRING },
          bullets: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: "Exactly 3 punchy, metric-rich achievement bullets. Each bullet must start directly with a strong past-tense action verb (e.g. 'Architected...', 'Engineered...', 'Led...', 'Optimized...'). Do NOT include bold category prefixes."
          }
        },
        required: ['company', 'role', 'period', 'location', 'bullets']
      }
    },
    projects: {
      type: SchemaType.ARRAY,
      description: "Exactly 3 relevant selected projects matching the role requirements from the digest/portfolio.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          badge: { type: SchemaType.STRING },
          desc: { type: SchemaType.STRING, description: "An elegant, highly concise 1-2 line description highlighting complex architectural details, scale, or metrics." },
          tech: { type: SchemaType.STRING, description: "Comma-separated tech stack list." }
        },
        required: ['title', 'badge', 'desc', 'tech']
      }
    },
    skills: {
      type: SchemaType.ARRAY,
      description: "Exactly 5 skill categories matching Languages, Backend & Systems, AI/ML & Data, Frontend & UI, and DevOps & Cloud.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          category: { type: SchemaType.STRING },
          items: { type: SchemaType.STRING }
        },
        required: ['category', 'items']
      }
    }
  },
  required: ['summary_text', 'competencies', 'experience', 'projects', 'skills']
};

function getTailoringModelInstance(genAI, name) {
  return genAI.getGenerativeModel({
    model: name,
    generationConfig: {
      temperature: 0.1, // low temperature for absolute precision
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: cvSchema
    }
  });
}

// ---------------------------------------------------------------------------
// Dynamic CV Tailoring & PDF Generation (Score >= 3.0)
// ---------------------------------------------------------------------------
async function tailorCVAndGeneratePDF(company, role, url, bodyText, num, today, companySlug, country) {
  console.log(`  📝 [Tailoring CV] dynamically customizing CV for ${company} | ${role}...`);
  try {
    const profileYmlContent = readFileSync(PATHS.profileYml, 'utf-8');
    const profileDoc = yaml.load(profileYmlContent);
    const candidateName = profileDoc?.candidate?.full_name || 'Shashwat Gupta';
    const phone = profileDoc?.candidate?.phone || '';
    const email = profileDoc?.candidate?.email || '';
    const linkedin = profileDoc?.candidate?.linkedin || '';
    const portfolioUrl = profileDoc?.candidate?.portfolio_url || 'https://shashtag.me';

    const candidateSlug = candidateName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Decide format & layout params
    const isUSOrCanada = ['us', 'usa', 'united states', 'canada'].includes(country?.toLowerCase().trim());
    const format = isUSOrCanada ? 'letter' : 'a4';
    const pageWidth = format === 'letter' ? '8.5in' : '210mm';

    // Load fresh contents of files
    const freshSharedContext = existsSync(PATHS.shared) ? readFileSync(PATHS.shared, 'utf-8').trim() : '';
    const freshCvContent = existsSync(PATHS.cv) ? readFileSync(PATHS.cv, 'utf-8').trim() : '';
    const freshProfileContent = existsSync(PATHS.profile) ? readFileSync(PATHS.profile, 'utf-8').trim() : '';
    const digestPath = join(ROOT, 'article-digest.md');
    const digestContent = existsSync(digestPath) ? readFileSync(digestPath, 'utf-8').trim() : '';

    const systemPrompt = `You are career-ops, an elite AI-powered job search assistant. Your goal is to generate a highly tailored, exceptionally premium, ATS-optimized CV matching the specific job description (JD) using the candidate's real work history and achievements.

EVALUATION METHODOLOGY AND BRAND STORY:
${freshSharedContext}

CANDIDATE CANONICAL EXPERIENCE (cv.md):
${freshCvContent}

PORTFOLIO & DETAILED ACHIEVEMENTS (article-digest.md):
${digestContent}

USER TARGETS & ARCHETYPE FRAMING (_profile.md):
${freshProfileContent}

STRICT RESUME FORMATTING AND LAYOUT DIRECTIVES:
To make the resume look absolutely stunning and ensure it fits on EXACTLY one single page (A4/Letter) with no page overflow, you must follow these rules:

1. "summary_text":
   - Write an elite, high-impact professional summary tailored precisely to the company (${company}) and role (${role}). Use sophisticated, action-oriented, and concise language.
   - It must be a single paragraph of exactly 3 sentences (max 4 lines when rendered).
   - Do NOT include any markdown bolding (\`**\`), lists, or double curly braces.
   - Incorporate the company name, target role, and the candidate's core value proposition:
     "Full-stack and systems engineer with 4+ years of experience architecting distributed networks, real-time collaboration platforms, and robust AI integrations. Co-founded and scaled high-performance products—from an acquired, Figma-like canvas (ProPro) to sandboxed dynamic DSL evaluation engines (JoyFill) and distributed Go microservices (karada.ai). Proven track record driving enterprise AI transformation roadmaps at realfast.ai. Targeting the ${role} role at ${company}."

2. "competencies":
   - Extract exactly 6 to 8 of the most relevant skill keywords or phrases from the JD.
   - Ensure the keywords directly reflect the job's core technical requirements (e.g., Distributed Systems, GoLang, ML Pipelines, RAG Architectures, API Design, High-Scale Web, etc.).

3. "experience":
   - You MUST output exactly the two jobs from cv.md in chronological order (newest to oldest):
     1. Forward Deployed Engineer | realfast.ai | Mar 2026 – Present
     2. Founding Engineer | ProPro Productions | July 2023 – Nov 2025
   - Limit each job to 3-4 bullet points. Keep each bullet point to a maximum of 1-2 lines. This is critical to guarantee a 1-page fit.
   - Use high-tier, sophisticated professional vocabulary. Do NOT use passive verbs. Focus on "Architected", "Engineered", "Pioneered", "Optimized", "Designed", "Spearheaded", "Led".
   - Bullets MUST start directly with the past-tense action verb (David Jiang Resume Blueprint). Do NOT prefix bullets with bold category labels like "<strong>Architected:</strong>".
   - Locations: realfast.ai is "Bengaluru, India"; ProPro Productions is "Germany (Remote)".

4. "projects":
   - To fit on one page, select EXACTLY 3 relevant projects matching the role requirements from the candidate's portfolio/digest (e.g. karada.ai, JoyFill Forms Formula Engine, Nifty-Graphs, Fusion Data Secure, etc.). Do NOT select more or less than 3 projects.
   - Ensure each project highlighting the core skills needed for the role (from article-digest.md).
   - Each project has:
     - \`title\`: Name of the project (e.g., karada.ai, Nifty-Graphs, JoyFill Forms Formula Engine, etc.).
     - \`badge\`: Highlighting core role/tech (e.g. \`Distributed Go & MCP Server\`, \`AST Calculation Engine\`, etc.).
     - \`desc\`: Tailored elegant description of what you built, how you built it, and the impact. Keep it highly concise — strictly exactly 1 or 2 lines maximum.
     - \`tech\`: Tech stack comma-separated.

5. "skills":
   - Reorder and tailor the technical skills categories into a beautifully balanced, keyword-optimized skills grid.
   - It MUST contain exactly 5 categories: "Languages", "Backend & Systems", "AI/ML & Data", "Frontend & UI", and "DevOps & Cloud".
   - Under each category, provide a comma-separated list of technologies, tailored to emphasize keywords from the JD.
`;

    const userPrompt = `JOB TITLE: ${role}
COMPANY: ${company}
JOB DESCRIPTION:
${bodyText}

Tailor the CV and return a raw JSON object adhering to the schema. Include elite metrics and highly professional vocabulary.`;

    const modelsToTry = [
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-flash-latest'
    ];
    let result = null;
    let modelIndex = 0;
    let attempts = 0;
    const maxAttemptsPerModel = 3;
    let delay = 20000;

    const genAI = new GoogleGenerativeAI(apiKey);

    while (modelIndex < modelsToTry.length) {
      const currentModelName = modelsToTry[modelIndex];
      const modelInstance = getTailoringModelInstance(genAI, currentModelName);
      console.log(`  🤖 Attempting CV generation using model: ${currentModelName} (Model ${modelIndex + 1}/${modelsToTry.length})`);
      
      let modelSuccess = false;
      attempts = 0;
      delay = 20000; // Reset delay for the new model
      
      while (attempts < maxAttemptsPerModel) {
        try {
          result = await modelInstance.generateContent({
            contents: [
              { role: 'user', parts: [{ text: systemPrompt }, { text: userPrompt }] }
            ]
          });
          modelSuccess = true;
          console.log(`  ✅ Successfully generated CV with model: ${currentModelName}`);
          break;
        } catch (err) {
          attempts++;
          const isRateLimit = err.status === 429 || 
                              (err.message && err.message.includes('429')) || 
                              (err.message && err.message.toLowerCase().includes('quota')) || 
                              (err.message && err.message.toLowerCase().includes('too many requests'));
          
          const isDailyQuotaExceeded = err.message && 
                                       (err.message.includes('daily') || 
                                        err.message.includes('Daily limit') || 
                                        err.message.includes('quota exceeded') ||
                                        (err.message.includes('429') && err.message.includes('limit') && err.message.includes('0')));

          if (isRateLimit && !isDailyQuotaExceeded && attempts < maxAttemptsPerModel) {
            console.warn(`  ⚠️  Rate limited (429) on ${company} | ${role} with model ${currentModelName}. Attempt ${attempts}/${maxAttemptsPerModel}. Waiting ${delay / 1000} seconds before retrying...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 1.5; // Exponential backoff
          } else if (isDailyQuotaExceeded || attempts >= maxAttemptsPerModel) {
            console.warn(`  ❌ Model ${currentModelName} failed (or daily quota exceeded). Falling back to next tier.`);
            break; // Break the inner loop, try the next model
          } else {
            // Re-throw other non-rate-limit errors
            throw err;
          }
        }
      }
      
      if (modelSuccess) {
        break;
      }
      modelIndex++;
    }

    if (!result) {
      throw new Error(`Failed to generate content using all available models: ${modelsToTry.join(', ')}`);
    }

    const responseText = result.response.text().trim();
    let tailoredData = JSON.parse(responseText);

    // Deep sanitize string fields to replace literal \n or raw newlines with spaces
    const sanitizeStrings = (val) => {
      if (typeof val === 'string') {
        return val.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      } else if (Array.isArray(val)) {
        return val.map(sanitizeStrings);
      } else if (typeof val === 'object' && val !== null) {
        const cleaned = {};
        for (const [k, v] of Object.entries(val)) {
          cleaned[k] = sanitizeStrings(v);
        }
        return cleaned;
      }
      return val;
    };
    tailoredData = sanitizeStrings(tailoredData);

    // Read the template HTML
    const templatePath = PATHS.cvTemplate;
    if (!existsSync(templatePath)) {
      throw new Error(`Templates path not found at ${templatePath}`);
    }
    let html = readFileSync(templatePath, 'utf-8');

    // Construct dynamic contact row items
    const contactItems = [];
    if (phone && phone.trim() !== '') {
      contactItems.push(`<a href="tel:${phone.trim()}">${phone.trim()}</a>`);
    }
    if (email && email.trim() !== '') {
      contactItems.push(`<a href="mailto:${email.trim()}">${email.trim()}</a>`);
    }
    if (profileDoc?.candidate?.github) {
      const gh = profileDoc.candidate.github.trim();
      const ghUrl = gh.startsWith('http') ? gh : `https://${gh}`;
      const ghDisplay = gh.replace(/^https?:\/\/(www\.)?/, '');
      contactItems.push(`<a href="${ghUrl}">${ghDisplay}</a>`);
    }
    if (linkedin && linkedin.trim() !== '') {
      const liUrl = linkedin.startsWith('http') ? linkedin : `https://${linkedin}`;
      const liDisplay = linkedin.replace(/^https?:\/\/(www\.)?/, '');
      contactItems.push(`<a href="${liUrl}">${liDisplay}</a>`);
    }
    if (portfolioUrl && portfolioUrl.trim() !== '') {
      const portUrl = portfolioUrl.startsWith('http') ? portfolioUrl : `https://${portfolioUrl}`;
      const portDisplay = portfolioUrl.replace(/^https?:\/\/(www\.)?/, '');
      contactItems.push(`<a href="${portUrl}">${portDisplay}</a>`);
    }
    // Always include karada.ai for Shashwat
    contactItems.push(`<a href="https://karada.ai">karada.ai</a>`);
    
    const locationVal = profileDoc?.candidate?.location || 'Bengaluru, India';
    contactItems.push(`<span>${locationVal}</span>`);

    const contactRowHtml = `<div class="contact-row">
      ${contactItems.join('\n      <span class="separator">|</span>\n      ')}
    </div>`;

    const contactRowRegex = /<div class="contact-row">[\s\S]*?<\/div>/i;
    html = html.replace(contactRowRegex, contactRowHtml);

    // Programmatically construct HTML blocks from structured JSON data
    const competenciesHtml = tailoredData.competencies.map(c => `<span class="competency-tag">${c}</span>`).join('\n      ');
    
    const experienceHtml = tailoredData.experience.map(job => {
      const bulletsHtml = job.bullets.map(b => `      <li>${b}</li>`).join('\n');
      return `  <div class="job">
    <div class="job-header">
      <span class="job-company">${job.company}</span>
      <span class="job-period">${job.period}</span>
    </div>
    <div class="job-role">${job.role}</div>
    <div class="job-location">${job.location}</div>
    <ul>
${bulletsHtml}
    </ul>
  </div>`;
    }).join('\n\n  ');

    const projectsHtml = tailoredData.projects.map(proj => {
      return `  <div class="project">
    <span class="project-title">${proj.title}</span>
    <span class="project-badge">${proj.badge}</span>
    <div class="project-desc">${proj.desc}</div>
    <div class="project-tech">${proj.tech}</div>
  </div>`;
    }).join('\n\n  ');

    const educationHtml = `  <div class="edu-item">
    <div class="edu-header">
      <span class="edu-title">B-Tech in Computer Science and Engineering</span>
      <span class="edu-org">Vellore Institute of Technology, Vellore</span>
    </div>
    <div class="edu-desc"><strong>Relevant Coursework:</strong> Data Structures and Algorithms, Distributed Systems, Operating Systems, Computer Networks, Computer Architecture, Discrete Math, AI/ML.</div>
  </div>`;

    const skillsHtml = `  <div class="skills-grid">
${tailoredData.skills.map(s => `    <div class="skill-item"><span class="skill-category">${s.category}:</span> ${s.items}</div>`).join('\n')}
  </div>`;

    // Replacements mapping
    const replacements = {
      '{{LANG}}': 'en',
      '{{PAGE_WIDTH}}': pageWidth,
      '{{NAME}}': candidateName,
      '{{PHOTO}}': profileDoc?.candidate?.photo ? `<img src="${profileDoc.candidate.photo}" class="cv-photo" alt="Photo" />` : '',
      '{{EMAIL}}': email,
      '{{LINKEDIN_URL}}': linkedin.startsWith('http') ? linkedin : `https://${linkedin}`,
      '{{LINKEDIN_DISPLAY}}': linkedin.replace(/^https?:\/\/(www\.)?/, ''),
      '{{PORTFOLIO_URL}}': portfolioUrl,
      '{{PORTFOLIO_DISPLAY}}': portfolioUrl.replace(/^https?:\/\/(www\.)?/, ''),
      '{{LOCATION}}': profileDoc?.candidate?.location || 'Bengaluru, India',
      '{{SECTION_SUMMARY}}': 'Professional Summary',
      '{{SUMMARY_TEXT}}': tailoredData.summary_text || '',
      '{{SECTION_COMPETENCIES}}': 'Core Competencies',
      '{{COMPETENCIES}}': competenciesHtml,
      '{{SECTION_EXPERIENCE}}': 'Work Experience',
      '{{EXPERIENCE}}': experienceHtml,
      '{{SECTION_PROJECTS}}': 'Projects',
      '{{PROJECTS}}': projectsHtml,
      '{{SECTION_EDUCATION}}': 'Education',
      '{{EDUCATION}}': educationHtml,
      '{{SECTION_CERTIFICATIONS}}': 'Certifications',
      '{{CERTIFICATIONS}}': '',
      '{{SECTION_SKILLS}}': 'Skills',
      '{{SKILLS}}': skillsHtml
    };

    for (const [key, val] of Object.entries(replacements)) {
      html = html.split(key).join(val); // robust replacement of all occurrences
    }

    // Clean up certifications start/end comments completely since candidate has none
    const certSectionRegex = /<!-- CERTIFICATIONS_START -->[\s\S]*?<!-- CERTIFICATIONS_END -->/i;
    html = html.replace(certSectionRegex, '');

    // Keep Education section and cleanly strip the comment markers
    html = html.replace(/<!-- EDUCATION_START -->/i, '').replace(/<!-- EDUCATION_END -->/i, '');

    // Inject compact styles to guarantee 1-page fit and fix spacing
    const compactStyles = `
    <style>
      body { font-size: 10px !important; }
      .page { padding: 0 !important; }
      .section { margin-bottom: 8px !important; }
      .section-title { margin-bottom: 4px !important; font-size: 11px !important; }
      .job { margin-bottom: 5px !important; }
      .job-header { margin-bottom: 1px !important; }
      .job-company { font-size: 11px !important; }
      .job-role { margin-bottom: 1px !important; font-size: 10px !important; }
      .job ul { margin-top: 1px !important; padding-left: 14px !important; }
      .job li { margin-bottom: 1px !important; font-size: 9px !important; line-height: 1.3 !important; }
      .project { margin-bottom: 3px !important; }
      .project-title { font-size: 11px !important; }
      .project-desc { margin-top: 1px !important; font-size: 9px !important; line-height: 1.3 !important; }
      .project-tech { font-size: 8px !important; margin-top: 1px !important; }
      .summary-text { line-height: 1.35 !important; font-size: 9.5px !important; }
      .header { margin-bottom: 6px !important; }
      .header h1 { font-size: 22px !important; margin-bottom: 3px !important; }
      .contact-row { font-size: 9px !important; gap: 4px 8px !important; }
      .competencies-grid { gap: 3px !important; }
      .competency-tag { font-size: 8px !important; padding: 2px 5px !important; }
      .skill-item { font-size: 9px !important; }
      .skill-category { font-size: 9px !important; }
      .edu-item { margin-bottom: 2px !important; }
    </style>
    `;
    html = html.replace('</head>', compactStyles + '\n</head>');

    const tempHtmlPath = `/tmp/cv-${candidateSlug}-${companySlug}.html`;
    const finalPdfPath = join(PATHS.output, `cv-${candidateSlug}-${companySlug}-${today}.pdf`);

    writeFileSync(tempHtmlPath, html, 'utf-8');
    console.log(`  💾 Tailored HTML CV saved to ${tempHtmlPath}`);

    console.log(`  🖨️ Compiling PDF via generate-pdf.mjs...`);
    execSync(`node generate-pdf.mjs "${tempHtmlPath}" "${finalPdfPath}" --format=${format}`, { cwd: ROOT, stdio: 'inherit' });
    console.log(`  ✅ Successfully generated tailored PDF at ${finalPdfPath}`);
    return { success: true, pdfPath: `output/cv-${candidateSlug}-${companySlug}-${today}.pdf` };
  } catch (error) {
    console.error(`  ❌ Failed to tailor CV or compile PDF: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Light-weight API-based liveness pre-check (Suggestion 005)
// ---------------------------------------------------------------------------
async function checkUrlLivenessApi(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    
    // 1. Lever
    if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const company = parts[0];
        const jobId = parts[1];
        const apiUrl = `https://api.lever.co/v0/postings/${company}/${jobId}`;
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
        if (res.status === 404) return 'expired';
        if (res.ok) {
          const data = await res.json();
          return data && data.text ? 'active' : 'expired';
        }
      }
    }
    
    // 2. Ashby
    if (host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const company = parts[0];
        const jobId = parts[1];
        const apiUrl = `https://api.ashbyhq.com/posting-api/job/${jobId}`;
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
        if (res.status === 404) return 'expired';
        if (res.ok) return 'active';
      }
    }
    
    // 3. Greenhouse
    if (host === 'boards.greenhouse.io' || host.endsWith('.greenhouse.io')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 3 && parts[1] === 'jobs') {
        const company = parts[0];
        const jobId = parts[2];
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}`;
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
        if (res.status === 404) return 'expired';
        if (res.ok) return 'active';
      }
    }
  } catch (err) {
    console.warn(`      ⚠️ API liveness check error for ${url}: ${err.message}`);
  }
  return 'unknown';
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
// Classification cache helpers
// ---------------------------------------------------------------------------
function loadClassificationCache() {
  if (!existsSync(PATHS.classifiedJobs)) return {};
  try {
    return JSON.parse(readFileSync(PATHS.classifiedJobs, 'utf-8'));
  } catch {
    return {};
  }
}

function saveClassificationCache(cache) {
  writeFileSync(PATHS.classifiedJobs, JSON.stringify(cache, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// ANSI colors & interaction helpers
// ---------------------------------------------------------------------------
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m'
};

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

function findTrackerIdByReport(filename) {
  const filePath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.includes(`(reports/${filename})`)) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 2) {
        return parts[1];
      }
    }
  }
  return null;
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
  const nonInteractive = args.includes('--non-interactive');

  if (!classifyOnly && targetPriority === null) {
    console.error('❌ Please specify a priority target: --priority [1|2|3] or use --classify-only');
    process.exit(1);
  }

  if (!classifyOnly && !apiKey) {
    console.error('❌ GEMINI_API_KEY is not set in environment or .env file. Real evaluation cannot proceed. Please run with --classify-only or set GEMINI_API_KEY.');
    process.exit(1);
  }

  // Load over-applied companies from applications.md history
  const overAppliedCompanies = getOverAppliedCompanies(PATHS.applications, 2, 30);
  const totalTrackedCompanies = portalsDoc?.tracked_companies?.length || 0;
  const remainingSlots = Math.max(0, totalTrackedCompanies - overAppliedCompanies.size);
  console.log(`Cap status: ${overAppliedCompanies.size} companies at cap, ${remainingSlots} companies with slots remaining.`);
  if (overAppliedCompanies.size > 0) {
    console.log(`⚠️ Over-applied companies (cap >= 2 in 30d): ${[...overAppliedCompanies].join(', ')}`);
  }

  // Load pending review queue
  const pendingReviewPath = join(ROOT, 'data', 'pending-review.yml');
  let pendingReviewList = [];
  if (existsSync(pendingReviewPath)) {
    try {
      pendingReviewList = yaml.load(readFileSync(pendingReviewPath, 'utf-8')) || [];
    } catch (e) {
      pendingReviewList = [];
    }
  }
  if (!Array.isArray(pendingReviewList)) pendingReviewList = [];
  if (pendingReviewList.length > 0) {
    console.log(`⏳ Pending review queue: ${pendingReviewList.length} application(s) waiting for user action.`);
  }

  // Query open Chrome tabs using list-open-forms.mjs
  let openForms = [];
  try {
    const listResult = spawnSync('node', ['list-open-forms.mjs'], { encoding: 'utf-8' });
    if (listResult.status === 0 && listResult.stdout.trim()) {
      openForms = JSON.parse(listResult.stdout);
      console.log(`🌐 list-open-forms.mjs: Found ${openForms.length} open application form(s) in Chrome.`);
    }
  } catch (e) {
    // Ignore error
  }

  console.log('📌 Parsing data/pipeline.md...');
  const { lines, pendingJobs } = loadPipeline();
  console.log(`📊 Found ${pendingJobs.length} pending unchecked job(s) in pipeline.`);

  // Prioritize pendingJobs based on config/profile.yml priority_companies (Suggestion 005)
  const priorityCompanies = (profileDoc.priority_companies || []).map(c => c.toLowerCase().trim());
  if (priorityCompanies.length > 0) {
    const priorityJobs = [];
    const normalJobs = [];
    for (const job of pendingJobs) {
      const isPriority = priorityCompanies.some(pc => job.company.toLowerCase().trim().includes(pc) || pc.includes(job.company.toLowerCase().trim()));
      if (isPriority) {
        priorityJobs.push(job);
      } else {
        normalJobs.push(job);
      }
    }
    if (priorityJobs.length > 0) {
      console.log(`⭐ Prioritized ${priorityJobs.length} job(s) from priority companies: ${profileDoc.priority_companies.join(', ')}`);
      pendingJobs.splice(0, pendingJobs.length, ...priorityJobs, ...normalJobs);
    }
  }

  let browser = null;
  // Claims taken this run; released in the finally so a crash can't wedge a job.
  const claimedThisRun = [];
  // Tab-held claims must be judged against the tabs that are actually open, so
  // the sweep needs the live tab list (null when Chrome is unreachable, which
  // deliberately preserves claims rather than freeing them).
  const openTabUrls = await fetchOpenTabUrls();
  sweepStaleClaims(openTabUrls);
  let evaluatedCount = 0;
  let expiredCount = 0;
  let skippedCount = 0;

  try {
    const classificationCounts = { 1: 0, 2: 0, 3: 0 };
    const countryCounts = {};
    const classificationCache = loadClassificationCache();
    let cacheHits = 0;
    let newlyClassified = 0;
    console.log(`📦 Classification cache: ${Object.keys(classificationCache).length} entries loaded.`);

    console.log('\n🔍 Processing jobs...');

    for (let i = 0; i < pendingJobs.length; i++) {
      const job = pendingJobs[i];
      const { rawLine, url, company, role, lineIndex } = job;

      // Claim this job before touching it. Selection is deterministic — every
      // run reads the same pipeline and picks the same top job — so without a
      // claim, two overlapping runs work the SAME job in two tabs and file the
      // same application twice. Keyed on URL because a report number doesn't
      // exist yet at this point. Released in the finally below.
      const claim = claimJob(url, { bindToPid: true, url, openUrls: openTabUrls, note: `${company} | ${role}` });
      if (!claim.ok) {
        console.log(`  ⏭️  [Claimed by another run] ${company} | ${role} — skipping (${claim.reason})`);
        skippedCount++;
        continue;
      }
      claimedThisRun.push({ jobId: url, release: claim.release });

      // Check if this job has already been marked as expired in cache (Suggestion 002)
      if (classificationCache[url]?.expired) {
        console.log(`  ❌ [Expired in Cache] ${company} | ${role} (${classificationCache[url].reason || 'marked expired'})`);
        expiredCount++;
        if (!classifyOnly) {
          lines[lineIndex] = `- [x] ~~${url} | ${company} | ${role}~~ [Expired in Cache]`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');
        }
        continue;
      }

      // Check if this job is already in the pending review list
      const isPendingReview = pendingReviewList.some(item => 
        item.url === url || (item.company.toLowerCase() === company.toLowerCase() && item.role.toLowerCase() === role.toLowerCase())
      );
      if (isPendingReview) {
        console.log(`  ⏳ [Pending Review] ${company} | ${role} is already waiting for user action. Skipping.`);
        skippedCount++;
        continue;
      }

      // Check if this company is already open in Chrome (from list-open-forms.mjs)
      if (openForms.length > 0) {
        const cleanCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchingOpenForm = openForms.find(form => 
          form.company.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanCompany
        );
        if (matchingOpenForm) {
          console.log(`  🌐 [Open Form] ${company} | ${role} is skipped because ${matchingOpenForm.company} has an active form open in Chrome (Report #${matchingOpenForm.report_id || 'unknown'}).`);
          skippedCount++;
          continue;
        }
      }

      // Check for duplicate in applications.md history
      const duplicate = checkDuplicate(url, PATHS.applications, PATHS.reports);
      if (duplicate) {
        const skipStatuses = ['applied', 'responded', 'interview', 'offer', 'discarded', 'evaluated', 'rejected', 'skip'];
        const statusClean = duplicate.status.replace(/\*\*/g, '').trim().toLowerCase();
        if (skipStatuses.includes(statusClean)) {
          console.log(`  ⏭️  [Duplicate] ${company} | ${role} is a duplicate of #${duplicate.num} (Status: ${duplicate.status}). Skipping.`);
          
          if (!classifyOnly) {
            lines[lineIndex] = `- [x] ${url} | ${company} | ${role} | DUPLICATE of #${duplicate.num} (${duplicate.status})`;
            writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');
          }
          skippedCount++;
          continue;
        }
      }

      // Check company application cap (Suggestion 007)
      const normCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (overAppliedCompanies.has(normCompany)) {
        console.log(`  🚫 [Cap Pre-check] Skipping ${company} | ${role} (Application cap reached: >= 2 in 30d)`);
        skippedCount++;
        continue;
      }

      // Light-weight API liveness pre-check (Suggestion 005)
      if (!classifyOnly) {
        const apiLiveness = await checkUrlLivenessApi(url);
        if (apiLiveness === 'expired') {
          expiredCount++;
          console.log(`  ❌ [Expired via API] ${company} | ${role}`);
          
          classificationCache[url] = {
            ...classificationCache[url],
            expired: true,
            expiredAt: new Date().toISOString(),
            reason: 'ATS API returned 404/expired'
          };
          saveClassificationCache(classificationCache);

          lines[lineIndex] = `- [x] ~~${url} | ${company} | ${role}~~ [Expired via API]`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');
          logExpiredToScanHistory(url, company, role);
          continue;
        }
      }

      // 0. If --classify-only and already classified, print from cache and skip all I/O
      if (classifyOnly && classificationCache[url]) {
        const cached = classificationCache[url];
        classificationCounts[cached.priority]++;
        countryCounts[cached.country] = (countryCounts[cached.country] || 0) + 1;
        console.log(`  ✅ [Cached] [Priority ${cached.priority}] [${cached.country}] ${company} | ${role}`);
        cacheHits++;
        continue;
      }

      // 1. Check JD cache first
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
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (response && (response.status() === 404 || response.status() === 410)) {
            console.log(`  ❌ [Expired HTTP ${response.status()}] ${company} | ${role}`);
            classificationCache[url] = {
              ...classificationCache[url],
              expired: true,
              expiredAt: new Date().toISOString(),
              reason: `HTTP ${response.status()}`
            };
            saveClassificationCache(classificationCache);
            if (!classifyOnly) {
              lines[lineIndex] = `- [x] ~~${url} | ${company} | ${role}~~ [Expired HTTP ${response.status()}]`;
              writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');
              logExpiredToScanHistory(url, company, role);
            }
            expiredCount++;
            await page.close();
            continue;
          }
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
        
        classificationCache[url] = {
          ...classificationCache[url],
          expired: true,
          expiredAt: new Date().toISOString(),
          reason: liveness.reason
        };
        saveClassificationCache(classificationCache);

        if (!classifyOnly) {
          // Mark as expired in pipeline.md memory representation
          lines[lineIndex] = `- [x] ~~${url} | ${company} | ${role}~~ [Expired]`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');
          // Log to scan-history.tsv so we never scan/process it again
          logExpiredToScanHistory(url, company, role);
        }
        continue;
      }

      // 4. Classify location & priority (use cache if available)
      let classification;
      if (classificationCache[url] && classificationCache[url].priority && classificationCache[url].country) {
        classification = { country: classificationCache[url].country, priority: classificationCache[url].priority };
        const normCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (overAppliedCompanies && overAppliedCompanies.has(normCompany)) {
          classification.priority = 3;
          classification.overApplied = true;
        }
        cacheHits++;
      } else {
        classification = classifyJob(company, role, url, bodyText, classificationCache[url]?.locationType, overAppliedCompanies, cacheData.location || '');
        // Persist to classification cache
        classificationCache[url] = {
          ...classificationCache[url],
          company,
          role,
          country: classification.country,
          priority: classification.priority,
          overApplied: classification.overApplied || false,
          classifiedAt: new Date().toISOString().slice(0, 10)
        };
        saveClassificationCache(classificationCache);
        newlyClassified++;
      }
      classificationCounts[classification.priority]++;
      countryCounts[classification.country] = (countryCounts[classification.country] || 0) + 1;

      console.log(`  ✅ [Active] [Priority ${classification.priority}] [${classification.country}] ${company} | ${role}${classification.overApplied ? ' (Over-applied)' : ''}`);

      if (classifyOnly) {
        continue;
      }

      // 5. Evaluate if priority matches target
      if (classification.priority === targetPriority) {
        if (limit !== null && evaluatedCount >= limit) {
          console.log(`⏱️ Limit of ${limit} evaluations reached. Stopping.`);
          break;
        }

        // Check dealbreakers
        const dealbreakerReason = checkHardDealbreakers(bodyText, classification, profileDoc);
        if (dealbreakerReason) {
          console.log(`  ⚠️ [Pre-screen Dealbreaker] ${company} | ${role} (Reason: ${dealbreakerReason})`);
          
          const num = nextReportNumber();
          const today = new Date().toISOString().split('T')[0];
          const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const filename = `${num}-${companySlug}-${today}.md`;
          const reportPath = join(PATHS.reports, filename);

          const score = '2.5';
          const parsedArchetype = 'Unknown';
          const parsedLegitimacy = 'High Confidence';
          const pdfReportStatus = '❌';

          const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${url}
**Archetype:** ${parsedArchetype}
**Score:** ${score}/5
**Legitimacy:** ${parsedLegitimacy}
**PDF:** ${pdfReportStatus}
**Tool:** Pre-screen Pass/Fail

---

### Hard Dealbreaker Detected
The job description contains an explicit, unambiguous dealbreaker: **${dealbreakerReason}**.
Skipped full Gemini evaluation and CV/PDF generation to save API tokens.
`;

          writeFileSync(reportPath, reportContent, 'utf-8');
          console.log(`  💾 Report saved to reports/${filename}`);

          // Create TSV tracker addition
          const pdfStatusString = '❌';
          const tsvContent = `${num}\t${today}\t${company}\t${role}\tEvaluated\t${score}/5\t${pdfStatusString}\t[${num}](reports/${filename})\tSkipped via Pre-screen: ${dealbreakerReason}`;
          const tsvPath = join(PATHS.trackerAdditions, `${num}-${companySlug}.tsv`);
          writeFileSync(tsvPath, tsvContent, 'utf-8');

          // Run merge-tracker.mjs to integrate into applications.md immediately
          execSync('node merge-tracker.mjs', { cwd: ROOT, stdio: 'inherit' });

          // Update pipeline.md to mark complete
          lines[lineIndex] = `- [x] ${url} | ${company} | ${role} | Score: 2.5/5 (Dealbreaker) | [Report ${num}](reports/${filename})`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');

          evaluatedCount++;
          continue;
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
          let parsedLocationConflict = false;

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
            
            const locConfStr = extract('location_conflict');
            if (locConfStr && locConfStr !== 'Unknown') {
              parsedLocationConflict = locConfStr.toLowerCase() === 'true';
            }
          }

          // Highly robust fallback parser if the machine summary block is missing, incomplete, or formatted differently
          if (!score || score === '?' || score === 'Unknown') {
            const scoreMatch = evaluationText.match(/(?:score|globale? score)\s*:\s*\*?\*?\s*([0-5](?:\.\d+)?)/i);
            if (scoreMatch) {
              score = scoreMatch[1].trim();
            }
          }
          if (parsedArchetype === 'Unknown' || !parsedArchetype) {
            const archMatch = evaluationText.match(/archetype\s*:\s*\*?\*?\s*([^\n\r*]+)/i);
            if (archMatch) {
              parsedArchetype = archMatch[1].trim();
            }
          }
          if (parsedLegitimacy === 'High Confidence' || parsedLegitimacy === 'Unknown' || !parsedLegitimacy) {
            const legMatch = evaluationText.match(/legitimacy\s*:\s*\*?\*?\s*(High Confidence|Proceed with Caution|Suspicious)/i);
            if (legMatch) {
              parsedLegitimacy = legMatch[1].trim();
            }
          }
          if (!parsedLocationConflict) {
            parsedLocationConflict = evaluationText.includes('⚠️ LOCATION CONFLICT') || 
                                     /location[-_]conflict\s*:\s*true/i.test(evaluationText) ||
                                     /Location Conflict\s*:\s*(?:Yes|⚠️)/i.test(evaluationText);
          }

          // Generate sequential report file
          const num = nextReportNumber();
          const today = new Date().toISOString().split('T')[0];
          const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const filename = `${num}-${companySlug}-${today}.md`;
          const reportPath = join(PATHS.reports, filename);

          const numericalScore = parseFloat(score);
          let pdfStatusString = '❌';
          let pdfReportStatus = '❌';
          let pdfSuccess = false;

          const minScorePdf = typeof profileDoc?.min_score_pdf === 'number' ? profileDoc.min_score_pdf : 4.0;
          if (!isNaN(numericalScore) && numericalScore >= minScorePdf) {
            if (classification.overApplied) {
              console.log(`  ⚠️ [Over-applied] Skipping PDF CV tailoring and generation for ${company} to save API tokens.`);
              pdfReportStatus = '❌ (skipped - over-applied)';
            } else {
              const pdfResult = await tailorCVAndGeneratePDF(company, role, url, bodyText, num, today, companySlug, classification.country);
              if (pdfResult && pdfResult.success) {
                pdfStatusString = '✅';
                pdfReportStatus = `✅ (${pdfResult.pdfPath})`;
                pdfSuccess = true;
              } else {
                pdfReportStatus = 'failed';
              }
            }
          } else if (!isNaN(numericalScore)) {
            console.log(`  ⚠️ [Below Threshold] Skipping PDF CV tailoring and generation (Score ${numericalScore} < ${minScorePdf}) to save API tokens.`);
            pdfReportStatus = '❌ (skipped - below score threshold)';
          }

          const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${url}
**Archetype:** ${parsedArchetype}
**Score:** ${score}/5
**Legitimacy:** ${parsedLegitimacy}
${parsedLocationConflict ? '**Location Conflict:** ⚠️ LOCATION CONFLICT\n' : ''}**PDF:** ${pdfReportStatus}
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

          writeFileSync(reportPath, reportContent, 'utf-8');
          console.log(`  💾 Report saved to reports/${filename}`);

          // Create TSV tracker addition
          const noteText = parsedLocationConflict ? '⚠️ LOCATION CONFLICT | Gemini auto-evaluated' : 'Gemini auto-evaluated';
          const tsvContent = `${num}\t${today}\t${company}\t${role}\tEvaluated\t${score}/5\t${pdfStatusString}\t[${num}](reports/${filename})\t${noteText}`;
          const tsvPath = join(PATHS.trackerAdditions, `${num}-${companySlug}.tsv`);
          writeFileSync(tsvPath, tsvContent, 'utf-8');

          // Run merge-tracker.mjs to integrate into applications.md immediately
          execSync('node merge-tracker.mjs', { cwd: ROOT, stdio: 'inherit' });

          // Update pipeline.md to mark complete
          lines[lineIndex] = `- [x] ${url} | ${company} | ${role} | Score: ${score}/5 | [Report ${num}](reports/${filename})`;
          writeFileSync(PATHS.pipeline, lines.join('\n'), 'utf-8');

          evaluatedCount++;
          console.log(`  🎉 Successfully processed [${evaluatedCount}] evaluations in this run!\n`);

          // --- Autonomous Apply integration ---
          if (pdfSuccess && !isNaN(numericalScore) && numericalScore >= 4.0) {
            console.log(`\n${colors.bright}${colors.bgBlue}               HIGH-FIT OFFER DETECTED!                       ${colors.reset}`);
            console.log(`${colors.bright}${colors.green}Company: ${company}${colors.reset}`);
            console.log(`${colors.bright}${colors.green}Role:    ${role}${colors.reset}`);
            console.log(`${colors.bright}${colors.green}Score:   ${score}/5${colors.reset}\n`);

            const appId = findTrackerIdByReport(filename);
            if (appId) {
              console.log(`\n🚀 Autonomous Pipeline: Launching Apply Automator for application #${appId}...`);
              // Autonomous submission is enabled (modes/_custom.md "Submitting").
              // argSubmit defaults to true, so omitting --no-submit lets the
              // automator complete the application rather than parking it.
              const applyArgs = ['scratch/apply_automator.mjs', '--id', appId, '--non-interactive'];
              spawnSync('node', applyArgs, { stdio: 'inherit', cwd: ROOT });

              // Whatever the outcome, the form now lives in a browser tab. Hand
              // the claim over to that tab so it outlives this run: another run
              // must not touch it while it's open, and it frees ~24h after the
              // tab goes away (closed by mistake, browser restarted).
              const idx = claimedThisRun.findIndex(c => c.jobId === url);
              if (idx !== -1) claimedThisRun.splice(idx, 1);
              holdForOpenTab(url, { url, note: `#${appId} ${company} | ${role}` });
            } else {
              console.warn(`${colors.yellow}⚠️ Could not locate application ID in applications.md for reports/${filename}. Skipping automator launch.${colors.reset}`);
            }
          }
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
    console.log(`  Cache hits (skipped re-classify): ${cacheHits}`);
    console.log(`  Newly classified & cached: ${newlyClassified}`);
    console.log(`\n📦 Classification cache now has ${Object.keys(classificationCache).length} entries → data/classified-jobs.json`);

  } finally {
    for (const c of claimedThisRun) {
      try { c.release(); } catch { /* already released */ }
    }
    if (browser) {
      await browser.close();
    }
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
