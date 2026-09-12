#!/usr/bin/env node
/**
 * token-audit.mjs — Where the tokens actually went, measured from transcripts
 *
 * career-ops is prompt-heavy by design, which makes it easy to optimise the
 * wrong thing. Reading file sizes says the mode files and the reports are the
 * cost; reading the *billed* numbers says otherwise. This script reads the
 * numbers.
 *
 * Two facts drive every finding below:
 *
 *   1. Cost is `context_size x api_calls`, not `content_written`. Everything in
 *      context is re-sent on every later call in the session, so a token added
 *      early is billed once per remaining call. In one local sample that was a
 *      ~43x amplification on everything that entered context.
 *
 *   2. The base context — system prompt, tool definitions, the skill listing,
 *      AGENTS.md, memory — is paid on *every* call, so trimming it is the one
 *      lever that scales with session length rather than fighting it.
 *
 * What it reports:
 *   - billed input split into base x calls vs conversation growth
 *   - per-tool result cost, worst first
 *   - the two anti-patterns that dominate a browser-driven apply run:
 *       * image-returning `computer` calls (screenshot/scroll) sent without
 *         `scale`, each ~19-24k tokens where `read_page` answers the same
 *         question for ~371
 *       * `Read` on a saved .png, ~80k tokens a time — four times a live
 *         screenshot, because it arrives at full resolution
 *
 * This is a MEASUREMENT tool, not a gate. It is read-only, it never touches the
 * tracker, reports, or any user-layer file, and it exits 0 on findings unless
 * `--strict` is passed. `modes/apply.md` -> "Reading the page without burning
 * context" is the rule this measures compliance with.
 *
 * Transcripts are a Claude Code artifact. career-ops is CLI-agnostic, so on
 * Codex/Gemini/OpenCode there is nothing to read: the script says so and exits
 * 0. Absence of transcripts is not a failure.
 *
 * Run: node token-audit.mjs                  (JSON to stdout)
 *      node token-audit.mjs --summary        (human-readable tables)
 *      node token-audit.mjs --since 30       (only sessions touched in 30 days)
 *      node token-audit.mjs --top 15         (rows per table in --summary)
 *      node token-audit.mjs --strict         (exit 1 when a finding fires)
 *      node token-audit.mjs --dir <path>     (override transcript dir; tests)
 *      node token-audit.mjs --self-test
 *
 * Issue #3600 — github.com/career-ops-hq/career-ops
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';

const USAGE = `Usage: node token-audit.mjs [options]

  --summary        Human-readable tables instead of JSON
  --since <days>   Only sessions modified within N days (default: all)
  --top <n>        Rows per table in --summary (default: 12)
  --strict         Exit 1 if any finding fires (default: always exit 0)
  --dir <path>     Transcript directory override (default: this project's)
  --self-test      Run built-in tests
  --help           Show this message
`;

// A screenshot/scroll returns an image; a click returns a status line. Only the
// first group is worth auditing, and only these two actions return an image.
const IMAGE_ACTIONS = new Set(['screenshot', 'scroll']);
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

/** Rough token estimate. Transcript payloads are JSON-ish text; ~4 chars/token. */
export function approxTokens(chars) {
  return Math.round((Number(chars) || 0) / 4);
}

/**
 * Claude Code stores transcripts under a directory named for the project path
 * with every non-alphanumeric run collapsed to a dash.
 *
 * @param {string} cwd - Absolute project path.
 * @returns {string} Absolute transcript directory (may not exist).
 */
export function transcriptDirFor(cwd) {
  const slug = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

/** Size of a tool_result block's content, in characters. */
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (part && typeof part.text === 'string') n += part.text.length;
      else n += safeStringify(part).length;
    }
    return n;
  }
  return safeStringify(content).length;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Fold one transcript file into running totals.
 *
 * Two passes over the lines: tool_use blocks first (so every tool_result can be
 * attributed to a tool name and, for `computer`, to an action), then the usage
 * and result accounting. A tool_result can precede its tool_use in file order
 * when a session is resumed, so a single forward pass would drop attributions.
 *
 * @param {string} text - Raw .jsonl contents.
 * @param {object} acc - Accumulator, mutated in place.
 */
export function foldTranscript(text, acc) {
  const lines = text.split('\n');
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* a partially-flushed trailing line is normal on a live session */
    }
  }

  const toolName = new Map();
  const toolDetail = new Map();
  for (const rec of parsed) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !b.id) continue;
      const name = b.name || 'unknown';
      toolName.set(b.id, name);
      if (/computer$/.test(name)) {
        const action = b.input?.action || 'unknown';
        toolDetail.set(b.id, { action, scaled: b.input?.scale !== undefined });
        if (IMAGE_ACTIONS.has(action)) {
          acc.image.total++;
          if (b.input?.scale !== undefined) acc.image.scaled++;
        }
      }
      if (name === 'Read') {
        const p = String(b.input?.file_path || '');
        toolDetail.set(b.id, { path: p, isImage: IMAGE_FILE_RE.test(p) });
      }
    }
  }

  let baseSeen = false;
  for (const rec of parsed) {
    const u = rec?.message?.usage;
    if (u) {
      const ctx =
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.input_tokens || 0);
      acc.billedInput += ctx;
      acc.output += u.output_tokens || 0;
      acc.calls++;
      // The first substantial context in a session is its base: system prompt +
      // tool definitions + skill listing + CLAUDE.md/AGENTS.md + memory. Small
      // early records are sub-agent or bookkeeping turns, not the real base.
      if (!baseSeen && ctx > 1000) {
        baseSeen = true;
        acc.sessions.push({ base: ctx, calls: 0 });
      }
      if (baseSeen) acc.sessions[acc.sessions.length - 1].calls++;
    }

    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      const name = toolName.get(b.tool_use_id);
      if (!name) continue;
      const chars = resultChars(b.content);
      const detail = toolDetail.get(b.tool_use_id);

      const key = /computer$/.test(name) && detail?.action
        ? `${shortName(name)}:${detail.action}`
        : shortName(name);
      const row = acc.byTool.get(key) || { calls: 0, chars: 0 };
      row.calls++;
      row.chars += chars;
      acc.byTool.set(key, row);

      if (name === 'Read' && detail?.isImage) {
        acc.imageRead.calls++;
        acc.imageRead.chars += chars;
      }
    }
  }
}

function shortName(n) {
  return String(n)
    .replace('mcp__claude-in-chrome__', 'chrome.')
    .replace('mcp__Claude_Browser__', 'browser.');
}

function newAccumulator() {
  return {
    billedInput: 0,
    output: 0,
    calls: 0,
    sessions: [],
    byTool: new Map(),
    image: { total: 0, scaled: 0 },
    imageRead: { calls: 0, chars: 0 },
  };
}

/**
 * Audit every transcript in `dir`.
 *
 * @param {string} dir - Transcript directory.
 * @param {{sinceDays?: number}} [opts]
 * @returns {object} Report object (the JSON shape printed by default).
 */
export function audit(dir, { sinceDays } = {}) {
  if (!dir || !existsSync(dir)) {
    return {
      available: false,
      reason: `no transcript directory at ${dir || '(unresolved)'} — ` +
        'transcripts are a Claude Code artifact; nothing to audit on another CLI',
      findings: [],
    };
  }

  let files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (Number.isFinite(sinceDays) && sinceDays > 0) {
    const cutoff = Date.now() - sinceDays * 86400000;
    files = files.filter((f) => {
      try {
        return statSync(join(dir, f)).mtimeMs >= cutoff;
      } catch {
        return false;
      }
    });
  }

  const acc = newAccumulator();
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    foldTranscript(text, acc);
  }

  if (!acc.calls) {
    return {
      available: false,
      reason: `no usage records in ${files.length} transcript(s) under ${dir}`,
      findings: [],
    };
  }

  const baseCost = acc.sessions.reduce((s, x) => s + x.base * x.calls, 0);
  const bases = acc.sessions.map((s) => s.base).sort((a, b) => a - b);
  const medianBase = bases.length ? bases[Math.floor(bases.length / 2)] : 0;

  const tools = [...acc.byTool.entries()]
    .map(([tool, v]) => ({
      tool,
      calls: v.calls,
      tokens: approxTokens(v.chars),
      avgTokens: approxTokens(v.chars / v.calls),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const findings = [];
  const unscaled = acc.image.total - acc.image.scaled;
  if (unscaled > 0) {
    findings.push({
      id: 'unscaled-screenshots',
      severity: acc.image.total >= 50 && unscaled / acc.image.total > 0.5 ? 'high' : 'low',
      detail:
        `${unscaled} of ${acc.image.total} image-returning computer calls ` +
        '(screenshot/scroll) passed no `scale`. scale:0.5 is a quarter of the ' +
        'tokens; read_page answers most apply-run questions for ~371.',
      remedy: 'modes/apply.md → "Reading the page without burning context"',
    });
  }
  if (acc.imageRead.calls > 0) {
    findings.push({
      id: 'image-read-from-disk',
      severity: 'high',
      detail:
        `${acc.imageRead.calls} Read call(s) on image files cost ` +
        `~${approxTokens(acc.imageRead.chars).toLocaleString()} tokens ` +
        `(~${approxTokens(acc.imageRead.chars / acc.imageRead.calls).toLocaleString()} each). ` +
        'A saved screenshot re-read from disk arrives at full resolution.',
      remedy: 'Look at the live page instead; never Read a screenshot back.',
    });
  }

  return {
    available: true,
    dir,
    sessions: acc.sessions.length,
    transcripts: files.length,
    apiCalls: acc.calls,
    billedInputTokens: acc.billedInput,
    outputTokens: acc.output,
    medianBaseContext: medianBase,
    baseContextCost: baseCost,
    baseSharePct: acc.billedInput ? +((100 * baseCost) / acc.billedInput).toFixed(1) : 0,
    conversationGrowthCost: Math.max(0, acc.billedInput - baseCost),
    imageCalls: acc.image,
    imageReads: { calls: acc.imageRead.calls, tokens: approxTokens(acc.imageRead.chars) },
    tools,
    findings,
  };
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function renderSummary(r, top) {
  if (!r.available) return `token-audit: ${r.reason}`;
  const out = [];
  out.push('Token audit — billed input, measured from transcripts');
  out.push('');
  out.push(`  transcripts        ${fmt(r.transcripts)}`);
  out.push(`  api calls          ${fmt(r.apiCalls)}`);
  out.push(`  billed input       ${fmt(r.billedInputTokens)}`);
  out.push(`  output             ${fmt(r.outputTokens)}`);
  out.push('');
  out.push(`  median base ctx    ${fmt(r.medianBaseContext)}  (paid on every call)`);
  out.push(`  base x calls       ${fmt(r.baseContextCost)}  = ${r.baseSharePct}% of billed input`);
  out.push(`  conversation grow  ${fmt(r.conversationGrowthCost)}`);
  out.push('');
  out.push('Tool result cost, worst first');
  out.push('  tool                                 calls        tokens      avg');
  for (const t of r.tools.slice(0, top)) {
    out.push(
      `  ${t.tool.slice(0, 34).padEnd(34)} ${String(fmt(t.calls)).padStart(7)} ` +
      `${String(fmt(t.tokens)).padStart(13)} ${String(fmt(t.avgTokens)).padStart(8)}`,
    );
  }
  out.push('');
  if (r.findings.length) {
    out.push('Findings');
    for (const f of r.findings) {
      out.push(`  [${f.severity}] ${f.id}`);
      out.push(`      ${f.detail}`);
      out.push(`      → ${f.remedy}`);
    }
  } else {
    out.push('Findings: none');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const results = [];
  const check = (name, cond) => {
    results.push({ name, ok: !!cond });
    console.log(`  ${cond ? '✅' : '❌'} ${name}`);
  };

  check('approxTokens rounds chars/4', approxTokens(400) === 100 && approxTokens(0) === 0);
  check(
    'transcriptDirFor collapses non-alphanumerics',
    transcriptDirFor('/Users/x/Desktop/career-ops').endsWith('-Users-x-Desktop-career-ops'),
  );

  // A transcript where the tool_result precedes its tool_use in file order —
  // the resumed-session shape a single forward pass would mis-attribute.
  const outOfOrder = [
    JSON.stringify({
      message: { usage: { cache_read_input_tokens: 5000 }, content: [
        { type: 'tool_result', tool_use_id: 'a1', content: 'x'.repeat(400) },
      ] },
    }),
    JSON.stringify({
      message: { content: [
        { type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/tmp/shot.png' } },
      ] },
    }),
  ].join('\n');
  const acc = newAccumulator();
  foldTranscript(outOfOrder, acc);
  check('tool_result before tool_use is still attributed', acc.imageRead.calls === 1);
  check('image Read chars counted', approxTokens(acc.imageRead.chars) === 100);

  // scale accounting
  const scaleDoc = [
    JSON.stringify({ message: { content: [
      { type: 'tool_use', id: 's1', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } },
      { type: 'tool_use', id: 's2', name: 'mcp__claude-in-chrome__computer', input: { action: 'scroll', scale: 0.5 } },
      { type: 'tool_use', id: 's3', name: 'mcp__claude-in-chrome__computer', input: { action: 'left_click' } },
    ] } }),
  ].join('\n');
  const acc2 = newAccumulator();
  foldTranscript(scaleDoc, acc2);
  check('only screenshot/scroll count as image calls', acc2.image.total === 2);
  check('scale usage detected', acc2.image.scaled === 1);

  check('malformed jsonl line does not throw', (() => {
    const a = newAccumulator();
    try { foldTranscript('{not json\n', a); return true; } catch { return false; }
  })());

  check('missing dir degrades, does not throw', (() => {
    const r = audit('/nonexistent/career-ops-token-audit');
    return r.available === false && Array.isArray(r.findings);
  })());

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(
    args,
    ['--summary', '--since', '--top', '--strict', '--dir', '--self-test', '--help', '-h'],
    USAGE,
    { valueFlags: ['--since', '--top', '--dir'] },
  );

  if (hasFlag(args, '--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }

  const dirFlag = flagValue(args, '--dir');
  const dir = dirFlag ? resolve(dirFlag) : transcriptDirFor(process.cwd());
  const sinceDays = safeIntFlag(flagValue(args, '--since'), 0);
  const top = safeIntFlag(flagValue(args, '--top'), 12);

  const report = audit(dir, { sinceDays });

  if (hasFlag(args, '--summary')) console.log(renderSummary(report, top));
  else console.log(JSON.stringify(report, null, 2));

  const hardFinding = report.findings.some((f) => f.severity === 'high');
  process.exit(hasFlag(args, '--strict') && hardFinding ? 1 : 0);
}
