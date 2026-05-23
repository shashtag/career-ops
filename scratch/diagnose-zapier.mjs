import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

const parseYaml = yaml.load;

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    const matchingPositives = positive.filter(k => lower.includes(k));
    const matchingNegatives = negative.filter(k => lower.includes(k));
    return {
      passed: hasPositive && !hasNegative,
      matchingPositives,
      matchingNegatives
    };
  };
}

function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => ({ passed: true });
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return { passed: true, reason: 'empty' };
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) {
      return { passed: true, reason: 'always_allow', matches: alwaysAllow.filter(k => lower.includes(k)) };
    }
    if (block.length > 0 && block.some(k => lower.includes(k))) {
      return { passed: false, reason: 'blocked', matches: block.filter(k => lower.includes(k)) };
    }
    if (allow.length === 0) return { passed: true, reason: 'no_allow_list' };
    const matchesAllow = allow.some(k => lower.includes(k));
    return { passed: matchesAllow, reason: 'allow_list', matches: allow.filter(k => lower.includes(k)) };
  };
}

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

async function run() {
  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const apiUrl = 'https://api.ashbyhq.com/posting-api/job-board/zapier?includeCompensation=true';
  console.log(`Fetching jobs from ${apiUrl}...`);
  const res = await fetch(apiUrl);
  const json = await res.json();
  const jobs = json.jobs || [];

  console.log(`Total jobs returned by API: ${jobs.length}\n`);

  for (const job of jobs) {
    const title = job.title;
    const location = job.location || 'N/A';
    const url = job.jobUrl;

    const tFilterRes = titleFilter(title);
    const lFilterRes = locationFilter(location);
    const urlSeen = seenUrls.has(url);
    const key = `zapier::${title.toLowerCase()}`;
    const keySeen = seenCompanyRoles.has(key);

    console.log(`Job: ${title}`);
    console.log(`Location: ${location}`);
    console.log(`URL: ${url}`);
    console.log(`Title Filter: ${tFilterRes.passed ? 'PASSED' : 'FAILED'} (Pos: [${tFilterRes.matchingPositives.join(', ')}], Neg: [${tFilterRes.matchingNegatives.join(', ')}])`);
    console.log(`Location Filter: ${lFilterRes.passed ? 'PASSED' : 'FAILED'} (Reason: ${lFilterRes.reason}, Matches: [${(lFilterRes.matches || []).join(', ')}])`);
    console.log(`Duplicate URL Check: ${urlSeen ? 'DUPLICATE' : 'NEW'}`);
    console.log(`Duplicate Title/Company Check: ${keySeen ? 'DUPLICATE' : 'NEW'}`);
    
    let action = 'ADD TO PIPELINE';
    if (!tFilterRes.passed) action = 'FILTERED BY TITLE';
    else if (!lFilterRes.passed) action = 'FILTERED BY LOCATION';
    else if (urlSeen || keySeen) action = 'SKIPPED (DUPLICATE)';
    
    console.log(`RESULT: ${action}`);
    console.log('-'.repeat(60));
  }
}

run().catch(console.error);
