import { readFileSync, existsSync } from 'fs';

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

function checkOrphans() {
  const pipelineUrls = new Set();
  const applicationsUrls = new Set();

  // Load from pipeline.md
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      pipelineUrls.add(match[1]);
    }
  }

  // Load from applications.md
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      applicationsUrls.add(match[0]);
    }
  }

  const orphans = [];
  let totalHistoryAdded = 0;

  // Read scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const parts = line.split('\t');
      if (parts.length < 6) continue;
      const url = parts[0];
      const status = parts[5];
      const title = parts[3];
      const company = parts[4];

      if (status === 'added' && url) {
        totalHistoryAdded++;
        if (!pipelineUrls.has(url) && !applicationsUrls.has(url)) {
          orphans.push({ url, title, company });
        }
      }
    }
  }

  console.log(`📊 Total added in history: ${totalHistoryAdded}`);
  console.log(`📋 Total in pipeline.md:   ${pipelineUrls.size}`);
  console.log(`💼 Total in applications:  ${applicationsUrls.size}`);
  console.log(`❓ Orphaned URLs:          ${orphans.length}`);

  if (orphans.length > 0) {
    console.log('\n🔍 Orphaned jobs found (in scan-history but missing from pipeline and applications):');
    for (const o of orphans.slice(0, 10)) {
      console.log(`  - [ ] ${o.url} | ${o.company} | ${o.title}`);
    }
    if (orphans.length > 10) {
      console.log(`  ... and ${orphans.length - 10} more`);
    }
  } else {
    console.log('\n✅ Perfect sync! No orphaned URLs found.');
  }
}

checkOrphans();
