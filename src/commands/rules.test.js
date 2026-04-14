import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { rules as rulesCmd } from './rules.js';

let tmpDir;
let origLog;
let logged;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ingest-e2e-'));
  fs.mkdirSync(path.join(tmpDir, '.harness', 'memory'), { recursive: true });
  logged = [];
  origLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
});

afterEach(() => {
  console.log = origLog;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('rules ingest — end-to-end', () => {
  it('ingests a CLAUDE.md file into rules.yaml with severity detection', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'),
      `## API Conventions

- Use REST naming
- Always version endpoints

## Database

- NEVER use string concatenation for SQL
`);

    await rulesCmd(tmpDir, ['ingest']);

    const rulesFile = path.join(tmpDir, '.harness', 'rules.yaml');
    assert.ok(fs.existsSync(rulesFile), 'rules.yaml should be created');

    const yaml = fs.readFileSync(rulesFile, 'utf8');
    assert.ok(yaml.includes('Use REST naming'));
    assert.ok(yaml.includes('Always version endpoints'));
    assert.ok(yaml.includes('NEVER use string concatenation'));
    // ALWAYS / NEVER bullets should be detected as severity: must
    assert.ok(/severity:\s*must/.test(yaml), 'NEVER/ALWAYS should map to severity: must');
  });

  it('handles nested CLAUDE.md without ID collision', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '## Rules\n\n- Shared rule text\n');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'CLAUDE.md'), '## Rules\n\n- Shared rule text\n');

    await rulesCmd(tmpDir, ['ingest']);

    const yaml = fs.readFileSync(path.join(tmpDir, '.harness', 'rules.yaml'), 'utf8');
    // Count distinct cmd- IDs (format: cmd-<4hex>-<8hex>)
    const ids = new Set([...yaml.matchAll(/^  (cmd-[a-f0-9]{4}-[a-f0-9]{8}):$/gm)].map(m => m[1]));
    assert.ok(ids.size >= 2, `Expected ≥2 distinct IDs for nested CLAUDE.md files, got ${ids.size}`);
  });

  it('dry-run does not write rules.yaml', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '## Rules\n\n- A simple rule\n');

    await rulesCmd(tmpDir, ['ingest', '--dry-run']);

    const rulesFile = path.join(tmpDir, '.harness', 'rules.yaml');
    assert.ok(!fs.existsSync(rulesFile), 'dry-run must not write files');
  });
});
