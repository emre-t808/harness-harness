// src/lib/ingestion/parsers.js

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { extractRulesFromMarkdown } from './markdown-parser.js';
import { computeRuleHash } from '../rule-parser.js';

/**
 * Compute SHA-256 hash of a file's contents (first 16 hex chars).
 * Used for source_hash staleness detection.
 */
export function computeSourceHash(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Parse a single file using the appropriate parser for its format.
 *
 * @param {string} filePath - Absolute path to source file
 * @param {string} format - Format identifier
 * @param {string} projectDir - Project root, for relative-path ID scoping
 * @returns {{ rules: object[], coverage: { rules_extracted, total_lines, coverage_ratio } }}
 */
export function parseSourceFile(filePath, format, projectDir = '') {
  if (!fs.existsSync(filePath)) {
    return { rules: [], coverage: { rules_extracted: 0, total_lines: 0, coverage_ratio: 0 } };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const sourceHash = computeSourceHash(filePath);
  const totalLines = content.split('\n').filter(l => l.trim().length > 0).length;

  let rawRules = [];

  switch (format) {
    case 'claude-md':
    case 'agents-md':
    case 'gsd':
      rawRules = extractRulesFromMarkdown(content, filePath);
      break;

    case 'cursorrules':
      rawRules = parseCursorRulesFlat(content, filePath);
      break;

    case 'cursor-rules-dir':
      rawRules = extractRulesFromMarkdown(content, filePath);
      break;

    default:
      return { rules: [], coverage: { rules_extracted: 0, total_lines: totalLines, coverage_ratio: 0 } };
  }

  const rules = rawRules.map(raw => {
    const id = generateIngestedRuleId(raw.text, format, filePath, projectDir);
    return {
      id,
      text: raw.text,
      hash: computeRuleHash(raw.text),
      severity: detectSeverity(raw.text),
      author: `ingested from ${format}`,
      created: new Date().toISOString().slice(0, 10),
      tags: raw.tags || [],
      routes: [],
      origin: format,
      source: filePath,
      source_line: raw.source_line || 0,
      source_hash: sourceHash,
      sources: [filePath],
    };
  });

  const coverage_ratio = totalLines > 0 ? rules.length / totalLines : 0;

  return {
    rules,
    coverage: {
      rules_extracted: rules.length,
      total_lines: totalLines,
      coverage_ratio: Math.round(coverage_ratio * 1000) / 1000,
    },
  };
}

function parseCursorRulesFlat(content, sourceFile) {
  const rules = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text.length >= 10 && text.length <= 500) {
        rules.push({
          text,
          tags: ['cursor'],
          source: sourceFile,
          source_line: i + 1,
        });
      }
    }
  }

  return rules;
}

/**
 * Generate a stable, deterministic rule ID for an ingested rule.
 *
 * Format: {origin-prefix}-{path-hash-4}-{text-hash-8}
 *   root CLAUDE.md → cmd-0000-a1b2c3d4
 *   src/CLAUDE.md  → cmd-7f2e-a1b2c3d4
 */
function generateIngestedRuleId(text, format, sourcePath, projectDir) {
  const textHash = computeRuleHash(text);
  const prefixMap = {
    'claude-md': 'cmd',
    'agents-md': 'amd',
    'cursorrules': 'cr',
    'cursor-rules-dir': 'crd',
    'gsd': 'gsd',
  };
  const prefix = prefixMap[format] || 'ext';

  const relPath = projectDir && sourcePath.startsWith(projectDir)
    ? sourcePath.slice(projectDir.length).replace(/^\/+/, '')
    : sourcePath;
  const isRoot = !relPath.includes('/');
  const pathHash = isRoot ? '0000' : computeRuleHash(relPath).slice(0, 4);

  return `${prefix}-${pathHash}-${textHash}`;
}

/**
 * Detect severity from rule text using emphasized keywords.
 */
export function detectSeverity(text) {
  const upper = (text || '').toUpperCase();
  if (/\b(MUST|NEVER|CRITICAL|ALWAYS|REQUIRED|DO NOT|DON'T)\b/.test(upper)) return 'must';
  if (/\b(SHOULD|PREFER|RECOMMENDED)\b/.test(upper)) return 'should';
  if (/\b(MAY|CAN|OPTIONAL)\b/.test(upper)) return 'may';
  return 'should';
}
