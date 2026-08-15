import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveStatus } from './statuses.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const CACHE_PATH = join(ROOT, 'data', 'company-caps.json');

/**
 * Returns a dictionary of company caps: { [companyLower]: { name, count, last_updated } }
 * Uses a cached file if valid, otherwise recomputes and invalidates.
 */
export function getCompanyCaps(limit = 2, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  // 1. Try to read from cache if it is fresh
  try {
    if (existsSync(CACHE_PATH) && existsSync(APPLICATIONS_PATH)) {
      const cacheStat = statSync(CACHE_PATH);
      const appsStat = statSync(APPLICATIONS_PATH);
      const pipeStat = existsSync(PIPELINE_PATH) ? statSync(PIPELINE_PATH) : null;
      
      const appsMtime = appsStat.mtimeMs;
      const pipeMtime = pipeStat ? pipeStat.mtimeMs : 0;
      const cacheAgeMs = Date.now() - cacheStat.mtimeMs;
      
      // If cache is newer than applications/pipeline and less than 4 hours old
      if (cacheStat.mtimeMs > appsMtime && cacheStat.mtimeMs > pipeMtime && cacheAgeMs < 4 * 60 * 60 * 1000) {
        return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
      }
    }
  } catch (e) {
    // Ignore cache read errors
  }

  // 2. Cache is stale or missing — compute counts
  const counts = {};
  
  // Parse applications.md
  if (existsSync(APPLICATIONS_PATH)) {
    try {
      const content = readFileSync(APPLICATIONS_PATH, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim().startsWith('|') || line.includes('|---|') || line.includes('| # |')) {
          continue;
        }
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 7) continue;

        const dateStr = parts[2];
        const company = parts[3];
        const status = parts[6];

        if (!dateStr || !company) continue;
        const statusClean = resolveStatus(status);
        if (statusClean === 'skip' || statusClean === 'discarded' || statusClean === 'evaluated') continue;

        const date = new Date(dateStr);
        if (!isNaN(date.getTime()) && date >= cutoff) {
          const normCompany = company.trim();
          counts[normCompany] = (counts[normCompany] || 0) + 1;
        }
      }
    } catch (err) {
      console.warn(`⚠️ Warning: Failed to parse applications.md for company caps: ${err.message}`);
    }
  }

  // Seed from pipeline.md (unchecked backlog)
  if (existsSync(PIPELINE_PATH)) {
    try {
      const pipelineLines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
      for (const l of pipelineLines) {
        if (l.trim().startsWith('- [ ]')) {
          const parts = l.split('|').map(s => s.trim());
          if (parts.length >= 2) {
            const company = parts[1];
            if (company && !company.startsWith('http') && company.length < 50) {
              const normCompany = company.trim();
              counts[normCompany] ??= 0;
            }
          }
        }
      }
    } catch (err) {
      // Ignore pipeline errors
    }
  }

  // Prepare cache data structure
  const cacheData = {};
  for (const [company, count] of Object.entries(counts)) {
    cacheData[company.toLowerCase()] = {
      name: company,
      count,
      last_updated: new Date().toISOString().split('T')[0]
    };
  }

  // Write to cache file
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2), 'utf-8');
  } catch (e) {
    // Ignore cache write errors
  }

  return cacheData;
}
