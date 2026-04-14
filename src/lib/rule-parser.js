/**
 * rule-parser.js — Deterministic rule extraction for route configs
 *
 * Replaces regex-based rule discovery with a parser that walks route config
 * "Must Load" sections, recognizes both explicit-id rules (XX-NNN) and
 * free-text rules, and assigns deterministic content-hashed IDs to free-text.
 */

import { createHash } from 'crypto';

/**
 * Compute a deterministic 8-char hex hash from rule text.
 * Normalize: lowercase, trim, collapse whitespace.
 */
export function computeRuleHash(text) {
  const normalized = (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

/**
 * Parse a single "- " bullet line from a route config Must Load section.
 *
 * Three formats supported:
 *   "- API-001: RESTful naming conventions"  → explicit-id
 *   "- API-001"                               → explicit-id (no text)
 *   "- Always validate webhook signatures"    → free-text
 *
 * @param {string} line - The bullet line (with or without leading "- ")
 * @param {string} source - Source file and line number, e.g. "coding-backend.md:14"
 * @returns {object|null} { id, hash, text, source, origin }
 */
export function parseRuleLine(line, source) {
  const trimmed = line.replace(/^-\s*/, '').trim();
  if (!trimmed) return null;

  const explicitMatch = trimmed.match(/^([A-Z]{2,4}-\d{2,4})(?::\s*(.*))?$/);
  if (explicitMatch) {
    const id = explicitMatch[1];
    const text = (explicitMatch[2] || '').trim() || id;
    return {
      id,
      hash: computeRuleHash(text),
      text,
      source,
      origin: 'explicit-id',
    };
  }

  const hash = computeRuleHash(trimmed);
  return {
    id: `rule-${hash}`,
    hash,
    text: trimmed,
    source,
    origin: 'free-text',
  };
}

/**
 * Parse all rules from a route config section's "Must Load" content.
 *
 * @param {string} sectionContent - The full "## Route Context" section text
 * @param {string} sourceFile - Filename for source tracking, e.g. "coding-backend.md"
 * @returns {object[]} Array of parsed rule objects
 */
export function parseRulesFromSection(sectionContent, sourceFile) {
  const rules = [];
  const lines = (sectionContent || '').split('\n');
  let inMustLoad = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('### Must Load')) {
      inMustLoad = true;
      continue;
    }
    if (/^###\s/.test(line) && !line.includes('Must Load')) {
      inMustLoad = false;
      continue;
    }

    if (inMustLoad && line.startsWith('- ')) {
      const rule = parseRuleLine(line, `${sourceFile}:${i + 1}`);
      if (rule) rules.push(rule);
    }
  }

  return rules;
}
