import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import readline from 'readline';

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
  cvTemplate: join(ROOT, 'templates', 'cv-template.html'),
  profile: join(ROOT, 'modes', '_profile.md'),
  profileYml: join(ROOT, 'config', 'profile.yml'),
  reports: join(ROOT, 'reports'),
  scanHistory: join(ROOT, 'data', 'scan-history.tsv'),
  cacheDir: join(ROOT, 'batch', 'scraped-jds'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions'),
  output: join(ROOT, 'output')
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
      description: "Exactly 3 chronological jobs: realfast.ai, Accenture, and ProPro Productions.",
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
            description: "Exactly 3 punchy, metric-rich achievement bullets. Each bullet must start with strong html tags wrapping a keyword category, e.g. '<strong>Architected:</strong> ...' or '<strong>Engineered:</strong> ...' using professional active verbs."
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
     "Full-stack and systems engineer with 4+ years of experience architecting distributed networks, real-time collaboration platforms, and robust AI integrations. Co-founded and scaled high-performance products—from an acquired, Figma-like canvas (ProPro) to sandboxed dynamic DSL evaluation engines (JoyFill) and distributed Go microservices (karada.ai). Proven track record driving enterprise AI transformation roadmaps at realfast.ai and managing high-scale systems at Accenture/Comcast. Targeting the ${role} role at ${company}."

2. "competencies":
   - Extract exactly 6 to 8 of the most relevant skill keywords or phrases from the JD.
   - Ensure the keywords directly reflect the job's core technical requirements (e.g., Distributed Systems, GoLang, ML Pipelines, RAG Architectures, API Design, High-Scale Web, etc.).

3. "experience":
   - You MUST output exactly three jobs in chronological order (newest to oldest):
     1. Forward Deployed Engineer | realfast.ai | Mar 2026 – Present
     2. Advanced Software Engineer | Accenture (Comcast Engineering Team) | Nov 2023 – Feb 2026
     3. Founding Engineer | ProPro Productions | June 2021 – Sept 2023
   - Limit each job to EXACTLY 3 bullet points. Keep each bullet point to a maximum of 1-2 lines. This is critical to guarantee a 1-page fit.
   - Use high-tier, sophisticated professional vocabulary. Do NOT use passive verbs. Focus on "Architected", "Engineered", "Pioneered", "Optimized", "Designed", "Spearheaded".
   - Each bullet must start with strong html tags wrapping a keyword category, e.g. "<strong>Architected:</strong> ...", "<strong>Engineered:</strong> ...", "<strong>Pioneered:</strong> ...", etc.
   - Locations: realfast.ai is "Bengaluru, India"; Accenture is "Bengaluru, India"; ProPro Productions is "Germany (Remote)".

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

    // Phone display with separator handling
    if (phone && phone.trim() !== '') {
      html = html.replace('{{PHONE}}', phone);
    } else {
      html = html.replace(/<span>\{\{PHONE\}\}<\/span>\s*<span class="separator">\|<\/span>/gi, '');
    }

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

          if (!isNaN(numericalScore) && numericalScore >= 3.0) {
            const pdfResult = await tailorCVAndGeneratePDF(company, role, url, bodyText, num, today, companySlug, classification.country);
            if (pdfResult && pdfResult.success) {
              pdfStatusString = '✅';
              pdfReportStatus = `✅ (${pdfResult.pdfPath})`;
              pdfSuccess = true;
            } else {
              pdfReportStatus = 'failed';
            }
          }

          const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${url}
**Archetype:** ${parsedArchetype}
**Score:** ${score}/5
**Legitimacy:** ${parsedLegitimacy}
**PDF:** ${pdfReportStatus}
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

          writeFileSync(reportPath, reportContent, 'utf-8');
          console.log(`  💾 Report saved to reports/${filename}`);

          // Create TSV tracker addition
          const tsvContent = `${num}\t${today}\t${company}\t${role}\tEvaluated\t${score}/5\t${pdfStatusString}\t[${num}](reports/${filename})\tGemini auto-evaluated`;
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
          if (pdfSuccess) {
            console.log(`\n${colors.bright}${colors.bgBlue}               HIGH-FIT OFFER DETECTED!                       ${colors.reset}`);
            console.log(`${colors.bright}${colors.green}Company: ${company}${colors.reset}`);
            console.log(`${colors.bright}${colors.green}Role:    ${role}${colors.reset}`);
            console.log(`${colors.bright}${colors.green}Score:   ${score}/5${colors.reset}\n`);

            const appId = findTrackerIdByReport(filename);
            if (appId) {
              console.log(`\n🚀 Autonomous Pipeline: Launching Apply Automator for application #${appId}...`);
              const applyArgs = ['scratch/apply_automator.mjs', '--id', appId, '--non-interactive'];
              spawnSync('node', applyArgs, { stdio: 'inherit', cwd: ROOT });
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
