import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

async function main() {
  const templatePath = resolve('templates/cv-template.html');
  let html = await readFile(templatePath, 'utf-8');

  // Placeholders mapping
  const replacements = {
    '{{LANG}}': 'en',
    '{{PAGE_WIDTH}}': '210mm',
    '{{NAME}}': 'Shashwat Gupta',
    '{{PHONE}}': '+91 9898027295',
    '{{EMAIL}}': 'shashwatvg@gmail.com',
    '{{LINKEDIN_URL}}': 'https://linkedin.com/in/shashtag',
    '{{LINKEDIN_DISPLAY}}': 'linkedin.com/in/shashtag',
    '{{PORTFOLIO_URL}}': 'https://shashtag.me',
    '{{PORTFOLIO_DISPLAY}}': 'shashtag.me',
    '{{LOCATION}}': 'Bengaluru, India',
    '{{SECTION_SUMMARY}}': 'Professional Summary',
    '{{SUMMARY_TEXT}}': 'Senior Backend Engineer with a proven record of orchestrating agentic development workflows and building high-performance enterprise APIs (Go/TypeScript). Expert in distributed state, OAuth integration, and developer automation harnesses.',
    '{{SECTION_COMPETENCIES}}': 'Core Competencies',
    '{{COMPETENCIES}}': [
      'Agentic Coding',
      'GoLang Systems',
      'REST APIs & GraphQL',
      'OAuth & Webhooks',
      'State Synchronization',
      'Distributed Architectures',
      'Sandboxing & Guardrails',
      'CI/CD & Developer Tooling'
    ].map(c => `<span class="competency-tag">${c}</span>`).join('\n      '),
    '{{SECTION_EXPERIENCE}}': 'Work Experience',
    '{{EXPERIENCE}}': `
    <div class="job">
      <div class="job-header">
        <span class="job-company">realfast.ai</span>
        <span class="job-period">Mar 2025 - Present</span>
      </div>
      <div class="job-role">Forward Deployed Engineer</div>
      <ul>
        <li><strong>AI Transformation Strategy:</strong> Spearheading enterprise AI discovery phases, conducting deep stakeholder interviews to map complex legacy workflows, and designing custom multi-agent coding adapters.</li>
        <li><strong>Process Optimization:</strong> Built and evaluated multi-agent workflows and sandboxed coding prompts using LangChain and RAG to automate codebase audits and API prototyping, accelerating process integration.</li>
      </ul>
    </div>

    <div class="job">
      <div class="job-header">
        <span class="job-company">Accenture (Comcast Engineering Team)</span>
        <span class="job-period">Nov 2023 - Feb 2025</span>
      </div>
      <div class="job-role">Advanced Software Engineer</div>
      <ul>
        <li><strong>Developer Automation:</strong> Designed and distributed automated Go CLI agent harnesses and test frameworks to standardize microservice structures across 16+ services, saving 1 hour per day per engineer.</li>
        <li><strong>Scale & Reliability:</strong> Contributed full-stack features (geolocation, A11y, user-flows) to the Comcast Xfinity website (3M daily visits), deploying versioned REST adapters with robust retry policies.</li>
        <li><strong>Systems Optimization:</strong> Optimized monorepo and microfrontend architectures for high-performance delivery, ensuring seamless coordination across complex service boundaries.</li>
      </ul>
    </div>

    <div class="job">
      <div class="job-header">
        <span class="job-company">ProPro Productions (Germany - Remote)</span>
        <span class="job-period">June 2021 - Sept 2023</span>
      </div>
      <div class="job-role">Founding Engineer</div>
      <ul>
        <li><strong>Distributed Systems:</strong> Architected real-time WebSocket state management, webhooks, and REST APIs, using CRDTs for collaborative conflict-free synchronization under offline-online modes.</li>
        <li><strong>Graphics Performance:</strong> Pioneered the core Infinite Canvas engine using DOM matrix transformations, virtualization, and QuadTrees, rendering thousands of concurrent elements flawlessly.</li>
        <li><strong>Outcome:</strong> Engineered the highly extensible system architecture and secure OAuth integration leading to a successful company acquisition.</li>
      </ul>
    </div>
    `,
    '{{SECTION_PROJECTS}}': 'Projects',
    '{{PROJECTS}}': `
    <div class="project">
      <span class="project-title">karada.ai</span>
      <span class="project-badge">Personal Project</span>
      <div class="project-desc">Personal AI/health tracking platform featuring a GoLang backend and a distributed, message-driven architecture with vector database integration for real-time semantic search.</div>
      <div class="project-tech">GoLang, Redis, PostgreSQL, Vector Database, Docker</div>
    </div>

    <div class="project">
      <span class="project-title">Fusion Data Secure</span>
      <span class="project-badge">Core Project</span>
      <div class="project-desc">Programmed high-performance client credential OAuth-style authentication protocols and cryptographic handshakes in a secure client VPN GoLang DLL using WireGuard.</div>
      <div class="project-tech">GoLang, WireGuard, OAuth, Security</div>
    </div>

    <div class="project">
      <span class="project-title">JoyFill Forms Formula Engine</span>
      <span class="project-badge">Core Project</span>
      <div class="project-desc">Architected high-level designs and robust state resolution logic for Excel-like formula functions and reactive distributed state within dynamic forms.</div>
      <div class="project-tech">TypeScript, State Engines, Functional Logic</div>
    </div>
    `,
    '{{SECTION_EDUCATION}}': 'Education',
    '{{EDUCATION}}': `
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">Bachelor of Technology (B.Tech)</span>
        <span class="edu-org">Vellore Institute of Technology (VIT)</span>
        <span class="edu-year">Graduated 2021</span>
      </div>
    </div>
    `,
    '{{SECTION_SKILLS}}': 'Skills',
    '{{SKILLS}}': `
    <div class="skills-grid">
      <div class="skill-item"><span class="skill-category">Languages:</span> Go, JavaScript, TypeScript, Python, C/C++, Rust, SQL, Shell</div>
      <div class="skill-item"><span class="skill-category">Backend/Systems:</span> Microservices, Distributed Systems, WebSockets, WebRTC, Kafka, RESTful APIs, SQL/NoSQL/Vector/Graph DBs, Redis, GraphQL, RabbitMQ</div>
      <div class="skill-item"><span class="skill-category">Frontend:</span> React, Next.js, Tauri, Solid.js, Webpack/Vite, HTML/CSS</div>
      <div class="skill-item"><span class="skill-category">DevOps/Cloud:</span> AWS, GCP, Kubernetes, Docker, Terraform, CI/CD</div>
      <div class="skill-item"><span class="skill-category">AI/ML:</span> LangChain, RAG Architecture, HuggingFace, Ollama, Training/Fine-tuning</div>
      <div class="skill-item"><span class="skill-category">Testing/Tooling:</span> Selenium, Playwright, Cypress</div>
    </div>
    `
  };

  // Perform replacements
  for (const [key, val] of Object.entries(replacements)) {
    html = html.replace(new RegExp(key, 'g'), val);
  }

  // Remove Certifications section since Shashwat doesn't have certifications listed
  const certSectionRegex = /<!-- CERTIFICATIONS -->[\s\S]*?<div class="section avoid-break">[\s\S]*?<\/div>/i;
  html = html.replace(certSectionRegex, '');
  // Also clean up any loose placeholder or unrendered divs
  html = html.replace(/<div class="section avoid-break">\s*<div class="section-title">\{\{SECTION_CERTIFICATIONS\}\}<\/div>[\s\S]*?<\/div>/i, '');

  // Inject compact styles to fit precisely on one page
  const compactStyles = `
  <style>
    body { font-size: 10px !important; }
    .page { padding: 0 !important; }
    .section { margin-bottom: 10px !important; }
    .section-title { margin-bottom: 4px !important; font-size: 11px !important; }
    .job { margin-bottom: 6px !important; }
    .job-header { margin-bottom: 1px !important; }
    .job-company { font-size: 11.5px !important; }
    .job-role { margin-bottom: 2px !important; font-size: 10px !important; }
    .job ul { margin-top: 1px !important; padding-left: 14px !important; }
    .job li { margin-bottom: 1px !important; font-size: 9.5px !important; line-height: 1.35 !important; }
    .project { margin-bottom: 3px !important; }
    .project-title { font-size: 11px !important; }
    .project-desc { margin-top: 1px !important; font-size: 9.5px !important; line-height: 1.35 !important; }
    .project-tech { font-size: 8.5px !important; margin-top: 1px !important; }
    .summary-text { line-height: 1.4 !important; font-size: 10px !important; }
    .header { margin-bottom: 8px !important; }
    .header h1 { font-size: 24px !important; margin-bottom: 4px !important; }
    .contact-row { font-size: 9.5px !important; gap: 4px 10px !important; }
    .competencies-grid { gap: 4px !important; }
    .competency-tag { font-size: 8.5px !important; padding: 2px 6px !important; }
    .skill-item { font-size: 9.5px !important; }
    .skill-category { font-size: 9.5px !important; }
    .edu-item { margin-bottom: 4px !important; }
  </style>
  `;
  html = html.replace('</head>', compactStyles + '\n</head>');

  const outputPath = '/tmp/cv-shashwat-gupta-zapier.html';
  await writeFile(outputPath, html, 'utf-8');
  console.log(`Successfully generated tailored HTML at ${outputPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
