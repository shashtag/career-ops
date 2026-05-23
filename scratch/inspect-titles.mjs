import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(__dirname, '..', 'data', 'pipeline.md');

const content = readFileSync(pipelinePath, 'utf-8');
const lines = content.split('\n');

const pendingJobs = [];
for (const line of lines) {
  if (line.trim().startsWith('- [ ]')) {
    const rawLine = line.trim();
    const parts = rawLine.slice(5).split('|').map(p => p.trim());
    pendingJobs.push({ url: parts[0] || '', company: parts[1] || '', role: parts[2] || '' });
  }
}

console.log('--- Checking for any country mentions in titles ---');
const locations = {
  india: [],
  germany: [],
  france: [],
  uk: [],
  remote: [],
  other: []
};

for (const job of pendingJobs) {
  const { role, company, url } = job;
  const lowerRole = role.toLowerCase();
  const lowerUrl = url.toLowerCase();
  
  if (lowerRole.includes('india') || lowerRole.includes('mumbai') || lowerRole.includes('bengaluru') || lowerRole.includes('bangalore') || lowerUrl.includes('india') || lowerUrl.includes('mumbai')) {
    locations.india.push(job);
  } else if (lowerRole.includes('germany') || lowerRole.includes('berlin') || lowerRole.includes('munich') || lowerRole.includes('frankfurt') || lowerRole.includes('german') || lowerUrl.includes('germany') || lowerUrl.includes('berlin') || lowerUrl.includes('munich')) {
    locations.germany.push(job);
  } else if (lowerRole.includes('france') || lowerRole.includes('paris') || lowerRole.includes('french') || lowerUrl.includes('france') || lowerUrl.includes('paris')) {
    locations.france.push(job);
  } else if (lowerRole.includes('uk') || lowerRole.includes('london') || lowerRole.includes('united kingdom') || lowerUrl.includes('uk') || lowerUrl.includes('london')) {
    locations.uk.push(job);
  } else if (lowerRole.includes('remote') || lowerRole.includes('global') || lowerRole.includes('worldwide') || lowerUrl.includes('remote') || lowerUrl.includes('global')) {
    locations.remote.push(job);
  } else {
    locations.other.push(job);
  }
}

console.log(`India: ${locations.india.length}`);
console.log(`Germany: ${locations.germany.length}`);
console.log(`France: ${locations.france.length}`);
console.log(`UK: ${locations.uk.length}`);
console.log(`Remote: ${locations.remote.length}`);
console.log(`Other: ${locations.other.length}`);

console.log('\n--- India ---');
locations.india.forEach(j => console.log(`- ${j.company} | ${j.role}`));

console.log('\n--- Germany ---');
locations.germany.forEach(j => console.log(`- ${j.company} | ${j.role}`));

console.log('\n--- France ---');
locations.france.forEach(j => console.log(`- ${j.company} | ${j.role}`));
