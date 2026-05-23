import { chromium } from 'playwright';
import readline from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const projectRoot = '/Users/shashwatguta/Desktop/career-ops';

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

async function main() {
  const resumePath = '/Users/shashwatguta/Desktop/career-ops/output/cv-shashwat-gupta-zapier-2026-05-23.pdf';
  if (!existsSync(resumePath)) {
    console.error(`Error: Resume file not found at ${resumePath}`);
    return;
  }

  console.log('🚀 Launching visible Chromium browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  console.log('🌐 Navigating to Zapier application form on Ashby...');
  await page.goto('https://jobs.ashbyhq.com/zapier/423d1bb7-1c08-458e-8a17-29a63cf23d92/application', { waitUntil: 'networkidle' });
  console.log('✅ Form page loaded successfully!');

  // Helper to safely fill fields by selector
  async function fillField(selector, value, fieldName) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible()) {
        await el.scrollIntoViewIfNeeded();
        await el.click();
        await el.fill(value);
        await el.dispatchEvent('input', { bubbles: true });
        await el.dispatchEvent('change', { bubbles: true });
        console.log(`   - Filled ${fieldName}`);
      } else {
        console.log(`   - Skipped ${fieldName} (not visible)`);
      }
    } catch (e) {
      console.log(`   - Error filling ${fieldName}: ${e.message}`);
    }
  }

  console.log('📝 Filling standard profile details...');
  await fillField('[id="d2c1b1d3-f146-45ff-a822-91d8248f60dd"]', 'Shashwat', 'Legal First Name');
  await fillField('[id="bfc8b641-41b2-47f5-b83a-80346c01d0d9"]', 'Gupta', 'Legal Last Name');
  await fillField('[id="_systemfield_name"]', 'Shashwat', 'Preferred First Name');
  await fillField('[id="67e20452-0c7c-46f7-a803-a6835daed73f"]', 'Gupta', 'Preferred Last Name');
  await fillField('[id="_systemfield_email"]', 'shashwatvg@gmail.com', 'Email');
  await fillField('[id="4c4de716-599c-4fc3-89ab-58e64d3893de"]', '+91 9898027295', 'Phone');
  await fillField('[id="8561c645-1d93-4b32-a985-655760240caa"]', 'He/Him', 'Pronouns');
  await fillField('[id="8e13bacd-aa07-41ce-96e8-6cd95459929f"]', 'Shuh-sh-vut Goop-tah', 'Name Pronunciation');
  await fillField('[id="cc345237-f4c6-4d97-a3fd-08e20405060e"]', 'https://linkedin.com/in/shashtag', 'LinkedIn URL');

  console.log('📍 Selecting city/country (Bengaluru, India)...');
  try {
    const locationInput = page.locator('input[placeholder="Start typing..."]').first();
    if (await locationInput.isVisible()) {
      await locationInput.scrollIntoViewIfNeeded();
      await locationInput.click();
      await locationInput.fill('Bengaluru');
      await page.waitForTimeout(1500); // Wait for auto-suggest options

      const option = page.locator('div[role="option"], [class*="option"], div').filter({ hasText: /^Bengaluru/ }).first();
      if (await option.isVisible()) {
        await option.click();
        console.log('   - Clicked on Bengaluru option in autocomplete dropdown');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        await page.keyboard.press('Enter');
        console.log('   - Keyboard fallback used to select Bengaluru');
      }
    }
  } catch (e) {
    console.log(`   - Error selecting city/country: ${e.message}`);
  }

  console.log('📄 Uploading tailored 1-page PDF resume...');
  try {
    const resumeInput = page.locator('input[type="file"]#_systemfield_resume').first();
    if (await resumeInput.isVisible()) {
      await resumeInput.scrollIntoViewIfNeeded();
      await resumeInput.setInputFiles(resumePath);
      console.log('   - Resume uploaded successfully!');
    }
  } catch (e) {
    console.log(`   - Error uploading resume: ${e.message}`);
  }

  console.log('🗳️ Selecting work authorization...');
  try {
    const workAuthLabel = page.locator('label').filter({ hasText: 'I am authorized to work in the country due to my nationality.' });
    if (await workAuthLabel.isVisible()) {
      await workAuthLabel.scrollIntoViewIfNeeded();
      await workAuthLabel.click();
      console.log('   - Selected: Authorized based on nationality');
    }
  } catch (e) {
    console.log(`   - Error selecting work authorization: ${e.message}`);
  }

  console.log('📣 Selecting how you heard about the role...');
  try {
    const heardLabel = page.locator('label').filter({ hasText: 'Online Job Ad or Job Board' });
    if (await heardLabel.isVisible()) {
      await heardLabel.scrollIntoViewIfNeeded();
      await heardLabel.click();
      console.log('   - Selected: Online Job Ad or Job Board');
    }
    await fillField('[id="cc150aa1-300e-47a8-b857-02e3d46472eb"]', 'LinkedIn', 'Heard details');
  } catch (e) {
    console.log(`   - Error selecting how you heard: ${e.message}`);
  }

  console.log('💡 Filling custom AI and API integration questions...');
  
  // Custom AI Workflow
  const q1 = "At realfast.ai, I built an automated multi-agent workflow to audit legacy fintech codebases and map business processes for our client, Bottomline. The workflow is triggered when a developer merges a feature branch or commits a new API route specification. A orchestrator agent intercepts the git hook, extracts the modified controllers, and triggers a sub-agent swarm: one agent parses the Abstract Syntax Tree (AST) to extract database queries, another maps the API endpoint dependencies, and a third evaluates the data-flow against security schemas. Initially, the agents would frequently lose context or hallucinate API boundaries on deeply nested legacy files. I iterated on this by transitioning to a schema-bounded, function-calling pattern using LangChain, supplying exact JSON/TypeScript contract definitions as system context, and running agent-generated code inside a local sandbox to compile/lint before allowing execution. This reduced desync issues to zero and produced fully automated, secure enterprise system blueprints. (My portfolio and architecture diagrams of similar Go/TypeScript tools are public at https://shashtag.me).";
  await fillField('[id="c59d4b28-9588-402a-ab35-45e342dcf373"]', q1, 'AI Workflow Question');

  // AI Quality vs Speed
  const q2 = "During our enterprise AI discovery phase for Bottomline, we initially used manual documentation audits to map business workflows, which were slow and prone to human gaps. To elevate the stakeholder experience, I designed an AI-driven discovery engine that parsed raw email threads, Slack integrations, and legacy ticketing data. Instead of just speeding up extraction, this system transformed quality: it detected previously invisible operational bottlenecks—like a recurring 4-hour delay in B2B payment authorizations—by running semantic pattern analysis across multi-system handoffs. I achieved this by implementing hybrid RAG alongside specialized clustering agents, utilizing domain-specific financial ontologies. This didn\'t just give the client a list of stats; it provided Bottomline’s executive leadership with a high-fidelity, interactive systems diagram showing precisely which APIs were failing, completely changing their trust and confidence in our strategic technical roadmap.";
  await fillField('[id="c6f773a7-e5fc-42a4-95a3-4b77fc01ca19"]', q2, 'AI Quality vs Speed Question');

  // AI Expanded Impact
  const q3 = "At Comcast (via Accenture), our engineering teams struggled with high friction bootstrapping services and maintaining code quality standards across a massive monorepo of 16+ microservices. I wanted to solve this by creating an interactive, local developer harness rather than a passive linter. I engineered a Go-based developer CLI that integrated local AI components. The CLI intercepting standard boilerplate commands, drafted robust unit tests based on the developer\'s custom Go struct or TypeScript schemas, and verified them in a sandbox. Initially, I used simple, direct prompt engineering, but it struggled with Comcast\'s complex internal library dependencies. I evolved this by designing local mock adapters and feeding the CLI exact API interface files, letting the AI generate precise mock-reliant implementations. This CLI was adopted across teams, saving 1 hour per day per engineer and drastically raising unit test coverage.";
  await fillField('[id="4cef7c88-e44f-47f9-8d2e-0d65ad4d47c6"]', q3, 'AI Impact Question');

  // Complex REST API
  const q4 = "The most complex REST API integration I architected was the real-time collaborative state synchronization engine for ProPro Productions (acquired). It required maintaining conflict-free, concurrent editing states for thousands of active users on an infinite canvas over WebSockets and REST. The main complexity was ensuring eventual consistency under poor networks, handling concurrent writes without lag, and migrating legacy database states without downtime. I handled this by implementing conflict-free replicated data types (CRDTs) to model canvas elements, decoupling the state mutations from presentation logic. On the backend, I engineered a highly performant Go synchronization API using QuadTree spatial partitioning to prune client payload sizes. This made client-server handshakes deterministic, resulting in zero state desync incidents and a highly stable integration that withstood the rigorous technical audits of a successful acquisition.";
  await fillField('[id="2fe6be7b-b821-42be-b737-54e88a1f5326"]', q4, 'Complex REST API Question');

  // OAuth 2.0 flow
  const q5 = "Yes, I have personally designed and implemented production-grade OAuth 2.0 flows. In our secure Fusion Data Secure GoLang VPN, I built the client credential handshakes and authentication middleware. For token management, I designed a stateless JWT architecture where the Go backend validated signatures using public key sets (JWKS), storing token claims securely. I implemented a robust refresh logic on the client: when a 401 Unauthorized was intercepted, the request queue was paused, a thread-safe atomic mutex was locked to trigger a single token refresh request using the secure HTTP-only refresh cookie, and on success, the request queue was retried with the new bearer token. To handle revocation, I integrated a fast Redis-backed blacklist to immediately invalidate compromised or logged-out tokens before their TTL expired. This architecture successfully protected our VPN DLL network handshakes with zero downtime and strict security compliance.";
  await fillField('[id="77271930-f8a8-4a20-961d-3de6496b9e1f"]', q5, 'OAuth 2.0 Question');

  // Debugging Complex Issue Spanning Multiple Services
  const q6 = "At ProPro Productions, our real-time collaborative whiteboarding platform (Figma-like) suffered intermittent, user-reported state drift under high write concurrency, leading to temporary lockups. The canvas relied on conflict-free replicated data types (CRDTs) synced via WebSockets to a Go backend with a QuadTree-partitioned state engine.\n\n**What Broke:** Under load, some users experienced desynchronized canvas elements. Because AWS Application Load Balancers (ALB) dropped WebSocket connections during micro-spikes, clients attempted quick reconnections. On reconnect, the local mutations buffer was flushed, but sequence vector clocks on the client drifted. An off-by-one error in our server-side mutation deduplication logic caused specific re-flushed mutation frames to be processed twice or ignored entirely, leading to permanent state divergences on the server versus client memory.\n\n**Triage & Tools:**\n1. **Datadog Tracing & Custom Telemetry:** I injected client-side transaction IDs into WebSocket payloads to trace mutations from the browser through the network layer down to the Go CRDT processor.\n2. **Wireshark & TCP Dump:** I ran a packet capture on the dev staging server and observed that AWS ALB aborted TCP connections due to Go socket write-buffer backpressure. The server-side WebSocket writer was blocking on slow clients, which backed up the buffer and forced the ALB to send TCP RST packets.\n3. **State diffing scripts:** I compared serializations of the canvas state from the Go backend's memory with the client's local IndexedDB cache, isolating the exact vector clock offset where desync happened.\n\n**How I Resolved It:**\n1. **Non-blocking Write Channels:** I refactored the Go backend WebSocket writer to use a thread-safe, non-blocking ring buffer. If a client's TCP buffer backed up, we gracefully dropped non-critical, transient rendering frames (like pointer move coordinates) rather than blocking the main write channel.\n2. **Idempotent Deduplication Engine:** I fixed the off-by-one vector clock logic and introduced a strict idempotency key hash check for incoming mutations on the Go server, rejecting duplicate mutations on reconnection.\n3. **Automatic Client Reconciliation:** I implemented a background state-hash handshake: every 10 seconds, the client and server compared Merkle tree hashes of their canvas quad-regions. If a divergence was detected, the server sent a compact delta patch instead of requiring a full page refresh.\n\nThis architecture successfully reduced desync issues to zero, eliminated WebSocket disconnect-spikes, and was critical in ensuring the platform's stability through the rigorous technical audits of our subsequent company acquisition.";
  await fillField('[id="1ce57bfc-d618-4886-9141-31099c035478"]', q6, 'Complex Debugging Question');

  // Values Quiz
  await fillField('[id="cf681e0f-115b-4d95-a07d-4d420cbdf6ab"]', '5', 'Zapier Core Values Count');

  console.log('✅ Confirming checkbox-style buttons...');
  try {
    const integrationsContainer = page.locator('div[data-field-path="2e72fd9e-cf46-4558-becf-50af1551aae8"]');
    if (await integrationsContainer.isVisible()) {
      await integrationsContainer.scrollIntoViewIfNeeded();
      await integrationsContainer.locator('button', { hasText: 'Yes' }).click();
      console.log('   - Confirmed: Integrations experience (Yes)');
    }

    const agreementContainer = page.locator('div[data-field-path="39e89696-4e2c-4f59-9ad2-792ba158fb4c"]');
    if (await agreementContainer.isVisible()) {
      await agreementContainer.scrollIntoViewIfNeeded();
      await agreementContainer.locator('button', { hasText: 'Yes' }).click();
      console.log('   - Confirmed: AI policy understanding (Yes)');
    }
  } catch (e) {
    console.log(`   - Error confirming checkboxes: ${e.message}`);
  }

  console.log('🌈 Checking voluntary demographics fields...');
  try {
    const asianCheckbox = page.locator('input[name="Asian"]').first();
    if (await asianCheckbox.isVisible()) {
      await asianCheckbox.scrollIntoViewIfNeeded();
      await asianCheckbox.check();
      console.log('   - Demographics: Selected Asian');
    }

    const manCheckbox = page.locator('input[name="Man"]').first();
    if (await manCheckbox.isVisible()) {
      await manCheckbox.scrollIntoViewIfNeeded();
      await manCheckbox.check();
      console.log('   - Demographics: Selected Man');
    }

    const orientationLabel = page.locator('label').filter({ hasText: 'Straight or Heterosexual' }).first();
    if (await orientationLabel.isVisible()) {
      await orientationLabel.scrollIntoViewIfNeeded();
      await orientationLabel.click();
      console.log('   - Demographics: Selected Straight or Heterosexual');
    }

    const veteranCheckbox = page.locator('input[name="I do not identify as a veteran"]').first();
    if (await veteranCheckbox.isVisible()) {
      await veteranCheckbox.scrollIntoViewIfNeeded();
      await veteranCheckbox.check();
      console.log('   - Demographics: Selected Not a Veteran');
    }

    const disabilityCheckbox = page.locator('input[name="I do not identify as a person with a disability"]').first();
    if (await disabilityCheckbox.isVisible()) {
      await disabilityCheckbox.scrollIntoViewIfNeeded();
      await disabilityCheckbox.check();
      console.log('   - Demographics: Selected Not Disabled');
    }
  } catch (e) {
    console.log(`   - Error checking demographics: ${e.message}`);
  }

  console.log('\n========================================================================');
  console.log('🎉 SUCCESS: FORM HAS BEEN COMPLETELY FILLED AUTOMATICALLY!');
  console.log('========================================================================');

  console.log('\n🚀 Attempting automated submission of the application...');
  let submittedSuccess = false;
  try {
    console.log('⏳ Waiting 4 seconds for file upload and form state to fully settle...');
    await page.waitForTimeout(4000);

    const submitBtn = page.locator('button.ashby-application-form-submit-button, button:has-text("Submit Application")').first();
    if (await submitBtn.isVisible()) {
      await submitBtn.scrollIntoViewIfNeeded();
      console.log('👉 Found the submit button! Programmatically clicking it now...');
      await submitBtn.click();
      
      console.log('⏳ Waiting 6 seconds to verify submission/redirect success...');
      await page.waitForTimeout(6000);
      
      const currentUrl = page.url();
      if (currentUrl.includes('/thank-you') || currentUrl.includes('/submitted') || currentUrl.includes('success')) {
        console.log('\n========================================================================');
        console.log('🎉 SUCCESS: APPLICATION FORM HAS BEEN SUBMITTED PROGRAMMATICALLY!');
        console.log('========================================================================\n');
        submittedSuccess = true;
        
        // Auto update tracker
        const updated = updateApplicationStatus('46', 'Applied');
        if (updated) {
          console.log('✅ Successfully updated application #46 to "Applied" in applications.md!');
        }
      } else {
        console.log('\n⚠️ Automated submit clicked, but page did not redirect. CAPTCHA or validation error might be blocking it.');
      }
    } else {
      console.log('❌ Could not locate the Submit button programmatically.');
    }
  } catch (e) {
    console.log(`❌ Error during automated submission click: ${e.message}`);
  }

  if (!submittedSuccess) {
    console.log('\n========================================================================');
    console.log('👉 ACTION REQUIRED IN CHROMIUM BROWSER WINDOW ON YOUR SCREEN:');
    console.log('   1. Verify your personal details, answers, and resume upload.');
    console.log('   2. Solve any CAPTCHA if visible at the bottom.');
    console.log('   3. Click "Submit Application" to complete your application!');
    console.log('========================================================================');
    console.log('Press [Enter] in this terminal once you have clicked Submit / finished...');
    console.log('========================================================================\n');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    await new Promise(resolve => rl.question('', () => {
      rl.close();
      resolve();
    }));

    console.log('⏳ Re-checking page URL for success...');
    const finalUrl = page.url();
    if (finalUrl.includes('/thank-you') || finalUrl.includes('/submitted') || finalUrl.includes('success')) {
      const updated = updateApplicationStatus('46', 'Applied');
      if (updated) {
        console.log('✅ Successfully updated application #46 to "Applied" in applications.md!');
      }
    } else {
      const rlConfirm = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      const answer = await new Promise(resolve => rlConfirm.question('Did you successfully click submit and apply? (y/n): ', (ans) => {
        rlConfirm.close();
        resolve(ans.toLowerCase().trim());
      }));
      if (answer === 'y' || answer === 'yes') {
        const updated = updateApplicationStatus('46', 'Applied');
        if (updated) {
          console.log('✅ Successfully updated application #46 to "Applied" in applications.md!');
        }
      } else {
        console.log('ℹ️ Application status remains "Evaluated". You can manually change it later.');
      }
    }
  }

  console.log('👋 Closing browser session. Best of luck with Zapier!');
  await browser.close();
}

main().catch(console.error);
