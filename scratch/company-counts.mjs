import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(__dirname, '..', 'data', 'pipeline.md');

const content = readFileSync(pipelinePath, 'utf-8');
const lines = content.split('\n');

const counts = {};

for (const line of lines) {
  if (line.trim().startsWith('- [ ]')) {
    const rawLine = line.trim();
    const parts = rawLine.slice(5).split('|').map(p => p.trim());
    const company = parts[1] || 'Unknown';
    counts[company] = (counts[company] || 0) + 1;
  }
}

console.log('--- Company Counts ---');
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [company, count] of sorted) {
  console.log(`${company}: ${count}`);
}
