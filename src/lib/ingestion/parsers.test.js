import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseSourceFile, computeSourceHash, detectSeverity } from './parsers.js';

describe('parseSourceFile', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ingest-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses CLAUDE.md with claude-md format', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, `## API Rules
- Use REST naming conventions
- Version endpoints always
`);

    const { rules } = parseSourceFile(filePath, 'claude-md', tmpDir);
    assert.equal(rules.length, 2);
    assert.match(rules[0].id, /^cmd-[a-f0-9]{4}-[a-f0-9]{8}$/);
    assert.equal(rules[0].origin, 'claude-md');
    assert.equal(rules[0].text, 'Use REST naming conventions');
    assert.ok(rules[0].source_hash.length === 16);
    assert.equal(rules[0].source, filePath);
  });

  it('parses flat .cursorrules file', () => {
    const filePath = path.join(tmpDir, '.cursorrules');
    fs.writeFileSync(filePath, `- Use TypeScript strict mode
- Prefer interfaces over types for object shapes
- Never use any type
`);

    const { rules } = parseSourceFile(filePath, 'cursorrules', tmpDir);
    assert.equal(rules.length, 3);
    assert.match(rules[0].id, /^cr-[a-f0-9]{4}-[a-f0-9]{8}$/);
    assert.equal(rules[0].origin, 'cursorrules');
  });

  it('deterministic: same content produces same IDs', () => {
    const filePath = path.join(tmpDir, 'CLAUDE2.md');
    fs.writeFileSync(filePath, `## Rules
- Exact same rule text here
`);

    const r1 = parseSourceFile(filePath, 'claude-md', tmpDir);
    const r2 = parseSourceFile(filePath, 'claude-md', tmpDir);

    assert.equal(r1.rules[0].id, r2.rules[0].id);
    assert.equal(r1.rules[0].source_hash, r2.rules[0].source_hash);
  });

  it('source_hash changes when content changes', () => {
    const filePath = path.join(tmpDir, 'CLAUDE3.md');

    fs.writeFileSync(filePath, `## Rules
- Original rule here
`);
    const hash1 = computeSourceHash(filePath);

    fs.writeFileSync(filePath, `## Rules
- Modified rule here
`);
    const hash2 = computeSourceHash(filePath);

    assert.notEqual(hash1, hash2);
  });

  it('returns empty array for non-existent file', () => {
    const { rules } = parseSourceFile('/nonexistent/path.md', 'claude-md');
    assert.equal(rules.length, 0);
  });

  it('nested CLAUDE.md files get distinct IDs', () => {
    const rootFile = path.join(tmpDir, 'CLAUDE.md');
    const srcDir = path.join(tmpDir, 'srcnested');
    fs.mkdirSync(srcDir, { recursive: true });
    const nestedFile = path.join(srcDir, 'CLAUDE.md');

    const bullet = `## Rules
- Use TypeScript strict mode always
`;
    fs.writeFileSync(rootFile, bullet);
    fs.writeFileSync(nestedFile, bullet);

    const r1 = parseSourceFile(rootFile, 'claude-md', tmpDir);
    const r2 = parseSourceFile(nestedFile, 'claude-md', tmpDir);

    assert.notEqual(r1.rules[0].id, r2.rules[0].id);
    assert.match(r1.rules[0].id, /^cmd-0000-/);
  });

  it('coverage ratio is reported', () => {
    const filePath = path.join(tmpDir, 'coverage.md');
    fs.writeFileSync(filePath, `## Rules
- One rule here
`);
    const { coverage } = parseSourceFile(filePath, 'claude-md', tmpDir);
    assert.ok(coverage.total_lines > 0);
    assert.ok(coverage.coverage_ratio >= 0);
    assert.equal(coverage.rules_extracted, 1);
  });
});

describe('detectSeverity', () => {
  it('detects must from NEVER keyword', () => {
    assert.equal(detectSeverity('NEVER commit secrets to git'), 'must');
  });
  it('detects must from MUST keyword', () => {
    assert.equal(detectSeverity('You MUST use bcrypt for password hashing'), 'must');
  });
  it('detects should from PREFER keyword', () => {
    assert.equal(detectSeverity('Prefer async/await over callbacks'), 'should');
  });
  it('defaults to should', () => {
    assert.equal(detectSeverity('Handle errors gracefully'), 'should');
  });
});
