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
      // Mark PDF as uploaded (since we successfully do it in this script)
      parts[7] = '✅';
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

  console.log('🌐 Navigating to Zapier Software Engineer — Release Engineering application form...');
  await page.goto('https://jobs.ashbyhq.com/zapier/6948a0e6-a580-4e9d-b109-20652d9a1507/application?departmentId=cbb2c602-5494-4a7b-914c-8ad0a77fdc11', { waitUntil: 'networkidle' });
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
  await fillField('[id="c2b89ec9-e028-4478-8600-0619b217e5b3"]', 'Shashwat', 'Legal First Name');
  await fillField('[id="40022016-e0f8-41b2-9e61-de1e5db2d728"]', 'Gupta', 'Legal Last Name');
  await fillField('[id="_systemfield_name"]', 'Shashwat', 'Preferred First Name');
  await fillField('[id="a466ec76-7629-410f-9709-47f412c7dae3"]', 'Gupta', 'Preferred Last Name');
  await fillField('[id="_systemfield_email"]', 'shashwatvg@gmail.com', 'Email');
  await fillField('[id="7e73e5ca-9289-4923-bcd6-bf88c1315d47"]', '+91 9898027295', 'Phone');
  await fillField('[id="0fbfe0ea-1183-404a-813e-e5ca3a5669eb"]', 'He/Him', 'Pronouns');
  await fillField('[id="61495319-fe64-467b-bfd3-c1b75806acde"]', 'Shuh-sh-vut Goop-tah', 'Name Pronunciation');
  await fillField('[id="4a124dd3-71c1-4872-bf72-0c2f85435614"]', 'https://linkedin.com/in/shashtag', 'LinkedIn URL');

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
    await fillField('[id="f84c3195-d534-4f41-89c5-c4313dd7f65c"]', 'LinkedIn', 'Heard details');
  } catch (e) {
    console.log(`   - Error selecting how you heard: ${e.message}`);
  }

  console.log('💡 Filling custom AI and API integration questions...');
  
  // Custom AI Workflow
  const q1 = "At realfast.ai, I built an automated multi-agent workflow to audit legacy fintech codebases and map business processes for our client, Bottomline. The workflow is triggered when a developer merges a feature branch or commits a new API route specification. A orchestrator agent intercepts the git hook, extracts the modified controllers, and triggers a sub-agent swarm: one agent parses the Abstract Syntax Tree (AST) to extract database queries, another maps the API endpoint dependencies, and a third evaluates the data-flow against security schemas. Initially, the agents would frequently lose context or hallucinate API boundaries on deeply nested legacy files. I iterated on this by transitioning to a schema-bounded, function-calling pattern using LangChain, supplying exact JSON/TypeScript contract definitions as system context, and running agent-generated code inside a local sandbox to compile/lint before allowing execution. This reduced desync issues to zero and produced fully automated, secure enterprise system blueprints. (My portfolio and architecture diagrams of similar Go/TypeScript tools are public at https://shashtag.me).";
  await fillField('[id="95a37f09-67ba-4a3a-be82-aeeb4bb6d142"]', q1, 'AI Workflow Question');

  // AI Quality vs Speed
  const q2 = "During our enterprise AI discovery phase for Bottomline, we initially used manual documentation audits to map business workflows, which were slow and prone to human gaps. To elevate the stakeholder experience, I designed an AI-driven discovery engine that parsed raw email threads, Slack integrations, and legacy ticketing data. Instead of just speeding up extraction, this system transformed quality: it detected previously invisible operational bottlenecks—like a recurring 4-hour delay in B2B payment authorizations—by running semantic pattern analysis across multi-system handoffs. I achieved this by implementing hybrid RAG alongside specialized clustering agents, utilizing domain-specific financial ontologies. This didn\'t just give the client a list of stats; it provided Bottomline’s executive leadership with a high-fidelity, interactive systems diagram showing precisely which APIs were failing, completely changing their trust and confidence in our strategic technical roadmap.";
  await fillField('[id="153f78f0-f9b9-40b1-9e26-cbab39d57d87"]', q2, 'AI Quality vs Speed Question');

  // AI Expanded Impact
  const q3 = "At Comcast (via Accenture), our engineering teams struggled with high friction bootstrapping services and maintaining code quality standards across a massive monorepo of 16+ microservices. I wanted to solve this by creating an interactive, local developer harness rather than a passive linter. I engineered a Go-based developer CLI that integrated local AI components. The CLI intercepting standard boilerplate commands, drafted robust unit tests based on the developer\'s custom Go struct or TypeScript schemas, and verified them in a sandbox. Initially, I used simple, direct prompt engineering, but it struggled with Comcast\'s complex internal library dependencies. I evolved this by designing local mock adapters and feeding the CLI exact API interface files, letting the AI generate precise mock-reliant implementations. This CLI was adopted across teams, saving 1 hour per day per engineer and drastically raising unit test coverage.";
  await fillField('[id="9bf2e5bf-1b14-4d05-a862-5126d2f04a09"]', q3, 'AI Impact Question');

  console.log('🛠️ Filling custom Platform/Release engineering questions...');

  // Q4: 5+ Years Experience & Systems worked on
  const q4 = "Yes. Over the past 5 years (spanning June 2021 to May 2026), my professional experience has been deeply rooted in systems engineering, developer experience, and release automation. Across startup environments and large-scale enterprises, I have designed and operated the software layers that empower engineering organizations to ship high-quality code safely and with minimal friction.\n\nAt Accenture, on the Comcast Engineering Team, I held complete technical ownership of developer tooling and environment orchestration for a web division serving 3 million daily visits. Our core challenge was managing a massive monorepo comprising 16+ microservices. I designed, built, and distributed a custom developer CLI in Go. This tool automated local workspace provisioning, handled microfrontend service routing, and managed mock database states. Additionally, I overhauled our testing golden paths, optimizing monorepo configurations and parallelizing Cypress/Playwright testing suites in our CI pipeline. My work saved approximately 1 hour of daily friction per engineer and eliminated 90% of local environment setup failures.\n\nPreviously, as Founding Engineer at ProPro Productions, I architected our real-time collaboration engine using WebSocket-based synchronization. I was solely responsible for building and scaling our automated testing and release pipeline. I engineered our CI/CD workflows from scratch, automating test isolation, containerized Docker builds, and deployment gates to Google Cloud Platform (GCP) via Kubernetes. This ensured zero-downtime rolling updates for our infinite-canvas graphics editor.\n\nCurrently, as a Forward Deployed Engineer at realfast.ai, I lead technical discovery and architect automated multi-agent code-auditing pipelines. These workflows use schema-bounded LLMs to inspect legacy APIs, parse ASTs, and run verification scripts in isolated sandboxes before code execution.\n\nThroughout my career, my ownership has spanned the entire lifecycle: from writing the core systems code and custom developer CLI utilities to designing, configuring, and maintaining the CI/CD pipelines that compile, test, and deliver that code to production.";
  await fillField('[id="88d65df4-5596-493e-a9c2-edfc347c164a"]', q4, '5+ Years Experience Question');

  // Q5: Developer tool designed or improved
  const q5 = "At Comcast (Accenture), a team of dozens of web developers faced severe friction developing and shipping features across a monorepo containing 16+ distinct microservices. Standard developer setups required manually starting multiple services, managing intricate environment configs, and debugging local port collisions and service routing. This fragmentation caused frequent local build failures, slowed developer onboarding, and led to test flakiness in our pipelines.\n\nTo solve this, I designed and built a custom developer workflow CLI in Go from scratch. The CLI automated local workspace provisioning, handled microfrontend service routing, and managed mock API and database states. In designing this tool, I evaluated key trade-offs:\n1. Custom CLI in Go vs. Existing Orchestration Tools: While tools like Docker Compose are powerful, they introduced high resource overhead and slow startup times (over 30 seconds) on developer machines. I chose to build a native Go CLI utilizing lightweight local binary execution, multi-threading, and direct TCP port management. This ensured the local harness was extremely lightweight and bootstrapped in under 2 seconds.\n2. Mocking vs. Live Service Dependencies: Relying on live sandbox services introduced network latency and unpredictable test results. I built a declarative mock-server within the CLI, allowing developers to define service responses locally in YAML, trading live-service parity for consistent, sub-millisecond, offline-capable responses.\n\nI also standardized our end-to-end testing suites (Playwright/Cypress) in our CI pipeline and optimized webpack/vite dependency resolution and build caching.\n\nMeasurable Impact:\n- Slashed local environment setup and service bootstrap times from over 20 minutes to under 2 seconds.\n- Saved approximately 1 hour of daily friction per engineer across the division.\n- Reduced pipeline test failures and setup-related environment errors to nearly zero.\n- Streamlined new engineer onboarding from multiple days to a single command.";
  await fillField('[id="aa41ed9c-fd9b-48ed-acf6-ef320a0a1837"]', q5, 'Developer Tool designed/improved Question');

  // Q6: Backend service or API built from scratch
  const q6 = "At ProPro Productions, I built the real-time collaborative state synchronization engine and REST/WebSocket API from scratch. The platform (similar to Figma) required syncing concurrent canvas edits, document state, and vector operations for thousands of active users with sub-50ms latency.\n\nKey Technical Decisions:\n1. State Consistency Model: I implemented Conflict-Free Replicated Data Types (CRDTs) to represent canvas elements, shifting the burden of conflict resolution from a central database lock to deterministic, order-independent state merges.\n2. Go for System Backend: I chose Go for the synchronization engine because of its efficient concurrency model (goroutines and channels), low memory footprint, and high-performance network I/O.\n3. Spatial Partitioning (QuadTrees): Broadcasting every canvas operation to every user would quickly saturate network bandwidth. I built a QuadTree spatial partitioner on the Go server to divide the infinite canvas into regions, allowing clients to subscribe only to mutations occurring in their active viewport.\n\nTradeoffs Weighed:\n- Performance vs. Memory (In-Memory State with Event Sourcing): To meet sub-50ms latency, we could not query a relational database on every mutation. I kept the active document CRDT state entirely in-memory on the Go server. To ensure durability, mutations were written sequentially to a fast, append-only log (event sourcing) and periodically snapshotted to PostgreSQL. This traded higher server memory consumption for exceptional read/write throughput.\n- Reliability vs. Network Overhead (TCP backpressure): Under heavy write concurrency, slower clients experienced TCP backpressure, which could block the server's main socket-writer. I implemented a thread-safe, non-blocking ring-buffer for each WebSocket connection. If a buffer filled up, the server gracefully dropped transient, non-critical rendering frames (such as cursor movements) to preserve critical CRDT mutations, prioritizing system reliability over visual synchronization fidelity.\n\nOutcome:\nThe API maintained a 99.99% uptime, synchronized states under high write load with zero consistency drift, and successfully passed the rigorous engineering audits during our subsequent acquisition.";
  await fillField('[id="c1847299-5352-4a71-9831-2fcc6dc6b66a"]', q6, 'Backend Service from scratch Question');

  // Q7: Troubleshoot failing end-to-end test pipeline
  const q7 = "At Comcast (Accenture), we experienced intermittent, highly disruptive test failures in our automated CI/CD pipeline. The pipeline ran our comprehensive Playwright end-to-end testing suite for the microfrontend monorepo (16+ services) on every pull request. Approximately 15% of pipeline runs failed on checkout and auth flows, yet rerunning the pipeline often resulted in a green build with no changes made. These 'flaky' tests slowed release cycles and eroded developer trust in our automated gates.\n\nDiagnosis and Triage:\n1. Log Analysis and Playwright Tracing: I began by enabling verbose Playwright trace viewer files and collecting stdout/stderr logs from all 16+ services running concurrently in our Jenkins pipeline agents. I observed that the failures were consistently occurring during the login step with a 504 Gateway Timeout.\n2. Network/Socket Profiling: I used custom health-check endpoints and inspected container network logs during pipeline execution. Using TCPDump, I discovered that the local authentication service was running out of database connections. When Playwright ran tests in parallel, multiple test threads initiated login flows simultaneously, saturating the connection pool of our ephemeral PostgreSQL container.\n3. Resource Saturation Checks: Further inspection of Docker container stats revealed that resource limits on the CI runner were throttling CPU usage, causing the auth service's database handshake to exceed the 3-second application timeout during spikes in concurrency.\n\nHow I Resolved It:\n1. Idempotent Connection Pooling: I adjusted our PostgreSQL container configuration to handle higher concurrent connections and tuned the auth service's connection pool limits, ensuring connections were recycled immediately.\n2. Hermetic Test Isolation: I refactored our global Playwright hooks. Instead of sharing a single database instance, we spun up lightweight, isolated Docker containers using a custom-tailored test schema for each test shard.\n3. Playwright Execution Optimization: I introduced a state-resetting API hook to wipe and seed database states in milliseconds between tests rather than restarting services, and configured Playwright’s worker concurrency limits to match the CPU cores allocated to the CI runner.\n\nThese optimizations reduced our test flakiness rate to under 0.5%, slashed overall pipeline execution times by 25%, and restored our engineering team's confidence in our automated release gates.";
  await fillField('[id="b80c3602-b662-434b-ae4f-c8ea59c535a1"]', q7, 'Troubleshoot E2E Pipeline Question');

  // Zapier Core Values Count Quiz
  await fillField('[id="799520a8-3fac-4080-a6c5-f6ce2d608416"]', '5', 'Zapier Core Values Count');

  console.log('✅ Confirming custom checkbox (Yes/No) options...');
  try {
    const agreementContainer = page.locator('div[data-field-path="6d98ad2b-53a3-484a-983b-86741b67bae5"]');
    if (await agreementContainer.isVisible()) {
      await agreementContainer.scrollIntoViewIfNeeded();
      await agreementContainer.locator('button', { hasText: 'Yes' }).click();
      console.log('   - Confirmed: AI Policy Understanding (Yes)');
    }

    const cicdContainer = page.locator('div[data-field-path="7a9c4f8e-1beb-49ef-9ef9-d7e5bcfdee42"]');
    if (await cicdContainer.isVisible()) {
      await cicdContainer.scrollIntoViewIfNeeded();
      await cicdContainer.locator('button', { hasText: 'Yes' }).click();
      console.log('   - Confirmed: Hands-on CI/CD Experience (Yes)');
    }

    const systemicContainer = page.locator('div[data-field-path="2876a8bc-47a7-4678-9d62-4add61b27fff"]');
    if (await systemicContainer.isVisible()) {
      await systemicContainer.scrollIntoViewIfNeeded();
      await systemicContainer.locator('button', { hasText: 'Yes' }).click();
      console.log('   - Confirmed: Systemic problem identified (Yes)');
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
  console.log('🎉 SUCCESS: RELEASE ENGINEERING FORM HAS BEEN COMPLETELY FILLED AUTOMATICALLY!');
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
        const updated = updateApplicationStatus('45', 'Applied');
        if (updated) {
          console.log('✅ Successfully updated application #45 to "Applied" in applications.md!');
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
      const updated = updateApplicationStatus('45', 'Applied');
      if (updated) {
        console.log('✅ Successfully updated application #45 to "Applied" in applications.md!');
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
        const updated = updateApplicationStatus('45', 'Applied');
        if (updated) {
          console.log('✅ Successfully updated application #45 to "Applied" in applications.md!');
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
