import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const portalsPath = join(__dirname, '..', 'portals.yml');

const doc = load(readFileSync(portalsPath, 'utf-8'));
const companies = doc.tracked_companies || doc.companies || [];

console.log(`Total companies found: ${companies.length}`);
for (const company of companies) {
  console.log(`- ${company.name}: ${company.notes || 'No notes'} (${company.careers_url})`);
}
