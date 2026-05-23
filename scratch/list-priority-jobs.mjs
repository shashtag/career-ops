import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(__dirname, '..', 'data', 'pipeline.md');
const portalsPath = join(__dirname, '..', 'portals.yml');

// 1. Load portals.yml for company notes
const portalsDoc = load(readFileSync(portalsPath, 'utf-8'));
const companies = portalsDoc.tracked_companies || [];
const companyMap = new Map();

for (const c of companies) {
  if (c && c.name) {
    companyMap.set(c.name.toLowerCase().trim(), c);
  }
}

// 2. Load pipeline.md
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

function classify(job) {
  const { url, company, role } = job;
  const lowerRole = role.toLowerCase();
  const lowerUrl = url.toLowerCase();
  const lowerCompany = company.toLowerCase().trim();
  const textToSearch = `${lowerRole} ${lowerUrl}`.toLowerCase();

  // 1. India check
  if (
    lowerRole.includes('india') || lowerRole.includes('mumbai') || lowerRole.includes('bengaluru') || lowerRole.includes('bangalore') ||
    lowerUrl.includes('india') || lowerUrl.includes('mumbai') || lowerUrl.includes('bangalore')
  ) {
    return 'India';
  }

  // 2. Germany check
  if (
    lowerRole.includes('berlin') || lowerRole.includes('munich') || lowerRole.includes('germany') || lowerRole.includes('deutschland') || lowerRole.includes('german') ||
    lowerUrl.includes('berlin') || lowerUrl.includes('munich') || lowerUrl.includes('germany')
  ) {
    return 'Germany';
  }

  // 3. France check
  if (
    lowerRole.includes('paris') || lowerRole.includes('france') || lowerRole.includes('french') ||
    lowerUrl.includes('paris') || lowerUrl.includes('france')
  ) {
    return 'France';
  }

  // 4. UK check
  if (
    lowerRole.includes('london') || lowerRole.includes('uk') || lowerRole.includes('united kingdom') || lowerRole.includes('england') ||
    lowerUrl.includes('london') || lowerUrl.includes('uk')
  ) {
    return 'UK';
  }

  // 5. Remote/Global check
  if (
    lowerRole.includes('remote') || lowerRole.includes('global') || lowerRole.includes('worldwide') || lowerRole.includes('anywhere') ||
    lowerUrl.includes('remote') || lowerUrl.includes('global')
  ) {
    return 'Remote/Global';
  }

  // Company based
  const remoteCompanies = [
    'anthropic', 'cohere', 'perplexity', 'zapier', 'sierra', 'runpod', 'arize ai', 
    'vercel', 'airtable', 'glean', 'weights & biases', 'weights & biases (coreweave)',
    'pinecone', 'decagon', 'cradle', 'lakera', 'n8n', 'stability ai', 'lovable', 
    'legora', 'amplemarket', 'hightouch', 'planetscale', 'inngest', 'supabase', 'elevenlabs', 'deepgram'
  ];

  if (remoteCompanies.includes(lowerCompany)) {
    return 'Remote/Global';
  }

  const companyInfo = companyMap.get(lowerCompany);
  if (companyInfo && companyInfo.notes) {
    const notes = companyInfo.notes.toLowerCase();
    if (notes.includes('india') || notes.includes('bangalore') || notes.includes('bengaluru') || notes.includes('mumbai')) return 'India';
    if (notes.includes('germany') || notes.includes('de') || notes.includes('berlin') || notes.includes('munich')) {
      if (!notes.includes('remote eu') && !notes.includes('emea/ukie')) return 'Germany';
    }
    if (notes.includes('france') || notes.includes('fr') || notes.includes('paris')) return 'France';
    if (notes.includes('uk') || notes.includes('london') || notes.includes('united kingdom')) return 'UK';
    if (notes.includes('remote') || notes.includes('global') || notes.includes('worldwide')) return 'Remote/Global';
  }

  return 'Other';
}

const p1Jobs = [];
for (const job of pendingJobs) {
  const category = classify(job);
  if (category === 'India' || category === 'Remote/Global') {
    p1Jobs.push(job);
  }
}

console.log(JSON.stringify(p1Jobs.slice(0, 10), null, 2));
