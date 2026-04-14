// src/lib/ingestion/markdown-parser.js

import { computeRuleHash } from '../rule-parser.js';

/**
 * Extract rule candidates from markdown content.
 *
 * @param {string} content - Full markdown file content
 * @param {string} sourceFile - Absolute path to the source file (for provenance)
 * @returns {object[]} Array of { text, tags, source, source_line }
 */
export function extractRulesFromMarkdown(content, sourceFile) {
  const rules = [];
  const lines = content.split('\n');

  let headingStack = [];
  let currentSectionLines = [];
  let currentSectionStartLine = 0;

  const flushSection = () => {
    if (currentSectionLines.length === 0) return;

    const tags = headingStack
      .filter(h => h.level >= 2)
      .map(h => normalizeTag(h.text));

    const bulletRules = extractBullets(currentSectionLines, currentSectionStartLine);

    if (bulletRules.length > 0) {
      for (const br of bulletRules) {
        rules.push({
          text: br.text,
          tags: [...tags],
          source: sourceFile,
          source_line: br.lineNumber,
        });
      }
    } else {
      const paragraph = extractFirstParagraph(currentSectionLines);
      if (paragraph && paragraph.text.length >= 10 && paragraph.text.length <= 500) {
        rules.push({
          text: paragraph.text,
          tags: [...tags],
          source: sourceFile,
          source_line: currentSectionStartLine + paragraph.lineOffset,
        });
      }
    }

    currentSectionLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);

    if (headingMatch) {
      flushSection();

      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });

      currentSectionStartLine = i + 1;
    } else {
      currentSectionLines.push({ text: line, lineOffset: currentSectionLines.length });
    }
  }

  flushSection();

  return rules;
}

function extractBullets(sectionLines, startLine) {
  const bullets = [];

  for (const { text: line, lineOffset } of sectionLines) {
    const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bulletMatch) {
      const ruleText = bulletMatch[1].trim();
      if (ruleText.length < 10) continue;
      if (ruleText.length > 500) continue;
      if (ruleText.startsWith('http')) continue;
      bullets.push({
        text: ruleText,
        lineNumber: startLine + lineOffset,
      });
    }
  }

  return bullets;
}

function extractFirstParagraph(sectionLines) {
  let paragraph = [];
  let startOffset = -1;

  for (let i = 0; i < sectionLines.length; i++) {
    const { text: line } = sectionLines[i];

    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }

    if (line.startsWith('```')) return null;
    if (line.startsWith('|')) return null;

    if (startOffset === -1) startOffset = i;
    paragraph.push(line.trim());
  }

  if (paragraph.length === 0) return null;

  return {
    text: paragraph.join(' '),
    lineOffset: startOffset,
  };
}

function normalizeTag(text) {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}
