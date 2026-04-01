/**
 * trace-utils.js — Shared utilities for the harness trace system
 *
 * Provides:
 *   classifyIntent(message, customIntents)  → intent string
 *   parseTraceEvent(input, projectDir)      → structured trace event
 *   scoreReferencedContext(events, rules)    → scoring map
 *   generateSessionSummary(opts)            → markdown string
 */

const ANTI_PATTERN_RE = /\b([A-Z]{2,4}-\d{2,4})\b/g;

/**
 * Default intent map. Users can extend this via route configs.
 * Ordered: first match wins.
 */
const DEFAULT_INTENT_MAP = [
  ['coding:frontend', ['dashboard', 'component', 'css', 'tsx', 'jsx', 'ui', 'frontend', 'webpage', 'style', 'tailwind', 'react', 'vue', 'svelte', 'html']],
  ['coding:backend', ['typescript', 'function', 'api', 'endpoint', 'test', 'npm', 'build', 'debug', 'error', 'vitest', 'node', 'express', 'fastapi', 'django', 'flask', 'rust', 'go']],
  ['coding:meta', ['agent', 'hook', 'harness', 'skill', 'claude', 'context', 'settings', 'mcp', 'trace', 'route']],
  ['writing:docs', ['document', 'readme', 'prd', 'report', 'write up', 'summarize', 'handover', 'brief', 'spec']],
  ['analyzing', ['count', 'metric', 'data', 'pipeline', 'analyze', 'analytics', 'benchmark', 'performance']],
];

/**
 * Classify a message into an intent category.
 * @param {string} message
 * @param {Array<[string, string[]]>} [customIntents] - Additional intents to prepend
 * @returns {string}
 */
export function classifyIntent(message, customIntents = []) {
  const lower = (message || '').toLowerCase();
  const intentMap = [...customIntents, ...DEFAULT_INTENT_MAP];

  for (const [intent, keywords] of intentMap) {
    for (const keyword of keywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`);
      if (pattern.test(lower)) {
        return intent;
      }
    }
  }
  return 'general';
}

/**
 * Strip a base directory prefix from a file path.
 * @param {string} filePath
 * @param {string} baseDir
 * @returns {string}
 */
function stripBase(filePath, baseDir) {
  if (!filePath) return filePath;
  const base = baseDir.endsWith('/') ? baseDir : baseDir + '/';
  return filePath.startsWith(base) ? filePath.slice(base.length) : filePath;
}

/**
 * Build input_summary based on tool type.
 */
function buildInputSummary(toolName, toolInput, projectDir) {
  if (!toolInput) return '';

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return stripBase(toolInput.file_path || '', projectDir);
    case 'Bash':
      return (toolInput.command || '').slice(0, 80);
    case 'Grep':
      return `grep "${toolInput.pattern || ''}" in ${stripBase(toolInput.path || '', projectDir)}`;
    case 'Glob':
      return `glob "${toolInput.pattern || ''}" in ${stripBase(toolInput.path || '', projectDir)}`;
    case 'Agent': {
      const text = toolInput.description || toolInput.prompt || '';
      return text.slice(0, 80);
    }
    default:
      return JSON.stringify(toolInput).slice(0, 80);
  }
}

/**
 * Determine bash outcome from response text.
 */
function bashOutcome(response) {
  const lower = (response || '').toLowerCase();
  const hasFail = /\bfail\b/.test(lower) || /(?<!\b0 )failed\b/.test(lower);
  if (hasFail || /error:/.test(lower) || /fatal:/.test(lower)) return 'fail';
  if (/\bpass\b/.test(lower) || /\bsuccess\b/.test(lower)) return 'pass';
  return null;
}

/**
 * Extract and deduplicate rule IDs from text.
 */
function extractRuleIds(text) {
  if (!text) return [];
  const matches = [...text.matchAll(ANTI_PATTERN_RE)].map(m => m[1]);
  return [...new Set(matches)];
}

/**
 * Parse a PostToolUse hook input into a structured trace event.
 * @param {object} input - { tool_name, tool_input, tool_response, session_id }
 * @param {string} projectDir - Project root for path stripping
 * @returns {object}
 */
export function parseTraceEvent(input, projectDir = '') {
  const { tool_name, tool_input, tool_response, session_id } = input || {};
  const responseStr = typeof tool_response === 'string' ? tool_response : JSON.stringify(tool_response || '');
  const filePath = tool_input && tool_input.file_path ? stripBase(tool_input.file_path, projectDir) : null;

  return {
    ts: new Date().toISOString(),
    session: session_id || null,
    turn: null,
    tool: tool_name || null,
    input_summary: buildInputSummary(tool_name, tool_input, projectDir),
    output_size: responseStr.length,
    duration_ms: null,
    referenced_context: extractRuleIds(responseStr),
    files_touched: filePath ? [filePath] : [],
    outcome: tool_name === 'Bash' ? bashOutcome(responseStr) : null,
  };
}

/**
 * Score each injected rule by how it was used in the session.
 * @param {object[]} traceEvents
 * @param {string[]} injectedRules
 * @returns {{ [ruleId: string]: { score: number, evidence: string } }}
 */
export function scoreReferencedContext(traceEvents, injectedRules) {
  if (!injectedRules || injectedRules.length === 0) return {};

  const result = {};

  for (const ruleId of injectedRules) {
    let score = 0.0;
    let evidence = 'ignored';

    const isReferenced = traceEvents.some(evt =>
      Array.isArray(evt.referenced_context) && evt.referenced_context.includes(ruleId)
    );

    if (isReferenced) {
      score = 1.0;
      evidence = 'referenced';
    }

    // Prevented-mistake detection: read anti-pattern file → edit within next 3 events
    for (let i = 0; i < traceEvents.length; i++) {
      const evt = traceEvents[i];
      const isAntiPatternRead =
        evt.tool === 'Read' &&
        typeof evt.input_summary === 'string' &&
        evt.input_summary.includes('anti-pattern') &&
        Array.isArray(evt.referenced_context) &&
        evt.referenced_context.includes(ruleId);

      if (!isAntiPatternRead) continue;

      const window = traceEvents.slice(i + 1, i + 4);
      if (window.some(e => e.tool === 'Edit' || e.tool === 'Write')) {
        score = 2.0;
        evidence = 'prevented-mistake';
        break;
      }
    }

    result[ruleId] = { score, evidence };
  }

  return result;
}

/**
 * Generate a markdown summary for a session.
 */
export function generateSessionSummary({ sessionId, date, intent, traceEvents, injectedRules }) {
  const events = traceEvents || [];
  const rules = injectedRules || [];

  const toolCount = events.length;
  const allFiles = events.flatMap(e => e.files_touched || []);
  const uniqueFiles = [...new Set(allFiles)].sort();
  const totalBytes = events.reduce((sum, e) => sum + (e.output_size || 0), 0);
  const estimatedTokens = Math.round(totalBytes / 4);

  const bashEvents = events.filter(e => e.tool === 'Bash');
  const passCount = bashEvents.filter(e => e.outcome === 'pass').length;
  const failCount = bashEvents.filter(e => e.outcome === 'fail').length;
  const unknownCount = bashEvents.filter(e => e.outcome === null).length;

  const lines = [];
  lines.push(`## Session ${sessionId} — ${date}`);
  lines.push('');
  lines.push(`**Route:** ${intent}`);
  lines.push(`**Tools:** ${toolCount}`);
  lines.push(`**Files:** ${uniqueFiles.length}`);
  lines.push('');

  if (bashEvents.length > 0) {
    lines.push('### Bash Outcomes');
    lines.push('');
    lines.push(`- pass: ${passCount}`);
    lines.push(`- fail: ${failCount}`);
    lines.push(`- unknown: ${unknownCount}`);
    lines.push('');
  }

  if (rules.length > 0) {
    const scores = scoreReferencedContext(events, rules);
    lines.push('### Effectiveness Scores');
    lines.push('');
    lines.push('| Context | Score | Evidence |');
    lines.push('|---------|-------|----------|');
    for (const ruleId of rules) {
      const { score, evidence } = scores[ruleId] || { score: 0.0, evidence: 'ignored' };
      lines.push(`| ${ruleId} | ${score.toFixed(1)} | ${evidence} |`);
    }
    lines.push('');
  }

  lines.push('### Files Touched');
  lines.push('');
  if (uniqueFiles.length > 0) {
    for (const f of uniqueFiles) lines.push(`- ${f}`);
  } else {
    lines.push('_None_');
  }
  lines.push('');

  lines.push('### Token Utilization');
  lines.push('');
  lines.push(`- Output bytes: ${totalBytes}`);
  lines.push(`- Estimated tokens: ~${estimatedTokens}`);
  lines.push('');

  return lines.join('\n');
}

export { extractRuleIds, stripBase, buildInputSummary };
