import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const pipelinePath = join(ROOT, 'data', 'pipeline.md');
const scanHistoryPath = join(ROOT, 'data', 'scan-history.tsv');

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

function logExpiredToScanHistory(url, company, title) {
  const date = new Date().toISOString().slice(0, 10);
  if (!existsSync(scanHistoryPath)) {
    writeFileSync(scanHistoryPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const line = `${url}\t${date}\tverify-eval\t${title}\t${company}\tskipped_expired\t\n`;
  appendFileSync(scanHistoryPath, line, 'utf-8');
}

const batchJobs = [
  { company: "Parloa", role: "Forward Deployed Engineer, DevOps", hash: "feeb8e40dcf6fc79b16b63628cbe0726", url: "https://job-boards.eu.greenhouse.io/parloa/jobs/4694431101" },
  { company: "Parloa", role: "Senior Forward Deployed Engineer - Partner Success", hash: "edd32601c90ec663a54650eca8a033e0", url: "https://job-boards.eu.greenhouse.io/parloa/jobs/4873079101" },
  { company: "Parloa", role: "Staff/Principal Software Engineer", hash: "fd4b2890b6f9619f43f3beda7ce25253", url: "https://job-boards.eu.greenhouse.io/parloa/jobs/4824273101" },
  { company: "PolyAI", role: "Senior Full Stack Engineer  (Must be based in UK)", hash: "8b23edab478d6419211713b5a124d4f4", url: "https://job-boards.eu.greenhouse.io/polyai/jobs/4658649101" },
  { company: "PolyAI", role: "Senior Platform Engineer", hash: "bc352a8474a2596b9885a6c073e80558", url: "https://job-boards.eu.greenhouse.io/polyai/jobs/4853250101" },
  { company: "Airtable", role: "Senior Partner Solutions Architect", hash: "8fe7db57b1dcef097d3ffd59c5df9ca1", url: "https://job-boards.greenhouse.io/airtable/jobs/8462421002" },
  { company: "Airtable", role: "Senior Solutions Architect", hash: "05727b548525590a907dee2529fb2f13", url: "https://job-boards.greenhouse.io/airtable/jobs/8341413002" },
  { company: "Vercel", role: "Senior Manager, Solutions Architect", hash: "053c69a807fb20fed2efee4e3b18f98d", url: "https://job-boards.greenhouse.io/vercel/jobs/5995789004" },
  { company: "Vercel", role: "Solutions Architect", hash: "460421db3eaeb465cbd42a8a51f4e3eb", url: "https://job-boards.greenhouse.io/vercel/jobs/5796302004" },
  { company: "ElevenLabs", role: "Full-Stack Growth Engineer", hash: "e94381dc34a50da1c943ccc1c46fd98a", url: "https://jobs.ashbyhq.com/elevenlabs/5881bc5d-765a-430e-9d28-7d598a0e1a03" }
];

const pipelineContent = readFileSync(pipelinePath, 'utf-8');
const lines = pipelineContent.split('\n');

const activeJobs = [];

for (const job of batchJobs) {
  const cacheFilePath = join(ROOT, 'batch', 'scraped-jds', `${job.hash}.json`);
  if (!existsSync(cacheFilePath)) {
    console.error(`⚠️ Cache file missing for ${job.company} | ${job.role}`);
    continue;
  }
  
  const cacheData = JSON.parse(readFileSync(cacheFilePath, 'utf-8'));
  const bodyText = cacheData.bodyText || '';
  
  const liveness = checkLivenessText(bodyText);
  if (liveness.expired) {
    console.log(`❌ [Expired] ${job.company} | ${job.role} — ${liveness.reason}`);
    
    // Find and update in pipeline.md memory representaton
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(job.url) && lines[i].trim().startsWith('- [ ]')) {
        lines[i] = `- [x] ~~${job.url} | ${job.company} | ${job.role}~~ [Expired]`;
        updated = true;
        break;
      }
    }
    
    if (updated) {
      writeFileSync(pipelinePath, lines.join('\n'), 'utf-8');
      console.log(`  💾 Marked expired in pipeline.md`);
    }
    
    // Log to scan-history.tsv so we don't scan it again
    logExpiredToScanHistory(job.url, job.company, job.role);
    console.log(`  💾 Logged to scan-history.tsv`);
  } else {
    console.log(`🟢 [Active] ${job.company} | ${job.role}`);
    activeJobs.push(job);
  }
}

console.log(`\nActive jobs to evaluate: ${activeJobs.length}`);
console.log(JSON.stringify(activeJobs, null, 2));
