/**
 * behavioral-scoring.js — Diff-based compliance checking
 *
 * Instead of searching for rule ID strings (e.g., "SEC-001") in Claude's output,
 * this module checks whether the actual code changes comply with each rule.
 *
 * Each rule is plain text. The engine matches rule keywords against a library
 * of deterministic check functions. Rules that don't match any check pattern
 * get status UNVERIFIABLE.
 *
 * All checks are deterministic: regex on diffs, file existence in trace events,
 * line counting. No LLM calls.
 */

// ---------------------------------------------------------------------------
// Check library — each entry has keywords that activate it and a check function
// ---------------------------------------------------------------------------

const CHECK_LIBRARY = [
  {
    name: 'no-sql-interpolation',
    keywords: ['parameterized', 'sql injection', 'string interpolation', 'interpolation in sql', 'prepared statement'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      // Detect ${...} near SQL keywords on the same line (template literal interpolation)
      const sqlWithInterp = /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)[^;\n]*\$\{/gi;
      const interpInSql = /\$\{[^}]*\}[^;\n]*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/gi;
      // Also catch "..." + variable + "..." SQL concatenation
      const sqlConcat = /["'][^"']*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s[^"']*["']\s*\+/gi;
      const interpMatches = (diff.match(sqlWithInterp) || []).length + (diff.match(interpInSql) || []).length;
      const concatMatches = (diff.match(sqlConcat) || []).length;
      const total = interpMatches + concatMatches;
      if (total > 0) {
        return { status: 'VIOLATED', evidence: `${total} SQL interpolation/concatenation pattern(s) in diff` };
      }
      // Check if there are SQL-related changes at all
      if (/(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(diff)) {
        return { status: 'COMPLIANT', evidence: 'SQL operations use parameterized style' };
      }
      return { status: 'NOT_APPLICABLE', evidence: 'No SQL operations in diff' };
    },
  },
  {
    name: 'test-coverage',
    keywords: ['test file', 'spec file', '.test.', '.spec.', 'unit test', 'write a test', 'write test'],
    check: (diff, traceEvents) => {
      const edited = extractEditedSourceFiles(traceEvents);
      if (edited.length === 0) return { status: 'NOT_APPLICABLE', evidence: 'No source files modified' };
      const testFiles = extractAllTouchedFiles(traceEvents)
        .filter(f => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f) || /\/__tests__\//.test(f));
      const untested = edited.filter(f => {
        const base = f.replace(/\.[^.]+$/, '').replace(/^.*\//, '');
        return !testFiles.some(t => t.includes(base));
      });
      if (untested.length === 0) {
        return { status: 'COMPLIANT', evidence: `${edited.length} modified file(s) all have corresponding test files` };
      }
      return { status: 'VIOLATED', evidence: `Missing tests for: ${untested.slice(0, 5).join(', ')}${untested.length > 5 ? ` (+${untested.length - 5} more)` : ''}` };
    },
  },
  {
    name: 'no-console-log',
    keywords: ['console.log', 'console.error', 'debug statement', 'no console', 'remove console'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      // Only check added lines (lines starting with +, not ++ for file headers)
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const consoleLines = addedLines.filter(l => /\bconsole\.(log|error|warn|debug|info)\b/.test(l));
      if (consoleLines.length > 0) {
        return { status: 'VIOLATED', evidence: `${consoleLines.length} console statement(s) added` };
      }
      return { status: 'COMPLIANT', evidence: 'No console statements in added lines' };
    },
  },
  {
    name: 'no-any-type',
    keywords: ['any type', ': any', 'avoid any', 'no any', 'explicit type', 'type safety'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      // Match ": any" but not "// any" or "* any" (comments)
      const anyLines = addedLines.filter(l => {
        const code = l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, ''); // strip comments
        return /:\s*any\b/.test(code);
      });
      if (anyLines.length > 0) {
        return { status: 'VIOLATED', evidence: `${anyLines.length} \`: any\` type(s) added` };
      }
      if (/\.tsx?\b/.test(diff.slice(0, 500)) || addedLines.some(l => /\b(interface|type|:\s*\w)/.test(l))) {
        return { status: 'COMPLIANT', evidence: 'No `: any` types in added code' };
      }
      return { status: 'NOT_APPLICABLE', evidence: 'Not a TypeScript diff' };
    },
  },
  {
    name: 'function-length',
    keywords: ['function', 'under', 'lines', 'max lines', 'keep functions', 'short functions'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      // Extract max length from common phrasings: "under 50 lines", "max 40 lines"
      // Default to 50 if not specified
      const maxLines = 50;
      // Look for added function bodies in the diff
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const code = addedLines.map(l => l.slice(1)).join('\n');
      // Simple heuristic: find function/method declarations and count lines to closing brace
      const funcStarts = [...code.matchAll(/(?:function\s+\w+|(?:async\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s+)?\(|(?:async\s+)?\w+\s*\([^)]*\)\s*\{)/g)];
      let longestFunc = 0;
      let longestName = '';
      for (const match of funcStarts) {
        const start = match.index;
        let braceDepth = 0;
        let foundOpen = false;
        let lineCount = 0;
        for (let i = start; i < code.length; i++) {
          if (code[i] === '{') { braceDepth++; foundOpen = true; }
          if (code[i] === '}') { braceDepth--; }
          if (code[i] === '\n') lineCount++;
          if (foundOpen && braceDepth === 0) break;
        }
        if (lineCount > longestFunc) {
          longestFunc = lineCount;
          longestName = match[0].slice(0, 40);
        }
      }
      if (funcStarts.length === 0) return { status: 'NOT_APPLICABLE', evidence: 'No function definitions in diff' };
      if (longestFunc > maxLines) {
        return { status: 'VIOLATED', evidence: `Longest function is ${longestFunc} lines (limit: ${maxLines}): ${longestName}...` };
      }
      return { status: 'COMPLIANT', evidence: `All ${funcStarts.length} function(s) under ${maxLines} lines (longest: ${longestFunc})` };
    },
  },
  {
    name: 'esm-imports',
    keywords: ['esm', 'import/export', 'no require', 'es modules', 'module import'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const requireLines = addedLines.filter(l => /\brequire\s*\(/.test(l) && !/\/\//.test(l.split('require')[0]));
      if (requireLines.length > 0) {
        return { status: 'VIOLATED', evidence: `${requireLines.length} require() call(s) in added code` };
      }
      const importLines = addedLines.filter(l => /\bimport\b/.test(l));
      if (importLines.length > 0) {
        return { status: 'COMPLIANT', evidence: 'Uses ESM imports' };
      }
      return { status: 'NOT_APPLICABLE', evidence: 'No import/require statements in diff' };
    },
  },
  {
    name: 'error-handling',
    keywords: ['asynchandler', 'error handling', 'try/catch', 'error handler', 'error middleware'],
    check: (diff, traceEvents) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      // Check if route-like files were modified
      const routeFiles = extractAllTouchedFiles(traceEvents)
        .filter(f => /route|handler|controller|endpoint/i.test(f));
      if (routeFiles.length === 0) return { status: 'NOT_APPLICABLE', evidence: 'No route/handler files modified' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const code = addedLines.join('\n');
      const hasErrorHandling = /asyncHandler|try\s*\{|\.catch\(|errorHandler|handleError/i.test(code);
      if (hasErrorHandling) {
        return { status: 'COMPLIANT', evidence: 'Error handling patterns found in route/handler code' };
      }
      return { status: 'VIOLATED', evidence: `${routeFiles.length} route file(s) modified without visible error handling` };
    },
  },
  {
    name: 'no-hardcoded-secrets',
    keywords: ['hardcode', 'secret', 'api key', 'credential', 'password', 'environment variable', 'env var'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      // Common patterns for hardcoded secrets
      const secretPatterns = [
        /(?:api[_-]?key|apikey|secret|password|token|credential)\s*[:=]\s*['"][^'"]{8,}/i,
        /(?:mongodb|postgres|mysql|redis):\/\/[^'"}\s]+:[^'"}\s]+@/i,
        /sk-[a-zA-Z0-9]{20,}/,  // OpenAI-style keys
        /ghp_[a-zA-Z0-9]{36}/,  // GitHub personal tokens
      ];
      for (const line of addedLines) {
        const code = line.replace(/\/\/.*$/, ''); // strip comments
        for (const pattern of secretPatterns) {
          if (pattern.test(code)) {
            return { status: 'VIOLATED', evidence: 'Possible hardcoded secret/credential detected in added code' };
          }
        }
      }
      return { status: 'COMPLIANT', evidence: 'No hardcoded secrets detected' };
    },
  },
  {
    name: 'aria-labels',
    keywords: ['aria', 'accessible', 'wcag', 'a11y', 'aria label', 'aria role'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const code = addedLines.join('\n');
      // Check if JSX/HTML interactive elements were added
      const interactiveEls = code.match(/<(?:button|input|a|select|textarea|dialog)\b[^>]*>/gi) || [];
      if (interactiveEls.length === 0) return { status: 'NOT_APPLICABLE', evidence: 'No interactive elements added' };
      const withAria = interactiveEls.filter(el => /aria-|role=/.test(el));
      const missing = interactiveEls.length - withAria.length;
      if (missing > 0) {
        return { status: 'VIOLATED', evidence: `${missing} of ${interactiveEls.length} interactive element(s) missing ARIA attributes` };
      }
      return { status: 'COMPLIANT', evidence: `All ${interactiveEls.length} interactive element(s) have ARIA attributes` };
    },
  },
  {
    name: 'no-inline-styles',
    keywords: ['inline style', 'no inline', 'css class', 'design token', 'style attribute'],
    check: (diff) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      // Match style={{...}} in JSX or style="..." in HTML
      const inlineStyles = addedLines.filter(l => /\bstyle\s*=\s*\{?\{/.test(l) || /\bstyle\s*=\s*"/.test(l));
      if (inlineStyles.length > 0) {
        return { status: 'VIOLATED', evidence: `${inlineStyles.length} inline style(s) in added code` };
      }
      return { status: 'COMPLIANT', evidence: 'No inline styles in added code' };
    },
  },
  {
    name: 'input-validation',
    keywords: ['validate', 'validation', 'zod', 'schema', 'sanitize', 'external input'],
    check: (diff, traceEvents) => {
      if (!diff) return { status: 'UNVERIFIABLE', evidence: 'No diff available' };
      const routeFiles = extractAllTouchedFiles(traceEvents)
        .filter(f => /route|handler|controller|endpoint|api/i.test(f));
      if (routeFiles.length === 0) return { status: 'NOT_APPLICABLE', evidence: 'No API/route files modified' };
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const code = addedLines.join('\n');
      const hasValidation = /\bz\.\b|zod|\.parse\(|\.safeParse\(|joi\b|yup\b|validate\(|\.body\(\s*{/.test(code);
      if (hasValidation) {
        return { status: 'COMPLIANT', evidence: 'Input validation found in route code' };
      }
      // Check if request body/params are accessed without validation
      const usesInput = /req\.body|req\.params|req\.query|request\.body/i.test(code);
      if (usesInput) {
        return { status: 'VIOLATED', evidence: 'Request input accessed without visible validation' };
      }
      return { status: 'NOT_APPLICABLE', evidence: 'No request input handling in diff' };
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractEditedSourceFiles(traceEvents) {
  const files = new Set();
  for (const evt of (traceEvents || [])) {
    if (evt.tool === 'Edit' || evt.tool === 'Write') {
      for (const f of (evt.files_touched || [])) {
        // Only source files, not test/spec/config files
        if (/\.(ts|js|tsx|jsx|py|go|rs|java)$/.test(f) &&
            !/\.(test|spec)\b/.test(f) && !/__tests__/.test(f) &&
            !/node_modules/.test(f)) {
          files.add(f);
        }
      }
    }
  }
  return [...files];
}

function extractAllTouchedFiles(traceEvents) {
  const files = new Set();
  for (const evt of (traceEvents || [])) {
    for (const f of (evt.files_touched || [])) files.add(f);
  }
  return [...files];
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Score a list of plain-text rules against the session diff and trace events.
 *
 * @param {string[]} rules - Plain-text rule strings
 * @param {string|null} diff - Git diff from session end (may be null)
 * @param {object[]} traceEvents - Parsed trace events from the session
 * @returns {Array<{ rule: string, status: string, evidence: string, check: string|null }>}
 */
export function scoreRules(rules, diff, traceEvents) {
  const results = [];

  for (const rule of rules) {
    const lower = rule.toLowerCase();
    let matched = false;

    for (const checker of CHECK_LIBRARY) {
      const keywordMatch = checker.keywords.some(kw => lower.includes(kw));
      if (keywordMatch) {
        const result = checker.check(diff, traceEvents);
        results.push({
          rule: rule.slice(0, 80),
          status: result.status,
          evidence: result.evidence,
          check: checker.name,
        });
        matched = true;
        break; // First matching checker wins
      }
    }

    if (!matched) {
      results.push({
        rule: rule.slice(0, 80),
        status: 'UNVERIFIABLE',
        evidence: 'No deterministic check available for this rule',
        check: null,
      });
    }
  }

  return results;
}

/**
 * Convert behavioral score status to a numeric score for aggregation.
 */
export function statusToScore(status) {
  switch (status) {
    case 'COMPLIANT': return 1.0;
    case 'VIOLATED': return -1.0;
    case 'NOT_APPLICABLE': return 0.0;
    case 'UNVERIFIABLE': return 0.0;
    default: return 0.0;
  }
}

/**
 * Parse rule lines from a markdown section.
 * Extracts lines that start with "- " (ignoring comments and headers).
 */
export function parseRuleLines(content) {
  if (!content) return [];
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- ') && !l.startsWith('- Example:') && !l.startsWith('- Add your'))
    .map(l => l.slice(2).trim())
    .filter(l => l.length > 10); // Skip very short lines (not real rules)
}

export { CHECK_LIBRARY, extractEditedSourceFiles, extractAllTouchedFiles };
