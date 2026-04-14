import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRulesFromMarkdown } from './markdown-parser.js';

describe('extractRulesFromMarkdown', () => {
  it('extracts bullets under headings', () => {
    const content = `# Project Guide

## API Conventions
- Use REST naming conventions
- Always version endpoints
- Return JSON from all endpoints

## Database
- Always use parameterized queries
- Never use string concatenation for SQL
`;

    const rules = extractRulesFromMarkdown(content, '/test/CLAUDE.md');
    assert.equal(rules.length, 5);
    assert.equal(rules[0].text, 'Use REST naming conventions');
    assert.deepStrictEqual(rules[0].tags, ['api-conventions']);
    assert.equal(rules[3].text, 'Always use parameterized queries');
    assert.deepStrictEqual(rules[3].tags, ['database']);
  });

  it('extracts paragraph when no bullets', () => {
    const content = `# Overview

## Error Handling
All errors must be caught and logged with context including the user ID,
request ID, and timestamp. Never swallow exceptions silently.

## Other Section
- explicit bullet rule
`;

    const rules = extractRulesFromMarkdown(content, '/test/CLAUDE.md');
    assert.equal(rules.length, 2);
    assert.ok(rules[0].text.startsWith('All errors must be caught'));
    assert.deepStrictEqual(rules[0].tags, ['error-handling']);
    assert.equal(rules[1].text, 'explicit bullet rule');
  });

  it('tracks nested heading tags', () => {
    const content = `# Project

## Backend
### Database
- Use parameterized queries

### API
- Return JSON
`;

    const rules = extractRulesFromMarkdown(content, '/test/file.md');
    assert.equal(rules.length, 2);
    assert.deepStrictEqual(rules[0].tags, ['backend', 'database']);
    assert.deepStrictEqual(rules[1].tags, ['backend', 'api']);
  });

  it('skips bullets that are too short or too long', () => {
    const content = `## Rules
- ok
- This is a valid rule that should be extracted
- ${'x'.repeat(600)}
`;

    const rules = extractRulesFromMarkdown(content, '/test/file.md');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].text, 'This is a valid rule that should be extracted');
  });

  it('handles numbered lists', () => {
    const content = `## Guidelines
1. First rule here
2. Second rule here
3. Third rule here
`;

    const rules = extractRulesFromMarkdown(content, '/test/file.md');
    assert.equal(rules.length, 3);
    assert.equal(rules[0].text, 'First rule here');
  });

  it('skips code blocks in paragraph extraction', () => {
    const content = `## Configuration

\`\`\`json
{ "key": "value" }
\`\`\`

- Use environment variables for secrets
`;

    const rules = extractRulesFromMarkdown(content, '/test/file.md');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].text, 'Use environment variables for secrets');
  });
});
