import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(__dirname, '..', 'data', 'pipeline.md');
const portalsPath = join(__dirname, '..', 'portals.yml');

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

  // 1. Title/URL-based overrides (highest specificity)
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

  // 2. Company-based overrides (using portals.yml notes)
  const companyInfo = companyMap.get(lowerCompany);
  if (companyInfo && companyInfo.notes) {
    const notes = companyInfo.notes.toLowerCase();
    
    // Check notes for India
    if (notes.includes('india') || notes.includes('bangalore') || notes.includes('bengaluru') || notes.includes('mumbai')) {
      return 'India';
    }

    // Check notes for Germany
    if (notes.includes('germany') || notes.includes('de') || notes.includes('berlin') || notes.includes('munich') || notes.includes('cologne') || notes.includes('freiburg') || notes.includes('heidelberg')) {
      if (!notes.includes('remote eu') && !notes.includes('emea/ukie')) {
        return 'Germany';
      }
    }

    // Check notes for France
    if (notes.includes('france') || notes.includes('fr') || notes.includes('paris')) {
      return 'France';
    }

    // Check notes for UK
    if (notes.includes('uk') || notes.includes('london') || notes.includes('united kingdom')) {
      return 'UK';
    }

    // Check notes for Remote/Global
    if (notes.includes('remote') || notes.includes('global') || notes.includes('worldwide')) {
      return 'Remote/Global';
    }
  }

  // Specific hardcoded company rules for key companies in list
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

  if (
    lowerCompany === 'elevenlabs' || lowerCompany === 'perplexity' || lowerCompany === 'cohere' ||
    lowerCompany === 'supabase' || lowerCompany === 'zapier' || lowerCompany === 'arize ai' ||
    lowerCompany === 'deepgram' || lowerCompany === 'hightouch' || lowerCompany === 'vercel' ||
    lowerCompany === 'airtable' || lowerCompany === 'weights & biases (coreweave)' ||
    lowerCompany === 'runpod' || lowerCompany === 'pinecone' || lowerCompany === 'stability ai' ||
    lowerCompany === 'inngest' || lowerCompany === 'planetscale'
  ) {
    return 'Remote/Global';
  }

  return 'Other';
}

const p2Jobs = [];
for (const job of pendingJobs) {
  const country = classify(job);
  if (country === 'Germany' || country === 'France' || country === 'UK') {
    p2Jobs.push({ ...job, country });
  }
}

console.log(`Found ${p2Jobs.length} unchecked Priority 2 jobs.`);
console.log(JSON.stringify(p2Jobs.slice(0, 10), null, 2));
