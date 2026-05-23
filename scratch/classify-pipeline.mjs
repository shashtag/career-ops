import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(__dirname, '..', 'data', 'pipeline.md');

if (!existsSync(pipelinePath)) {
  console.error(`Pipeline file not found at: ${pipelinePath}`);
  process.exit(1);
}

const content = readFileSync(pipelinePath, 'utf-8');
const lines = content.split('\n');

const pendingJobs = [];
let inPendientes = false;

for (const line of lines) {
  if (line.trim().startsWith('## Pendientes') || line.trim().startsWith('## Pending')) {
    inPendientes = true;
    continue;
  }
  if (line.trim().startsWith('## Procesadas') || line.trim().startsWith('## Processed')) {
    inPendientes = false;
  }

  if (inPendientes && line.trim().startsWith('- [ ]')) {
    const rawLine = line.trim();
    // Parse line: - [ ] URL | Company | Role
    const parts = rawLine.slice(5).split('|').map(p => p.trim());
    const url = parts[0] || '';
    const company = parts[1] || '';
    const role = parts[2] || '';
    pendingJobs.push({ line: rawLine, url, company, role });
  }
}

console.log(`Total pending jobs found: ${pendingJobs.length}`);

// Let's define the classification function
function classify(job) {
  const { url, company, role } = job;
  const combined = `${url} ${company} ${role}`.toLowerCase();

  // 1. India
  if (
    combined.includes('india') ||
    combined.includes('mumbai') ||
    combined.includes('bengaluru') ||
    combined.includes('bangalore')
  ) {
    return 'India';
  }

  // 2. Germany
  if (
    combined.includes('germany') ||
    combined.includes('deutschland') ||
    combined.includes('german') ||
    combined.includes('berlin') ||
    combined.includes('munich') ||
    combined.includes('münchen') ||
    company.toLowerCase() === 'parloa' ||
    company.toLowerCase() === 'aleph alpha' ||
    company.toLowerCase() === 'contentful' ||
    company.toLowerCase() === 'trade republic' ||
    company.toLowerCase() === 'hellofresh'
  ) {
    return 'Germany';
  }

  // 3. France
  if (
    combined.includes('france') ||
    combined.includes('french') ||
    combined.includes('paris') ||
    company.toLowerCase() === 'photoroom' ||
    company.toLowerCase() === 'pigment' ||
    company.toLowerCase() === 'mistral ai'
  ) {
    return 'France';
  }

  // 4. UK
  if (
    combined.includes('uk') ||
    combined.includes('london') ||
    combined.includes('united kingdom') ||
    combined.includes('england') ||
    company.toLowerCase() === 'wayve' ||
    company.toLowerCase() === 'isomorphic labs' ||
    company.toLowerCase() === 'physicsx' ||
    company.toLowerCase() === 'speechmatics' ||
    company.toLowerCase() === 'faculty' ||
    company.toLowerCase() === 'synthesia' ||
    company.toLowerCase() === 'causaly' ||
    company.toLowerCase() === 'attio' ||
    company.toLowerCase() === 'polyai'
  ) {
    return 'UK';
  }

  // 5. Remote / Global / General Areas
  if (
    combined.includes('remote') ||
    combined.includes('global') ||
    combined.includes('sovereign ai') ||
    combined.includes('federal') ||
    combined.includes('worldwide') ||
    combined.includes('apaj') ||
    combined.includes('apac') ||
    combined.includes('emea') ||
    combined.includes('latam') ||
    combined.includes('apj') ||
    combined.includes('founding software engineer') ||
    combined.includes('founding engineer') ||
    company.toLowerCase() === 'anthropic' ||
    company.toLowerCase() === 'cohere' ||
    company.toLowerCase() === 'perplexity' ||
    company.toLowerCase() === 'zapier' ||
    company.toLowerCase() === 'sierra' ||
    company.toLowerCase() === 'runpod' ||
    company.toLowerCase() === 'arize ai' ||
    company.toLowerCase() === 'vercel' ||
    company.toLowerCase() === 'airtable' ||
    company.toLowerCase() === 'glean' ||
    company.toLowerCase() === 'weights & biases' ||
    company.toLowerCase() === 'pinecone' ||
    company.toLowerCase() === 'decagon' ||
    company.toLowerCase() === 'cradle' ||
    company.toLowerCase() === 'lakera' ||
    company.toLowerCase() === 'n8n' ||
    company.toLowerCase() === 'stability ai' ||
    company.toLowerCase() === 'lovable' ||
    company.toLowerCase() === 'legora' ||
    company.toLowerCase() === 'amplemarket' ||
    company.toLowerCase() === 'hightouch' ||
    company.toLowerCase() === 'planetscale' ||
    company.toLowerCase() === 'inngest' ||
    company.toLowerCase() === 'supabase'
  ) {
    return 'Remote/Global';
  }

  // 6. Other (default)
  return 'Other';
}

const categorized = {
  'India': [],
  'Remote/Global': [],
  'UK': [],
  'Germany': [],
  'France': [],
  'Other': []
};

for (const job of pendingJobs) {
  const category = classify(job);
  categorized[category].push(job);
}

console.log('\n--- Classification Counts ---');
for (const [cat, list] of Object.entries(categorized)) {
  console.log(`${cat}: ${list.length}`);
}

console.log('\n--- India Jobs ---');
categorized['India'].forEach(j => console.log(`- ${j.company} | ${j.role} | ${j.url}`));

console.log('\n--- Remote/Global Jobs (First 10) ---');
categorized['Remote/Global'].slice(0, 10).forEach(j => console.log(`- ${j.company} | ${j.role} | ${j.url}`));
