#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

async function main() {
  const openForms = [];
  try {
    const res = await fetch('http://localhost:9222/json/list');
    if (!res.ok) {
      console.log(JSON.stringify([]));
      return;
    }
    const tabs = await res.json();
    const pageTabs = tabs.filter(t => t.type === 'page' && t.url && t.url.startsWith('http'));

    if (pageTabs.length === 0) {
      console.log(JSON.stringify([]));
      return;
    }

    // Load applications to match
    const appsFile = join(projectRoot, 'data', 'applications.md');
    const allApps = [];
    if (existsSync(appsFile)) {
      const content = readFileSync(appsFile, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim().startsWith('|') || line.includes('| # |') || line.includes('|---|')) continue;
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 10) continue;
        
        const reportMatch = parts[8].match(/\[.*?\]\((reports\/.*?)\)/);
        allApps.push({
          id: parts[1],
          company: parts[3],
          role: parts[4],
          reportPath: reportMatch ? reportMatch[1] : null
        });
      }
    }

    // Match tabs
    for (const tab of pageTabs) {
      const urlLower = tab.url.toLowerCase();
      const normTabUrl = urlLower.split('?')[0].replace(/\/$/, '');
      
      // Try to find matching application in applications.md
      let matchedApp = allApps.find(app => {
        if (!app.reportPath) return false;
        try {
          const reportContent = readFileSync(join(projectRoot, app.reportPath), 'utf-8');
          const urlMatch = reportContent.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s]+)/i);
          if (urlMatch) {
            const normAppUrl = urlMatch[1].toLowerCase().split('?')[0].replace(/\/$/, '');
            return normTabUrl.includes(normAppUrl) || normAppUrl.includes(normTabUrl);
          }
        } catch {}
        return false;
      });

      if (matchedApp) {
        openForms.push({
          company: matchedApp.company,
          report_id: matchedApp.id,
          url: tab.url
        });
      } else {
        // Fallback matching: does the URL look like an ATS page containing the company name?
        if (urlLower.includes('greenhouse.io') || urlLower.includes('lever.co') || urlLower.includes('ashbyhq.com') || urlLower.includes('workday')) {
          const companyMatch = allApps.find(app => {
            const cleanCompany = app.company.toLowerCase().replace(/[^a-z0-9]/g, '');
            return cleanCompany && urlLower.includes(cleanCompany);
          });
          if (companyMatch) {
            openForms.push({
              company: companyMatch.company,
              report_id: companyMatch.id,
              url: tab.url
            });
          }
        }
      }
    }
  } catch (err) {
    // Chrome debugger not running or other error, return empty array silently
  }
  console.log(JSON.stringify(openForms, null, 2));
}

main();
