/**
 * rule-registry.js — Structured rule registry (Phase 6)
 *
 * Parses, serializes, and merges rules.yaml files that give inline route
 * rules first-class metadata: severity, author, tags, routes, related, etc.
 * Supports team + developer override layering.
 */

import fs from 'fs';
import path from 'path';
import { computeRuleHash } from './rule-parser.js';
import { withFileLock } from './file-lock.js';

/**
 * Default rule fields. Every rule has at least these.
 */
const RULE_DEFAULTS = {
  text: '',
  description: '',
  severity: 'should',    // 'must' | 'should' | 'may'
  author: 'unknown',
  created: '',
  tags: [],
  routes: [],
  related: [],
  hash: '',
  origin: '',                   // Phase 7
  source: '',                    // Phase 7
  source_line: 0,                // Phase 7
  source_hash: '',               // Phase 7
  behavioral_signals: [],        // Phase 7
};

// ---------------------------------------------------------------------------
// YAML parsing (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a rules.yaml file into a Map<string, RuleObject>.
 *
 * Expected format:
 *   rules:
 *     RULE-ID:
 *       text: "rule text"
 *       severity: must
 *       tags: [security, api]
 *       ...
 */
export function parseRulesYaml(content) {
  const rules = new Map();
  if (!content || !content.includes('rules:')) return rules;

  const ruleBlocks = splitIntoRuleBlocks(content);

  for (const { id, blockLines } of ruleBlocks) {
    const rule = parseRuleBlock(blockLines);
    if (!rule.hash && rule.text) {
      rule.hash = computeRuleHash(rule.text);
    }
    rules.set(id, { ...RULE_DEFAULTS, ...rule, id });
  }

  return rules;
}

function splitIntoRuleBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');
  let currentId = null;
  let currentBlock = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('#') || line.trim() === 'rules:') continue;

    const idMatch = line.match(/^  (\S+):$/);
    if (idMatch) {
      if (currentId) {
        blocks.push({ id: currentId, blockLines: currentBlock });
      }
      currentId = idMatch[1];
      currentBlock = [];
      continue;
    }

    if (currentId && line.length > 0) {
      currentBlock.push(line);
    }
  }

  if (currentId) {
    blocks.push({ id: currentId, blockLines: currentBlock });
  }

  return blocks;
}

function parseRuleBlock(lines) {
  const rule = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fieldMatch = line.match(/^    (\w[\w_]*):\s*(.*)/);

    if (!fieldMatch) { i++; continue; }

    const [, key, rawValue] = fieldMatch;
    const value = rawValue.trim();

    if (key === 'behavioral_signals' && value === '') {
      const signals = [];
      i++;
      while (i < lines.length && lines[i].startsWith('      - ')) {
        const signalLines = [lines[i]];
        i++;
        while (i < lines.length && lines[i].startsWith('        ')) {
          signalLines.push(lines[i]);
          i++;
        }
        const signal = parseSignalBlock(signalLines);
        if (signal) signals.push(signal);
      }
      rule[key] = signals;
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      rule[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else if (value === 'true') rule[key] = true;
    else if (value === 'false') rule[key] = false;
    else if (/^\d+$/.test(value)) rule[key] = parseInt(value, 10);
    else if (/^\d+\.\d+$/.test(value)) rule[key] = parseFloat(value);
    else rule[key] = value.replace(/^["']|["']$/g, '');

    i++;
  }

  return rule;
}

function parseSignalBlock(lines) {
  const signal = { trigger: {}, expect: {} };
  let currentSection = null;

  for (const line of lines) {
    if (line.match(/^\s+- trigger:/)) {
      currentSection = 'trigger';
      continue;
    }
    if (line.match(/^\s+expect:/)) {
      currentSection = 'expect';
      continue;
    }

    const fieldMatch = line.match(/^\s+(\w[\w_]*):\s*(.+)/);
    if (fieldMatch && currentSection) {
      const [, key, rawValue] = fieldMatch;
      const value = rawValue.trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        signal[currentSection][key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      } else {
        signal[currentSection][key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  // Phase 8: validate content_includes as a compilable regex
  if (signal.expect && signal.expect.content_includes) {
    try {
      new RegExp(signal.expect.content_includes);
    } catch (err) {
      console.warn(`Invalid content_includes regex: ${signal.expect.content_includes} — ${err.message}`);
      return null;
    }
  }

  return (signal.trigger && signal.expect) ? signal : null;
}

// ---------------------------------------------------------------------------
// YAML writing
// ---------------------------------------------------------------------------

export function serializeRulesYaml(rules) {
  const lines = [
    '# Harness Harness — Rule Registry',
    '# Managed by: harness-harness rules',
    '',
    'rules:',
  ];

  const fieldOrder = ['text', 'description', 'severity', 'author', 'created',
                      'tags', 'routes', 'related', 'origin', 'source',
                      'source_line', 'source_hash', 'hash', 'behavioral_signals'];

  for (const [id, rule] of rules) {
    lines.push(`  ${id}:`);

    for (const key of fieldOrder) {
      const value = rule[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value === '' && key !== 'text') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (key === 'source_line' && value === 0) continue;

      if (key === 'behavioral_signals' && Array.isArray(value)) {
        if (value.length === 0) continue;
        lines.push(`    behavioral_signals:`);
        for (const signal of value) {
          lines.push(`      - trigger:`);
          for (const [k, v] of Object.entries(signal.trigger || {})) {
            if (Array.isArray(v)) {
              lines.push(`          ${k}: [${v.join(', ')}]`);
            } else {
              lines.push(`          ${k}: ${v}`);
            }
          }
          lines.push(`        expect:`);
          for (const [k, v] of Object.entries(signal.expect || {})) {
            if (Array.isArray(v)) {
              lines.push(`          ${k}: [${v.join(', ')}]`);
            } else {
              lines.push(`          ${k}: ${v}`);
            }
          }
        }
        continue;
      }

      if (Array.isArray(value)) {
        lines.push(`    ${key}: [${value.join(', ')}]`);
      } else if (typeof value === 'string' && (value.includes(':') || value.includes('"'))) {
        lines.push(`    ${key}: "${value.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`    ${key}: ${value}`);
      }
    }

    for (const [key, value] of Object.entries(rule)) {
      if (fieldOrder.includes(key) || key === 'id') continue;
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        lines.push(`    ${key}: [${value.join(', ')}]`);
      } else {
        lines.push(`    ${key}: ${value}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Registry loading with team/developer merge
// ---------------------------------------------------------------------------

/**
 * Load the merged rule registry for a project.
 * Team rules from .harness/rules.yaml, developer overrides from .harness/local/rules.yaml.
 */
export function loadRuleRegistry(paths) {
  let teamRules = new Map();
  let devRules = new Map();

  const teamFile = paths.rulesFile || path.join(paths.harnessDir, 'rules.yaml');
  if (fs.existsSync(teamFile)) {
    teamRules = parseRulesYaml(fs.readFileSync(teamFile, 'utf8'));
  }

  const devFile = paths.localRulesFile || path.join(paths.localDir, 'rules.yaml');
  if (fs.existsSync(devFile)) {
    devRules = parseRulesYaml(fs.readFileSync(devFile, 'utf8'));
  }

  const merged = new Map(teamRules);
  for (const [id, rule] of devRules) {
    merged.set(id, rule);
  }

  return merged;
}

/**
 * Resolve a rule ID against the registry, with inline fallback.
 */
export function resolveRule(id, registry) {
  if (registry.has(id)) return registry.get(id);

  if (id.startsWith('rule-')) {
    const hash = id.slice(5);
    for (const rule of registry.values()) {
      if (rule.hash === hash) return rule;
    }
  }

  return null;
}

/**
 * Add a rule to the team or local registry file.
 */
export function addRuleToFile(rule, registryFile) {
  let existing = new Map();
  if (fs.existsSync(registryFile)) {
    existing = parseRulesYaml(fs.readFileSync(registryFile, 'utf8'));
  }

  if (!rule.hash) {
    rule.hash = computeRuleHash(rule.text);
  }
  if (!rule.created) {
    rule.created = new Date().toISOString().slice(0, 10);
  }
  if (!rule.author) {
    rule.author = process.env.USER || process.env.USERNAME || 'unknown';
  }

  existing.set(rule.id, { ...RULE_DEFAULTS, ...rule });

  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  withFileLock(registryFile, () => {
    fs.writeFileSync(registryFile, serializeRulesYaml(existing), 'utf8');
  });
}

/**
 * List rules from the registry, optionally filtered.
 */
export function filterRules(registry, filter = {}) {
  let results = [...registry.values()];

  if (filter.tag) {
    results = results.filter(r => (r.tags || []).includes(filter.tag));
  }
  if (filter.route) {
    results = results.filter(r => (r.routes || []).includes(filter.route));
  }
  if (filter.severity) {
    results = results.filter(r => r.severity === filter.severity);
  }
  if (filter.query) {
    const q = filter.query.toLowerCase();
    results = results.filter(r =>
      (r.text || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q) ||
      (r.id || '').toLowerCase().includes(q) ||
      (r.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  if (filter.origin) {
    results = results.filter(r => r.origin === filter.origin);
  }

  return results;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'use', 'all', 'any', 'must', 'should',
  'always', 'never', 'this', 'that', 'from', 'when', 'while', 'then',
]);

/**
 * Simple Jaccard-ish token similarity (0.0 to 1.0).
 */
export function normalizedSimilarity(a, b) {
  const tokenize = (s) => new Set(
    (s || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .filter(t => !STOP_WORDS.has(t))
  );

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

export { RULE_DEFAULTS };
