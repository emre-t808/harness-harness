#!/usr/bin/env node
/**
 * hh-session-summary.js — Stop hook
 *
 * Reads the current session's trace JSONL, scores effectiveness,
 * and writes a structured summary.
 *
 * IMPORTANT: Checks stop_hook_active to prevent infinite loops.
 *
 * Input:  JSON on stdin with { session_id, stop_hook_active }
 * Output: NONE — no stdout (must not inject context)
 * Side effects:
 *   1. Writes {session}-summary.md to .claude/traces/{date}/
 *   2. Appends to .claude/traces/index.md
 *   3. Appends to .harness/memory/trace-patterns.md
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || '{{PROJECT_DIR}}';
const HARNESS_PACKAGE_DIR = '{{HARNESS_PACKAGE_DIR}}';
const TRACES_DIR = path.join(PROJECT_DIR, '.claude', 'traces');
const INDEX_FILE = path.join(TRACES_DIR, 'index.md');
const PATTERNS_FILE = path.join(PROJECT_DIR, '.harness', 'memory', 'trace-patterns.md');
const SESSIONS_DIR = path.join(PROJECT_DIR, '.harness', 'sessions');

function todayDate() { return new Date().toISOString().slice(0, 10); }

function readStdin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const lines = [];
    rl.on('line', (line) => lines.push(line));
    rl.on('close', () => resolve(lines.join('\n')));
    setTimeout(() => resolve(lines.join('\n')), 300);
  });
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readTracefile(traceFile) {
  const events = [];
  if (!fs.existsSync(traceFile)) return events;
  for (const line of fs.readFileSync(traceFile, 'utf8').split('\n')) {
    const parsed = parseJsonSafe(line.trim());
    if (parsed) events.push(parsed);
  }
  return events;
}

function deriveIntent(events) {
  for (const evt of events) {
    if (evt.intent && evt.intent !== 'general') return evt.intent;
  }
  return 'general';
}

function scoreReferencedContext(events, rules) {
  const result = {};
  for (const ruleId of rules) {
    let score = 0.0, evidence = 'ignored';
    if (events.some(e => (e.referenced_context || []).includes(ruleId))) {
      score = 1.0; evidence = 'referenced';
    }
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.tool === 'Read' && (evt.input_summary || '').includes('anti-pattern') &&
          (evt.referenced_context || []).includes(ruleId)) {
        if (events.slice(i + 1, i + 4).some(e => e.tool === 'Edit' || e.tool === 'Write')) {
          score = 2.0; evidence = 'prevented-mistake'; break;
        }
      }
    }
    result[ruleId] = { score, evidence };
  }
  return result;
}

function collectRules(events) {
  const refs = new Set();
  for (const evt of events) {
    for (const r of (evt.referenced_context || [])) refs.add(r);
  }
  return [...refs];
}

function computeSlotUtilization(manifest, events) {
  if (!manifest || !manifest.slots) return '';
  const allRefs = new Set(events.flatMap(e => e.referenced_context || []));
  const rows = [];
  let totalInjected = 0, totalReferenced = 0;

  for (const [name, data] of Object.entries(manifest.slots)) {
    const injected = data.tokens || 0;
    totalInjected += injected;
    let referenced = 0;
    if (name === 'identity') referenced = injected;
    else if (name === 'route_context') {
      const rules = manifest.rules_injected || [];
      referenced = Math.round(injected * (rules.filter(r => allRefs.has(r)).length / Math.max(1, rules.length)));
    } else referenced = Math.round(injected * 0.5);
    totalReferenced += referenced;
    const util = injected > 0 ? Math.round((referenced / injected) * 100) : 0;
    rows.push(`| ${name.replace(/_/g, ' ')} | ${injected} | ${referenced} | ${util}% |`);
  }
  const totalUtil = totalInjected > 0 ? Math.round((totalReferenced / totalInjected) * 100) : 0;
  return [
    '', '### Slot Utilization', '',
    '| Slot | Injected | Referenced | Utilization |',
    '|---|---|---|---|',
    ...rows,
    `| **Total** | **${totalInjected}** | **${totalReferenced}** | **${totalUtil}%** |`, '',
  ].join('\n');
}

function ensureFile(filePath, header) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, header + '\n', 'utf8');
  }
}

async function main() {
  let sessionId = 'unknown';
  let stopHookActive = false;

  try {
    const raw = await readStdin();
    const parsed = parseJsonSafe(raw.trim());
    if (parsed) {
      if (parsed.session_id) sessionId = parsed.session_id;
      // CRITICAL: prevent infinite loop if Stop hook causes continuation
      if (parsed.stop_hook_active === true) {
        process.exit(0);
      }
    }
    if (sessionId === 'unknown' && process.env.CLAUDE_SESSION_ID) {
      sessionId = process.env.CLAUDE_SESSION_ID;
    }
  } catch {
    if (process.env.CLAUDE_SESSION_ID) sessionId = process.env.CLAUDE_SESSION_ID;
  }

  const date = todayDate();
  const traceFile = path.join(TRACES_DIR, date, `${sessionId}.jsonl`);
  if (!fs.existsSync(traceFile)) process.exit(0);

  const events = readTracefile(traceFile);
  const intent = deriveIntent(events);
  const rules = collectRules(events);
  const scores = scoreReferencedContext(events, rules);

  const uniqueFiles = [...new Set(events.flatMap(e => e.files_touched || []))].sort();

  const lines = [];
  lines.push(`## Session ${sessionId} — ${date}`, '', `**Route:** ${intent}`, `**Tools:** ${events.length}`, `**Files:** ${uniqueFiles.length}`, '');

  if (rules.length > 0) {
    lines.push('### Effectiveness Scores', '', '| Context | Score | Evidence |', '|---------|-------|----------|');
    for (const r of rules) {
      const s = scores[r] || { score: 0, evidence: 'ignored' };
      lines.push(`| ${r} | ${s.score.toFixed(1)} | ${s.evidence} |`);
    }
    lines.push('');
  }

  lines.push('### Files Touched', '');
  if (uniqueFiles.length > 0) {
    for (const f of uniqueFiles) lines.push(`- ${f}`);
  } else {
    lines.push('_None_');
  }
  lines.push('');

  const totalBytes = events.reduce((sum, e) => sum + (e.output_size || 0), 0);
  lines.push('### Token Utilization', '', `- Output bytes: ${totalBytes}`, `- Estimated tokens: ~${Math.round(totalBytes / 4)}`, '');

  let summary = lines.join('\n');

  // Append session state info
  const stateFile = path.join(SESSIONS_DIR, sessionId, 'state.md');
  if (fs.existsSync(stateFile)) {
    const stateContent = fs.readFileSync(stateFile, 'utf8');
    const objMatch = stateContent.match(/## Current Objective\n(.+)/);
    const objective = objMatch && !objMatch[1].startsWith('(') ? objMatch[1].trim() : '(not set)';
    summary += `\n### Session State\n\n- Objective: ${objective}\n`;
  }

  // Append slot utilization from manifest
  const manifestFile = path.join(TRACES_DIR, date, `${sessionId}-manifest.json`);
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      summary += computeSlotUtilization(manifest, events);
    } catch { /* skip */ }
  }

  // Write summary
  const traceDir = path.join(TRACES_DIR, date);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, `${sessionId}-summary.md`), summary, 'utf8');

  // Update index
  const allRefs = [...new Set(events.flatMap(e => e.referenced_context || []))];
  ensureFile(INDEX_FILE, '# Session Trace Index\n');
  fs.appendFileSync(INDEX_FILE, `- ${sessionId} | ${date} | ${intent} | ${events.length} tools | ${allRefs.length} refs\n`);

  // Update trace patterns
  ensureFile(PATTERNS_FILE, '# Trace Patterns\n\nSession stats appended by session-summary hook.\n');
  fs.appendFileSync(PATTERNS_FILE, `\n### ${date} — ${sessionId} (${intent})\n- Tools: ${events.length}\n- Referenced: ${allRefs.join(', ') || 'none'}\n- Files: ${uniqueFiles.length} unique\n`);

  // Daily aggregation check — piggybacks on Stop hook
  if (HARNESS_PACKAGE_DIR && !HARNESS_PACKAGE_DIR.startsWith('{{')) {
    try {
      const dailyCheckPath = path.join(HARNESS_PACKAGE_DIR, 'src', 'lib', 'daily-check.js');
      const { runDailyCheckIfDue } = await import(dailyCheckPath);
      const result = await runDailyCheckIfDue(PROJECT_DIR);
      if (result.ran) {
        process.stderr.write(`[hh-daily-check] Aggregated ${result.sessionsAnalyzed} sessions, ${result.proposals} proposals\n`);
      }
    } catch (err) {
      process.stderr.write(`[hh-daily-check] ${err.message}\n`);
    }
  }
}

main().catch(err => {
  process.stderr.write(`[hh-session-summary] ${err.message}\n`);
  process.exit(0);
});
