#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = join(__dirname, 'portals.yml');

// Default seed list of high-value AI / developer tool startups
const SEED_SLUGS = [
  { slug: 'composio', name: 'Composio', prefATS: 'ashby' },
  { slug: 'truefoundry', name: 'TrueFoundry', prefATS: 'ashby' },
  { slug: 'portkey', name: 'Portkey AI', prefATS: 'ashby' },
  { slug: 'agno', name: 'Agno', prefATS: 'ashby' },
  { slug: 'mem0', name: 'Mem0', prefATS: 'ashby' },
  { slug: 'firecrawl', name: 'Firecrawl', prefATS: 'ashby' },
  { slug: 'livekit', name: 'LiveKit', prefATS: 'greenhouse' },
  { slug: 'baseten', name: 'Baseten', prefATS: 'ashby' },
  { slug: 'vapi', name: 'Vapi', prefATS: 'ashby' },
  { slug: 'bland', name: 'Bland AI', prefATS: 'ashby' },
  { slug: 'decagon', name: 'Decagon', prefATS: 'ashby' },
  { slug: 'sierra', name: 'Sierra', prefATS: 'ashby' },
  { slug: 'lindy', name: 'Lindy', prefATS: 'ashby' },
  { slug: 'agentops', name: 'AgentOps', prefATS: 'ashby' },
  { slug: 'langfuse', name: 'Langfuse', prefATS: 'ashby' },
  { slug: 'helicone', name: 'Helicone', prefATS: 'ashby' },
  { slug: 'together', name: 'Together AI', prefATS: 'greenhouse' },
  { slug: 'mistral', name: 'Mistral AI', prefATS: 'greenhouse' },
  { slug: 'lepton', name: 'Lepton AI', prefATS: 'ashby' },
  { slug: 'deepinfra', name: 'DeepInfra', prefATS: 'ashby' },
  { slug: 'replicate', name: 'Replicate', prefATS: 'greenhouse' },
  { slug: 'anyscale', name: 'Anyscale', prefATS: 'greenhouse' },
  { slug: 'groq', name: 'Groq', prefATS: 'greenhouse' },
  { slug: 'cognition', name: 'Cognition', prefATS: 'ashby' },
  { slug: 'safe-superintelligence', name: 'Safe Superintelligence', prefATS: 'greenhouse' },
];

async function checkAshbyBoard(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 200) {
      const data = await res.json();
      return Array.isArray(data?.jobs) && data.jobs.length > 0;
    }
  } catch (e) {}
  return false;
}

async function checkGreenhouseBoard(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 200) {
      const data = await res.json();
      return Array.isArray(data?.jobs);
    }
  } catch (e) {}
  return false;
}

async function main() {
  if (!existsSync(PORTALS_PATH)) {
    console.error(`Error: portals.yml not found at ${PORTALS_PATH}`);
    process.exit(1);
  }

  // Load existing config
  let portalContent = readFileSync(PORTALS_PATH, 'utf-8');
  let config;
  try {
    config = yaml.load(portalContent);
  } catch (e) {
    console.error(`Error parsing portals.yml: ${e.message}`);
    process.exit(1);
  }

  const trackedCompanies = config?.tracked_companies || [];
  const existingNames = new Set(trackedCompanies.map(c => c.name.toLowerCase()));
  const existingUrls = new Set(trackedCompanies.map(c => (c.careers_url || '').toLowerCase()));

  console.log(`🔍 Checking ${SEED_SLUGS.length} seed AI companies for active job boards...`);
  
  const discovered = [];

  for (const item of SEED_SLUGS) {
    // Skip if already in portals.yml
    if (existingNames.has(item.name.toLowerCase())) {
      continue;
    }
    
    let isActive = false;
    let type = '';
    let careersUrl = '';
    let api = '';

    if (item.prefATS === 'ashby') {
      isActive = await checkAshbyBoard(item.slug);
      if (isActive) {
        type = 'ashby';
        careersUrl = `https://jobs.ashbyhq.com/${item.slug}`;
      } else {
        // Fallback check on greenhouse
        isActive = await checkGreenhouseBoard(item.slug);
        if (isActive) {
          type = 'greenhouse';
          careersUrl = `https://job-boards.greenhouse.io/${item.slug}`;
          api = `https://boards-api.greenhouse.io/v1/boards/${item.slug}/jobs`;
        }
      }
    } else {
      isActive = await checkGreenhouseBoard(item.slug);
      if (isActive) {
        type = 'greenhouse';
        careersUrl = `https://job-boards.greenhouse.io/${item.slug}`;
        api = `https://boards-api.greenhouse.io/v1/boards/${item.slug}/jobs`;
      } else {
        // Fallback check on ashby
        isActive = await checkAshbyBoard(item.slug);
        if (isActive) {
          type = 'ashby';
          careersUrl = `https://jobs.ashbyhq.com/${item.slug}`;
        }
      }
    }

    if (isActive) {
      if (existingUrls.has(careersUrl.toLowerCase())) {
        continue;
      }
      discovered.push({
        name: item.name,
        careers_url: careersUrl,
        api: api || undefined,
        type
      });
      console.log(`✨ Discovered active ${type.toUpperCase()} board for: ${item.name} (${careersUrl})`);
    }
  }

  if (discovered.length === 0) {
    console.log('✅ No new active boards discovered (all seeds are either inactive or already tracked).');
    return;
  }

  console.log(`\nAdding ${discovered.length} new companies to portals.yml...`);

  // Build the YAML block to append
  let yamlAppend = '\n  # -- Auto-Discovered AI Startups --\n';
  for (const item of discovered) {
    yamlAppend += `\n  - name: ${item.name}\n`;
    yamlAppend += `    careers_url: ${item.careers_url}\n`;
    if (item.api) {
      yamlAppend += `    api: ${item.api}\n`;
    }
    yamlAppend += `    enabled: true\n`;
  }

  // Find the tracked_companies: line and append to the end of the file (or at a reasonable place)
  // Since tracked_companies is usually at the bottom or has a list, we can just append it to the end of the file.
  portalContent = portalContent.trimEnd() + '\n' + yamlAppend;
  writeFileSync(PORTALS_PATH, portalContent, 'utf-8');

  console.log(`🎉 Successfully added ${discovered.length} companies to portals.yml!`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
