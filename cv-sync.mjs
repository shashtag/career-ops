#!/usr/bin/env node

/**
 * cv-sync.mjs — Syncs cv.md from a Google Docs source.
 *
 * Usage:
 *   node cv-sync.mjs                  # Sync (skips if doc unchanged)
 *   node cv-sync.mjs --check          # Check if remote changed, don't overwrite
 *   node cv-sync.mjs --force          # Force re-fetch + write, ignore cache
 *   node cv-sync.mjs --url "https://docs.google.com/document/d/..."
 *
 * The Google Doc must be shared with "Anyone with the link can view".
 *
 * How it works:
 *   1. Fetches the doc as plain text (~2-3 KB, fast)
 *   2. Compares SHA-256 hash of fetched text against .cv-sync-state.json
 *   3. If identical → instant exit, no write, no backup
 *   4. If changed → backs up old cv.md, writes new one, updates state
 *
 * State file (.cv-sync-state.json):
 *   {
 *     "doc_id":          "Google Doc ID",
 *     "remote_hash":     "SHA-256 of raw exported text",
 *     "local_hash":      "SHA-256 of cv.md after conversion",
 *     "last_synced_at":  "ISO — last time we checked",
 *     "last_changed_at": "ISO — last time cv.md was actually updated"
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const STATE_FILE = join(projectRoot, '.cv-sync-state.json');

// ── Parse args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const forceSync = args.includes('--force');
const urlArgIdx = args.indexOf('--url');
const urlArg = urlArgIdx !== -1 ? args[urlArgIdx + 1] : null;

// ── State management ────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return null; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ── Get Google Doc URL ──────────────────────────────────────────────────
function getDocUrl() {
  if (urlArg) return urlArg;

  const profilePath = join(projectRoot, 'config', 'profile.yml');
  if (!existsSync(profilePath)) {
    console.error('ERROR: config/profile.yml not found and no --url provided.');
    process.exit(1);
  }

  const content = readFileSync(profilePath, 'utf-8');
  const match = content.match(/(?:google_doc_url|source_url):\s*["']?([^\s"'#]+)/);
  if (!match) {
    console.error('ERROR: No Google Doc URL found in config/profile.yml.');
    console.error('Add to your profile.yml:');
    console.error('  cv:');
    console.error('    google_doc_url: "https://docs.google.com/document/d/YOUR_DOC_ID/edit"');
    process.exit(1);
  }
  return match[1];
}

function extractDocId(url) {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    console.error(`ERROR: Could not extract document ID from: ${url}`);
    process.exit(1);
  }
  return match[1];
}

// ── Convert plain text CV to markdown ───────────────────────────────────
function textToMarkdown(rawText) {
  let text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const mdLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (mdLines.length === 0 && !line) continue;

    // Name (first non-empty line)
    if (mdLines.length === 0 && line.length > 0) {
      mdLines.push(`# ${line}`);
      continue;
    }

    // Contact info line
    if (mdLines.length === 1 && (line.includes('@') || line.includes('|'))) {
      const parts = line.split('|').map(p => p.trim()).filter(Boolean);
      mdLines.push('');
      mdLines.push(`**${parts.join(' | ')}**`);
      continue;
    }

    // Section headers (ALL CAPS)
    if (line.length > 2 && line === line.toUpperCase() && /^[A-Z\s&/]+$/.test(line)) {
      mdLines.push('');
      mdLines.push(`## ${titleCase(line)}`);
      continue;
    }

    // Sub-section headers (role | company | dates)
    if (line.includes('|') && /\d{4}/.test(line) && !line.startsWith('*') && !line.startsWith('-')) {
      mdLines.push('');
      const parts = line.split('|').map(p => p.trim());
      mdLines.push(parts.length >= 2
        ? `### ${parts[0]} | ${parts.slice(1).join(' | ')}`
        : `### ${line}`);
      continue;
    }

    // Bullet points
    if (line.startsWith('* ') || line.startsWith('- ')) {
      const text = line.slice(2);
      const prefixMatch = text.match(/^([A-Za-z\s/&]+):\s*(.+)/);
      if (prefixMatch) {
        mdLines.push(`- **${prefixMatch[1]}:** ${prefixMatch[2]}`);
      } else {
        mdLines.push(`- ${text}`);
      }
      continue;
    }

    mdLines.push(line);
  }

  return mdLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function titleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bAnd\b/g, '&');
}

function hash(text) {
  return createHash('sha256').update(text.trim()).digest('hex');
}

function timeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== career-ops CV sync ===\n');

  const docUrl = getDocUrl();
  const docId = extractDocId(docUrl);
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const state = loadState();

  if (state?.last_synced_at) {
    console.log(`🕐 Last synced:  ${timeAgo(state.last_synced_at)}`);
    if (state.last_changed_at) console.log(`📝 Last changed: ${timeAgo(state.last_changed_at)}`);
    console.log('');
  }

  // Fetch the document (plain text export, ~2-3 KB)
  console.log('📥 Fetching from Google Docs...');
  let response;
  try {
    response = await fetch(exportUrl);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error('Make sure the doc is shared: "Anyone with the link can view".');
    process.exit(1);
  }

  if (!response.ok) {
    const reasons = { 404: 'Document not found.', 403: 'Access denied. Share with "Anyone with the link".' };
    console.error(`ERROR: HTTP ${response.status}. ${reasons[response.status] || ''}`);
    process.exit(1);
  }

  const rawText = await response.text();
  if (!rawText || rawText.trim().length < 50) {
    console.error('ERROR: Document appears empty.');
    process.exit(1);
  }

  // ── Compare remote hash against cache ─────────────────────────────────
  const remoteHash = hash(rawText);

  if (!forceSync && state?.remote_hash === remoteHash && state?.doc_id === docId) {
    saveState({ ...state, last_synced_at: new Date().toISOString() });
    console.log('✅ No changes in Google Doc. Skipping.\n');
    process.exit(0);
  }

  // Remote changed — convert and compare with local cv.md
  console.log(`   Remote hash: ${remoteHash.slice(0, 12)}… (changed!)\n`);

  const newCv = textToMarkdown(rawText);
  const newLocalHash = hash(newCv);
  const cvPath = join(projectRoot, 'cv.md');
  const existingCv = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';

  if (hash(existingCv) === newLocalHash) {
    saveState({
      doc_id: docId, remote_hash: remoteHash, local_hash: newLocalHash,
      last_synced_at: new Date().toISOString(),
      last_changed_at: state?.last_changed_at || new Date().toISOString(),
    });
    console.log('✅ cv.md already matches. Cache refreshed.\n');
    process.exit(0);
  }

  console.log('📝 Changes detected!');

  if (checkOnly) {
    console.log('   (--check mode: run without --check to apply)\n');
    process.exit(0);
  }

  // Backup
  if (existingCv) {
    const backupDir = join(projectRoot, '.cv-backups');
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(cvPath, join(backupDir, `cv-${ts}.md`));
    console.log(`💾 Backed up → .cv-backups/cv-${ts}.md`);
  }

  // Write
  writeFileSync(cvPath, newCv, 'utf-8');
  const now = new Date().toISOString();
  saveState({ doc_id: docId, remote_hash: remoteHash, local_hash: newLocalHash, last_synced_at: now, last_changed_at: now });

  const oldLines = existingCv.split('\n').length;
  const newLines = newCv.split('\n').length;
  console.log(`✅ cv.md updated!`);
  console.log(`   ${oldLines} → ${newLines} lines | ${existingCv.length} → ${newCv.length} bytes\n`);
}

main().catch(err => { console.error(`FATAL: ${err.message}`); process.exit(1); });
