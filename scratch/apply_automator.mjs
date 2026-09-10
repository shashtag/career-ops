/**
 * RETIRED 2026-08-27 — do not use this to fill or submit application forms.
 *
 * Replaced by the loop in modes/_custom.md ("Applying"):
 *     node answer-resolver.mjs --collector          # snippet to run in the page
 *     node answer-resolver.mjs --stdin --summary    # what to say, per field
 *     ... browser agent fills ...
 *     node audit-form-fill.mjs --stdin --summary    # gate, must exit 0
 *     ... browser agent submits, as one deliberate call ...
 *
 * Why: this file held a live page handle across a long-running process with an
 * interactive stdin. When that stdin hit EOF (background task, zombie process,
 * non-TTY), the prompt defaulted to "Apply" and it submitted on its own — 7+
 * confirmed incidents. It also reported its own state unreliably, logging
 * "Not submitted" on forms that had in fact gone through. Neither failure is
 * possible when submit is a discrete tool call by the agent.
 *
 * Kept, not deleted, because ~40 past applications reference it in notes and its
 * per-ATS DOM knowledge was mined into config/application-answers.yml and the
 * ATS-quirk checklist in modes/_custom.md. It still runs read-only helpers; it
 * refuses to fill or submit without --i-know-this-is-retired.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { exec } from 'child_process';
import { chromium } from 'playwright';
import * as yaml from 'js-yaml';
import { sanitizeAnswer } from '../lib/answer-sanitizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Dynamic report-specific lock check will be performed after app is resolved.

// Bulletproof delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper to ask user for input
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

// Format ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m'
};

// Load profile from config/profile.yml
function loadProfile() {
  const profilePath = join(projectRoot, 'config', 'profile.yml');
  if (!existsSync(profilePath)) {
    return null;
  }
  try {
    const content = readFileSync(profilePath, 'utf-8');
    return yaml.load(content);
  } catch (e) {
    console.error(`Error loading profile: ${e.message}`);
    return null;
  }
}

// Find latest resume PDF in output/ specifically for the given company if possible
function findLatestResume(companyName) {
  const outputDir = join(projectRoot, 'output');
  if (!existsSync(outputDir)) return null;
  try {
    const files = readdirSync(outputDir)
      .filter(f => f.endsWith('.pdf'))
      .map(f => {
        const fullPath = join(outputDir, f);
        return {
          path: fullPath,
          name: f,
          mtime: statSync(fullPath).mtime
        };
      });

    if (files.length === 0) return null;

    // 1. Try to find a company-specific resume
    if (companyName) {
      const cleanCompany = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const companyResumes = files.filter(f => {
        const cleanName = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        return cleanName.includes(cleanCompany);
      }).sort((a, b) => b.mtime - a.mtime);

      if (companyResumes.length > 0) {
        console.log(`${colors.green}🎯 Found company-specific resume in output/: "${companyResumes[0].name}"${colors.reset}`);
        return companyResumes[0].path;
      }
    }

    // 2. Try to find a generic/universal resume (e.g. one without a specific company name, or with "generic"/"universal" in the title)
    const knownCompanies = [
      'anthropic', 'elevenlabs', 'glean', 'perplexity', 'n8n', 'zapier', 'supabase', 'deepgram', 'runpod', 'intercom', 'arize',
      'speechmatics', 'vercel', 'sierra', 'polyai', 'parloa', 'inngest', 'pinecone', 'lakera', 'weights',
      // expanded from output/ PDFs 2026-08-08
      'aiprise', 'airbnb', 'alphagrep', 'amazon', 'anyscale', 'astronomer', 'atomicwork', 'attio', 'aws',
      'bjak', 'bolna', 'braintrust', 'broccoli', 'camunda', 'canonical', 'cartesia', 'celonis', 'ciroos',
      'cloudflare', 'coframe', 'cognite', 'cognition', 'coinbase', 'commerceiq', 'composio', 'credo', 'cursor',
      'databricks', 'deductive', 'demandbase', 'earnin', 'elastic', 'ema', 'emergent', 'employ', 'endor',
      'fivetran', 'founding', 'gitlab', 'grafana', 'graviton', 'handshake', 'harvey', 'infisical', 'kantiv',
      'kong', 'libra', 'lightning', 'litellm', 'livekit', 'metaforms', 'mongodb', 'nanonets', 'neuron7',
      'notion', 'openai', 'opengov', 'outmarket', 'palantir', 'par', 'posthog', 'postman', 'pulsora',
      'quadeye', 'quillbot', 'railway', 'razorpay', 'reacher', 'reo', 'rubrik', 'sagent', 'sarvam',
      'singlestore', 'sumologic', 'synthflow', 'temporal', 'tide', 'truefoundry', 'turing', 'twilio',
      'vapi', 'weave', 'wisdomai', 'zscaler'
    ];
    
    const genericResumes = files.filter(f => {
      const cleanName = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (cleanName.includes('generic') || cleanName.includes('universal') || cleanName.includes('standard')) {
        return true;
      }
      // If it doesn't contain any other known company names, it might be generic
      return !knownCompanies.some(company => cleanName.includes(company));
    }).sort((a, b) => b.mtime - a.mtime);

    if (genericResumes.length > 0) {
      console.log(`${colors.green}🎯 No company-specific resume found for "${companyName}". Using generic/standard resume: "${genericResumes[0].name}"${colors.reset}`);
      return genericResumes[0].path;
    }

    // 3. Prevent uploading another company's tailored resume
    console.log(`\n${colors.bright}${colors.red}❌ ERROR: No tailored resume found for "${companyName}" in output/, and no generic resume was found.${colors.reset}`);
    console.log(`${colors.yellow}To prevent uploading an incorrect company-specific resume, NO file will be uploaded.${colors.reset}`);
    console.log(`${colors.cyan}Please generate a tailored resume for "${companyName}" first, or upload your resume manually.${colors.reset}\n`);
    
    return null;
  } catch (e) {
    console.error(`Error finding latest resume: ${e.message}`);
  }
  return null;
}

// Unified robust autofill engine using Visual-Label DOM Analysis and Node-side Fuzzy Matching
// Helper to find the best option among choices
function findBestOption(options, keywords, fallback) {
  // 1. Try to find an exact or very close match first
  for (const keyword of keywords) {
    const cleanKeyword = keyword.toLowerCase().trim();
    for (const opt of options) {
      const text = (opt.label || opt.text || '').toLowerCase().trim();
      if (text === cleanKeyword) {
        return opt;
      }
    }
  }

  // 2. Try to find a substring match
  for (const keyword of keywords) {
    const cleanKeyword = keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const opt of options) {
      const text = opt.label || opt.text || '';
      const cleanOpt = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanOpt.includes(cleanKeyword)) {
        return opt;
      }
    }
  }

  // 3. Try fallback
  if (fallback) {
    const cleanFallback = fallback.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const opt of options) {
      const text = opt.label || opt.text || '';
      const cleanOpt = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanOpt.includes(cleanFallback) || cleanFallback.includes(cleanOpt)) {
        return opt;
      }
    }
  }

  return null;
}

// Dictionary of custom, premium strategy profiles for each detected job board engine
const portalStrategies = {
  'Greenhouse': {
    title: 'Greenhouse Job Board Optimizer',
    desc: 'Optimized form filler targeting Greenhouse multi-step & custom demographics controls.',
    optimizations: 'Plural container checks, telephone country list exclusions, scoped listbox selections, direct DOM click fallbacks.',
    color: colors.green
  },
  'Ashby': {
    title: 'AshbyHQ Engine Adaptor',
    desc: 'Tailored automation targeting Ashby virtualized react-select elements and highly nested divs.',
    optimizations: 'Dynamic keyboard type-filtering, visible listbox containment, fallback selector matching.',
    color: colors.cyan
  },
  'Lever': {
    title: 'Lever.co Application Auto-filler',
    desc: 'Structured automation targeting Lever unified 1-page form schemas.',
    optimizations: 'Explicit textarea content injection, work authorization checkbox force-clicks, multiple radio option siblings check.',
    color: colors.magenta
  },
  'Workday': {
    title: 'Workday Enterprise Form Automator',
    desc: 'Advanced workflow handling for multi-page shadow DOM Enterprise applications.',
    optimizations: 'Deep shadow root traversal, automatic multi-step "Next" button progression, secure field fills.',
    color: colors.yellow
  },
  'FirstStage': {
    title: 'FirstStage Wizard Automator',
    desc: 'Iterative step-by-step wizard handling for Typeform-style forms hosted on firststage.co.',
    optimizations: 'Step detection, force-click option checks, file upload input targeting, next-button progression loop.',
    color: colors.yellow
  },
  'CareerPuck': {
    title: 'CareerPuck Embed Optimizations',
    desc: 'Optimized form filler targeting CareerPuck embedded multi-step application forms.',
    optimizations: 'Email step skip, multi-step field filling, continue button clicks, standard submissions.',
    color: colors.blue
  },
  'Generic': {
    title: 'Universal AI Job Board Filler',
    desc: 'Fuzzy visual-label engine designed to inspect standard HTML forms globally.',
    optimizations: 'Fuzzy regex label distance matching, standard input class/type identification, custom Section H keyword overlaps.',
    color: colors.white
  }
};

// Helper function to dynamically detect the target job portal engine
async function detectPortal(page, url) {
  const lowercaseUrl = url.toLowerCase();
  
  // 1. Initial URL signature checking
  if (lowercaseUrl.includes('firststage.co') || lowercaseUrl.includes('firststage-co')) {
    return 'FirstStage';
  }
  if (lowercaseUrl.includes('app.careerpuck.com') || lowercaseUrl.includes('careerpuck.com')) {
    return 'CareerPuck';
  }
  if (lowercaseUrl.includes('greenhouse.io') || lowercaseUrl.includes('greenhouse-io')) {
    return 'Greenhouse';
  }
  if (lowercaseUrl.includes('ashbyhq.com') || lowercaseUrl.includes('ashby-hq')) {
    return 'Ashby';
  }
  if (lowercaseUrl.includes('lever.co') || lowercaseUrl.includes('lever-co')) {
    return 'Lever';
  }
  if (lowercaseUrl.includes('myworkdayjobs.com') || lowercaseUrl.includes('workday')) {
    return 'Workday';
  }

  // 2. In-browser DOM check fallback for custom or company-aliased domains
  try {
    const domIndicator = await page.evaluate(() => {
      if (document.querySelector('[class*="firststage"]') || document.querySelector('form[action*="firststage.co"]') || document.getElementById('firststage-app')) {
        return 'FirstStage';
      }
      if (document.querySelector('[class*="careerpuck"]') || document.querySelector('form[action*="careerpuck"]') || document.querySelector('a[href*="careerpuck.com"]')) {
        return 'CareerPuck';
      }
      if (document.querySelector('#application-form') || document.querySelector('form[action*="greenhouse.io"]') || document.querySelector('input[name^="job_application["]')) {
        return 'Greenhouse';
      }
      if (document.querySelector('[class*="ashby"]') || document.querySelector('a[href*="ashbyhq.com"]') || document.getElementById('ashby-jobs-app')) {
        return 'Ashby';
      }
      if (document.querySelector('.application-form') || document.querySelector('.lever-job') || document.querySelector('a[href*="lever.co"]')) {
        return 'Lever';
      }
      if (document.querySelector('[data-automation-id*="workday"]') || document.querySelector('form[action*="workday"]')) {
        return 'Workday';
      }
      return null;
    });
    if (domIndicator) return domIndicator;
  } catch (e) {
    // Ignore DOM evaluation errors
  }

  return 'Generic';
}

// Helper to evaluate inside a frame with a strict timeout to avoid hangs
async function evaluateWithTimeout(frame, fn, arg, timeoutMs = 2000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Evaluation timed out')), timeoutMs);
  });
  try {
    const evalPromise = arg !== undefined ? frame.evaluate(fn, arg) : frame.evaluate(fn);
    const result = await Promise.race([evalPromise, timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Helper for lightweight JSON DOM form-state audit (<1KB machine readable state dump)
async function dumpFormStateJSON(frame) {
  try {
    return await evaluateWithTimeout(frame, () => {
      const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'));
      return fields.map(el => {
        const label = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '').trim();
        const rawVal = el.value || '';
        const singleVal = (el.closest('[class*="container"]')?.querySelector('[class*="singleValue"], [class*="single-value"]')?.textContent || '').trim();
        return {
          id: el.id || el.name || '',
          label: label.length > 40 ? label.slice(0, 40) + '...' : label,
          val: (rawVal || singleVal)
        };
      });
    }, undefined, 2000);
  } catch (e) {
    return [];
  }
}

// Helper to retrieve the actual URL of a frame, evaluating window.location.href if Playwright's url() is empty
async function getFrameUrl(frame) {
  try {
    let url = frame.url();
    if (url && url !== 'about:blank') return url;
    
    // Evaluate inside the frame with a short 500ms timeout
    url = await evaluateWithTimeout(frame, () => window.location.href, undefined, 500);
    return url || '';
  } catch (e) {
    return '';
  }
}

// Helper to determine if a URL is a third-party tracking, ads, captcha, or analytics frame that should be skipped
function shouldSkipUrl(url, pageUrl) {
  if (!url) return true;
  if (url === 'about:blank') return false;
  if (url.startsWith('chrome-error://')) return true;
  
  const lowerUrl = url.toLowerCase();
  const skipKeywords = [
    'recaptcha', 'hcaptcha', 'doubleclick', 'google.com/recaptcha', 'googletagmanager',
    'facebook.com', 'hs-analytics', 'intercom', 'hubspot', 'stripe.com', 'datadoghq',
    'sentry.io', 'hotjar', 'ads', 'youtube', 'vimeo', 'linkedin.com/analytics',
    'drift.com', 'munchkin', 'marketo', 'g2.com', 'leadfeeder', 'optimizely',
    'segment.com', 'amplitude', 'mixpanel'
  ];
  
  const lowerPageUrl = (pageUrl || '').toLowerCase();
  for (const keyword of skipKeywords) {
    if (lowerUrl.includes(keyword) && !lowerPageUrl.includes(keyword)) {
      return true;
    }
  }
  return false;
}

// Unified robust autofill engine using Visual-Label DOM Analysis and Node-side Fuzzy Matching
// Helper to scan all frames on a page and return the one housing the actual form (by maximum non-hidden input counts)
async function findTargetFrame(page) {
  const frames = page.frames();
  console.log(`[DEBUG findTargetFrame] Total frames on page: ${frames.length}`);
  let targetFrame = page.mainFrame();
  let maxInputs = 0;
  const pageUrl = page.url();
  
  for (const frame of frames) {
    const frameUrl = await getFrameUrl(frame);
    const isSkipped = shouldSkipUrl(frameUrl, pageUrl);
    let inputCount = 0;
    let evalError = null;
    if (!isSkipped) {
      try {
        inputCount = await evaluateWithTimeout(frame, () => {
          return document.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
        }, undefined, 2000);
      } catch (e) {
        evalError = e.message;
      }
    }
    console.log(`   - Frame URL: "${frameUrl}", name: "${frame.name()}", isSkipped: ${isSkipped}, inputCount: ${inputCount}, error: ${evalError}`);
    if (!isSkipped && inputCount > maxInputs) {
      maxInputs = inputCount;
      targetFrame = frame;
    }
  }
  return targetFrame;
}

// Helper to detect if the target job is located in India
async function detectIfIndiaRole(page, app) {
  let isIndia = false;
  
  // 1. Check if the report mentions India / Bangalore / Bengaluru / LPA / INR
  if (app?.reportPath) {
    try {
      const fullReportPath = join(projectRoot, app.reportPath);
      if (existsSync(fullReportPath)) {
        const content = readFileSync(fullReportPath, 'utf-8').toLowerCase();
        const locationBlock = content.match(/## block d[\s\S]*?## block e/i);
        const compBlock = content.match(/## block e[\s\S]*?## block f/i);
        
        if (locationBlock && (locationBlock[0].includes('india') || locationBlock[0].includes('bangalore') || locationBlock[0].includes('bengaluru'))) {
          isIndia = true;
        }
        if (compBlock && (compBlock[0].includes('lpa') || compBlock[0].includes('inr') || compBlock[0].includes('₹'))) {
          isIndia = true;
        }
        if (!isIndia && (content.includes('india roles') || content.includes('inr roles') || content.includes('₹'))) {
          isIndia = true;
        }
      }
    } catch (e) {}
  }
  
  // 2. Check page URL / Title / Content
  try {
    const pageTitle = await page.title().catch(() => '');
    const pageUrl = page.url() || '';
    const pageContent = await page.innerText('body').catch(() => '');
    
    const titleLower = pageTitle.toLowerCase();
    const urlLower = pageUrl.toLowerCase();
    const bodyLower = pageContent.toLowerCase();
    
    if (titleLower.includes('india') || titleLower.includes('bangalore') || titleLower.includes('bengaluru') ||
        urlLower.includes('india') || urlLower.includes('bangalore') || urlLower.includes('bengaluru')) {
      isIndia = true;
    }
    
    if (bodyLower.includes('bengaluru, india') || bodyLower.includes('bangalore, india') ||
        bodyLower.includes('bengaluru, karnataka') || bodyLower.includes('bangalore, karnataka') ||
        bodyLower.includes('office in bangalore') || bodyLower.includes('office in bengaluru') ||
        bodyLower.includes('location: bangalore') || bodyLower.includes('location: bengaluru')) {
      isIndia = true;
    }
  } catch (e) {}
  
  // 3. Check known Indian companies/roles
  const companyLower = (app?.company || '').toLowerCase();
  const roleLower = (app?.role || '').toLowerCase();
  if (companyLower.includes('composio') || companyLower.includes('sarvam') || companyLower.includes('kantiv') || 
      roleLower.includes('bangalore') || roleLower.includes('bengaluru') || roleLower.includes('india')) {
    isIndia = true;
  }

  return isIndia;
}

// Helper to resolve salary dynamically based on whether it is an Indian or International application
async function resolveSalaryField(frame, profile, app, fieldName) {
  const compensation = profile?.compensation || {};
  const formDefaults = profile?.form_defaults || {};
  
  if (fieldName === 'salary_expectations' && formDefaults.salary_expectation) {
    return formDefaults.salary_expectation;
  }
  if (fieldName === 'current_salary' && formDefaults.current_salary) {
    return formDefaults.current_salary;
  }
  
  const isIndiaRole = await detectIfIndiaRole(frame, app);
  
  // Parse LPA vs USD salary expectations
  const rangeStr = fieldName === 'current_salary'
    ? (compensation.current || '₹28 LPA / $35K USD')
    : (compensation.target_range || '₹40-100+ LPA / $50K-150K+ USD');
    
  let targetLpa = '';
  let targetUsd = '';
  const parts = rangeStr.split('/');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().includes('lpa') || trimmed.toLowerCase().includes('₹')) {
      targetLpa = targetLpa || trimmed;
    }
    if (trimmed.toLowerCase().includes('usd') || trimmed.toLowerCase().includes('$') || trimmed.toLowerCase().includes('k')) {
      targetUsd = targetUsd || trimmed;
    }
  }
  
  // Fallbacks if not parsed
  if (fieldName === 'current_salary') {
    targetLpa = targetLpa || '₹28 LPA';
    targetUsd = targetUsd || '$35K USD';
  } else {
    targetLpa = targetLpa || '₹40-100 LPA';
    targetUsd = targetUsd || '$50K-150K USD';
  }

  const resolved = isIndiaRole ? targetLpa : targetUsd;
  console.log(`${colors.cyan}💰 Resolved ${fieldName} for ${isIndiaRole ? 'Indian' : 'International'} role: "${resolved}"${colors.reset}`);
  return resolved;
}

// Iterative scan-and-advance filling loop for Typeform-style wizard boards (firststage.co)
async function fillFirstStageWizard(frame, profile, resumePath, customAnswers, app) {
  console.log(`\n============================================================`);
  console.log(`${colors.bright}${colors.bgMagenta}          STARTING FIRSTSTAGE WIZARD AUTOMATION            ${colors.reset}`);
  console.log(`============================================================`);

  const candidate = profile.candidate || {};
  const formDefaults = profile.form_defaults || {};
  const compensation = profile.compensation || {};
  const resolvedSalary = await resolveSalaryField(frame, profile, app, 'salary_expectations');
  const resolvedCurrentSalary = await resolveSalaryField(frame, profile, app, 'current_salary');

  const nameParts = (candidate.full_name || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Run up to 20 wizard steps to avoid infinite loops
  for (let step = 1; step <= 20; step++) {
    console.log(`\n${colors.cyan}🧙 [Step ${step}/20] Scanning page state...${colors.reset}`);

    // Check if we are on the final Review & Submit view
    const isReviewOrSubmitPage = await frame.evaluate(() => {
      const text = (document.body.innerText || '').toLowerCase();
      const hasReviewHeading = text.includes('review your application') || text.includes('review & submit') || text.includes('review and submit');
      
      // Look for a submit button
      const submitBtn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(b => {
          const btnText = (b.innerText || b.value || '').toLowerCase();
          return btnText.includes('submit application') || btnText.includes('submit form') || btnText === 'submit';
        });
      
      // If we see review text or a submit button on a page with many fields
      return hasReviewHeading || (submitBtn && document.querySelectorAll('input:not([type="hidden"]), textarea, select').length > 5);
    });

    if (isReviewOrSubmitPage) {
      console.log(`${colors.green}✅ Reached "Review and submit" page! Halting automator for user manual review.${colors.reset}`);
      break;
    }

    // Get active visible input controls on this screen
    const visibleFields = await frame.evaluate(() => {
      function isVisible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));
      return allInputs
        .filter(isVisible)
        .map(el => {
          let labelText = '';
          // A. Try label by ID
          if (el.id) {
            const labelEl = document.querySelector(`label[for="${el.id}"]`);
            if (labelEl) labelText = labelEl.innerText || labelEl.textContent;
          }
          // B. Try aria-label / placeholder / name
          if (!labelText) labelText = el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '';
          // C. Try closest question container heading/label
          if (!labelText) {
            const container = el.closest('.question, .field, .form-group, [class*="question"], [class*="field"], [class*="step"]');
            if (container) {
              const headerEl = container.querySelector('label, h1, h2, h3, h4, .label, .title, .question-title');
              if (headerEl) labelText = headerEl.innerText || headerEl.textContent;
            }
          }
          return {
            id: el.id || '',
            name: el.name || '',
            tagName: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || el.tagName.toLowerCase(),
            placeholder: el.placeholder || '',
            label: labelText.replace(/\s+/g, ' ').replace(/\*$/, '').trim()
          };
        });
    });

    if (visibleFields.length === 0) {
      console.log('   No active input controls found on this step.');
    } else {
      console.log(`   Found ${visibleFields.length} active input controls:`);
      for (const field of visibleFields) {
        console.log(`     - [${field.type}] "${field.label}" (id: ${field.id}, name: ${field.name})`);
      }

      // Fill each active input control on this step
      for (const field of visibleFields) {
        const labelLower = field.label.toLowerCase();
        let valueToFill = null;

        // A. CV / Resume Upload
        if (field.type === 'file' || labelLower.includes('resume') || labelLower.includes('cv') || labelLower.includes('upload')) {
          if (resumePath) {
            console.log(`   Uploading tailored CV PDF to "${field.label}" -> ${resumePath}`);
            const selector = field.id ? `#${field.id}` : (field.name ? `input[name="${field.name}"]` : 'input[type="file"]');
            try {
              const fileInput = await frame.$(selector);
              if (fileInput) {
                await fileInput.setInputFiles(resumePath);
                await delay(2500); // Wait for upload completion
              }
            } catch (err) {
              console.error(`   ⚠️ File upload failed: ${err.message}`);
            }
          }
          continue;
        }

        // B. Standard Fields
        if (labelLower.includes('full name')) {
          valueToFill = candidate.full_name;
        } else if (labelLower.includes('preferred name') || labelLower.includes('first name')) {
          valueToFill = firstName;
        } else if (labelLower.includes('last name')) {
          valueToFill = lastName;
        } else if (labelLower.includes('email')) {
          valueToFill = candidate.email;
        } else if (labelLower.includes('phone') || labelLower.includes('mobile') || labelLower.includes('contact number')) {
          valueToFill = candidate.phone;
        } else if (labelLower.includes('linkedin')) {
          valueToFill = candidate.linkedin;
        } else if (labelLower.includes('github') || labelLower.includes('portfolio') || labelLower.includes('website')) {
          valueToFill = candidate.portfolio_url || candidate.github || '';
        } else if (labelLower.includes('current salary') || labelLower.includes('current compensation') || labelLower.includes('previous salary') || labelLower.includes('previous compensation')) {
          valueToFill = resolvedCurrentSalary;
        } else if (labelLower.includes('salary') || labelLower.includes('expectation') || labelLower.includes('compensation')) {
          valueToFill = resolvedSalary;
        } else if (labelLower.includes('notice') || labelLower.includes('start date') || labelLower.includes('availability')) {
          valueToFill = formDefaults.notice_period || '1 month';
        } else if (labelLower.includes('sponsorship') || labelLower.includes('work authorization') || labelLower.includes('require visa')) {
          const sponsorshipNeeded = profile.config?.visa_sponsorship === 'Yes' || formDefaults.visa_sponsorship === 'Yes';
          valueToFill = sponsorshipNeeded ? 'Yes' : 'No';
        }

        // C. Custom H-Block Answers
        if (!valueToFill && customAnswers && customAnswers.length > 0) {
          const matched = customAnswers.find(ans => {
            const q = (ans.question || '').toLowerCase();
            return q.includes(labelLower) || labelLower.includes(q);
          });
          if (matched) {
            valueToFill = matched.answer;
          }
        }

        // D. Perform Fill
        if (valueToFill !== null) {
          const selector = field.id ? `#${field.id}` : (field.name ? `${field.tagName}[name="${field.name}"]` : null);
          if (selector) {
            try {
              if (field.tagName === 'select') {
                console.log(`   Selecting option for "${field.label}" -> "${valueToFill}"`);
                await frame.selectOption(selector, { label: valueToFill }).catch(async () => {
                  await frame.selectOption(selector, { value: valueToFill });
                });
              } else if (field.type === 'radio' || field.type === 'checkbox') {
                console.log(`   Clicking option for "${field.label}" -> "${valueToFill}"`);
                await frame.evaluate(({ name, value }) => {
                  const options = Array.from(document.querySelectorAll(`input[name="${name}"], input[type="radio"], input[type="checkbox"]`));
                  for (const opt of options) {
                    const label = opt.closest('label') || document.querySelector(`label[for="${opt.id}"]`);
                    const text = (label?.innerText || label?.textContent || opt.value || '').toLowerCase();
                    const target = value.toLowerCase();
                    if (text.includes(target) || target.includes(text) || opt.value.toLowerCase() === target) {
                      opt.click();
                      break;
                    }
                  }
                }, { name: field.name, value: valueToFill });
              } else {
                console.log(`   Filling text field "${field.label}" -> "${valueToFill}"`);
                await frame.fill(selector, valueToFill);
              }
            } catch (fillErr) {
              console.error(`   ⚠️ Failed to fill "${field.label}": ${fillErr.message}`);
            }
          }
        }
      }
    }

    // Step Advancement (Click Continue / Next / Save)
    console.log(`   Advancing wizard step...`);
    const clickSuccess = await frame.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
      const continueBtn = btns.find(b => {
        const text = (b.innerText || b.value || '').toLowerCase();
        const isSubmit = text.includes('submit') || b.getAttribute('type') === 'submit' || b.getAttribute('data-action') === 'submit';
        if (isSubmit) return false;
        return (text.includes('continue') || text.includes('next') || text.includes('save') || text.includes('proceed')) &&
               !text.includes('back') && !text.includes('cancel');
      });
      if (continueBtn) {
        continueBtn.click();
        return true;
      }
      return false;
    });

    if (!clickSuccess) {
      console.warn(`${colors.yellow}⚠️ Could not locate any "Continue" or "Next" button on current wizard step. Exiting.${colors.reset}`);
      break;
    }

    // Wait for animation transition
    await delay(2000);
  }

  console.log(`\n============================================================`);
  console.log(`${colors.bright}${colors.green}          FIRSTSTAGE WIZARD AUTOMATION COMPLETE             ${colors.reset}`);
  console.log(`============================================================\n`);
}

// Unified robust autofill engine using Visual-Label DOM Analysis and Node-side Fuzzy Matching
async function autofillForm(page, profile, resumePath, customAnswers, app) {
  if (!profile) {
    console.log(`${colors.yellow}⚠️ No profile configuration found to autofill.${colors.reset}`);
    return page.mainFrame();
  }

  const isIndia = await detectIfIndiaRole(page, app);

  let yoeText = "4 years, 9 months";
  let yoeDecimal = "4.7";
  const candidate = profile.candidate || {};
  if (candidate.experience_start_date) {
    try {
      const startDate = new Date(candidate.experience_start_date);
      const now = new Date();
      if (!isNaN(startDate.getTime())) {
        let years = now.getFullYear() - startDate.getFullYear();
        let months = now.getMonth() - startDate.getMonth();
        if (months < 0) {
          years--;
          months += 12;
        }
        yoeText = `${years} years, ${months} months`;
        yoeDecimal = (years + months / 12).toFixed(1);
      }
    } catch (e) {}
  }

  const resolvedSalary = await resolveSalaryField(page, profile, app, 'salary_expectations');
  const resolvedCurrentSalary = await resolveSalaryField(page, profile, app, 'current_salary');

  // Scan and select the correct target frame (handles iframe-embedded forms like Greenhouse/Lever/Ashby)
  console.log(`${colors.cyan}🔍 Scanning page for forms and active frames...${colors.reset}`);
  let targetFrame = page.mainFrame();
  for (let attempt = 1; attempt <= 5; attempt++) {
    targetFrame = await findTargetFrame(page);
    const count = await targetFrame.evaluate(() => document.querySelectorAll('input:not([type="hidden"]), textarea, select').length).catch(() => 0);
    if (count > 0) {
      console.log(`${colors.green}✅ Target frame identified (${targetFrame.url()}) with ${count} form fields!${colors.reset}`);
      break;
    }
    if (attempt < 5) {
      console.log(`${colors.dim}   - Attempt ${attempt}: No form fields found yet. Waiting 1s...${colors.reset}`);
      await delay(1000);
    }
  }

  const url = targetFrame.url();
  const detectedPortal = await detectPortal(targetFrame, url);
  const strategy = portalStrategies[detectedPortal] || portalStrategies.Generic;

  console.log(`\n============================================================`);
  console.log(`${colors.bright}${colors.bgBlue}             PORTAL-SPECIFIC FILL STRATEGY                  ${colors.reset}`);
  console.log(`============================================================`);
  console.log(`📡 Detected Job Board: ${strategy.color}${colors.bright}${detectedPortal.toUpperCase()}${colors.reset}`);
  console.log(`🎯 Strategy Profile:  ${colors.bright}${strategy.title}${colors.reset}`);
  console.log(`📝 Description:       ${colors.dim}${strategy.desc}${colors.reset}`);
  console.log(`🛠️ Optimizations:     ${colors.dim}${strategy.optimizations}${colors.reset}`);
  console.log(`============================================================\n`);

  if (detectedPortal === 'FirstStage') {
    await fillFirstStageWizard(targetFrame, profile, resumePath, customAnswers, app);
    return targetFrame;
  }

  console.log(`${colors.cyan}🤖 Running unified visual-label form autofill engine...${colors.reset}`);
  
  const location = profile.location || {};
  const formDefaults = profile.form_defaults || {};
  const nameParts = (candidate.full_name || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const logs = [];
  if (app) app.fillLogs = logs;
  logs.push = function(msg) {
    console.log(`   - [${strategy.color}${detectedPortal}${colors.reset}] ${msg}`);
    return Array.prototype.push.call(this, msg);
  };

  let step = 1;
  const maxSteps = 5;
  let hasMoreSteps = true;

  while (hasMoreSteps && step <= maxSteps) {
    if (step > 1) {
      console.log(`\n${colors.cyan}🧙 [Step ${step}] Scanning page state for next step...${colors.reset}`);
    }

  // Scroll to bottom to trigger lazy loading of fields (e.g. Country dropdowns / async widgets)
  try {
    await targetFrame.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    // Wait briefly for elements to render
    await new Promise(resolve => setTimeout(resolve, 500));
    await targetFrame.evaluate(() => {
      window.scrollTo(0, 0);
    });
  } catch (e) {
    // Ignore scroll errors if targetFrame is not scrollable or detached
  }

  // Get in-browser DOM layout analysis
  const domLayout = await targetFrame.evaluate(() => {
    function getLabelText(el) {
      let labelText = '';
      
      // A. Try label elements linked by id
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) {
          labelText = labelEl.innerText || labelEl.textContent;
        }
      }
      
      // B. Try aria-labelledby link
      if (!labelText && el.getAttribute('aria-labelledby')) {
        const labelId = el.getAttribute('aria-labelledby');
        const labelEl = document.getElementById(labelId);
        if (labelEl) {
          labelText = labelEl.innerText || labelEl.textContent;
        }
      }
      
      // C. Try aria-label directly on element
      if (!labelText && el.getAttribute('aria-label')) {
        labelText = el.getAttribute('aria-label');
      }
      
      // B. Climb up to find closest field/question container
      if (!labelText) {
        const container = el.closest('.field, .question, .form-group, .field-wrapper, [class*="field"]:not([class*="fields"]), [class*="question"]:not([class*="questions"]), [class*="form-row"], [class*="Field"], [class*="Question"]');
        if (container) {
          const labelEl = container.querySelector('label');
          if (labelEl) {
            labelText = labelEl.innerText || labelEl.textContent;
          } else {
            const titleEl = container.querySelector('.label, .title, .question-title, [class*="label"], [class*="title"], [class*="question-text"], [class*="QuestionText"]');
            if (titleEl) {
              labelText = titleEl.innerText || titleEl.textContent;
            } else {
              const headingEl = container.querySelector('h1, h2, h3, h4, h5');
              if (headingEl) {
                labelText = headingEl.innerText || headingEl.textContent;
              }
            }
          }
        }
      }
      
      // C. Fallback to closest label or previous siblings / placeholder / name / id
      if (!labelText) {
        labelText = el.closest('label')?.innerText || el.closest('label')?.textContent || el.previousElementSibling?.innerText || el.previousElementSibling?.textContent || el.placeholder || el.name || el.id || '';
      }
      
      // If the label is a short checkbox label (e.g., less than 15 chars), try to prepend or fall back to container question text
      if (el.tagName.toLowerCase() === 'input' && el.getAttribute('type') === 'checkbox' && labelText.length < 15) {
        const container = el.closest('.question, .field, .form-group, .field-wrapper, [class*="field"], [class*="question"]');
        if (container) {
          const titleEl = container.querySelector('label, .label, .title, .question-title, h1, h2, h3, h4, span, p');
          if (titleEl) {
            const containerText = (titleEl.innerText || titleEl.textContent || '').trim();
            if (containerText && containerText !== labelText) {
              labelText = `${containerText} - ${labelText}`;
            }
          }
        }
      }
      
      // If the label text looks like a raw Lever "cards" custom question name,
      // walk up the DOM to find the nearest parent with substantial text content
      if (labelText.includes('cards[') || /^cards\[/i.test(labelText)) {
        let p = el.parentElement;
        for (let i = 0; i < 5 && p; i++) {
          const text = (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length > 0 && text.length < 500) {
            labelText = text;
            break;
          }
          p = p.parentElement;
        }
      }
      
      return labelText
        .replace(/\r?\n/g, ' ')
        .replace(/\s*\*\s*/g, '')
        .replace(/\(required\)/gi, '')
        .replace(/\*required\*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function getSelectorAndIndex(el) {
      const tag = el.tagName.toLowerCase();
      if (el.id) {
        return { selector: `${tag}[id="${el.id}"]`, index: 0 };
      }
      if (el.name) {
        const allWithName = Array.from(document.querySelectorAll(`${tag}[name="${el.name}"]`));
        return { selector: `${tag}[name="${el.name}"]`, index: allWithName.indexOf(el) };
      }
      
      const typeAttr = el.getAttribute('type');
      const selector = typeAttr ? `${tag}[type="${typeAttr}"]` : tag;
      const allMatches = Array.from(document.querySelectorAll(selector));
      return { selector, index: allMatches.indexOf(el) };
    }

    // Capture standard input fields (text, email, tel, file, textarea, etc.)
    const inputs = Array.from(document.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="hidden"]), textarea, [contenteditable="true"]'))
      .filter(el => {
        // Exclude reCAPTCHA elements
        if (el.id?.includes('g-recaptcha') || el.name?.includes('g-recaptcha') || el.id?.startsWith('g-recaptcha-response')) {
          return false;
        }
        // Exclude inputs inside international telephone country code search list
        if (el.classList.contains('iti__search-input') || el.id?.startsWith('iti-') || el.closest('.iti__dropdown-content') || el.closest('.iti__country-container')) {
          return false;
        }
        // Exclude custom dropdown helper input elements (e.g. react-select)
        const className = el.className || '';
        if (typeof className === 'string' && className.includes('select__input')) {
          return false;
        }
        // Exclude read-only or disabled input fields
        if (el.readOnly || el.disabled) {
          return false;
        }
        // Exclude aria-hidden inputs or those with tabindex="-1" (unless it's a file input, which often uses these while hidden)
        if (el.getAttribute('type') !== 'file' && (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('tabindex') === '-1')) {
          return false;
        }
        // Exclude inputs that are inside styled custom dropdown / combobox containers
        if (el.closest('[role="combobox"], [class*="select__control"], [class*="select-control"], [class*="select__value-container"]')) {
          return false;
        }
        // Exclude text inputs that are visually hidden (size 0x0)
        if (el.getAttribute('type') !== 'file' && el.offsetWidth === 0 && el.offsetHeight === 0) {
          return false;
        }
        return true;
      })
      .map(el => {
        const { selector, index } = getSelectorAndIndex(el);
        return {
          id: el.id || '',
          name: el.name || '',
          type: el.tagName.toLowerCase() === 'textarea' ? 'textarea' : (el.getAttribute('type') || 'text'),
          labelText: getLabelText(el),
          placeholder: el.placeholder || '',
          tag: el.tagName.toLowerCase(),
          selector,
          index
        };
      });

    // Capture standard selects
    const selects = Array.from(document.querySelectorAll('select')).map(select => {
      const { selector, index } = getSelectorAndIndex(select);
      const options = Array.from(select.querySelectorAll('option')).map(opt => ({
        text: (opt.innerText || opt.textContent || '').trim(),
        value: opt.getAttribute('value')
      }));
      return {
        id: select.id || '',
        name: select.name || '',
        labelText: getLabelText(select),
        type: 'select',
        options: options,
        selector,
        index
      };
    });

    // Capture custom dropdown controls
    const dropdownElements = Array.from(document.querySelectorAll('[role="combobox"], [class*="select__control"], [class*="select-control"]'));
    const customDropdowns = dropdownElements
      .filter(el => {
        // Exclude visually hidden dropdown controls (size 0x0)
        if (el.offsetWidth === 0 && el.offsetHeight === 0) {
          return false;
        }
        // Exclude elements that are nested inside another matched dropdown container to avoid duplicates
        const hasDropdownAncestor = dropdownElements.some(parent => parent !== el && parent.contains(el));
        if (hasDropdownAncestor) {
          return false;
        }
        return true;
      })
      .map(el => {
        let cssSelector = '';
        if (el.id) {
          cssSelector = `[id="${el.id}"]`;
        } else {
          const classes = Array.from(el.classList).filter(c => !c.includes('is-focused') && !c.includes('is-open'));
          cssSelector = classes.length > 0 ? `.${classes.join('.')}` : el.tagName.toLowerCase();
        }
        const allMatches = Array.from(document.querySelectorAll(cssSelector));
        return {
          id: el.id || '',
          labelText: getLabelText(el),
          type: 'custom-dropdown',
          selector: cssSelector,
          index: allMatches.indexOf(el)
        };
      });

    // Capture checkboxes
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).map(el => {
      const { selector, index } = getSelectorAndIndex(el);
      return {
        id: el.id || '',
        name: el.name || '',
        labelText: getLabelText(el),
        type: 'checkbox',
        checked: el.checked,
        selector,
        index
      };
    });

    // Group and capture radio groups
    const radioGroups = {};
    const radioElements = document.querySelectorAll('input[type="radio"]');
    for (const radio of radioElements) {
      const name = radio.name || radio.closest('.question, .field, .form-group')?.id || 'unnamed-group';
      let groupLabel = '';
      const container = radio.closest('.question, .field, .form-group, .field-wrapper, [class*="field"], [class*="question"]');
      if (container) {
        const titleEl = container.querySelector('label, .label, .title, .question-title, h1, h2, h3, h4, span, p');
        if (titleEl) groupLabel = titleEl.innerText || titleEl.textContent;
      }
      
      // Fallback 1: Check closest fieldset legend
      if (!groupLabel) {
        const parentFieldSet = radio.closest('fieldset');
        if (parentFieldSet) {
          const legend = parentFieldSet.querySelector('legend');
          if (legend) groupLabel = legend.innerText || legend.textContent;
        }
      }
      
      // Fallback 2: Walk up ancestors to find a heading or label
      if (!groupLabel) {
        let parent = radio.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const heading = parent.querySelector('h1, h2, h3, h4, h5, legend, [class*="label"], [class*="title"]');
          if (heading) {
            groupLabel = heading.innerText || heading.textContent;
            break;
          }
          parent = parent.parentElement;
        }
      }
      
      // Fallback 3: Walk up N ancestor levels and take first non-empty text content under 300 chars
      if (!groupLabel || groupLabel === name) {
        let parent = radio.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const text = (parent.innerText || parent.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length > 5 && text.length < 300) {
            groupLabel = text;
            break;
          }
          parent = parent.parentElement;
        }
      }

      if (!groupLabel) groupLabel = name;
      groupLabel = groupLabel.replace(/\s+/g, ' ').trim();

      let optionLabel = '';
      if (radio.id) {
        const optLabelEl = document.querySelector(`label[for="${radio.id}"]`);
        if (optLabelEl) optionLabel = optLabelEl.innerText || optLabelEl.textContent;
      }
      if (!optionLabel) {
        optionLabel = radio.closest('label')?.innerText || radio.nextElementSibling?.innerText || radio.nextSibling?.textContent || '';
      }
      optionLabel = optionLabel.replace(/\s+/g, ' ').trim();

      if (!radioGroups[name]) {
        radioGroups[name] = {
          name: name,
          groupLabel: groupLabel,
          options: []
        };
      }
      const { selector, index } = getSelectorAndIndex(radio);
      radioGroups[name].options.push({
        label: optionLabel,
        id: radio.id,
        selector,
        index
      });
    }

    // Group and capture button-style Yes/No questions (specifically for Ashby)
    const buttonQuestions = [];
    const questionContainers = Array.from(document.querySelectorAll('.question, .field, [class*="question"], [class*="field"], [class*="Question"], [class*="Field"]'));
    for (const container of questionContainers) {
      const buttons = Array.from(container.querySelectorAll('button:not([type="submit"])'));
      if (buttons.length === 2) {
        const btnTexts = buttons.map(b => (b.innerText || b.textContent || '').trim().toLowerCase());
        if (btnTexts.includes('yes') || btnTexts.includes('no') || btnTexts.includes('agree') || btnTexts.includes('disagree')) {
          let labelText = '';
          const headerEl = container.querySelector('label, h1, h2, h3, h4, .label, .title, .question-title, [class*="label"], [class*="title"], [class*="question-text"], [class*="QuestionText"]');
          if (headerEl) labelText = headerEl.innerText || headerEl.textContent;
          if (!labelText) {
            labelText = container.previousElementSibling?.innerText || '';
          }
          labelText = labelText.replace(/\s+/g, ' ').trim();
          if (labelText) {
            let containerSelector = '';
            if (container.id) {
              containerSelector = `[id="${container.id}"]`;
            } else {
              const classes = Array.from(container.classList).filter(c => !c.includes('is-focused') && !c.includes('is-open'));
              containerSelector = classes.length > 0 ? `.${classes.join('.')}` : 'div';
            }
            if (!buttonQuestions.some(bq => bq.labelText === labelText)) {
              buttonQuestions.push({
                labelText,
                buttons: buttons.map((b, idx) => ({
                  text: (b.innerText || b.textContent || '').trim(),
                  selector: `${containerSelector} button`,
                  index: idx
                }))
              });
            }
          }
        }
      }
    }

    return {
      inputs,
      selects,
      customDropdowns,
      checkboxes,
      radioGroups: Object.values(radioGroups),
      buttonQuestions
    };
  });

  // Debug logging for detected DOM elements and their resolved labels
  console.log(`${colors.cyan}[DEBUG] Form layout scanned:${colors.reset}`);
  console.log(`   - Inputs: ${domLayout.inputs?.length || 0}`);
  for (const input of (domLayout.inputs || [])) {
    console.log(`     * Input: labelText="${input.labelText}", type="${input.type}", id="${input.id}", name="${input.name}"`);
  }
  console.log(`   - Selects: ${domLayout.selects?.length || 0}`);
  for (const select of (domLayout.selects || [])) {
    console.log(`     * Select: labelText="${select.labelText}", id="${select.id}", name="${select.name}"`);
  }
  console.log(`   - Custom Dropdowns: ${domLayout.customDropdowns?.length || 0}`);
  for (const dropdown of (domLayout.customDropdowns || [])) {
    console.log(`     * Dropdown: labelText="${dropdown.labelText}", id="${dropdown.id}"`);
  }
  console.log(`   - Checkboxes: ${domLayout.checkboxes?.length || 0}`);
  for (const cb of (domLayout.checkboxes || [])) {
    console.log(`     * Checkbox: labelText="${cb.labelText}", id="${cb.id}", name="${cb.name}"`);
  }
  console.log(`   - Radio Groups: ${domLayout.radioGroups?.length || 0}`);
  for (const rg of (domLayout.radioGroups || [])) {
    console.log(`     * Radio Group: groupLabel="${rg.groupLabel}", name="${rg.name}"`);
  }
  console.log(`   - Ashby Button Questions: ${domLayout.buttonQuestions?.length || 0}`);
  for (const bq of (domLayout.buttonQuestions || [])) {
    console.log(`     * Button Question: labelText="${bq.labelText}", buttons=[${bq.buttons.map(b => b.text).join(', ')}]`);
  }

    // logs is defined outside the loop

  // Helper to match labels fuzzily
  function fuzzyLabelMatch(labelText, regexList) {
    if (!labelText) return false;
    const cleanLabel = labelText.toLowerCase();
    for (const regex of regexList) {
      if (regex.test(cleanLabel)) return true;
    }
    return false;
  }

  // Helper to match custom Section H answers
  function matchCustomAnswer(labelText, answers, inputObj = null, usedAnswers = null) {
    if (!labelText || !answers || answers.length === 0) return null;
    const cleanLabel = labelText.toLowerCase();

    // Define semantic themes with associated keywords
    const themes = {
      WHY_COMPANY: {
        keywords: ['why', 'join', 'interest', 'cover letter', 'about us', 'why now', 'choose us', 'reasons for applying', 'why elevenlabs', 'fit for this role', 'note', 'message', 'comments', 'additional', 'anything else'],
        name: 'WHY_COMPANY'
      },
      HARD_PROBLEM_OR_IMPACT: {
        keywords: ['hardest', 'hard', 'impactful', 'built', 'technical challenge', 'engineering problem', 'contribution', 'solved', 'problem you solved', 'project', 'most proud of', 'proudest achievement'],
        name: 'HARD_PROBLEM_OR_IMPACT'
      },
      METRICS_OR_SUCCESS: {
        keywords: ['how did you know', 'worked', 'success', 'metric', 'measure', 'result', 'how did you measure', 'evidence of success'],
        name: 'METRICS_OR_SUCCESS'
      },
      PRODUCT_USAGE: {
        keywords: ['have you used', 'side project', 'explore', 'experience with', 'personal project', 'using elevenlabs', 'used elevenlabs', 'testing', 'experimented'],
        name: 'PRODUCT_USAGE'
      },
      DESIGN_INTERACTION: {
        keywords: ['designing complex', 'interactive interfaces', 'infinite canvas', 'voice dashboards', 'real-time voice', 'ui/ux approach', 'user interface design'],
        name: 'DESIGN_INTERACTION'
      }
    };

    // Helper to identify theme of a string based on keyword matches
    function getTheme(text) {
      const lower = text.toLowerCase();
      let bestTheme = null;
      let maxMatches = 0;
      for (const [themeKey, themeDef] of Object.entries(themes)) {
        let matches = 0;
        for (const kw of themeDef.keywords) {
          if (lower.includes(kw)) {
            matches++;
          }
        }
        if (matches > maxMatches) {
          maxMatches = matches;
          bestTheme = themeKey;
        }
      }
      return bestTheme;
    }

    const labelTheme = getTheme(cleanLabel);

    // Determine if this specific input is a cover letter field (large essay textarea/input for introducing oneself or cover letter)
    const isCoverLetterText = inputObj && (
      (inputObj.type === 'textarea' || inputObj.tag === 'textarea') && (
        cleanLabel.includes('cover letter') ||
        cleanLabel.includes('coverletter') ||
        cleanLabel.includes('introduce yourself') ||
        cleanLabel.includes('message to hiring') ||
        cleanLabel.includes('application letter') ||
        (inputObj.id || '').toLowerCase().includes('cover') ||
        (inputObj.name || '').toLowerCase().includes('cover') ||
        (inputObj.placeholder || '').toLowerCase().includes('cover letter') ||
        (inputObj.placeholder || '').toLowerCase().includes('introduce yourself')
      )
    );

    // Filter the candidate answers:
    // - If it's a cover letter field, we ONLY want the 'Cover Letter' answer or why-company/intro answer
    // - If it is NOT a cover letter field, we EXCLUDE the 'Cover Letter' answer to avoid putting it in custom essay fields.
    let filteredAnswers = answers;
    if (isCoverLetterText) {
      const coverAns = answers.find(ans => ans.question.toLowerCase().includes('cover') || getTheme(ans.question.toLowerCase()) === 'WHY_COMPANY');
      if (coverAns) {
        if (usedAnswers) usedAnswers.add(coverAns);
        return coverAns;
      }
    } else {
      filteredAnswers = answers.filter(ans => !ans.question.toLowerCase().includes('cover') && ans.question.toLowerCase() !== 'cover letter');
    }

    // Deprioritize already used answers if unused answers remain
    let candidates = filteredAnswers;
    if (usedAnswers && usedAnswers.size > 0) {
      const unused = filteredAnswers.filter(ans => !usedAnswers.has(ans));
      if (unused.length > 0) {
        candidates = unused;
      }
    }

    let bestMatch = null;
    let highestScore = 0;

    const STOP_WORDS = new Set(['in', 'on', 'at', 'to', 'of', 'by', 'is', 'am', 'an', 'as', 'it', 'we', 'he', 'my', 'me', 'or', 'do', 'so', 'if', 'the', 'and', 'for', 'but', 'not', 'you', 'are', 'was', 'out', 'our', 'his', 'her', 'how', 'who', 'why', 'can', 'has', 'had', 'any', 'all', 'with', 'about', 'your', 'would', 'like', 'share']);

    for (const item of candidates) {
      const cleanQuestion = item.question.toLowerCase();
      
      // 1. Direct substring match
      if (cleanLabel.includes(cleanQuestion) || cleanQuestion.includes(cleanLabel)) {
        bestMatch = item;
        break;
      }

      // 2. Semantic Theme Match (High Priority)
      if (labelTheme) {
        const questionTheme = getTheme(cleanQuestion);
        if (questionTheme === labelTheme) {
          bestMatch = item;
          break;
        }
      }

      // 3. Keyword overlap match (excluding standard stop words but retaining short tech terms >= 2 chars)
      const words = cleanQuestion.split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
      let matchCount = 0;
      for (const word of words) {
        if (cleanLabel.includes(word)) {
          matchCount++;
        }
      }

      const score = words.length > 0 ? (matchCount / words.length) : 0;
      if (score > highestScore && score >= 0.4) {
        highestScore = score;
        bestMatch = item;
      }
    }

    // Index-based fallback if fuzzy matching did not find a strong candidate among unused answers
    if (!bestMatch && candidates.length > 0) {
      bestMatch = candidates[0];
    }

    if (bestMatch && usedAnswers) {
      usedAnswers.add(bestMatch);
    }

    return bestMatch;
  }

  // Helper to match a custom answer to the best option in a radio group
  function findBestRadioOptionFromCustomAnswer(options, customAnswerText) {
    if (!customAnswerText || !options || options.length === 0) return null;
    const ansLower = customAnswerText.toLowerCase().trim();
    
    // 1. Try exact or startsWith/endsWith match
    for (const opt of options) {
      const optLower = opt.label.toLowerCase().trim();
      if (ansLower.includes(optLower) || optLower.includes(ansLower)) {
        return opt;
      }
    }
    
    // 2. Keyword-based matching
    let bestOpt = null;
    let maxScore = -1;
    const ansWords = ansLower.split(/\W+/).filter(w => w.length > 2);
    for (const opt of options) {
      const optLower = opt.label.toLowerCase().trim();
      let score = 0;
      for (const word of ansWords) {
        if (optLower.includes(word)) {
          score++;
        }
      }
      // Boost if yes/no question and matches polarity
      if (ansLower.startsWith('yes') && (optLower === 'yes' || optLower.includes('yes') || optLower.includes('true') || optLower.includes('agree') || optLower.startsWith('y'))) {
        score += 10;
      }
      if (ansLower.startsWith('no') && (optLower === 'no' || optLower.includes('no') || optLower.includes('false') || optLower.includes('disagree') || optLower.startsWith('n'))) {
        score += 10;
      }
      if (score > maxScore && score > 0) {
        maxScore = score;
        bestOpt = opt;
      }
    }
    return bestOpt;
  }

  // Helper to match timezone options against a drafted answer
  function matchTimezoneOption(options, answer) {
    if (!answer) return null;
    const cleanAnswer = answer.toLowerCase();
    
    // Extract offsets: looking for patterns like +5:30, +05:30, -8, -08:00, etc.
    const offsetRegexes = [
      /(?:UTC|GMT)\s*([+-]\d{1,2}:\d{2})/i,
      /(?:UTC|GMT)\s*([+-]\d{1,2})/i,
      /([+-]\d{1,2}:\d{2})/,
      /([+-]\d{1,2})/
    ];
    let extractedOffset = null;
    for (const r of offsetRegexes) {
      const m = answer.match(r);
      if (m) {
        extractedOffset = m[1].replace(/\s+/g, '');
        break;
      }
    }
    
    const offsetAlternatives = [];
    if (extractedOffset) {
      offsetAlternatives.push(extractedOffset);
      // Handle zero padding (e.g. +5:30 -> +05:30)
      const padMatch = extractedOffset.match(/^([+-])(\d)(:\d{2})$/);
      if (padMatch) {
        offsetAlternatives.push(`${padMatch[1]}0${padMatch[2]}${padMatch[3]}`);
      }
      // Handle unpadding (e.g. +05:30 -> +5:30)
      const unpadMatch = extractedOffset.match(/^([+-])0(\d)(:\d{2})$/);
      if (unpadMatch) {
        offsetAlternatives.push(`${unpadMatch[1]}${unpadMatch[2]}${unpadMatch[3]}`);
      }
    }

    // Standard timezone abbreviations
    const tzAbbrs = ['IST', 'EST', 'PST', 'GMT', 'CET', 'EET', 'UTC', 'MST', 'CST', 'AST', 'JST', 'KST', 'AEST', 'AWST', 'NZST'];
    const foundAbbrs = tzAbbrs.filter(abbr => {
      const r = new RegExp(`\\b${abbr}\\b`, 'i');
      return r.test(answer);
    });

    for (const opt of options) {
      const optText = opt.text.toLowerCase();
      
      // Match offset
      if (offsetAlternatives.length > 0) {
        for (const alt of offsetAlternatives) {
          if (optText.includes(alt.toLowerCase())) {
            return opt;
          }
        }
      }
      
      // Match abbreviations
      for (const abbr of foundAbbrs) {
        if (optText.includes(abbr.toLowerCase())) {
          return opt;
        }
      }
    }
    return null;
  }

  // Helper to match Yes/No options against a drafted answer
  function matchYesNoOption(options, answer) {
    if (!answer) return null;
    const cleanAnswer = answer.toLowerCase().trim();
    const isYes = cleanAnswer.startsWith('yes') || cleanAnswer === 'i do' || cleanAnswer === 'true';
    const isNo = cleanAnswer.startsWith('no') || cleanAnswer === 'i do not' || cleanAnswer === 'false';
    
    if (!isYes && !isNo) return null;
    
    for (const opt of options) {
      const optText = opt.text.toLowerCase().trim();
      if (isYes) {
        if (optText.startsWith('yes') || optText === 'i do' || optText === 'i agree' || optText.startsWith('agree') || optText.startsWith('authorized')) {
          return opt;
        }
      } else {
        if (optText.startsWith('no') || optText.startsWith('i do not') || optText.startsWith('disagree') || optText.startsWith('i decline') || optText.startsWith('decline')) {
          return opt;
        }
      }
    }
    return null;
  }


  // Define matcher configurations for text / textarea inputs
  const textMatchers = [
    {
      name: 'full_name',
      regex: [/full\s*name/i, /^name$/i, /first\s*(and|&)?\s*last\s*name/i, /first\s+name\s+last\s+name/i],
      value: candidate.full_name || ''
    },
    {
      name: 'most_recent_employer',
      regex: [/employer/i, /company/i, /most\s*recent\s*employer/i, /current\s*employer/i, /current\s*company/i, /recent\s*employer/i],
      value: "realfast.ai"
    },
    {
      name: 'most_recent_title',
      regex: [/job\s*title/i, /current\s*role/i, /most\s*recent\s*title/i, /current\s*title/i, /recent\s*job\s*title/i],
      value: "Forward Deployed Engineer"
    },
    {
      name: 'email',
      regex: [/email/i, /e-mail/i],
      value: candidate.email || ''
    },
    {
      name: 'first_name',
      regex: [/first\s*name/i, /given\s*name/i, /^first$/i],
      value: firstName
    },
    {
      name: 'last_name',
      regex: [/last\s*name/i, /family\s*name/i, /^last$/i],
      value: lastName
    },
    {
      name: 'phone',
      regex: [/phone/i, /mobile/i, /telephone/i, /tel\b/i],
      value: candidate.phone || ''
    },
    {
      name: 'linkedin',
      regex: [/linkedin/i],
      value: candidate.linkedin ? (candidate.linkedin.startsWith('http') ? candidate.linkedin : `https://${candidate.linkedin}`) : ''
    },
    {
      name: 'github',
      regex: [/github/i],
      value: candidate.github ? (candidate.github.startsWith('http') ? candidate.github : `https://${candidate.github}`) : ''
    },
    {
      name: 'twitter',
      regex: [/twitter/i, /\bx\b/i, /twitter\s*profile/i, /x\s*profile/i],
      value: candidate.twitter ? (candidate.twitter.startsWith('http') ? candidate.twitter : `https://${candidate.twitter}`) : ''
    },
    {
      name: 'portfolio',
      regex: [/portfolio/i, /website/i, /personal\s*site/i, /personal\s*website/i],
      value: candidate.portfolio_url || ''
    },
    {
      name: 'current_location',
      regex: [/\bcity\b/i, /current\s*location/i, /where\s*are\s*you\s*located/i, /where\s*are\s*you\s*based/i, /location\s*\(city/i, /city,\s*state/i, /^location$/i, /current\s*city/i],
      value: candidate.location || profile.candidate?.location || (location.city && location.country ? `${location.city}, ${location.country}` : "Bengaluru, India")
    },
    {
      name: 'passport_country',
      regex: [/passport\s*country/i, /citizenship/i, /citizen/i],
      value: location.country || 'India'
    },
    {
      name: 'residence_country',
      regex: [/residence\s*country/i, /country\s*of\s*residence/i, /where\s*do\s*you\s*live/i, /country\b/i],
      value: location.country || 'India'
    },
    {
      name: 'address_line',
      regex: [/^address\s*line\s*1$/i, /^street\s*address$/i, /^address$/i],
      value: ''
    },
    {
      name: 'address_line2',
      regex: [/^address\s*line\s*2/i, /^apt\.?\/suite/i, /^unit\s*\/\s*apt/i],
      value: ''
    },
    {
      name: 'city_field',
      regex: [/^city$/i, /^city\s*[\*\(]/i],
      value: location.city || 'Bengaluru'
    },
    {
      name: 'state_field',
      regex: [/^state$/i, /^province$/i, /^state\s*\/\s*province/i, /^province\s*\/\s*state/i],
      value: 'Karnataka'
    },
    {
      name: 'postal_field',
      regex: [/^postal/i, /^zip\s*code/i, /^postal\s*\/\s*zip/i, /^postcode$/i],
      value: '560001'
    },
    {
      name: 'notice_period',
      regex: [/notice\s*period/i, /how\s*soon\s*can\s*you\s*start/i, /start\s*date/i, /availability/i, /when\s*can\s*you\s*start/i, /join/i, /how\s*soon.*join/i, /notice\b/i],
      value: candidate.notice_period || profile.candidate?.notice_period || "Immediately / 1 month"
    },
    {
      name: 'current_salary',
      regex: [/current\s*salary/i, /current\s*compensation/i, /current\s*pay/i, /previous\s*salary/i, /previous\s*compensation/i, /past\s*salary/i, /current\s*annual/i, /current\s*ctc/i, /present\s*ctc/i, /present\s*salary/i, /last\s*compensation/i, /last\s*salary/i],
      value: resolvedCurrentSalary
    },
    {
      name: 'salary_expectations',
      regex: [/^(?!.*(current|previous|past|present|last)).*(salary|compensation|expectation|pay|rate|ctc)/i, /desired\s*pay/i, /expected/i, /expected\s*ctc/i, /target\s*ctc/i],
      value: resolvedSalary
    },
    {
      name: 'years_experience',
      regex: [/total\s*experience/i, /years?\s*(of\s*)?experience/i, /how\s+many\s+years/i, /experience\s+\(.*years/i, /yoe\b/i],
      value: yoeText
    },
    {
      name: 'years_experience_numeric',
      regex: [/experience\s*in\s*years/i, /number\s*of\s*years/i, /years\s+of\s+exp\b/i],
      value: yoeDecimal
    },
    {
      name: 'referrer_name',
      regex: [/referrer\s*name/i, /referral/i],
      value: ''
    },
    {
      name: 'open_source_contributions',
      regex: [/open\s*source/i, /contributions/i, /projects/i],
      value: candidate.open_source_contributions || profile.candidate?.open_source_contributions || "Yes! I am a proud contributor to MDN Web Docs (Mozilla Developer Network) for JavaScript documentation. I also actively develop and maintain open-source developer tooling like career-ops, karada.ai, and go-common packages (which includes concurrent libraries, AST compilers, and slot allocation trackers)."
    },
    {
      name: 'fallback_why_n8n',
      regex: [/why.*n8n/i, /attention/i, /interest/i, /reasons.*applying/i, /caught.*attention/i],
      value: `I build developer tools and automation workflows. From creating custom Go CLI tools that saved Comcast developers an hour a day, to architecting real-time synchronization engines, my career has been about empowering other builders. n8n is the absolute gold standard for open-source workflow orchestration. With the rise of AI agents, n8n is perfectly positioned to be the execution layer of the modern AI stack. I want to bring my combination of startup velocity, enterprise scale, and AI-integration experience to n8n's product engineering team to build features that millions of builders rely on.`
    },
    {
      name: 'fallback_startup_experience',
      regex: [/startup/i, /start-up/i, /scale-up/i, /scaleup/i, /past.*companies/i],
      value: `ProPro Productions operated as an intensive 0-to-1 startup. As the Founding Engineer, I had extreme ownership and velocity. I architected the core real-time infinite canvas, implemented CRDTs, optimized rendering to 60 FPS using QuadTree spatial partitioning, and handled both frontend (React/custom canvas) and backend (Node.js/WebSockets). This environment required absolute comfort with technical ambiguity, fast execution, and a relentless focus on product value, which directly led to our successful acquisition.`
    },
    {
      name: 'fallback_largest_scale',
      regex: [/largest\s*scale/i, /scale\s*project/i, /data\s*volume/i, /traffic/i, /users/i],
      value: `The largest scale project I worked on was Comcast Xfinity during my tenure at Accenture, which serves over 3 million daily visits. We managed a complex monorepo with 16+ distinct services. The primary challenges as it grew were microfrontend routing synchronization, web performance budget, and accessibility compliance. To address these, I optimized the build pipeline, instrumented telemetry and error logging, and refined geolocation A/B user-flows, ensuring 99.9% uptime and a performance budget that scaled flawlessly under heavy load.`
    },
    {
      name: 'fallback_thrive',
      regex: [/thrive/i, /need.*from\s*us/i, /need.*to\s*thrive/i],
      value: `To thrive as an engineer, I need a high-trust culture that values autonomy, a transparent and ambitious product/engineering roadmap, clear ownership boundaries, and direct customer feedback loops. n8n's open-source ethos and ship-every-week cadence are exactly the type of environment where I do my best work.`
    },
    // Personality / Culture / Fun questions (from form_defaults.personality)
    {
      name: 'personality_junk_food',
      regex: [/junk\s*food/i, /favourite\s*food/i, /favorite\s*food/i, /comfort\s*food/i, /guilty\s*pleasure.*food/i],
      value: formDefaults.personality?.junk_food || ''
    },
    {
      name: 'personality_fun_fact',
      regex: [/fun\s*fact/i, /tell\s*us\s*something\s*(fun|interesting)/i, /something\s*unique/i, /something\s*(fun|interesting)\s*about\s*(you|yourself)/i],
      value: formDefaults.personality?.fun_fact || ''
    }
  ];

  // Define matcher configurations for choice elements (select / radio / custom dropdown)
  const choiceMatchers = [
    {
      name: 'pronouns',
      regex: [/pronoun/i],
      keywords: ['he', 'him', 'his'],
      fallback: 'He / Him'
    },
    {
      name: 'gender',
      regex: [/gender/i, /sex\b/i],
      keywords: formDefaults.gender ? [formDefaults.gender.toLowerCase(), 'male', 'man'] : ['male', 'man'],
      fallback: formDefaults.gender || 'Male'
    },
    {
      name: 'race',
      regex: [/race/i, /ethnicity/i],
      keywords: formDefaults.race_ethnicity_us_eeoc ? [formDefaults.race_ethnicity_us_eeoc.toLowerCase(), 'decline', 'not to self-identify'] : ['decline', 'not to self-identify', 'asian'],
      fallback: formDefaults.race_ethnicity_us_eeoc || 'Decline to self-identify'
    },
    {
      name: 'hispanic_latino',
      regex: [/hispanic/i, /latino/i, /are\s*you\s*hispanic/i],
      keywords: formDefaults.hispanic_latino ? [formDefaults.hispanic_latino.toLowerCase(), 'no', 'decline', "don't wish to answer"] : ['no', 'decline', "don't wish to answer", "i don't wish to answer"],
      fallback: formDefaults.hispanic_latino || "I don't wish to answer"
    },
    {
      name: 'veteran',
      regex: [/veteran/i],
      keywords: formDefaults.veteran_status ? [formDefaults.veteran_status.toLowerCase(), 'not a veteran', 'no', 'decline'] : ['not a veteran', 'no', 'decline'],
      fallback: formDefaults.veteran_status || 'I am not a veteran'
    },
    {
      name: 'disability',
      regex: [/disability/i],
      keywords: formDefaults.disability_status ? [formDefaults.disability_status.toLowerCase(), 'no', "don't have", 'decline'] : ['no', "don't have", 'decline'],
      fallback: formDefaults.disability_status || 'No, I don\'t have a disability'
    },
    {
      name: 'sf_onsite',
      regex: [/san francisco/i, /sf office/i, /onsite.*san francisco/i, /on-site.*san francisco/i, /relocate.*san francisco/i, /relocate.*sf/i],
      keywords: ['no', 'do not wish', 'not open'],
      fallback: 'No'
    },
    {
      name: 'authorized_to_work',
      regex: [/authorized\s*to\s*work/i, /legally\s*authorized/i, /eligible\s*to\s*work/i, /authorization/i],
      keywords: ['yes', 'authorized'],
      fallback: 'Yes'
    },
    {
      name: 'location',
      regex: [/location/i, /residence/i, /country/i, /city/i],
      keywords: [
        'bengaluru, india',
        'bangalore, india',
        candidate.location || '',
        'bengaluru',
        'bangalore',
        location.city || '',
        location.country || 'India',
        'india'
      ].filter(k => k),
      fallback: candidate.location || `${location.city}, ${location.country}` || "Bengaluru, India"
    },
    {
      name: 'visa_sponsorship',
      regex: [/sponsorship/i, /require\s*sponsorship/i, /sponsor\b/i, /need.*sponsor/i, /require.*visa/i],
      keywords: profile.location?.sponsorship_required === false ? ['no', 'do not require'] : ['yes', 'require'],
      fallback: profile.location?.sponsorship_required === false ? 'No' : 'Yes'
    },
    {
      name: 'privacy_confirmation',
      regex: [/privacy/i, /data\s*protection/i, /gdpr/i, /read\s*and\s*agree/i, /privacy\s*notice/i, /handling.*personal.*data/i],
      keywords: ['yes', 'confirm', 'i confirm', 'agree', 'i agree', 'accept'],
      fallback: 'Yes'
    },
    {
      name: 'truth_confirmation',
      regex: [/truth/i, /correct/i, /accurate/i, /information.*true/i, /false\s*statements/i],
      keywords: ['yes', 'confirm', 'i confirm', 'agree', 'i agree', 'accept'],
      fallback: 'Yes'
    },
    {
      name: 'preferred_contract_location',
      regex: [/location.*contract/i, /preferred.*location/i, /main.*location/i],
      keywords: ['Germany', 'Germany (Berlin)', 'germany', 'berlin'],
      fallback: 'Germany'
    },
    {
      name: 'jsts_frequency',
      regex: [/how\s*often\s*do\s*you.*javascript/i, /how\s*often\s*do\s*you.*typescript/i, /frequency.*js/i, /frequency.*ts/i, /javascript.*frequency/i, /typescript.*frequency/i, /frequency.*js\s*\/\s*ts/i, /frequency/i],
      keywords: ['Daily / almost daily', 'Daily', 'Almost daily', 'Frequently', 'Every day', 'Often'],
      fallback: 'Daily / almost daily'
    },
    {
      name: 'node_frequency',
      regex: [/how\s*often\s*do\s*you.*node/i, /frequency.*node/i, /node\.js.*frequency/i, /node/i],
      keywords: ['Daily / almost daily', 'Daily', 'Almost daily', 'Frequently', 'Every day', 'Often'],
      fallback: 'Daily / almost daily'
    },
    {
      name: 'vuereact_expertise',
      regex: [/expertise.*vue/i, /expertise.*react/i, /vue.*react.*expertise/i, /level.*react/i, /level.*vue/i, /proficiency.*vue/i, /proficiency.*react/i, /react.*vue/i],
      keywords: ['Expert', 'High', 'Highly proficient', 'Advanced', 'Strong', 'Proficient'],
      fallback: 'Expert'
    },
    {
      name: 'backend_involvement',
      regex: [/backend.*involvement/i, /involvement.*backend/i, /how\s*much\s*backend/i, /backend/i],
      keywords: ['Fullstack/heavy involvement', 'Heavy', 'Fullstack', 'Deep involvement', 'High'],
      fallback: 'Fullstack/heavy involvement'
    },
    {
      name: 'go_ts_proficiency',
      regex: [/proficiency\s*in\s*go/i, /go\s*and\s*typescript/i, /languages?\s*proficiency/i],
      keywords: ['confident and productive', 'both, strong', 'proficient in both'],
      fallback: 'Both, strong'
    },
    {
      name: 'auth_experience',
      regex: [/auth\s*system/i, /authentication\s*system/i, /experience.*auth/i],
      keywords: ['solid experience', 'deep experience', 'some exposure'],
      fallback: 'Solid experience'
    },
    {
      name: 'web_framework_paradigms',
      regex: [/framework\s*paradigm/i, /web\s*framework/i, /paradigms/i],
      keywords: ['cross-paradigm', 'meaningful experience with both', 'cross paradigm'],
      fallback: 'Cross-paradigm'
    },
    // --- Binary Yes/No heuristics for common logistics questions ---
    {
      name: 'office_attendance',
      regex: [/work\s*from\s*(the\s*)?(office|bengaluru|bangalore|berlin|london|new\s*york|sf|san\s*francisco)/i, /days?\s*(a|per)\s*week/i, /on[\s-]*site/i, /in[\s-]*office/i, /commute\s*to/i, /hybrid/i],
      keywords: ['yes'],
      fallback: 'Yes'
    },
    {
      name: 'travel_comfort',
      regex: [/comfortable\s*travel/i, /travel\s*(onsite|on-site|on\s*site)/i, /willing\s*to\s*travel/i, /travel\s*required/i, /travel.*customer/i, /travel.*percent/i],
      keywords: ['yes'],
      fallback: 'Yes'
    },
    {
      name: 'attending_college',
      regex: [/currently\s*(attending|enrolled|in)\s*(college|university|school)/i, /are\s*you\s*a\s*student/i, /full[\s-]*time\s*student/i],
      keywords: ['no'],
      fallback: 'No'
    },
    {
      name: 'relocation_willing',
      regex: [/willing\s*to\s*relocate/i, /open\s*to\s*relocation/i, /relocate\s*to/i, /move\s*to/i],
      keywords: ['yes', 'open to relocation'],
      fallback: 'Yes'
    },
    {
      name: 'age_18_plus',
      regex: [/18\s*years?\s*(of\s*age|or\s*older|old)/i, /legally\s*of\s*age/i, /at\s*least\s*18/i, /over\s*18/i],
      keywords: ['yes'],
      fallback: 'Yes'
    },
    {
      name: 'criminal_background',
      regex: [/criminal\s*(history|record|background|conviction)/i, /felony/i, /misdemeanor/i, /arrested/i],
      keywords: ['no'],
      fallback: 'No'
    },
    {
      name: 'source',
      regex: [/hear\s*about/i, /source/i, /find\s*us/i, /how\s*did\s*you\s*hear/i],
      keywords: ['linkedin', 'x/twitter', 'google', 'other'],
      fallback: 'Linkedin'
    },
    {
      name: 'work_from_london',
      regex: [/work\s*from\s*london/i, /relocate\s*to\s*london/i, /london\s*office/i, /able\s*to\s*work\s*from/i],
      keywords: ['open to relocation', 'relocation', 'relocate', 'yes'],
      fallback: 'Yes, and while I do not currently live in the London area, I am open to relocation.'
    },
    {
      name: 'metaview_consent',
      regex: [/metaview/i, /transcribe\s*all\s*your\s*interviews/i, /recording\s*interviews/i],
      keywords: ['yes', 'agree', 'allow'],
      fallback: 'Yes'
    },
    {
      name: 'transgender',
      regex: [/transgender/i],
      keywords: ['no', 'prefer not to answer', 'decline'],
      fallback: 'No'
    },
    {
      name: 'age',
      regex: [/current\s*age/i, /age\s*group/i, /your\s*age/i],
      keywords: ['under 30', '18-24', '21-29', '20-29', 'prefer not to say', 'prefer not to answer'],
      fallback: 'Under 30'
    }
  ];

  function resolveChoiceParams(matcher, label) {
    let keywords = matcher.keywords;
    let fallback = matcher.fallback;
    
    if (matcher.name === 'authorized_to_work') {
      const labelLower = label.toLowerCase();
      // If label mentions a foreign country/region (not India), the Indian candidate does not have legal authorization.
      const foreignCountries = ['united kingdom', ' uk ', '\buk\b', 'united states', ' us ', '\bus\b', 'usa', 'europe', 'eu', 'germany', 'berlin', 'france', 'paris', 'canada', 'london'];
      const isForeign = foreignCountries.some(c => labelLower.includes(c));
      if (isForeign) {
        keywords = ['no', 'not authorized', 'not legally'];
        fallback = 'No';
      } else if (labelLower.includes('india')) {
        keywords = ['yes', 'authorized', 'legally'];
        fallback = 'Yes';
      } else {
        // Safe default: yes if it is an India role, otherwise no
        if (isIndia) {
          keywords = ['yes', 'authorized', 'legally'];
          fallback = 'Yes';
        } else {
          keywords = ['no', 'not authorized'];
          fallback = 'No';
        }
      }
    } else if (matcher.name === 'visa_sponsorship') {
      const labelLower = label.toLowerCase();
      if (labelLower.includes('india') || isIndia) {
        keywords = ['no', 'do not require', 'not require'];
        fallback = 'No';
      } else {
        keywords = ['yes', 'require', 'will require'];
        fallback = 'Yes';
      }
    } else if (matcher.name === 'location') {
      const labelLower = label.toLowerCase();
      // Country-only fields: "Country", "Country of Residence", "Country of Origin"
      const isCountryOnly = /\bcountry\b/i.test(labelLower) && !/city/i.test(labelLower) && !/location/i.test(labelLower);
      if (isCountryOnly) {
        keywords = [
          location.country || 'India',
          'india'
        ];
        fallback = location.country || 'India';
      }
      // City-only fields: "City", "What city do you live in?"
      const isCityOnly = /\bcity\b/i.test(labelLower) && !/country/i.test(labelLower);
      if (isCityOnly) {
        keywords = [
          location.city || 'Bengaluru',
          'bangalore',
          'bengaluru'
        ];
        fallback = location.city || 'Bengaluru';
      }
    } else if (matcher.name === 'age') {
      const userAge = candidate.age || 24;
      if (userAge < 30) {
        keywords = ['under 30', '18-24', '21-29', '20-29', 'prefer not to say', 'prefer not to answer'];
        fallback = 'Under 30';
      } else if (userAge >= 30 && userAge < 40) {
        keywords = ['30-39', '25-34', 'prefer not to say', 'prefer not to answer'];
        fallback = '30-39';
      }
    }
    
    return { keywords, fallback };
  }

  // 1. Fill Text and Textarea Inputs
  for (const input of domLayout.inputs) {
    if (input.type === 'file') {
      // Robust Resume Upload: Check labelText, id, and name attributes while excluding cover letters
      const labelLower = (input.labelText || '').toLowerCase();
      const idLower = (input.id || '').toLowerCase();
      const nameLower = (input.name || '').toLowerCase();
      
      const isResume = (
        labelLower.includes('resume') || 
        labelLower.includes('cv') || 
        labelLower.includes('curriculum') ||
        idLower.includes('resume') ||
        idLower.includes('cv') ||
        nameLower.includes('resume') ||
        nameLower.includes('cv')
      ) && !idLower.includes('cover') && !nameLower.includes('cover') && !labelLower.includes('cover');

      const isCoverLetter = labelLower.includes('cover') || idLower.includes('cover') || nameLower.includes('cover');

      if (resumePath && isResume) {
        try {
          await targetFrame.locator(input.selector).nth(input.index).setInputFiles(resumePath);
          logs.push(`Uploaded resume PDF to file field (Label: "${input.labelText}", ID: "${input.id}")`);
        } catch (e) {
          logs.push(`⚠️ Resume upload failed for label "${input.labelText}" (ID: "${input.id}"): ${e.message}`);
        }
      } else if (isCoverLetter) {
        const coverAns = customAnswers.find(ans => ans.question.toLowerCase().includes('cover'));
        if (coverAns) {
          try {
            let letterText = coverAns.answer;
            if (letterText.includes('```')) {
              letterText = letterText.replace(/```[a-z]*\n?/gi, '').trim();
            }
            
            const tempLetterPath = `/tmp/cover-letter-${app.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
            writeFileSync(tempLetterPath, letterText, 'utf-8');
            
            await targetFrame.locator(input.selector).nth(input.index).setInputFiles(tempLetterPath);
            logs.push(`Uploaded generated Cover Letter to file field (Label: "${input.labelText}", ID: "${input.id}")`);
          } catch (e) {
            logs.push(`⚠️ Cover letter upload failed for label "${input.labelText}" (ID: "${input.id}"): ${e.message}`);
          }
        }
      }
      continue;
    }

    let filled = false;

    // A. Match custom Section H Answers (Primary, tailored role answers)
    const labelText = input.labelText || '';
    
    // Scan for external form links in the field label (Suggestion 009)
    let externalFormUrl = null;
    if (labelText && (labelText.includes('typeform.com') || labelText.includes('tally.so') || labelText.includes('forms.gle') || labelText.includes('forms.office.com'))) {
      const urlMatch = labelText.match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch) {
        externalFormUrl = urlMatch[0];
      }
    }
    if (externalFormUrl) {
      console.log(`\n${colors.yellow}⚠️ WARNING: External form required in field "${input.labelText}": ${externalFormUrl}${colors.reset}`);
      console.log(`${colors.cyan}Please complete this external form manually before submitting.${colors.reset}\n`);
      logs.push(`⚠️ External form required: ${externalFormUrl} (Label: "${input.labelText}"). Skipped auto-fill.`);
      app.externalFormRequired = externalFormUrl;
      continue;
    }
    const STANDARD_FIELD_BLOCKLIST = [
      'email', 'full name', 'name', 'phone', 'linkedin', 'twitter',
      'github', 'portfolio', 'resume', 'current location', 'current company',
      'salary', 'compensation', 'expectation', 'pay', 'ctc', 'notice period', 'start date', 'availability', 'how soon can you join', 'how soon can you start',
      'address', 'city', 'province', 'state', 'postal', 'zip', 'country'
    ];
    const isStandardField = STANDARD_FIELD_BLOCKLIST.some(b => labelText.toLowerCase().includes(b));
    const isNumberInput = input.type === 'number';
    const customAns = !isStandardField && !isNumberInput ? matchCustomAnswer(input.labelText, customAnswers, input) : null;
    if (customAns) {
      try {
        const loc = targetFrame.locator(input.selector).nth(input.index);
        await loc.fill(customAns.answer);
        await loc.dispatchEvent('input', { bubbles: true });
        await loc.dispatchEvent('change', { bubbles: true });
        logs.push(`Fuzzily matched Section H question & filled custom field:\n     "${input.labelText}" -> "${customAns.answer.substring(0, 50)}..."`);
        filled = true;
      } catch (e) {
        logs.push(`⚠️ Failed to fill Section H answer for "${input.labelText}": ${e.message}`);
      }
    }

    if (filled) continue;

    // B. Match standard text profile fields and general fallbacks
    for (const matcher of textMatchers) {
      if (fuzzyLabelMatch(input.labelText, matcher.regex)) {
        // Guard against keyword collision for short/structured values in textareas or long labels (essay questions)
        const isEssayQuestion = input.type === 'textarea' || (input.labelText.length > 70 && matcher.name !== 'salary_expectations' && matcher.name !== 'notice_period');
        const isShortStructuredMatcher = [
          'full_name', 'first_name', 'last_name', 'email', 'phone',
          'linkedin', 'github', 'twitter', 'portfolio', 'salary_expectations',
          'current_location', 'passport_country', 'residence_country', 'notice_period',
          'address_line', 'address_line2', 'city_field', 'state_field', 'postal_field'
        ].includes(matcher.name);
        
        if (isEssayQuestion && isShortStructuredMatcher) {
          // Skip mapping short structured data to long essay textareas/questions
          continue;
        }

        // Additional guard for residence_country: avoid matching clearance or passport/visa questions
        if (matcher.name === 'residence_country') {
          const lowerLabel = input.labelText.toLowerCase();
          if (lowerLabel.includes('clearance') || lowerLabel.includes('visa') || lowerLabel.includes('sponsor') || lowerLabel.includes('passport') || lowerLabel.includes('citizen')) {
            continue;
          }
        }

        if (matcher.value !== undefined && matcher.value !== null) {
          try {
            const loc = targetFrame.locator(input.selector).nth(input.index);
            if (input.type === 'number') {
              const numVal = parseFloat(matcher.value);
              if (!isNaN(numVal)) {
                await loc.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(numVal));
                logs.push(`Filled number input "${input.labelText}" with: ${numVal}`);
                filled = true;
              }
            } else {
              await loc.fill(matcher.value);
              await loc.dispatchEvent('input', { bubbles: true });
              await loc.dispatchEvent('change', { bubbles: true });
              logs.push(`Filled "${input.labelText}" with: "${matcher.value.length > 50 ? matcher.value.substring(0, 50) + '...' : matcher.value}"`);
              filled = true;
            }
          } catch (e) {
            // fallback
          }
        }
        break;
      }
    }
  }

  // Direct Resume Upload Fallback (Greenhouse / Ashby drag-and-drop hidden input fallback)
  if (resumePath) {
    try {
      // Look for inputs of type file with name or id containing "resume" or "cv" case-insensitively
      const hiddenResumeInput = await targetFrame.$('input[type="file"][name="resume"], input[type="file"][id="resume"], input[type="file"][id*="resume" i], input[type="file"][name*="resume" i], input[type="file"][id*="cv" i], input[type="file"][name*="cv" i]');
      if (hiddenResumeInput) {
        await hiddenResumeInput.setInputFiles(resumePath);
        logs.push(`Uploaded resume PDF via direct file-input fallback`);
      }
    } catch (e) {
      logs.push(`⚠️ Direct resume upload fallback failed: ${e.message}`);
    }
  }

  // 2. Fill standard selects
  for (const select of domLayout.selects) {
    let filled = false;
    for (const matcher of choiceMatchers) {
      if (fuzzyLabelMatch(select.labelText, matcher.regex)) {
        const { keywords, fallback } = resolveChoiceParams(matcher, select.labelText);
        const bestOpt = findBestOption(select.options, keywords, fallback);
        if (bestOpt) {
          try {
            const loc = targetFrame.locator(select.selector).nth(select.index);
            await loc.selectOption(bestOpt.value, { force: true });
            await loc.dispatchEvent('change', { bubbles: true });
            logs.push(`Selected dropdown option "${bestOpt.text}" for label "${select.labelText}"`);
          } catch (e) {
            // Fallback: set it in-browser
            try {
              await targetFrame.evaluate(({ selector, index, value }) => {
                const el = document.querySelectorAll(selector)[index];
                if (el) {
                  el.value = value;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, { selector: select.selector, index: select.index, value: bestOpt.value });
              logs.push(`Selected dropdown option "${bestOpt.text}" for label "${select.labelText}" (in-browser fallback)`);
            } catch (browserErr) {
              logs.push(`⚠️ Failed to select option for "${select.labelText}": ${e.message}`);
            }
          }
        }
        filled = true;
        break;
      }
    }
    if (!filled) {
      // Source/Referral fallback for unmatched dropdowns
      const isSource = !select.labelText || /source/i.test(select.labelText) || /hear\s*about/i.test(select.labelText) || /how\s*did\s*you/i.test(select.labelText);
      if (isSource) {
        const sourceKeywords = ['linkedin', 'job board', 'indeed', 'glassdoor', 'website', 'referral'];
        const bestOpt = findBestOption(select.options, sourceKeywords, 'LinkedIn');
        if (bestOpt) {
          try {
            const loc = targetFrame.locator(select.selector).nth(select.index);
            await loc.selectOption(bestOpt.value, { force: true });
            await loc.dispatchEvent('change', { bubbles: true });
            logs.push(`Selected dropdown option "${bestOpt.text}" for source/referral label "${select.labelText}" (fallback)`);
          } catch (e) {
            try {
              await targetFrame.evaluate(({ selector, index, value }) => {
                const el = document.querySelectorAll(selector)[index];
                if (el) {
                  el.value = value;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, { selector: select.selector, index: select.index, value: bestOpt.value });
              logs.push(`Selected dropdown option "${bestOpt.text}" for source/referral label "${select.labelText}" (in-browser fallback fallback)`);
            } catch (err) {}
          }
        }
      }
    }
  }

  // 3. Fill Custom Dropdowns (comboboxes / react-select etc.)
  for (const dropdown of domLayout.customDropdowns) {
    try {
      // Skip unlabeled phone country selector (Greenhouse): cosmetic, auto-set by phone prefix (+91 etc.)
      if (dropdown.labelText === '' && dropdown.id === '') {
        const hasFilledPhone = await targetFrame.evaluate(() => {
          const tel = document.querySelector('input[type="tel"]');
          return tel && tel.value && tel.value.includes('+');
        });
        if (hasFilledPhone) {
          logs.push(`[Greenhouse] Skipping unlabeled phone country selector (auto-set by prefix)`);
          continue;
        }
      }
      // Open custom dropdown
      const locator = targetFrame.locator(dropdown.selector).nth(dropdown.index);
      if (await locator.count() === 0 || !(await locator.isVisible())) {
        logs.push(`⚠️ Dropdown element is not visible or no longer exists: "${dropdown.labelText}"`);
        continue;
      }
      const isInput = await locator.evaluate(el => el.tagName.toLowerCase() === 'input');
      if (isInput) {
        const hasControl = await locator.evaluate(el => !!el.closest('.select__control, .select-control, [class*="control"]'));
        if (hasControl) {
          await locator.evaluate(el => {
            const ctrl = el.closest('.select__control, .select-control, [class*="control"]');
            if (ctrl) ctrl.click();
          });
        } else {
          await locator.evaluate(el => el.parentElement?.click());
        }
      } else {
        try {
          // Shorter timeout to avoid hanging if the element is not stable in Playwright's strict model
          await locator.click({ timeout: 5000 });
        } catch (clickErr) {
          // Direct DOM-level fallback click
          await locator.evaluate(el => el.click());
        }
      }
      await delay(500);

      // Match targets and resolve parameters
      let matcher = null;
      for (const m of choiceMatchers) {
        if (fuzzyLabelMatch(dropdown.labelText, m.regex)) {
          matcher = m;
          break;
        }
      }

      const dropdownLabel = dropdown.labelText || '';
      const STANDARD_FIELD_BLOCKLIST = [
        'email', 'full name', 'name', 'phone', 'linkedin', 'twitter',
        'github', 'portfolio', 'resume', 'current location', 'current company',
        'salary', 'compensation', 'expectation', 'pay', 'ctc', 'notice period', 'start date', 'availability', 'how soon can you join', 'how soon can you start',
        'address', 'city', 'province', 'state', 'postal', 'zip', 'country'
      ];
      const isStandardDropdown = STANDARD_FIELD_BLOCKLIST.some(b => dropdownLabel.toLowerCase().includes(b));
      const customAns = !isStandardDropdown ? matchCustomAnswer(dropdown.labelText, customAnswers, dropdown) : null;

      // Determine a search term if we need to filter the dropdown list
      let searchTerm = null;
      if (matcher) {
        const { keywords, fallback } = resolveChoiceParams(matcher, dropdown.labelText);
        searchTerm = fallback || keywords[0];
      } else if (customAns) {
        if (/timezone/i.test(dropdown.labelText) || /timezone/i.test(customAns.question)) {
          const tzAbbrs = ['IST', 'EST', 'PST', 'GMT', 'CET', 'EET', 'UTC', 'MST', 'CST', 'AST', 'JST', 'KST', 'AEST', 'AWST', 'NZST'];
          const found = tzAbbrs.find(abbr => new RegExp(`\\b${abbr}\\b`, 'i').test(customAns.answer));
          if (found) {
            searchTerm = found;
          } else {
            const m = customAns.answer.match(/(?:UTC|GMT)?\s*([+-]\d{1,2}(?::\d{2})?)/i);
            if (m) searchTerm = m[1];
          }
        } else if (/country/i.test(dropdown.labelText) || /residence/i.test(dropdown.labelText)) {
          searchTerm = location.country || 'India';
        } else {
          searchTerm = customAns.answer.slice(0, 15);
        }
      }

      // Type search term if present to filter options (e.g. for virtualized lists)
      if (searchTerm) {
        let searchInput = null;
        if (isInput) {
          searchInput = locator;
        } else {
          const scopedSelector = [
            `${dropdown.selector} input`,
            `${dropdown.selector} input[class*="-input"]`,
            `${dropdown.selector} input[role="combobox"]`,
            `[id="${dropdown.id}"] input`
          ].join(', ');
          
          const candidates = targetFrame.locator(scopedSelector);
          if (await candidates.count() > 0 && await candidates.first().isVisible()) {
            searchInput = candidates.first();
          } else {
            const parentInput = locator.locator('xpath=..//input');
            if (await parentInput.count() > 0 && await parentInput.first().isVisible()) {
              searchInput = parentInput.first();
            }
          }
        }

        if (searchInput && await searchInput.isVisible()) {
          await searchInput.fill(searchTerm);
          const isLocationSearch = /location|city|country/i.test(dropdown.labelText);
          await delay(isLocationSearch ? 2000 : 500); // Wait for filtering
        } else {
          try {
            // Try focused element typing as backup
            await page.keyboard.type(searchTerm);
            const isLocationSearch = /location|city|country/i.test(dropdown.labelText);
            await delay(isLocationSearch ? 2000 : 500);
          } catch (kbdErr) {
            // ignore
          }
        }
      }

      // Read options from DOM
      const getOptions = async () => {
        return await targetFrame.evaluate(() => {
          const selectors = [
            '[class*="select__option"]',
            '[class*="-option"]',
            '[role="option"]',
            'div[id*="-listbox"] div',
            'div[class*="option"]'
          ];
          const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          
          // Find active visible listboxes/dropdown menus
          const menuContainers = Array.from(document.querySelectorAll('[role="listbox"], [class*="menu"], [class*="listbox"], [class*="-menu"]'))
            .filter(isVisible);

          for (const sel of selectors) {
            let elms = [];
            if (menuContainers.length > 0) {
              for (const menu of menuContainers) {
                const found = Array.from(menu.querySelectorAll(sel)).filter(isVisible);
                if (found.length > 0) {
                  elms = found;
                  break;
                }
              }
            }
            if (elms.length === 0) {
              elms = Array.from(document.querySelectorAll(sel)).filter(isVisible);
            }
            if (elms.length > 0) {
              return elms.map((el, idx) => ({
                text: (el.innerText || el.textContent || '').trim(),
                id: el.id || '',
                selector: `${sel}:nth-child(${idx + 1})`
              }));
            }
          }
          return [];
        });
      };

      let options = await getOptions();

      // Matching options helper
      const findMatchInOptions = (opts) => {
        let opt = null;
        let method = null;
        
        // A. ChoiceMatchers
        if (matcher) {
          const { keywords, fallback } = resolveChoiceParams(matcher, dropdown.labelText);
          opt = findBestOption(opts, keywords, fallback);
          if (opt) method = `standard choice matcher "${matcher.name}"`;
        }
        
        // B. Custom Answers (Block H)
        if (!opt && customAns) {
          if (/timezone/i.test(dropdown.labelText) || /timezone/i.test(customAns.question)) {
            opt = matchTimezoneOption(opts, customAns.answer);
            if (opt) method = `Block H timezone match`;
          }
          if (!opt) {
            opt = matchYesNoOption(opts, customAns.answer);
            if (opt) method = `Block H Yes/No match`;
          }
          if (!opt) {
            opt = findBestOption(opts, [customAns.answer], customAns.answer);
            if (opt) method = `Block H fuzzy match`;
          }
        }
        
        // C. Demographic/EEOC
        if (!opt) {
          const isDemographic = !dropdown.labelText || 
            /gender/i.test(dropdown.labelText) ||
            /race/i.test(dropdown.labelText) ||
            /ethnic/i.test(dropdown.labelText) ||
            /veteran/i.test(dropdown.labelText) ||
            /disability/i.test(dropdown.labelText) ||
            /eeoc/i.test(dropdown.labelText) ||
            /demographic/i.test(dropdown.labelText) ||
            /voluntary/i.test(dropdown.labelText);

          if (isDemographic) {
            const declineKeywords = [
              'decline to self-identify',
              'decline to state',
              "don't wish to answer",
              "do not wish to answer",
              'prefer not to say',
              'prefer not to answer',
              'decline',
              'choose not to identify',
              'choose not to disclose'
            ];
            
            for (const keyword of declineKeywords) {
              opt = opts.find(o => o.text.toLowerCase().includes(keyword));
              if (opt) {
                method = `EEOC/Demographic default`;
                break;
              }
            }
          }
        }

        // D. Country
        if (!opt) {
          const isCountryList = opts.some(o => {
            const t = o.text.toLowerCase();
            return t === 'india' || t === 'united states' || t === 'canada' || t === 'germany' || t === 'united kingdom';
          });
          
          if (isCountryList) {
            const targetCountry = (location.country || 'India').toLowerCase();
            const exactOpt = opts.find(o => o.text.toLowerCase().trim() === targetCountry);
            if (exactOpt) {
              opt = exactOpt;
              method = `Country dropdown exact default`;
            } else {
              opt = opts.find(o => {
                const textLower = o.text.toLowerCase();
                if (targetCountry === 'india' && textLower.includes('british')) return false;
                return textLower.includes(targetCountry) || targetCountry.includes(textLower);
              });
              if (opt) {
                method = `Country dropdown default`;
              }
            }
          }
        }

        // E. form_defaults keyword match (Suggestion 009)
        if (!opt && Object.keys(formDefaults).length > 0) {
          const labelLower = (dropdown.labelText || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
          const labelWords = labelLower.split(/\s+/).filter(w => w.length >= 1);
          
          for (const [key, value] of Object.entries(formDefaults)) {
            if (typeof value !== 'string') continue; // skip nested objects like personality
            const baseKeyWords = key.toLowerCase().split('_');
            
            let isMatch = false;
            if (baseKeyWords.length >= 2) {
              const sigWords = baseKeyWords.filter(w => w.length >= 2);
              isMatch = sigWords.length > 0 && sigWords.every(kw => labelWords.some(lw => lw.includes(kw) || kw.includes(lw)));
            } else if (baseKeyWords.length === 1) {
              const singleKey = baseKeyWords[0];
              isMatch = labelWords.some(lw => lw === singleKey);
            }

            if (isMatch) {
              // Try to find matching option
              const defaultOpt = findBestOption(opts, [value], value);
              if (defaultOpt) {
                opt = defaultOpt;
                method = `form_defaults[${key}]`;
                break;
              }
            }
          }
        }

        // F. Source/Referral fallback for unmatched dropdowns
        if (!opt) {
          const isSource = !dropdown.labelText || /source/i.test(dropdown.labelText) || /hear\s*about/i.test(dropdown.labelText) || /how\s*did\s*you/i.test(dropdown.labelText);
          if (isSource) {
            const sourceKeywords = ['linkedin', 'job board', 'indeed', 'glassdoor', 'website', 'referral'];
            opt = findBestOption(opts, sourceKeywords, 'LinkedIn');
            if (opt) method = `Source/Referral default`;
          }
        }

        return opt ? { opt, method } : null;
      };

      let matchResult = findMatchInOptions(options);

      // If we couldn't find a match, try typing country or custom answers as backup (in case the options list was lazy-loaded or virtualized and typing is required to load options)
      if (!matchResult && !searchTerm && (customAns || /country/i.test(dropdown.labelText) || /residence/i.test(dropdown.labelText))) {
        let backupSearchTerm = '';
        if (customAns) {
          backupSearchTerm = customAns.answer.slice(0, 15);
        } else {
          backupSearchTerm = location.country || 'India';
        }

        let searchInput = null;
        if (isInput) {
          searchInput = locator;
        } else {
          const scopedSelector = [
            `${dropdown.selector} input`,
            `${dropdown.selector} input[class*="-input"]`,
            `${dropdown.selector} input[role="combobox"]`,
            `[id="${dropdown.id}"] input`
          ].join(', ');
          
          const candidates = targetFrame.locator(scopedSelector);
          if (await candidates.count() > 0 && await candidates.first().isVisible()) {
            searchInput = candidates.first();
          }
        }

        if (searchInput && await searchInput.isVisible()) {
          await searchInput.fill(backupSearchTerm);
          await delay(500);
          options = await getOptions();
          matchResult = findMatchInOptions(options);
        }
      }

      if (matchResult) {
        const { opt: bestOpt, method: matchedBy } = matchResult;
        try {
          // Blur active element first so ArrowDown/enter events from comboboxes don't leak into previously focused text inputs
          await targetFrame.evaluate(() => document.activeElement?.blur()).catch(() => {});

          // 300px viewport scroll offset so dropdown menus opening upward or downward have plenty of room
          await targetFrame.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              const rect = el.getBoundingClientRect();
              const targetY = Math.max(0, window.scrollY + rect.top - 300);
              window.scrollTo({ top: targetY, behavior: 'instant' });
            }
          }, dropdown.selector).catch(() => {});
          
          const success = await targetFrame.evaluate(({ optId, optText, selector }) => {
            let el = null;
            if (optId) {
              el = document.getElementById(optId) || document.querySelector(`[name="${optId}"]`) || document.querySelector(`[name*="${optId}"]`);
            }
            if (!el) {
              const elements = Array.from(document.querySelectorAll(selector));
              el = elements.find(e => (e.innerText || e.textContent || '').trim() === optText);
            }
            if (!el) {
              const selectors = [
                '[class*="select__option"]',
                '[class*="-option"]',
                '[role="option"]',
                'div[id*="-listbox"] div',
                'div[class*="option"]'
              ];
              for (const sel of selectors) {
                const elms = Array.from(document.querySelectorAll(sel));
                el = elms.find(e => (e.innerText || e.textContent || '').trim() === optText);
                if (el) break;
              }
            }
            if (el) {
              el.click();
              return true;
            }
            return false;
          }, { optId: bestOpt.id, optText: bestOpt.text, selector: bestOpt.selector });
          
          if (success) {
            logs.push(`Selected custom dropdown option "${bestOpt.text}" for label "${dropdown.labelText}" via ${matchedBy}`);
          } else {
            // Playwright fallback click
            const optionSelector = `[class*="select__option"], [class*="-option"], [role="option"], div[id*="-listbox"] div, div[class*="option"]`;
            await targetFrame.locator(optionSelector).filter({ hasText: bestOpt.text }).first().click();
            logs.push(`Selected custom dropdown option "${bestOpt.text}" for label "${dropdown.labelText}" via ${matchedBy} (Playwright fallback)`);
          }

          // Conditional Escape key press: only press Escape if menu portal remains open
          const menuOpen = await targetFrame.evaluate(() => !!document.querySelector('[class*="select__menu"], [class*="-menu"], [role="listbox"]')).catch(() => false);
          if (menuOpen) {
            await page.keyboard.press('Escape').catch(() => {});
          }

          // Verify-after-fill check: read singleValue text
          const filledVal = await targetFrame.evaluate((sel) => {
            const container = document.querySelector(sel);
            return container?.closest('[class*="container"]')?.querySelector('[class*="singleValue"], [class*="single-value"]')?.textContent || '';
          }, dropdown.selector).catch(() => '');
          if (filledVal) {
            logs.push(`Verified singleValue display for "${dropdown.labelText}": "${filledVal.trim()}"`);
          }
        } catch (clickErr) {
          // Direct locator fallback
          const optionSelector = `[class*="select__option"], [class*="-option"], [role="option"], div[id*="-listbox"] div, div[class*="option"]`;
          await targetFrame.locator(optionSelector).filter({ hasText: bestOpt.text }).first().click();
          logs.push(`Selected custom dropdown option "${bestOpt.text}" for label "${dropdown.labelText}" via ${matchedBy} (Playwright fallback catch)`);
        }

        // React State Verification check (React Fiber traversal)
        try {
          const reactVal = await targetFrame.evaluate(({ selector, index }) => {
            const el = document.querySelectorAll(selector)[index];
            if (!el) return null;
            const input = el.querySelector('input') || el;
            const key = Object.keys(input || {}).find(k => k.startsWith('__reactFiber'));
            let fiber = input?.[key];
            while (fiber) {
              if (fiber.memoizedState?.value) return fiber.memoizedState.value;
              if (fiber.memoizedProps?.value) return fiber.memoizedProps.value;
              fiber = fiber.return;
            }
            return null;
          }, { selector: dropdown.selector, index: dropdown.index });
          if (reactVal) {
            logs.push(`Verified React select state for label "${dropdown.labelText}": ${JSON.stringify(reactVal)}`);
          }
        } catch (reactErr) {
          // Ignore
        }
      } else {
        // Close dropdown safely by clicking the control again
        if (isInput) {
          await locator.evaluate(el => {
            const ctrl = el.closest('.select__control, .select-control, [class*="control"]');
            if (ctrl) ctrl.click();
          });
        } else {
          try {
            await locator.click({ timeout: 2000 });
          } catch (err) {
            await locator.evaluate(el => el.click());
          }
        }
        logs.push(`⚠️ No matching option found for custom dropdown: "${dropdown.labelText}"`);
      }
    } catch (e) {
      logs.push(`⚠️ Custom dropdown selection failed for "${dropdown.labelText}": ${e.message}`);
    }
  }

  // 4. Fill Checkboxes
  for (const cb of domLayout.checkboxes) {
    let checked = false;
    
    // A. Match required consent checkboxes (privacy, terms, accuracy)
    const consentRegex = [/privacy/i, /consent/i, /agree/i, /terms/i, /policy/i, /acknowledge/i, /data\s*processing/i, /gdpr/i, /statement/i, /declaration/i];
    if (fuzzyLabelMatch(cb.labelText, consentRegex)) {
      checked = true;
    }
    
    // B. Match work authorization & visa sponsorship checkboxes with mutual exclusivity
    const visaAuthRegex = [/authorized\s*to\s*work/i, /legally\s*authorized/i, /work\s*authorization/i, /sponsorship/i, /require.*visa/i, /visa.*sponsor/i, /eligible\s*to\s*work/i, /right\s*to\s*work/i, /work\s*permit/i];
    if (fuzzyLabelMatch(cb.labelText, visaAuthRegex)) {
      const lbl = cb.labelText.toLowerCase();
      // Detect if the label mentions a specific foreign country
      const foreignCountries = ['united states', ' us ', 'usa', 'united kingdom', ' uk ', 'europe', 'eu ', 'germany', 'france', 'canada', 'australia', 'singapore', 'japan', 'netherlands', 'london', 'berlin'];
      const mentionsForeign = foreignCountries.some(c => lbl.includes(c));
      const mentionsIndia = lbl.includes('india');
      // Detect if the label is a negative statement
      const isNegative = /\bnot\b|\bdon'?t\b|\bdo not\b|\bwithout\b|\bno\b.*\brequir/i.test(lbl);
      
      if (/sponsor/i.test(lbl) || /require.*visa/i.test(lbl) || /visa.*sponsor/i.test(lbl)) {
        // Sponsorship questions: Indian candidate applying abroad DOES require sponsorship
        if (mentionsIndia) {
          // "Do you require visa sponsorship to work in India?" → No
          checked = isNegative ? true : false;
        } else {
          // "Do you require visa sponsorship?" / "Will you require sponsorship?" → Yes
          // "I do NOT require sponsorship" → Don't check
          checked = isNegative ? false : true;
        }
      } else {
        // Authorization questions: "Are you authorized to work in X?"
        if (mentionsIndia) {
          // "Authorized to work in India?" → Yes (check affirmative, skip negative)
          checked = isNegative ? false : true;
        } else if (mentionsForeign) {
          // "Authorized to work in US?" → No (check negative, skip affirmative)
          checked = isNegative ? true : false;
        } else {
          // Generic "authorized to work" with no country → conservative No
          checked = isNegative ? true : false;
        }
      }
      if (checked) {
        logs.push(`Checked visa/auth checkbox (Label: "${cb.labelText}") [negative=${isNegative}, foreign=${mentionsForeign}, india=${mentionsIndia}]`);
      } else {
        logs.push(`Skipped visa/auth checkbox (Label: "${cb.labelText}") [negative=${isNegative}, foreign=${mentionsForeign}, india=${mentionsIndia}]`);
      }
    }

    // D. Match prefer not to answer for demographic/diversity checklists
    const preferNotToAnswerRegex = [/prefer\s*not\s*to\s*answer/i, /decline\s*to\s*state/i, /decline\s*to\s*say/i, /prefer\s*not\s*to\s*disclose/i];
    if (fuzzyLabelMatch(cb.labelText, preferNotToAnswerRegex)) {
      checked = true;
      logs.push(`Checked demographic fallback checkbox (Label: "${cb.labelText}")`);
    }

    // E. Match previous employment fake radio checkboxes
    if (/previously\s*(employed|worked|associated)/i.test(cb.labelText)) {
      if (/\bno\b/i.test(cb.labelText) || cb.labelText.toLowerCase().endsWith('no')) {
        checked = true;
        logs.push(`Checked previous employment 'No' checkbox (Label: "${cb.labelText}")`);
      }
    }

    // F. Match office/location checkbox groups (e.g. Sweden/Germany relocation cities)
    const isLocationGroup = /city/i.test(cb.labelText) || /location/i.test(cb.labelText) || /office/i.test(cb.labelText) || /work/i.test(cb.labelText) || /available/i.test(cb.labelText) || /relocate/i.test(cb.labelText);
    if (isLocationGroup) {
      const targetCities = ['stockholm', 'munich', 'warsaw', 'london', 'amsterdam', 'berlin', 'bengaluru', 'bangalore', 'gothenburg', 'goteborg'];
      const cbLabelLower = cb.labelText.toLowerCase();
      const matchedCity = targetCities.find(city => cbLabelLower.includes(city));
      if (matchedCity) {
        checked = true;
        logs.push(`Checked location/city checkbox (Label: "${cb.labelText}")`);
      }
    }

    // C. Match custom checkboxes
    const checkboxMatchers = [
      {
        name: 'relocate_germany_visa',
        regex: [/germany.*visa/i, /relocat.*germany/i, /based\s*in\s*germany.*visa/i],
        value: true
      },
      {
        name: 'used_automation_tools',
        regex: [/other\s*automation\s*tools/i, /used\s*other\s*automation/i],
        value: true
      },
      {
        name: 'use_n8n_personal',
        regex: [/use\s*n8n.*personal/i, /personal\s*projects.*n8n/i],
        value: true
      },
      {
        name: 'agentic_workflows_n8n',
        regex: [/agentic\s*workflows/i, /workflows.*n8n/i],
        value: true
      },
      {
        name: 'fullstack_responsibility',
        regex: [/both\s*frontend\s*and\s*backend/i, /user-facing\s*product\s*features/i],
        value: true
      },
      {
        name: 'product_experiments',
        regex: [/product\s*experiments/i, /activation.*retention/i],
        value: true
      },
      {
        name: 'third_party_integrations',
        regex: [/integrations.*third-party/i, /open-source\s*libraries/i, /building\s*integrations/i],
        value: true
      }
    ];

    for (const matcher of checkboxMatchers) {
      if (fuzzyLabelMatch(cb.labelText, matcher.regex)) {
        checked = matcher.value;
        logs.push(`Checked custom checkbox (Label: "${cb.labelText}") based on profile`);
        break;
      }
    }

    if (checked && !cb.checked) {
      try {
        const checkboxLoc = targetFrame.locator(cb.selector).nth(cb.index);
        const labelLoc = targetFrame.locator(`label[for="${cb.id}"]`);
        if (cb.id && await labelLoc.count() > 0 && await labelLoc.isVisible()) {
          await labelLoc.click();
        } else {
          await checkboxLoc.check({ force: true });
        }
      } catch (e) {
        // Fallback: check in-browser
        try {
          await targetFrame.evaluate(({ selector, index }) => {
            const el = document.querySelectorAll(selector)[index];
            if (el && !el.checked) {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('click', { bubbles: true }));
            }
          }, { selector: cb.selector, index: cb.index });
          logs.push(`Checked checkbox (Label: "${cb.labelText}") (in-browser fallback)`);
        } catch (browserErr) {
          logs.push(`⚠️ Failed to check checkbox "${cb.labelText}": ${e.message}`);
        }
      }
    }
    if (!checked) {
      logs.push(`⚠️ No matcher fired for checkbox: labelText="${cb.labelText}"`);
    }
  }

  // 4b. Fill Ashby Button Questions (paired Yes/No buttons)
  if (domLayout.buttonQuestions && domLayout.buttonQuestions.length > 0) {
    console.log(`   - Ashby Button Questions: ${domLayout.buttonQuestions.length}`);
    for (const bq of domLayout.buttonQuestions) {
      try {
        let valueToClick = null;
        
        // A. Match standard choice matchers
        let matcher = null;
        for (const m of choiceMatchers) {
          if (fuzzyLabelMatch(bq.labelText, m.regex)) {
            matcher = m;
            break;
          }
        }
        
        if (matcher) {
          const { keywords, fallback } = resolveChoiceParams(matcher, bq.labelText);
          valueToClick = keywords[0] || fallback;
        }
        
        // B. Custom Answers
        if (!valueToClick && customAnswers && customAnswers.length > 0) {
          const matched = matchCustomAnswer(bq.labelText, customAnswers, bq);
          if (matched) {
            valueToClick = matched.answer;
          }
        }

        // C. Override Right-to-Work / Legally Authorized questions (Yes/No buttons)
        if (!valueToClick && /right.to.work|legally.*authorized|authorized.to.work/i.test(bq.labelText)) {
          valueToClick = 'Yes';
        }
        
        if (valueToClick) {
          const targetLower = valueToClick.toLowerCase();
          const targetBtn = bq.buttons.find(btn => {
            const btnText = btn.text.toLowerCase();
            return btnText === targetLower || btnText.includes(targetLower) || targetLower.includes(btnText);
          });
          
          if (targetBtn) {
            const locator = targetFrame.locator(targetBtn.selector).nth(targetBtn.index);
            console.log(`🔘 Clicking button "${targetBtn.text}" for question "${bq.labelText}"`);
            await locator.click({ force: true }).catch(async () => {
              await locator.evaluate(el => el.click());
            });
            logs.push(`Clicked button "${targetBtn.text}" for question "${bq.labelText}"`);
          } else {
            logs.push(`⚠️ Ashby button question "${bq.labelText}" valueToClick="${valueToClick}" but no button matched text.`);
          }
        } else {
          logs.push(`⚠️ No matcher fired for button question: "${bq.labelText}"`);
        }
      } catch (err) {
        logs.push(`⚠️ Failed to process button question "${bq.labelText}": ${err.message}`);
      }
    }
  }

  // 5. Fill Radio Groups
  for (const group of domLayout.radioGroups) {
    let radioFilled = false;
    for (const matcher of choiceMatchers) {
      if (fuzzyLabelMatch(group.groupLabel, matcher.regex)) {
        const { keywords, fallback } = resolveChoiceParams(matcher, group.groupLabel);
        const bestOpt = findBestOption(group.options, keywords, fallback);
        if (bestOpt) {
          try {
            // Prefer setting radio.checked = true and dispatching events via in-browser execution
            // to avoid timeouts/pointer-intercept issues from overlays (like hCaptcha widgets)
            const success = await targetFrame.evaluate(({ selector, index }) => {
              const el = document.querySelectorAll(selector)[index];
              if (el) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('click', { bubbles: true }));
                return true;
              }
              return false;
            }, { selector: bestOpt.selector, index: bestOpt.index });

            if (success) {
              logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}"`);
              radioFilled = true;
            } else {
              // Fallback to Playwright click if DOM element wasn't found in-browser
              const radioLabel = targetFrame.locator(`label[for="${bestOpt.id}"]`);
              if (bestOpt.id && await radioLabel.count() > 0 && await radioLabel.isVisible()) {
                await radioLabel.click({ timeout: 2000 });
              } else {
                await targetFrame.locator(bestOpt.selector).nth(bestOpt.index).click({ force: true, timeout: 2000 });
              }
              logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}" (fallback)`);
              radioFilled = true;
            }
          } catch (e) {
            // Fallback click on catch block
            try {
              const radioLabel = targetFrame.locator(`label[for="${bestOpt.id}"]`);
              if (bestOpt.id && await radioLabel.count() > 0 && await radioLabel.isVisible()) {
                await radioLabel.click({ force: true, timeout: 2000 });
              } else {
                await targetFrame.locator(bestOpt.selector).nth(bestOpt.index).click({ force: true, timeout: 2000 });
              }
              logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}" (fallback catch)`);
              radioFilled = true;
            } catch (clickErr) {
              logs.push(`⚠️ Failed to select radio option for "${group.groupLabel}": ${clickErr.message}`);
            }
          }
        }
        break;
      }
    }
    if (!radioFilled) {
      const customAns = matchCustomAnswer(group.groupLabel, customAnswers, group);
      if (customAns) {
        const bestOpt = findBestRadioOptionFromCustomAnswer(group.options, customAns.answer);
        if (bestOpt) {
          try {
            const success = await targetFrame.evaluate(({ selector, index }) => {
              const el = document.querySelectorAll(selector)[index];
              if (el) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('click', { bubbles: true }));
                return true;
              }
              return false;
            }, { selector: bestOpt.selector, index: bestOpt.index });

            if (success) {
              logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}" from Section H answer`);
              radioFilled = true;
            } else {
              const radioLabel = targetFrame.locator(`label[for="${bestOpt.id}"]`);
              if (bestOpt.id && await radioLabel.count() > 0 && await radioLabel.isVisible()) {
                await radioLabel.click({ timeout: 2000 });
              } else {
                await targetFrame.locator(bestOpt.selector).nth(bestOpt.index).click({ force: true, timeout: 2000 });
              }
              logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}" from Section H answer (fallback)`);
              radioFilled = true;
            }
          } catch (e) {
            logs.push(`⚠️ Failed to select radio option from Section H answer for "${group.groupLabel}": ${e.message}`);
          }
        }
      }
    }
    if (!radioFilled) {
      logs.push(`⚠️ No matcher fired for radio group: labelText="${group.groupLabel}" (options: ${group.options.map(o => o.label).join(', ')})`);
    }
  }

    // Check if we should advance to the next step
    if (detectedPortal === 'CareerPuck' || detectedPortal === 'Generic') {
      const clickSuccess = await targetFrame.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const continueBtn = btns.find(b => {
          const text = (b.innerText || b.value || '').toLowerCase();
          const isSubmit = text.includes('submit') || b.getAttribute('type') === 'submit';
          if (isSubmit) return false;
          return (text.includes('continue') || text.includes('next') || text.includes('save') || text.includes('proceed') || text.includes('start application') || text.includes('start app')) &&
                 !text.includes('back') && !text.includes('cancel');
        });
        if (continueBtn) {
          continueBtn.click();
          return true;
        }
        return false;
      });

      if (clickSuccess) {
        console.log(`   Advancing multi-step form...`);
        // For CareerPuck, clicking "Start application" navigates to /apply — wait for it
        if (detectedPortal === 'CareerPuck') {
          try {
            await page.waitForURL('**/apply**', { timeout: 10000 });
            await page.waitForLoadState('networkidle', { timeout: 15000 });
            // Re-resolve targetFrame after navigation
            targetFrame = page.mainFrame();
          } catch (_) { /* page may not navigate for all CareerPuck steps */ }
        }
        await delay(2000); // Wait for transition
        step++;
      } else {
        hasMoreSteps = false;
      }
    } else {
      hasMoreSteps = false;
    }
  }

  // Summary of fills
  console.log(`\n${colors.green}✅ Form filling complete!${colors.reset}`);
  if (logs.length === 0) {
    console.log(`   - ${colors.dim}No fields were auto-filled by matchers.${colors.reset}`);
  }
  return targetFrame;
}

// Parse applications.md
function parseApplications() {
  const filePath = join(projectRoot, 'data', 'applications.md');
  if (!existsSync(filePath)) {
    console.error(`${colors.red}Error: applications.md not found at ${filePath}${colors.reset}`);
    return [];
  }
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const apps = [];

  for (const line of lines) {
    if (!line.trim().startsWith('|') || line.includes('| # |') || line.includes('|---|')) continue;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 10) continue;

    const id = parts[1];
    const date = parts[2];
    const company = parts[3];
    const role = parts[4];
    const scoreText = parts[5];
    const status = parts[6];
    const pdf = parts[7];
    const reportMatch = parts[8].match(/\[.*?\]\((?:\.\.\/)?(reports\/.*?)\)/);
    const reportPath = reportMatch ? reportMatch[1] : null;
    const notes = parts[9];

    // Extract numerical score
    const scoreValMatch = scoreText.match(/([\d.]+)\/5/);
    const score = scoreValMatch ? parseFloat(scoreValMatch[1]) : 0;

    apps.push({
      id,
      date,
      company,
      role,
      scoreText,
      score,
      status,
      pdf,
      reportPath,
      notes,
      rawLine: line
    });
  }
  return apps;
}

// Parse job URL from report markdown
function parseJobUrl(reportPath) {
  if (!reportPath) return null;
  const fullPath = join(projectRoot, reportPath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, 'utf-8');
  
  // Try matching markdown link [text](url)
  const mdMatch = content.match(/\*\*URL:\*\*\s*\[[^\]]+\]\((https?:\/\/[^\s\)]+)\)/i);
  if (mdMatch) return mdMatch[1].trim();

  // Fallback to simple URL match
  const match = content.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/i);
  return match ? match[1].trim() : null;
}

// Parse draft application answers from report markdown
function parseDraftAnswers(reportPath) {
  if (!reportPath) return [];
  const fullPath = join(projectRoot, reportPath);
  if (!existsSync(fullPath)) return [];
  const content = readFileSync(fullPath, 'utf-8');
  const answers = [];

  // Extract cover letter draft if present
  try {
    let coverLetterText = '';
    const coverLetterMatch = content.match(/##\s+Cover\s+Letter\s+Draft\s*\r?\n([\s\S]*?)(?:\r?\n##|$)/i);
    if (coverLetterMatch) {
      coverLetterText = coverLetterMatch[1]
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('>') && !l.startsWith('---') && !l.includes('/career-ops cover'))
        .join('\n\n').trim();
    } else {
      // Try Block F cover note draft / strategy section
      const blockFMatch = content.match(/##\s+(?:Block\s+F|F\))[\s\S]*?(\n>\s*[\s\S]*?)(?:\r?\n##|$)/i);
      if (blockFMatch) {
        coverLetterText = blockFMatch[1]
          .split('\n')
          .filter(l => l.trim().startsWith('>'))
          .map(l => l.trim().replace(/^>\s*/, ''))
          .join('\n\n').trim();
      }
    }
    
    if (coverLetterText) {
      // Clean up markdown bold/italic formatting to match plain textarea inputs
      coverLetterText = coverLetterText
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/_(.*?)_/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
      answers.push({
        question: 'Cover Letter',
        answer: coverLetterText
      });
    }
  } catch (e) {
    // Ignore cover letter parsing errors
  }

  // Find Section H (Draft Application Answers). In non-English templates it may be G).
  // Try H first so we don't accidentally match G) Posting Legitimacy in English reports.
  let hSectionIndex = content.search(/##\s+H[\)—–-]/i);
  if (hSectionIndex === -1) {
    // Fall back to G only when the G heading is about application answers, NOT posting legitimacy.
    const gIdx = content.search(/##\s+G[\)—–-]/i);
    if (gIdx !== -1) {
      const gHeading = content.slice(gIdx, gIdx + 120);
      if (!/legitimacy|posting legit/i.test(gHeading)) {
        hSectionIndex = gIdx;
      }
    }
  }
  if (hSectionIndex === -1) return answers; // Return answers containing at least Cover Letter if found

  let hContent = content.slice(hSectionIndex);
  // Isolate Section H/G by finding the next major Markdown header starting with '## '
  const nextSectionIndex = hContent.slice(10).search(/\r?\n##\s+/);
  if (nextSectionIndex !== -1) {
    hContent = hContent.slice(0, nextSectionIndex + 10);
  }

  function cleanAnswerBody(answerBody) {
    // Clean up draft response/answer prefixes (e.g. "**Draft Response:**", "**Draft Answer:**", etc.)
    answerBody = answerBody
      .replace(/^\*\*Draft\s*(?:Response|Answer|Answers):\*\*\s*/i, '')
      .replace(/^\*\*(?:Response|Answer|Answers):\*\*\s*/i, '')
      .replace(/^Draft\s*(?:Response|Answer|Answers):\s*/i, '')
      .replace(/^(?:Response|Answer|Answers):\s*/i, '')
      .trim();

    // Clean up trailing horizontal rules or markdown separators (common at the end of section H)
    answerBody = answerBody.replace(/\n*---\s*$/, '').trim();

    // Strip leading/trailing surrounding quotes if they wrap the entire text block
    if (answerBody.startsWith('"') && answerBody.endsWith('"')) {
      answerBody = answerBody.slice(1, -1).trim();
    } else if (answerBody.startsWith("'") && answerBody.endsWith("'")) {
      answerBody = answerBody.slice(1, -1).trim();
    }

    // Strip markdown for plain textareas. Delegated to lib/answer-sanitizer.mjs:
    // the old inline regexes silently corrupted snake_case identifiers
    // (apply_automator.mjs → applyautomator.mjs) and left links, headings,
    // tables and blockquotes to land in the field verbatim.
    return sanitizeAnswer(answerBody);
  }

  // Split by question headers: '### '
  const questions = hContent.split(/###\s+/);
  const isH3Split = questions.length > 1;

  if (!isH3Split) {
    // Try splitting by bold headers: '**Question text**'
    const lines = hContent.split(/\r?\n/);
    const qBlocks = [];
    let currentQ = '';
    let currentA = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (currentQ) currentA.push(line);
        continue;
      }

      if (trimmed.startsWith('## ')) continue;

      // Check for bold header
      let isBoldHeader = false;
      let questionContent = '';
      if (trimmed.startsWith('**') && trimmed.includes('**', 2)) {
        const lastDoubleAsterisk = trimmed.lastIndexOf('**');
        const inside = trimmed.slice(2, lastDoubleAsterisk).trim();
        const after = trimmed.slice(lastDoubleAsterisk + 2).trim();
        if (/^[?:!:\s]*$/.test(after) && inside.length > 0 && !inside.toLowerCase().startsWith('draft response') && !inside.toLowerCase().startsWith('response') && !inside.toLowerCase().startsWith('draft answer')) {
          isBoldHeader = true;
          questionContent = inside;
        }
      }

      if (isBoldHeader) {
        if (currentQ) {
          qBlocks.push({ question: currentQ, answerLines: currentA });
        }
        currentQ = questionContent;
        currentA = [];
      } else {
        if (currentQ) {
          currentA.push(line);
        }
      }
    }

    if (currentQ) {
      qBlocks.push({ question: currentQ, answerLines: currentA });
    }

    for (const block of qBlocks) {
      const questionText = block.question.trim();
      let answerBody = block.answerLines.join('\n').replace(/^>\s*/gm, '').trim();
      answerBody = cleanAnswerBody(answerBody);

      if (questionText && answerBody) {
        answers.push({
          question: questionText,
          answer: answerBody
        });
      }
    }
  } else {
    // Skip the first block as it's the section header "H) Draft Application Answers\n\n"
    for (let i = 1; i < questions.length; i++) {
      const qBlock = questions[i].trim();
      if (!qBlock) continue;

      const lines = qBlock.split('\n');
      const questionText = lines[0].trim();

      // Extract the answer block, stripping blockquote brackets '>' and excess whitespace
      let answerBody = lines.slice(1).join('\n').replace(/^>\s*/gm, '').trim();
      answerBody = cleanAnswerBody(answerBody);

      if (questionText && answerBody) {
        answers.push({
          question: questionText,
          answer: answerBody
        });
      }
    }
  }
  return answers;
}

// Get fallback draft answers from other reports for the same company
function getFallbackAnswersForCompany(companyName, currentReportPath) {
  if (!companyName) return [];
  const reportsDir = join(projectRoot, 'reports');
  if (!existsSync(reportsDir)) return [];
  
  const files = readdirSync(reportsDir);
  const cleanCompany = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const fallbacks = [];
  
  // Define themes
  const themes = {
    WHY_COMPANY: ['why', 'join', 'interest', 'cover letter', 'about us', 'why now', 'choose us', 'reasons for applying', 'why elevenlabs', 'fit for this role', 'note', 'message', 'comments', 'additional', 'anything else'],
    HARD_PROBLEM_OR_IMPACT: ['hardest', 'hard', 'impactful', 'built', 'technical challenge', 'engineering problem', 'contribution', 'solved', 'problem you solved', 'project', 'most proud of', 'proudest achievement'],
    METRICS_OR_SUCCESS: ['how did you know', 'worked', 'success', 'metric', 'measure', 'result', 'how did you measure', 'evidence of success'],
    PRODUCT_USAGE: ['have you used', 'side project', 'explore', 'experience with', 'personal project', 'using elevenlabs', 'used elevenlabs', 'testing', 'experimented'],
    DESIGN_INTERACTION: ['designing complex', 'interactive interfaces', 'infinite canvas', 'voice dashboards', 'real-time voice', 'ui/ux approach', 'user interface design']
  };

  function getTheme(text) {
    const lower = text.toLowerCase();
    let bestTheme = null;
    let maxMatches = 0;
    for (const [themeKey, keywords] of Object.entries(themes)) {
      let matches = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) matches++;
      }
      if (matches > maxMatches) {
        maxMatches = matches;
        bestTheme = themeKey;
      }
    }
    return bestTheme;
  }

  for (const file of files) {
    const filePath = join('reports', file);
    if (filePath === currentReportPath || !file.endsWith('.md')) continue;
    
    // Check if filename contains the company name
    const cleanFileName = file.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (cleanFileName.includes(cleanCompany)) {
      try {
        const otherAnswers = parseDraftAnswers(filePath);
        for (const item of otherAnswers) {
          const itemTheme = getTheme(item.question);
          fallbacks.push({
            question: item.question,
            answer: item.answer,
            theme: itemTheme,
            source: file
          });
        }
      } catch (e) {
        // Ignore parsing errors for other files
      }
    }
  }
  return fallbacks;
}

// Combined loader that merges primary report answers and any fallback answers for missing themes
function loadMergedAnswers(appItem) {
  const customAnswers = parseDraftAnswers(appItem.reportPath);
  try {
    const fallbackAnswers = getFallbackAnswersForCompany(appItem.company, appItem.reportPath);
    const themes = {
      WHY_COMPANY: ['why', 'join', 'interest', 'cover letter', 'about us', 'why now', 'choose us', 'reasons for applying', 'why elevenlabs', 'fit for this role', 'note', 'message', 'comments', 'additional', 'anything else'],
      HARD_PROBLEM_OR_IMPACT: ['hardest', 'hard', 'impactful', 'built', 'technical challenge', 'engineering problem', 'contribution', 'solved', 'problem you solved', 'project', 'most proud of', 'proudest achievement'],
      METRICS_OR_SUCCESS: ['how did you know', 'worked', 'success', 'metric', 'measure', 'result', 'how did you measure', 'evidence of success'],
      PRODUCT_USAGE: ['have you used', 'side project', 'explore', 'experience with', 'personal project', 'using elevenlabs', 'used elevenlabs', 'testing', 'experimented'],
      DESIGN_INTERACTION: ['designing complex', 'interactive interfaces', 'infinite canvas', 'voice dashboards', 'real-time voice', 'ui/ux approach', 'user interface design']
    };

    function getTheme(text) {
      const lower = text.toLowerCase();
      let bestTheme = null;
      let maxMatches = 0;
      for (const [themeKey, keywords] of Object.entries(themes)) {
        let matches = 0;
        for (const kw of keywords) {
          if (lower.includes(kw)) matches++;
        }
        if (matches > maxMatches) {
          maxMatches = matches;
          bestTheme = themeKey;
        }
      }
      return bestTheme;
    }

    const currentThemes = new Set(customAnswers.map(ans => getTheme(ans.question)).filter(Boolean));
    
    for (const fb of fallbackAnswers) {
      if (fb.theme && !currentThemes.has(fb.theme)) {
        customAnswers.push({
          question: fb.question,
          answer: fb.answer
        });
        currentThemes.add(fb.theme);
      }
    }
  } catch (e) {
    // Ignore error
  }
  return customAnswers;
}


// Check if Chrome debugging port is active
function isChromeDebuggingActive() {
  return new Promise((resolve) => {
    // Attempt to ping Chrome remote debugging JSON endpoint
    fetch('http://localhost:9222/json/version')
      .then(res => resolve(res.ok))
      .catch(() => resolve(false));
  });
}

// Attempt to automatically launch Google Chrome in debugging mode on macOS
function launchChromeOnMac() {
  return new Promise((resolve) => {
    console.log(`${colors.cyan}🚀 Launching Google Chrome with remote debugging on port 9222...${colors.reset}`);
    const profilePath = join(projectRoot, 'scratch', 'chrome-profile');
    const launchCmd = `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="${profilePath}" --restore-last-session > /dev/null 2>&1 &`;
    exec(launchCmd, (err) => {
      if (err) {
        console.error(`${colors.red}Failed to run launch command: ${err.message}${colors.reset}`);
        resolve(false);
      } else {
        // Give Chrome 2 seconds to initialize
        setTimeout(() => resolve(true), 2000);
      }
    });
  });
}

// Safely update application status in applications.md
export function updateApplicationStatus(id, newStatus) {
  const filePath = join(projectRoot, 'data', 'applications.md');
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|') || line.includes('| # |') || line.includes('|---|')) continue;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 10) continue;

    const rowId = parts[1];
    if (rowId === id) {
      parts[6] = newStatus;
      lines[i] = `| ${parts.slice(1, -1).join(' | ')} |`;
      updated = true;
      break;
    }
  }

  if (updated) {
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    if (newStatus !== 'Evaluated') {
      removeFromPendingReview(id);
    }
    return true;
  }
  return false;
}

function clearSessionStateCheckpoint() {
  try {
    const sessionStatePath = join(projectRoot, 'scratch', 'session-state.json');
    if (existsSync(sessionStatePath)) {
      unlinkSync(sessionStatePath);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

const pendingReviewPath = join(projectRoot, 'data', 'pending-review.yml');

function addToPendingReview(app) {
  let list = [];
  if (existsSync(pendingReviewPath)) {
    try {
      list = yaml.load(readFileSync(pendingReviewPath, 'utf-8')) || [];
    } catch (e) {
      list = [];
    }
  }

  if (!Array.isArray(list)) list = [];

  const exists = list.some(item => String(item.id) === String(app.id));
  if (!exists) {
    const jobUrl = parseJobUrl(app.reportPath) || '';
    const scoreVal = app.score || null;

    // Find company tailored resume and build relative path
    const resumePath = findLatestResume(app.company);
    const relativePdf = resumePath ? resumePath.replace(projectRoot + '/', '') : null;

    // Parse ATS platform type
    let atsType = '';
    const lowercaseUrl = jobUrl.toLowerCase();
    if (lowercaseUrl.includes('greenhouse.io') || lowercaseUrl.includes('greenhouse-io')) atsType = 'greenhouse';
    else if (lowercaseUrl.includes('ashbyhq.com') || lowercaseUrl.includes('ashby-hq')) atsType = 'ashby';
    else if (lowercaseUrl.includes('lever.co') || lowercaseUrl.includes('lever-co')) atsType = 'lever';
    else if (lowercaseUrl.includes('myworkdayjobs.com') || lowercaseUrl.includes('workday')) atsType = 'workday';
    else if (lowercaseUrl.includes('firststage.co') || lowercaseUrl.includes('firststage-co')) atsType = 'firststage';

    list.push({
      id: String(app.id),
      company: app.company,
      role: app.role,
      url: jobUrl,
      score: scoreVal,
      ats: atsType || null,
      pdf: relativePdf,
      addedAt: new Date().toISOString()
    });
    writeFileSync(pendingReviewPath, yaml.dump(list), 'utf-8');
    console.log(`${colors.green}📝 Added application #${app.id} (${app.company}) to pending review queue in data/pending-review.yml${colors.reset}`);
  }
}

function removeFromPendingReview(id) {
  if (!existsSync(pendingReviewPath)) return;
  let list = [];
  try {
    list = yaml.load(readFileSync(pendingReviewPath, 'utf-8')) || [];
  } catch (e) {
    return;
  }

  if (!Array.isArray(list)) return;

  const originalLength = list.length;
  list = list.filter(item => String(item.id) !== String(id));

  if (list.length < originalLength) {
    writeFileSync(pendingReviewPath, yaml.dump(list), 'utf-8');
    console.log(`${colors.green}📝 Removed application #${id} from pending review queue in data/pending-review.yml${colors.reset}`);
  }
}

// Main interactive flow
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let argId = null;
  let argStatus = null;
  let nonInteractive = false;
  let argSubmit = true;  // Auto-submit by default — use --no-submit to fill without submitting
  let keepOpen = false;
  let cdpRaw = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') {
      argId = args[i + 1];
      i++;
    } else if (args[i] === '--status') {
      argStatus = args[i + 1];
      i++;
    } else if (args[i] === '--non-interactive') {
      nonInteractive = true;
    } else if (args[i] === '--submit') {
      argSubmit = true;  // explicit (already default, kept for backward compat)
    } else if (args[i] === '--no-submit' || args[i] === '--fill-only') {
      argSubmit = false;
    } else if (args[i] === '--keep-open') {
      keepOpen = true;
    } else if (args[i] === '--cdp-raw') {
      cdpRaw = true;
    } else if (!isNaN(parseInt(args[i]))) {
      argId = args[i];
    }
  }

  const allApps = parseApplications();

  if (argId && argStatus) {
    const ok = updateApplicationStatus(argId, argStatus);
    if (ok) {
      console.log(`${colors.green}🎉 Successfully marked application #${argId} as "${argStatus}"!${colors.reset}`);
    } else {
      console.error(`${colors.red}Error: Could not update status for application #${argId}.${colors.reset}`);
    }
    return;
  }

  let app = null;
  if (argId) {
    app = allApps.find(a => a.id === argId);
    if (!app) {
      console.error(`${colors.red}Error: Application with ID #${argId} not found in applications.md!${colors.reset}`);
      return;
    }
  }

  if (!app) {
    console.clear();
    console.log(`${colors.bright}${colors.bgMagenta}                                                     ${colors.reset}`);
    console.log(`${colors.bright}${colors.bgMagenta}     🚀 CAREER-OPS CHROME APPLY AUTOMATOR v1.0 🚀    ${colors.reset}`);
    console.log(`${colors.bright}${colors.bgMagenta}                                                     ${colors.reset}\n`);

    const evaluatedApps = allApps
      .filter(app => app.status.toLowerCase() === 'evaluated' && app.reportPath)
      .sort((a, b) => b.score - a.score);

    if (evaluatedApps.length === 0) {
      console.log(`${colors.yellow}No applications with status "Evaluated" found in applications.md!${colors.reset}`);
      return;
    }

    console.log(`${colors.bright}Found ${evaluatedApps.length} Evaluated Roles (Sorted by Score):${colors.reset}\n`);
    
    for (let i = 0; i < evaluatedApps.length; i++) {
      const appItem = evaluatedApps[i];
      const customAnswers = loadMergedAnswers(appItem);
      const hasAnswersText = customAnswers.length > 0 
        ? `${colors.green}✅ ${customAnswers.length} custom answers drafted${colors.reset}`
        : `${colors.dim}❌ No custom answers${colors.reset}`;
        
      console.log(`[${i + 1}] ${colors.bright}${colors.cyan}${appItem.company}${colors.reset} - ${colors.yellow}${appItem.role}${colors.reset}`);
      console.log(`    Score: ${colors.bright}${appItem.scoreText}${colors.reset} | Date: ${appItem.date} | Report ID: #${appItem.id}`);
      console.log(`    Status: ${colors.blue}${appItem.status}${colors.reset} | ${hasAnswersText}`);
      console.log(`    Notes: ${colors.dim}${appItem.notes}${colors.reset}\n`);
    }

    const selectionIndexText = await askQuestion(`${colors.bright}Select a role index (1-${evaluatedApps.length}) to open & autofill, or 'q' to quit: ${colors.reset}`);
    if (selectionIndexText.toLowerCase().trim() === 'q') {
      console.log('Goodbye!');
      return;
    }

    const selIndex = parseInt(selectionIndexText) - 1;
    if (isNaN(selIndex) || selIndex < 0 || selIndex >= evaluatedApps.length) {
      console.error(`${colors.red}Invalid selection!${colors.reset}`);
      return;
    }

    app = evaluatedApps[selIndex];
  }
  const jobUrl = parseJobUrl(app.reportPath);
  const customAnswers = loadMergedAnswers(app);
  const profile = loadProfile();
  const resumePath = findLatestResume(app.company);

  if (!jobUrl) {
    console.error(`${colors.red}Error: Could not extract job URL from report ${app.reportPath}${colors.reset}`);
    return;
  }

  // Report-specific PID lock check
  const lockFilePath = `/tmp/fill-${app.id}.lock`;
  if (existsSync(lockFilePath)) {
    try {
      const oldPid = parseInt(readFileSync(lockFilePath, 'utf-8'));
      if (oldPid && oldPid !== process.pid) {
        console.log(`${colors.yellow}⚠️ Killing previous zombie run process for Report #${app.id} (PID ${oldPid})${colors.reset}`);
        process.kill(oldPid, 'SIGTERM');
      }
    } catch (e) {
      // Process might already be dead or we don't have permission to kill
    }
  }
  try {
    writeFileSync(lockFilePath, String(process.pid), 'utf-8');
    process.on('exit', () => { try { unlinkSync(lockFilePath); } catch {} });
  } catch (e) {
    // Ignore lock writing errors
  }

  // Write session state checkpoint
  try {
    const sessionStatePath = join(projectRoot, 'scratch', 'session-state.json');
    const checkpoint = {
      active_application: {
        id: app.id,
        company: app.company,
        role: app.role,
        url: jobUrl,
        step: "form_filling",
        timestamp: new Date().toISOString()
      },
      pending_tracker_additions: [],
      forms_open_in_playwright: [jobUrl]
    };
    writeFileSync(sessionStatePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  } catch (err) {
    // Ignore checkpoint write errors
  }

  console.log(`\n------------------------------------------------------------`);
  console.log(`Targeting: ${colors.bright}${app.company} — ${app.role}${colors.reset}`);
  console.log(`URL: ${colors.underline}${jobUrl}${colors.reset}`);
  console.log(`------------------------------------------------------------\n`);

  // Ensure Chrome remote debugging is active
  let debugActive = await isChromeDebuggingActive();
  if (!debugActive) {
    console.log(`${colors.yellow}⚠️  Google Chrome is not running in remote debugging mode on port 9222.${colors.reset}`);
    let shouldLaunch = false;
    if (nonInteractive) {
      console.log(`🤖 Non-interactive mode: Automatically attempting to launch Google Chrome in debugging mode...`);
      shouldLaunch = true;
    } else {
      const action = await askQuestion(`Would you like me to try launching Chrome in debugging mode for you? (y/n): `);
      shouldLaunch = action.toLowerCase().trim() === 'y';
    }
    
    if (shouldLaunch) {
      const success = await launchChromeOnMac();
      if (success) {
        debugActive = await isChromeDebuggingActive();
      }
    }

    if (!debugActive) {
      if (nonInteractive) {
        console.error(`${colors.red}Error: Could not connect to Chrome on port 9222. Please make sure Google Chrome is fully closed (Cmd+Q), then restart it with debugging enabled manually, or run interactively.${colors.reset}`);
        return;
      }
      console.log(`\n${colors.bright}${colors.red}Please start Chrome manually with remote debugging enabled using this command:${colors.reset}`);
      console.log(`\n    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --restore-last-session\n`);
      await askQuestion('Press [Enter] once you have restarted Google Chrome with the command above...');
      
      debugActive = await isChromeDebuggingActive();
      if (!debugActive) {
        console.error(`${colors.red}Could not connect to Chrome on port 9222. Aborting.${colors.reset}`);
        return;
      }
    }
  }

  console.log(`${colors.green}✅ Connected to Chrome remote debugging!${colors.reset}`);
  console.log(`${colors.cyan}Opening Playwright session...${colors.reset}`);

  if (cdpRaw) {
    console.log(`${colors.cyan}🚀 Running raw CDP WebSocket fill script (cdp-fill-template.mjs)...${colors.reset}`);
    const { execSync } = await import('child_process');
    try {
      const submitFlag = argSubmit ? '--submit' : '';
      execSync(`node scratch/cdp-fill-template.mjs --id ${app.id} ${submitFlag}`, { stdio: 'inherit' });
      return;
    } catch (err) {
      console.error(`${colors.red}❌ Raw CDP WebSocket fill failed: ${err.message}${colors.reset}`);
      return;
    }
  }

  let browser;
  try {
    // 2s Fast CDP pre-flight check to avoid 10s-30s Playwright connection hangs
    const cdpLive = await (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('http://localhost:9222/json/version', { signal: controller.signal });
        clearTimeout(timer);
        return res.ok;
      } catch (e) {
        return false;
      }
    })();

    if (!cdpLive) {
      console.warn(`\n${colors.yellow}⚠️  Chrome CDP not available on port 9222.${colors.reset}`);
      console.warn(`${colors.cyan}Start Chrome with:${colors.reset}`);
      console.warn(`    open -a "Google Chrome" --args --remote-debugging-port=9222\n`);
      throw new Error('Chrome CDP port 9222 not reachable (pre-flight failed within 2s).');
    }

    // Check Chrome tab saturation to warn on Playwright CDP latency
    try {
      const tabsRes = await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(1500) });
      if (tabsRes.ok) {
        const tabs = await tabsRes.json();
        if (Array.isArray(tabs) && tabs.length > 50) {
          console.warn(`\n${colors.yellow}⚠️  Chrome tab saturation detected: ${tabs.length} open tabs.${colors.reset}`);
          console.warn(`${colors.yellow}Playwright CDP connection may experience higher latency.${colors.reset}\n`);
        }
      }
    } catch (e) {}

    const connectPromise = chromium.connectOverCDP('http://localhost:9222', { noDefaults: true });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Playwright connectOverCDP timeout after 10s')), 10000));
    browser = await Promise.race([connectPromise, timeoutPromise]);
    
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No active Chrome profiles/contexts found.');
    }

    let page = null;
    let targetContext = contexts[0];
    let targetTabJustApplied = false;

    // Normalize url for comparison
    // Re-use existing tabs to avoid duplicate loads and utilize existing hydration state
    const normJobUrl = jobUrl.toLowerCase().split('?')[0].replace(/\/$/, '');

    console.log(`${colors.cyan}Scanning open tabs to find "${app.company} — ${app.role}" or detect already applied roles...${colors.reset}`);
    for (const ctx of contexts) {
      const pages = ctx.pages();
      for (const p of pages) {
        try {
          const url = p.url();
          if (!url || url === 'about:blank') continue;
          const normUrl = url.toLowerCase().split('?')[0].replace(/\/$/, '');

          // Check if this matches the current target job URL
          const isTargetTab = normUrl.includes(normJobUrl) || normJobUrl.includes(normUrl);

          // Find if this open page corresponds to any of our 'Evaluated' applications
          const matchingApp = allApps.find(item => {
            if (item.status.toLowerCase() !== 'evaluated') return false;
            const appUrl = parseJobUrl(item.reportPath);
            if (!appUrl) return false;
            const normAppUrl = appUrl.toLowerCase().split('?')[0].replace(/\/$/, '');
            return normUrl.includes(normAppUrl) || normAppUrl.includes(normUrl);
          });

          if (matchingApp) {
            // Check if this page is currently a confirmation/success page
            let hasConfirmationText = false;
            try {
              hasConfirmationText = await p.evaluate(() => {
                const bodyText = document.body.innerText.toLowerCase();
                return bodyText.includes('thank you for') || 
                       bodyText.includes('application submitted') || 
                       bodyText.includes('successfully submitted') || 
                       bodyText.includes('your application has been') ||
                       bodyText.includes('thanks for applying') ||
                       bodyText.includes('application received') ||
                       bodyText.includes('thanks, application received');
              });
            } catch (e) {}

            const currentTitle = await p.title().catch(() => '');
            const isRedirected = normUrl.includes('confirmation') || 
                                 normUrl.includes('thank') || 
                                 normUrl.includes('success') || 
                                 normUrl.includes('/applied');
            const isTitleConfirmed = currentTitle.toLowerCase().includes('thank') || 
                                     currentTitle.toLowerCase().includes('success');

            const isLever = normUrl.includes('lever.co');
            const isApplicationFormUrl = (normUrl.includes('/apply') || normUrl.includes('/application') || normUrl.includes('/postings/')) && !isLever;

            const isConfirmed = (hasConfirmationText || isRedirected || isTitleConfirmed) && !isApplicationFormUrl;

            if (isConfirmed) {
              console.log(`\n${colors.green}🎉 Open tab for "${matchingApp.company} — ${matchingApp.role}" detected as submitted/applied!${colors.reset}`);
              const ok = updateApplicationStatus(matchingApp.id, 'Applied');
              if (ok) {
                console.log(`${colors.green}🎉 Successfully marked application #${matchingApp.id} as "Applied"!${colors.reset}`);
                if (matchingApp.id === app.id) {
                  targetTabJustApplied = true;
                }
              }
              console.log(`${colors.cyan}Closing the applied tab for ${matchingApp.company}...${colors.reset}`);
              await p.close();
              continue; // Skip attaching to this closed tab
            }
          }

          // If this is the target tab we want to attach to, and we haven't closed it/found it yet
          if (isTargetTab && !page) {
            console.log(`${colors.green}✅ Found an existing tab open with this job URL! Attaching to it...${colors.reset}`);
            page = p;
            targetContext = ctx;
          }
        } catch (err) {
          // Ignore page errors
        }
      }
    }

    if (targetTabJustApplied) {
      console.log(`\n${colors.bright}${colors.green}🎉 The selected application #${app.id} was already submitted in an open tab, marked as Applied, and the tab has been closed. Exiting.${colors.reset}\n`);
      await browser.close();
      return;
    }

    if (!page) {
      console.log(`${colors.cyan}No existing tab found for this URL. Creating a new tab...${colors.reset}`);
      page = await targetContext.newPage();
      console.log(`${colors.cyan}Navigating to job application page...${colors.reset}`);
      await page.goto(jobUrl, { waitUntil: 'load', timeout: 30000 }).catch(e => {
        console.log(`${colors.yellow}⚠️ Navigation timeout or warning: ${e.message}. Continuing...${colors.reset}`);
      });
      console.log(`${colors.green}Page loaded successfully. Waiting 3s for client-side SPA components to fully render and hydrate...${colors.reset}`);
      await delay(3000);
    } else {
      // Bring tab to front
      try {
        await page.bringToFront();
      } catch (e) {
        // Ignore errors bringing to front
      }
    }

    // Click Apply button if present to scroll/reveal the form (handles dynamic iframe reveals as well)
    try {
      let applyBtnClicked = false;
      let clickedText = '';
      
      // Define a standard searcher to run inside any page or frame
      const findAndClickApplyInBrowser = () => {
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
        for (const el of candidates) {
          const text = (el.innerText || el.textContent || '').trim();
          const cleanText = text.toLowerCase();
          const id = (el.id || '').toLowerCase();
          const className = (el.className || '').toLowerCase();
          
          // Check visibility
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
          
          if (isVisible) {
            // Check if text indicates "Apply"
            const isApplyText = cleanText === 'apply' || 
                                cleanText === 'apply now' || 
                                cleanText === 'apply for this job' || 
                                cleanText === 'apply to position' || 
                                cleanText.includes('apply now') || 
                                cleanText === 'apply today' ||
                                (cleanText.includes('apply') && cleanText.length < 30 && !cleanText.includes('filter') && !cleanText.includes('terms'));
                                
            const isApplyIdOrClass = id.includes('apply') || className.includes('apply-button') || className.includes('apply_button');
            
            if (isApplyText || isApplyIdOrClass) {
              // Scroll into view
              el.scrollIntoView({ block: 'center', behavior: 'smooth' });
              // Click
              el.click();
              el.dispatchEvent(new Event('click', { bubbles: true }));
              return { success: true, text: text };
            }
          }
        }
        return { success: false };
      };

      // Try main page first
      const mainResult = await page.evaluate(findAndClickApplyInBrowser).catch(() => ({ success: false }));
      if (mainResult.success) {
        applyBtnClicked = true;
        clickedText = mainResult.text;
        console.log(`${colors.green}✅ Clicked "Apply" button ("${clickedText}") on main page!${colors.reset}`);
      } else {
        // Try all frames with filters and timeouts
        const pageUrl = page.url();
        for (const frame of page.frames()) {
          const frameUrl = await getFrameUrl(frame);
          if (shouldSkipUrl(frameUrl, pageUrl)) {
            continue;
          }
          try {
            const frameResult = await evaluateWithTimeout(frame, findAndClickApplyInBrowser, undefined, 2000);
            if (frameResult && frameResult.success) {
              applyBtnClicked = true;
              clickedText = frameResult.text;
              console.log(`${colors.green}✅ Clicked "Apply" button ("${clickedText}") inside iframe (${frame.url()})!${colors.reset}`);
              break;
            }
          } catch (e) {
            // ignore frame evaluation error and timeouts
          }
        }
      }

      if (applyBtnClicked) {
        console.log(`${colors.cyan}Waiting 3s for transition/scroll/render...${colors.reset}`);
        await delay(3000);
      } else {
        console.log(`${colors.dim}No explicit, visible "Apply" button found or already revealed. Continuing...${colors.reset}`);
      }
    } catch (e) {
      console.log(`${colors.dim}Note: Could not click Apply button automatically: ${e.message}${colors.reset}`);
    }


    // Print draft answers in high contrast for the user
    if (customAnswers.length > 0) {
      console.log(`\n============================================================`);
      console.log(`${colors.bright}${colors.bgBlue}               DRAFTED CUSTOM ANSWERS                       ${colors.reset}`);
      console.log(`============================================================`);
      for (const item of customAnswers) {
        console.log(`\n${colors.bright}${colors.yellow}Q: ${item.question}${colors.reset}`);
        console.log(`${colors.bright}${colors.green}A: "${item.answer}"${colors.reset}`);
      }
      console.log(`============================================================\n`);
    }

    // Run unified visual form autofill engine
    const targetFrame = await autofillForm(page, profile, resumePath, customAnswers, app);

    // Write fill receipt JSON
    try {
      const fillReceiptDir = join(projectRoot, 'output', 'fills');
      mkdirSync(fillReceiptDir, { recursive: true });
      const receiptPath = join(fillReceiptDir, `${app.id}-fill-receipt.json`);
      const receipt = {
        id: app.id,
        company: app.company,
        role: app.role,
        url: parseJobUrl(app.reportPath) || '',
        filled_at: new Date().toISOString(),
        logs: app.fillLogs || [],
        submitted: argSubmit,
        status: argSubmit ? 'submitted_unverified' : 'awaiting_manual_submit',
        externalFormRequired: app.externalFormRequired || null
      };
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf-8');
      console.log(`${colors.green}📝 Saved fill receipt to: ${colors.underline}${receiptPath}${colors.reset}`);
    } catch (e) {
      console.warn(`⚠️ Failed to save fill receipt: ${e.message}`);
    }

    if (argSubmit) {
      console.log(`\n${colors.bright}${colors.bgMagenta}🚀 AUTONOMOUS PIPELINE: Submitting application...${colors.reset}`);
      let submissionSuccess = false;
      try {
        // Highly robust selector list for final submit buttons
        const submitSelector = [
          'button:has-text("Submit application")',
          'button:has-text("Submit Application")',
          'button:has-text("Submit")',
          'button[type="submit"]',
          'input[type="submit"]',
          '[id*="submit-button"]',
          '[id*="submit_app"]',
          '[data-automation-id="submit-button"]',
          'button[id*="submit"]',
          'input[id*="submit"]'
        ].join(', ');

        let submitBtn = targetFrame.locator(submitSelector).first();
        let submitBtnInFrame = true;
        if (await submitBtn.count() === 0 || !(await submitBtn.isVisible())) {
          submitBtn = page.locator(submitSelector).first();
          submitBtnInFrame = false;
        }

        if (await submitBtn.count() > 0 && await submitBtn.isVisible()) {
          console.log(`${colors.cyan}🤖 Found final submit button in ${submitBtnInFrame ? 'iframe' : 'main page'} with text: "${await submitBtn.innerText().catch(() => 'Submit')}"${colors.reset}`);
          if (!argSubmit) {
            console.log(`${colors.yellow}⏸️ --no-submit specified: Form filled successfully, skipping submit click for manual user review.${colors.reset}`);
            return;
          }
          console.log(`${colors.yellow}Clicking submit...${colors.reset}`);
          await submitBtn.click();
          console.log(`${colors.green}✅ Clicked submit! Waiting 6s for page transition/confirmation...${colors.reset}`);
          await delay(6000);
          
          // Verify if submitted successfully
          const currentUrl = page.url();
          const currentTitle = await page.title().catch(() => '');
          console.log(`Current URL: ${currentUrl}`);
          console.log(`Current Title: ${currentTitle}`);
          
          let hasConfirmationText = false;
          try {
            hasConfirmationText = await page.evaluate(() => {
              const bodyText = document.body.innerText.toLowerCase();
              return bodyText.includes('thank you for') || 
                     bodyText.includes('application submitted') || 
                     bodyText.includes('successfully submitted') || 
                     bodyText.includes('your application has been') ||
                     bodyText.includes('thanks for applying') ||
                     bodyText.includes('application received') ||
                     bodyText.includes('thanks, application received');
            });
            if (!hasConfirmationText && targetFrame !== page.mainFrame()) {
              hasConfirmationText = await targetFrame.evaluate(() => {
                const bodyText = document.body.innerText.toLowerCase();
                return bodyText.includes('thank you for') || 
                       bodyText.includes('application submitted') || 
                       bodyText.includes('successfully submitted') || 
                       bodyText.includes('your application has been') ||
                       bodyText.includes('thanks for applying') ||
                       bodyText.includes('application received') ||
                       bodyText.includes('thanks, application received');
              });
            }
          } catch (e) {}

          const isRedirected = currentUrl.toLowerCase().includes('confirmation') || 
                               currentUrl.toLowerCase().includes('thank') || 
                               currentUrl.toLowerCase().includes('success') || 
                               currentUrl.toLowerCase().includes('/applied');

          const isTitleConfirmed = currentTitle.toLowerCase().includes('thank') || 
                                   currentTitle.toLowerCase().includes('success');

          if (isRedirected || isTitleConfirmed || hasConfirmationText) {
            console.log(`\n${colors.bright}${colors.green}🎉 Application submission verified successfully!${colors.reset}`);
            const ok = updateApplicationStatus(app.id, 'Applied');
            if (ok) console.log(`${colors.green}🎉 Successfully marked application #${app.id} as "Applied"!${colors.reset}`);
            submissionSuccess = true;

            // Update fill receipt
            try {
              const receiptPath = join(projectRoot, 'output', 'fills', `${app.id}-fill-receipt.json`);
              if (existsSync(receiptPath)) {
                const receipt = JSON.parse(readFileSync(receiptPath, 'utf-8'));
                receipt.submitted = true;
                receipt.status = 'Applied';
                writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf-8');
              }
            } catch (e) {}
          }
        } else {
          console.error(`${colors.red}Error: Could not locate a visible Submit button on the page.${colors.reset}`);
        }
      } catch (submitErr) {
        console.error(`${colors.red}Error during submit: ${submitErr.message}${colors.reset}`);
      }
      
      if (submissionSuccess) {
        // Only close browser if we are 100% sure it was successful
        await browser.close();
      } else {
        // Keep the tab open and warn the user
        console.log(`\n${colors.bright}${colors.bgBlue}============================================================`);
        console.log(`⚠️ SUBMISSION UNVERIFIED / FAILED`);
        console.log(`============================================================`);
        console.log(`The form was filled and submit clicked, but success was not verified.`);
        console.log(`This is common when there are validation errors, CAPTCHAs, or required fields.`);
        console.log(`\n👉 KEEPING CHROME TAB OPEN WITH YOUR POPULATED FORM!`);
        console.log(`Please switch to Chrome, resolve any errors, and submit manually.`);
        console.log(`Once submitted, you can update the tracker status by running:`);
        console.log(`\n    node scratch/apply_automator.mjs --id ${app.id} --status Applied`);
        console.log(`============================================================\n`);
        addToPendingReview(app);
      }
      return;
    }

    // Post-fill safety/verification check
    console.log(`\n${colors.cyan}📸 Performing post-fill safety verification...${colors.reset}`);
    const screenshotPath = join(projectRoot, 'output', `apply-screenshot-${app.id || 'unknown'}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`${colors.green}✅ Verification screenshot saved successfully to: ${colors.underline}${screenshotPath}${colors.reset}`);
      
      // Robust input-based liveness verification instead of flaky frame URL checks
      let totalInputs = 0;
      try {
        totalInputs = await page.evaluate(() => {
          return document.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
        });
        for (const frame of page.frames()) {
          try {
            const frameInputs = await evaluateWithTimeout(frame, () => {
              return document.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
            }, undefined, 1000);
            totalInputs += (frameInputs || 0);
          } catch (e) {}
        }
      } catch (e) {}
      
      if (totalInputs > 0) {
        console.log(`${colors.green}✅ Safety verification: Form is confirmed live (found ${totalInputs} interactive inputs). Not submitted.${colors.reset}`);
      } else {
        console.log(`${colors.yellow}⚠️ Warning: No inputs found on the page or frames. The form may have been submitted or reloaded. Please check Chrome immediately!${colors.reset}`);
      }
    } catch (screenshotErr) {
      console.warn(`${colors.yellow}⚠️ Could not generate verification screenshot: ${screenshotErr.message}${colors.reset}`);
    }

    console.log(`\n============================================================`);
    console.log(`${colors.bright}${colors.bgBlue}              ACTION NEEDED IN CHROME                       ${colors.reset}`);
    console.log(`============================================================`);
    console.log(`1. Review the opened tab in Google Chrome.`);
    console.log(`2. Verify that all standard fields (name, email, resume, etc.) are correctly filled.`);
    console.log(`3. Check that the custom AI answers are properly filled.`);
    console.log(`4. Handoff is complete — fill remaining fields & submit!`);
    console.log(`============================================================\n`);

    if (nonInteractive || !process.stdin.isTTY || process.env.CI) {
      console.log(`\n${colors.bright}${colors.green}Non-interactive / headless environment detected.${colors.reset}`);
      console.log(`Form filled but NOT submitted. Review in Chrome, then submit manually.`);
      console.log(`Once submitted, update the tracker by running:`);
      console.log(`\n    node scratch/apply_automator.mjs --id ${app.id} --status Applied\n`);
      addToPendingReview(app);
      
      if (keepOpen) {
        console.log(`${colors.cyan}--keep-open specified. Keeping browser connection alive for 5 minutes. Press Ctrl+C to exit...${colors.reset}`);
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // Keep alive for 5 minutes
      }
      if (browser) await browser.close().catch(() => {});
      clearSessionStateCheckpoint();
      process.exit(0);
    }

    // Let user complete and decide status
    console.log(`${colors.bright}Choose status to set in applications.md once you are done:${colors.reset}`);
    console.log(`[1] Mark as ${colors.bright}${colors.green}Applied${colors.reset} 🚀`);
    console.log(`[2] Mark as ${colors.bright}${colors.red}Discarded${colors.reset} ❌`);
    console.log(`[3] Leave as ${colors.bright}${colors.yellow}Evaluated${colors.reset} ➡️`);
    
    const choice = await askQuestion(`\nEnter choice index (1-3): `);
    const choiceTrim = choice.trim();

    if (choiceTrim === '1') {
      const ok = updateApplicationStatus(app.id, 'Applied');
      if (ok) console.log(`${colors.green}🎉 Successfully marked application #${app.id} as "Applied"!${colors.reset}`);
    } else if (choiceTrim === '2') {
      const ok = updateApplicationStatus(app.id, 'Discarded');
      if (ok) console.log(`${colors.yellow}❌ Marked application #${app.id} as "Discarded".${colors.reset}`);
    } else {
      console.log(`${colors.blue}➡️ Left application #${app.id} in "Evaluated" status.${colors.reset}`);
      addToPendingReview(app);
    }

    // Clean up Playwright CDP session
    clearSessionStateCheckpoint();
    await browser.close();
    console.log(`\nSession closed. Retrying main dashboard...`);
    setTimeout(main, 1500);

  } catch (error) {
    clearSessionStateCheckpoint();
    console.error(`${colors.red}Playwright/CDP Error: ${error.message}${colors.reset}`);
    
    // Check if error is related to CDP connection or timeout
    const isConnError = error.message.includes('connectOverCDP') || 
                        error.message.includes('timeout') || 
                        error.message.includes('WebSocket') || 
                        error.message.includes('connect') ||
                        error.message.includes('target') ||
                        error.message.includes('Page.enable');
                        
    if (isConnError && app && app.id) {
      console.log(`${colors.yellow}⚠️ Playwright CDP connection failed or timed out. Falling back to raw CDP WebSocket fill script...${colors.reset}`);
      const { execSync } = await import('child_process');
      try {
        const submitFlag = argSubmit ? '--submit' : '';
        execSync(`node scratch/cdp-fill-template.mjs --id ${app.id} ${submitFlag}`, { stdio: 'inherit' });
        return;
      } catch (fallbackErr) {
        console.error(`${colors.red}❌ Fallback raw CDP WebSocket fill failed: ${fallbackErr.message}${colors.reset}`);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // ignore
      }
    }
    if (nonInteractive || !process.stdin.isTTY || process.env.CI) {
      process.exit(1);
    }
    await askQuestion('\nPress [Enter] to return to the main dashboard...');
    main();
  }
}

const RETIRED_OVERRIDE = process.argv.includes('--i-know-this-is-retired');
if (!RETIRED_OVERRIDE && process.argv[1] && process.argv[1].endsWith('apply_automator.mjs')) {
  console.error(`
apply_automator.mjs is RETIRED (2026-08-27).

It auto-submitted forms 7+ times from a stale page handle with an EOF'd stdin,
and misreported whether a submit landed. Use the agent-driven loop instead:

  node answer-resolver.mjs --collector           # snippet to evaluate in the form frame
  node answer-resolver.mjs --stdin --summary     # what to answer, per field
  <browser agent fills the form>
  node audit-form-fill.mjs --stdin --summary     # must exit 0 before submitting
  <browser agent clicks submit, once, deliberately>

Full workflow: modes/_custom.md -> "Applying".
To mark a tracker row instead:  node set-status.mjs <report#|company> Applied --note "..."

Override (not recommended):  --i-know-this-is-retired
`);
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('apply_automator.mjs')) {
  main().catch(console.error);
}
