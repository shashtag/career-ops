import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { exec } from 'child_process';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

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
    const reportMatch = parts[8].match(/\[.*?\]\((reports\/.*?)\)/);
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
  const fullPath = join(projectRoot, reportPath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, 'utf-8');
  const match = content.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/i);
  return match ? match[1].trim() : null;
}

// Parse draft application answers from report markdown
function parseDraftAnswers(reportPath) {
  const fullPath = join(projectRoot, reportPath);
  if (!existsSync(fullPath)) return [];
  const content = readFileSync(fullPath, 'utf-8');
  const answers = [];
  
  // Find Section H
  const hSectionIndex = content.search(/##\s+H\)/i);
  if (hSectionIndex === -1) return [];

  const hContent = content.slice(hSectionIndex);
  // Split by question headers: '### '
  const questions = hContent.split(/###\s+/);
  // Skip the first block as it's the section header "H) Draft Application Answers\n\n"
  for (let i = 1; i < questions.length; i++) {
    const qBlock = questions[i].trim();
    if (!qBlock) continue;

    const lines = qBlock.split('\n');
    const questionText = lines[0].trim();
    
    // Extract the answer block, stripping blockquote brackets '>' and excess whitespace
    const answerBody = lines.slice(1).join('\n').replace(/^>\s*/gm, '').trim();
    
    if (questionText && answerBody) {
      answers.push({
        question: questionText,
        answer: answerBody
      });
    }
  }
  return answers;
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
    const launchCmd = `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --restore-last-session > /dev/null 2>&1 &`;
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
function updateApplicationStatus(id, newStatus) {
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
    return true;
  }
  return false;
}

// Main interactive flow
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let argId = null;
  let argStatus = null;
  let nonInteractive = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') {
      argId = args[i + 1];
      i++;
    } else if (args[i] === '--status') {
      argStatus = args[i + 1];
      i++;
    } else if (args[i] === '--non-interactive') {
      nonInteractive = true;
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
      const customAnswers = parseDraftAnswers(appItem.reportPath);
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
  const customAnswers = parseDraftAnswers(app.reportPath);

  if (!jobUrl) {
    console.error(`${colors.red}Error: Could not extract job URL from report ${app.reportPath}${colors.reset}`);
    return;
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

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No active Chrome profiles/contexts found.');
    }
    const context = contexts[0];
    const page = await context.newPage();

    console.log(`${colors.cyan}Navigating to job application page...${colors.reset}`);
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });
    console.log(`${colors.green}Page loaded successfully!${colors.reset}`);

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

      console.log(`${colors.cyan}🤖 Attempting to match and auto-inject answers into custom form fields...${colors.reset}`);
      
      // Inject script to match labels/fields and fill them
      const matchStats = await page.evaluate((answers) => {
        let matchedCount = 0;
        const inputs = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'));
        const logs = [];

        for (const input of inputs) {
          let labelText = '';
          
          if (input.id) {
            const label = document.querySelector(`label[for="${input.id}"]`);
            if (label) labelText = label.innerText;
          }
          
          if (!labelText) {
            const parentLabel = input.closest('label');
            if (parentLabel) labelText = parentLabel.innerText;
          }
          
          if (!labelText) {
            const container = input.closest('.field, .question, .form-group, [class*="field"], [class*="question"]');
            if (container) {
              const titleEl = container.querySelector('label, .label, .title, h1, h2, h3, h4, span');
              if (titleEl) labelText = titleEl.innerText;
            }
          }
          
          if (!labelText) {
            const previousEl = input.previousElementSibling;
            if (previousEl) labelText = previousEl.innerText || previousEl.textContent;
          }

          if (!labelText) continue;
          
          const cleanLabel = labelText.toLowerCase().trim();
          
          for (const item of answers) {
            const cleanQuestion = item.question.toLowerCase();
            const words = cleanQuestion.split(/[^a-z0-9]+/).filter(w => w.length > 4);
            let matchCount = 0;
            
            for (const word of words) {
              if (cleanLabel.includes(word)) {
                matchCount++;
              }
            }
            
            if (
              cleanLabel.includes(cleanQuestion) || 
              cleanQuestion.includes(cleanLabel) || 
              (words.length > 0 && matchCount >= Math.min(2, words.length))
            ) {
              // Populate input value
              if (input.tagName.toLowerCase() === 'input' || input.tagName.toLowerCase() === 'textarea') {
                input.value = item.answer;
              } else if (input.getAttribute('contenteditable') === 'true') {
                input.innerText = item.answer;
              }
              
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              logs.push(`Matched question keyword in label: "${labelText.trim().substring(0, 40)}..."`);
              matchedCount++;
              break;
            }
          }
        }
        return { matchedCount, logs };
      }, customAnswers);

      if (matchStats.matchedCount > 0) {
        console.log(`${colors.green}✅ Auto-injected ${matchStats.matchedCount} custom answer(s)!${colors.reset}`);
        matchStats.logs.forEach(log => console.log(`   - ${log}`));
      } else {
        console.log(`${colors.dim}No exact matching custom text areas found. They have been printed above for your manual pasting.${colors.reset}`);
      }
    }

    // Try clicking Simplify button if present
    try {
      const simplifyButton = page.locator('button:has-text("Simplify"), [class*="simplify"], [id*="simplify"]').first();
      if (await simplifyButton.isVisible()) {
        console.log(`${colors.cyan}🤖 Found floating Simplify Jobs button! Clicking to trigger standard autofill...${colors.reset}`);
        await simplifyButton.click();
        console.log(`${colors.green}✅ Clicked Simplify Jobs trigger!${colors.reset}`);
      } else {
        console.log(`${colors.dim}💡 Simplify Jobs autofill button not auto-clicked. You can trigger it manually in Chrome. ${colors.reset}`);
      }
    } catch (e) {
      // Ignore click failures
    }

    console.log(`\n============================================================`);
    console.log(`${colors.bright}${colors.bgBlue}              ACTION NEEDED IN CHROME                       ${colors.reset}`);
    console.log(`============================================================`);
    console.log(`1. Review the opened tab in Google Chrome.`);
    console.log(`2. Trigger Simplify Jobs extension to fill name, resume, email, etc.`);
    console.log(`3. Check that the custom AI answers are properly filled.`);
    console.log(`4. Handoff is complete — fill remaining fields & submit!`);
    console.log(`============================================================\n`);

    if (nonInteractive) {
      console.log(`\n${colors.bright}${colors.green}Non-interactive mode complete!${colors.reset}`);
      console.log(`Please complete and submit the application in Google Chrome.`);
      console.log(`Once submitted, you can update the tracker status by running:`);
      console.log(`\n    node scratch/apply_automator.mjs --id ${app.id} --status Applied\n`);
      await browser.close();
      return;
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
    }

    // Clean up Playwright CDP session
    await browser.close();
    console.log(`\nSession closed. Retrying main dashboard...`);
    setTimeout(main, 1500);

  } catch (error) {
    console.error(`${colors.red}Playwright/CDP Error: ${error.message}${colors.reset}`);
    if (browser) await browser.close();
    await askQuestion('\nPress [Enter] to return to the main dashboard...');
    main();
  }
}

main().catch(console.error);
