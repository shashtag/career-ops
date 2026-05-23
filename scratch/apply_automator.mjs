import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { exec } from 'child_process';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

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

// Find latest resume PDF in output/
function findLatestResume() {
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
      })
      .sort((a, b) => b.mtime - a.mtime);
    
    if (files.length > 0) {
      return files[0].path;
    }
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

  return options[0] || null;
}

// Unified robust autofill engine using Visual-Label DOM Analysis and Node-side Fuzzy Matching
async function autofillForm(page, profile, resumePath, customAnswers) {
  if (!profile) {
    console.log(`${colors.yellow}⚠️ No profile configuration found to autofill.${colors.reset}`);
    return;
  }

  console.log(`\n${colors.cyan}🤖 Running unified visual-label form autofill engine...${colors.reset}`);
  
  const candidate = profile.candidate || {};
  const location = profile.location || {};
  const nameParts = (candidate.full_name || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Get in-browser DOM layout analysis
  const domLayout = await page.evaluate(() => {
    function getLabelText(el) {
      let labelText = '';
      
      // A. Try label elements linked by id
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) {
          labelText = labelEl.innerText || labelEl.textContent;
        }
      }
      
      // B. Climb up to find closest field/question container
      if (!labelText) {
        const container = el.closest('.field, .question, .form-group, .field-wrapper, [class*="field"], [class*="question"], [class*="form-row"], [class*="Field"], [class*="Question"]');
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
    const inputs = Array.from(document.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="hidden"]), textarea, [contenteditable="true"]')).map(el => {
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
    const customDropdowns = Array.from(document.querySelectorAll('[role="combobox"], [class*="select__control"], [class*="select-control"]')).map(el => {
      let cssSelector = '';
      if (el.id) {
        cssSelector = `#${el.id}`;
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

    // Group and capture radio buttons
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

    return {
      inputs,
      selects,
      customDropdowns,
      checkboxes,
      radioGroups: Object.values(radioGroups)
    };
  });

  const logs = [];
  logs.push = function(msg) {
    console.log(`   - ${msg}`);
    return Array.prototype.push.call(this, msg);
  };

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
  function matchCustomAnswer(labelText, answers) {
    if (!labelText || !answers || answers.length === 0) return null;
    const cleanLabel = labelText.toLowerCase();
    
    let bestMatch = null;
    let highestScore = 0;

    const STOP_WORDS = new Set(['in', 'on', 'at', 'to', 'of', 'by', 'is', 'am', 'an', 'as', 'it', 'we', 'he', 'my', 'me', 'or', 'do', 'so', 'if', 'the', 'and', 'for', 'but', 'not', 'you', 'are', 'was', 'out', 'our', 'his', 'her', 'how', 'who', 'why', 'can', 'has', 'had', 'any', 'all', 'with', 'about', 'your', 'would', 'like', 'share']);

    for (const item of answers) {
      const cleanQuestion = item.question.toLowerCase();
      
      // Direct substring match
      if (cleanLabel.includes(cleanQuestion) || cleanQuestion.includes(cleanLabel)) {
        return item;
      }

      // Keyword overlap match (excluding standard stop words but retaining short tech terms >= 2 chars)
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

    return bestMatch;
  }

  // Define matcher configurations for text / textarea inputs
  const textMatchers = [
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
      name: 'full_name',
      regex: [/full\s*name/i, /^name$/i],
      value: candidate.full_name || ''
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
      name: 'passport_country',
      regex: [/passport\s*country/i, /citizenship/i, /citizen/i],
      value: location.country || 'India'
    },
    {
      name: 'residence_country',
      regex: [/residence\s*country/i, /country\s*of\s*residence/i, /where\s*do\s*you\s*live/i, /location/i],
      value: location.country || 'India'
    },
    {
      name: 'notice_period',
      regex: [/notice\s*period/i, /how\s*soon\s*can\s*you\s*start/i, /start\s*date/i, /availability/i, /when\s*can\s*you\s*start/i],
      value: candidate.notice_period || profile.candidate?.notice_period || "Immediately / 1 month"
    },
    {
      name: 'salary_expectations',
      regex: [/salary/i, /compensation/i, /expectation/i, /desired\s*pay/i, /hourly\s*rate/i],
      value: profile.compensation?.target_range || "₹40-100+ LPA / $50K-150K+ USD"
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
      keywords: ['male', 'man'],
      fallback: 'Male'
    },
    {
      name: 'race',
      regex: [/race/i, /ethnicity/i],
      keywords: ['decline', 'not to self-identify', 'asian'],
      fallback: 'Decline to self-identify'
    },
    {
      name: 'veteran',
      regex: [/veteran/i],
      keywords: ['not a veteran', 'no', 'decline'],
      fallback: 'I am not a veteran'
    },
    {
      name: 'disability',
      regex: [/disability/i],
      keywords: ['no', 'don\'t have', 'decline'],
      fallback: 'No, I don\'t have a disability'
    },
    {
      name: 'authorized_to_work',
      regex: [/authorized\s*to\s*work/i, /legally\s*authorized/i, /eligible\s*to\s*work/i, /authorization/i],
      keywords: ['yes', 'authorized'],
      fallback: 'Yes'
    },
    {
      name: 'visa_sponsorship',
      regex: [/sponsorship/i, /require\s*sponsorship/i, /sponsor\b/i, /need.*sponsor/i, /require.*visa/i],
      keywords: profile.location?.sponsorship_required === false ? ['no', 'do not require'] : ['yes', 'require'],
      fallback: profile.location?.sponsorship_required === false ? 'No' : 'Yes'
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
    {
      name: 'source',
      regex: [/hear\s*about/i, /source/i, /find\s*us/i, /how\s*did\s*you\s*hear/i],
      keywords: ['linkedin', 'x/twitter', 'google', 'other'],
      fallback: 'Linkedin'
    }
  ];

  // 1. Fill Text and Textarea Inputs
  for (const input of domLayout.inputs) {
    if (input.type === 'file') {
      // Resume Upload
      if (resumePath && (input.labelText.toLowerCase().includes('resume') || input.labelText.toLowerCase().includes('cv') || input.labelText.toLowerCase().includes('curriculum'))) {
        try {
          await page.locator(input.selector).nth(input.index).setInputFiles(resumePath);
          logs.push(`Uploaded resume PDF to file field (Label: "${input.labelText}")`);
        } catch (e) {
          logs.push(`⚠️ Resume upload failed for label "${input.labelText}": ${e.message}`);
        }
      }
      continue;
    }

    let filled = false;

    // A. Match standard text profile fields
    for (const matcher of textMatchers) {
      if (fuzzyLabelMatch(input.labelText, matcher.regex)) {
        if (matcher.value !== undefined && matcher.value !== null) {
          try {
            const loc = page.locator(input.selector).nth(input.index);
            await loc.fill(matcher.value);
            await loc.dispatchEvent('input', { bubbles: true });
            await loc.dispatchEvent('change', { bubbles: true });
            logs.push(`Filled "${input.labelText}" with: "${matcher.value.length > 50 ? matcher.value.substring(0, 50) + '...' : matcher.value}"`);
            filled = true;
          } catch (e) {
            // fallback
          }
        }
        break;
      }
    }

    if (filled) continue;

    // B. Match custom Section H Answers
    const customAns = matchCustomAnswer(input.labelText, customAnswers);
    if (customAns) {
      try {
        const loc = page.locator(input.selector).nth(input.index);
        await loc.fill(customAns.answer);
        await loc.dispatchEvent('input', { bubbles: true });
        await loc.dispatchEvent('change', { bubbles: true });
        logs.push(`Fuzzily matched Section H question & filled custom field:\n     "${input.labelText}" -> "${customAns.answer.substring(0, 50)}..."`);
      } catch (e) {
        logs.push(`⚠️ Failed to fill Section H answer for "${input.labelText}": ${e.message}`);
      }
    }
  }

  // 2. Fill standard selects
  for (const select of domLayout.selects) {
    for (const matcher of choiceMatchers) {
      if (fuzzyLabelMatch(select.labelText, matcher.regex)) {
        const bestOpt = findBestOption(select.options, matcher.keywords, matcher.fallback);
        if (bestOpt) {
          try {
            const loc = page.locator(select.selector).nth(select.index);
            await loc.selectOption(bestOpt.value, { force: true });
            await loc.dispatchEvent('change', { bubbles: true });
            logs.push(`Selected dropdown option "${bestOpt.text}" for label "${select.labelText}"`);
          } catch (e) {
            // Fallback: set it in-browser
            try {
              await page.evaluate(({ selector, index, value }) => {
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
        break;
      }
    }
  }

  // 3. Fill Custom Dropdowns (comboboxes / react-select etc.)
  for (const dropdown of domLayout.customDropdowns) {
    for (const matcher of choiceMatchers) {
      if (fuzzyLabelMatch(dropdown.labelText, matcher.regex)) {
        try {
          // Open custom dropdown
          await page.locator(dropdown.selector).nth(dropdown.index).click();
          await page.waitForTimeout(500);

          // Type search term if present to filter options (e.g. for virtualized lists)
          const searchTerm = matcher.fallback || matcher.keywords[0];
          if (searchTerm) {
            const inputSelector = `${dropdown.selector} input, [class*="select"] input, input[class*="-input"], input[role="combobox"]`;
            const searchInput = page.locator(inputSelector).first();
            if (await searchInput.count() > 0 && await searchInput.isVisible()) {
              await searchInput.fill(searchTerm);
              await page.waitForTimeout(500); // Wait for filtering
            } else {
              try {
                // Try focused element typing as backup
                await page.keyboard.type(searchTerm);
                await page.waitForTimeout(500);
              } catch (kbdErr) {
                // ignore
              }
            }
          }

          // Get open choices
          const options = await page.evaluate(() => {
            const selectors = [
              '[class*="select__option"]',
              '[class*="-option"]',
              '[role="option"]',
              'div[id*="-listbox"] div',
              'div[class*="option"]'
            ];
            for (const sel of selectors) {
              const elms = Array.from(document.querySelectorAll(sel));
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

          const bestOpt = findBestOption(options, matcher.keywords, matcher.fallback);
          if (bestOpt) {
            const optionSelector = `[class*="select__option"], [class*="-option"], [role="option"], div[id*="-listbox"] div, div[class*="option"]`;
            await page.locator(optionSelector).filter({ hasText: bestOpt.text }).first().click();
            logs.push(`Selected custom dropdown option "${bestOpt.text}" for label "${dropdown.labelText}"`);
          } else {
            // Close dropdown safely
            await page.locator(dropdown.selector).nth(dropdown.index).click();
          }
        } catch (e) {
          logs.push(`⚠️ Custom dropdown selection failed for "${dropdown.labelText}": ${e.message}`);
        }
        break;
      }
    }
  }

  // 4. Fill Checkboxes
  for (const cb of domLayout.checkboxes) {
    let checked = false;
    
    // A. Match required consent checkboxes (privacy, terms, accuracy)
    const consentRegex = [/privacy/i, /consent/i, /agree/i, /terms/i, /policy/i, /acknowledge/i, /data\s*processing/i, /gdpr/i, /statement/i, /declaration/i];
    if (fuzzyLabelMatch(cb.labelText, consentRegex)) {
      checked = true;
      logs.push(`Checked consent checkbox (Label: "${cb.labelText}")`);
    }
    
    // B. Match work authorization
    const authRegex = [/authorized\s*to\s*work/i, /legally\s*authorized/i];
    if (fuzzyLabelMatch(cb.labelText, authRegex)) {
      checked = true;
      logs.push(`Checked work authorization checkbox (Label: "${cb.labelText}")`);
    }

    if (checked && !cb.checked) {
      try {
        const checkboxLoc = page.locator(cb.selector).nth(cb.index);
        const labelLoc = page.locator(`label[for="${cb.id}"]`);
        if (cb.id && await labelLoc.count() > 0 && await labelLoc.isVisible()) {
          await labelLoc.click();
        } else {
          await checkboxLoc.check({ force: true });
        }
      } catch (e) {
        // Fallback: check in-browser
        try {
          await page.evaluate(({ selector, index }) => {
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
  }

  // 5. Fill Radio Groups
  for (const group of domLayout.radioGroups) {
    for (const matcher of choiceMatchers) {
      if (fuzzyLabelMatch(group.groupLabel, matcher.regex)) {
        const bestOpt = findBestOption(group.options, matcher.keywords, matcher.fallback);
        if (bestOpt) {
          try {
            const radioLabel = page.locator(`label[for="${bestOpt.id}"]`);
            if (bestOpt.id && await radioLabel.count() > 0 && await radioLabel.isVisible()) {
              await radioLabel.click();
            } else {
              await page.locator(bestOpt.selector).nth(bestOpt.index).click({ force: true });
            }
            logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}"`);
          } catch (e) {
            try {
              await page.locator(bestOpt.selector).nth(bestOpt.index).click({ force: true });
              logs.push(`Selected radio option "${bestOpt.label}" for group "${group.groupLabel}" (forced)`);
            } catch (clickErr) {
              logs.push(`⚠️ Failed to select radio option for "${group.groupLabel}": ${clickErr.message}`);
            }
          }
        }
        break;
      }
    }
  }

  // Summary of fills
  console.log(`\n${colors.green}✅ Form filling complete!${colors.reset}`);
  if (logs.length === 0) {
    console.log(`   - ${colors.dim}No fields were auto-filled by matchers.${colors.reset}`);
  }
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
  
  // Try matching markdown link [text](url)
  const mdMatch = content.match(/\*\*URL:\*\*\s*\[[^\]]+\]\((https?:\/\/[^\s\)]+)\)/i);
  if (mdMatch) return mdMatch[1].trim();

  // Fallback to simple URL match
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
    let answerBody = lines.slice(1).join('\n').replace(/^>\s*/gm, '').trim();
    
    // Clean up draft response prefixes (e.g. "**Draft Response:**", "**Response:**", etc.)
    answerBody = answerBody
      .replace(/^\*\*Draft\s*Response:\*\*\s*/i, '')
      .replace(/^\*\*Response:\*\*\s*/i, '')
      .replace(/^Draft\s*Response:\s*/i, '')
      .replace(/^Response:\s*/i, '')
      .trim();
    
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
  let argSubmit = false;

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
      argSubmit = true;
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
  const profile = loadProfile();
  const resumePath = findLatestResume();

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
    browser = await chromium.connectOverCDP('http://localhost:9222', { noDefaults: true });
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No active Chrome profiles/contexts found.');
    }
    const context = contexts[0];
    const pages = context.pages();
    let page = null;
    
    // Normalize url for comparison
    // Force a fresh tab to avoid any locked or paused states in existing tabs
    /*
    const normJobUrl = jobUrl.toLowerCase().split('?')[0].replace(/\/$/, '');
    for (const p of pages) {
      try {
        const u = p.url().toLowerCase().split('?')[0].replace(/\/$/, '');
        if (u.includes(normJobUrl) || normJobUrl.includes(u)) {
          console.log(`${colors.green}✅ Found an existing tab open with this job URL! Attaching to it...${colors.reset}`);
          page = p;
          break;
        }
      } catch (err) {
        // Ignore page errors
      }
    }
    */

    if (!page) {
      console.log(`${colors.cyan}No existing tab found for this URL. Creating a new tab...${colors.reset}`);
      page = await context.newPage();
      console.log(`${colors.cyan}Navigating to job application page...${colors.reset}`);
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });
      console.log(`${colors.green}Page loaded successfully!${colors.reset}`);
    } else {
      // Bring tab to front
      try {
        await page.bringToFront();
      } catch (e) {
        // Ignore errors bringing to front
      }
    }

    // Click Apply button if present to scroll/reveal the form
    try {
      const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply"), [class*="apply-button"]').first();
      if (await applyBtn.isVisible()) {
        console.log(`${colors.cyan}🤖 Found an "Apply" button. Clicking to scroll/reveal the form...${colors.reset}`);
        await applyBtn.click();
        await page.waitForTimeout(1500); // Wait for transition/scroll/render
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
    await autofillForm(page, profile, resumePath, customAnswers);

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

    if (argSubmit) {
      console.log(`\n${colors.bright}${colors.bgMagenta}🚀 USER OVERRIDE: Submitting application...${colors.reset}`);
      try {
        // Find submit button
        const submitBtn = page.locator('button:has-text("Submit application"), button:has-text("Submit Application"), [id*="submit-button"], [id*="submit_app"]').first();
        if (await submitBtn.count() > 0 && await submitBtn.first().isVisible()) {
          console.log(`${colors.cyan}🤖 Found submit button with text: "${await submitBtn.first().innerText()}"${colors.reset}`);
          console.log(`${colors.yellow}Clicking submit...${colors.reset}`);
          await submitBtn.first().click();
          console.log(`${colors.green}✅ Clicked submit! Waiting 5s for page transition/confirmation...${colors.reset}`);
          await page.waitForTimeout(5000);
          
          // Verify if submitted successfully
          const currentUrl = page.url();
          const currentTitle = await page.title();
          console.log(`Current URL: ${currentUrl}`);
          console.log(`Current Title: ${currentTitle}`);
          
          if (currentUrl.includes('confirmation') || currentUrl.includes('thank-you') || currentUrl.includes('thanks') || currentTitle.toLowerCase().includes('thank') || currentTitle.toLowerCase().includes('success')) {
            console.log(`\n${colors.bright}${colors.green}🎉 Application submitted successfully!${colors.reset}`);
            // Automatically mark as Applied in tracker
            const ok = updateApplicationStatus(app.id, 'Applied');
            if (ok) console.log(`${colors.green}🎉 Successfully marked application #${app.id} as "Applied"!${colors.reset}`);
          } else {
            console.log(`\n${colors.yellow}⚠️ Application click executed. Please double check your Chrome browser tab to ensure no validation errors occurred.${colors.reset}`);
            console.log(`If it submitted successfully, run:\n    node scratch/apply_automator.mjs --id ${app.id} --status Applied`);
          }
        } else {
          console.error(`${colors.red}Error: Could not locate a visible Submit button on the page.${colors.reset}`);
        }
      } catch (submitErr) {
        console.error(`${colors.red}Error during submit: ${submitErr.message}${colors.reset}`);
      }
      
      await browser.close();
      return;
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
    }

    // Clean up Playwright CDP session
    await browser.close();
    console.log(`\nSession closed. Retrying main dashboard...`);
    setTimeout(main, 1500);

  } catch (error) {
    console.error(`${colors.red}Playwright/CDP Error: ${error.message}${colors.reset}`);
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // ignore
      }
    }
    if (nonInteractive) {
      process.exit(1);
    }
    await askQuestion('\nPress [Enter] to return to the main dashboard...');
    main();
  }
}

main().catch(console.error);
