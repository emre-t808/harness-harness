import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverRules, detectStack, buildStackFingerprint, formatDiscoveredRules } from './rule-discovery.js';

function makeTmpProject(files = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-discover-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return tmpDir;
}

// ---------------------------------------------------------------------------
// detectStack — multi-ecosystem
// ---------------------------------------------------------------------------

describe('detectStack', () => {
  it('detects Node.js + TypeScript + Express', () => {
    const dir = makeTmpProject({
      'package.json': { type: 'module', dependencies: { express: '4.0' }, devDependencies: { typescript: '5.0' } },
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('node'));
    assert.ok(techs.includes('esm'));
    assert.ok(techs.includes('typescript'));
    assert.ok(techs.includes('express'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects Python + FastAPI + pytest', () => {
    const dir = makeTmpProject({
      'requirements.txt': 'fastapi==0.100.0\npytest==7.4.0\nsqlalchemy==2.0.0\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('python'));
    assert.ok(techs.includes('fastapi'));
    assert.ok(techs.includes('pytest'));
    assert.ok(techs.includes('sqlalchemy'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects Go + Gin', () => {
    const dir = makeTmpProject({
      'go.mod': 'module example.com/myapp\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.0\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('go'));
    assert.ok(techs.includes('gin'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects Rust + Axum + Tokio', () => {
    const dir = makeTmpProject({
      'Cargo.toml': '[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\nserde = "1"\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('rust'));
    assert.ok(techs.includes('axum'));
    assert.ok(techs.includes('tokio'));
    assert.ok(techs.includes('serde'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects Kotlin + Spring', () => {
    const dir = makeTmpProject({
      'build.gradle.kts': 'plugins { kotlin("jvm") }\ndependencies { implementation("org.springframework.boot:spring-boot") }\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('kotlin'));
    assert.ok(techs.includes('spring'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects Ruby + Rails', () => {
    const dir = makeTmpProject({
      'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 7.0"\ngem "rspec-rails"\ngem "rubocop"\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('ruby'));
    assert.ok(techs.includes('rails'));
    assert.ok(techs.includes('rspec'));
    assert.ok(techs.includes('rubocop'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects Docker + Terraform', () => {
    const dir = makeTmpProject({
      'Dockerfile': 'FROM node:20\nCOPY . .\n',
      'main.tf': 'resource "aws_instance" "web" {}\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('docker'));
    assert.ok(techs.includes('terraform'));
    fs.rmSync(dir, { recursive: true });
  });

  it('detects dbt', () => {
    const dir = makeTmpProject({
      'dbt_project.yml': 'name: my_project\nversion: 1.0.0\n',
    });
    const stack = detectStack(dir);
    const techs = stack.map(s => s.tech);
    assert.ok(techs.includes('dbt'));
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty for bare directory', () => {
    const dir = makeTmpProject({});
    const stack = detectStack(dir);
    assert.equal(stack.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// buildStackFingerprint
// ---------------------------------------------------------------------------

describe('buildStackFingerprint', () => {
  it('builds readable fingerprint from stack', () => {
    const stack = [
      { tech: 'node' }, { tech: 'typescript' }, { tech: 'ts-strict' },
      { tech: 'express' }, { tech: 'prisma' }, { tech: 'vitest' }, { tech: 'docker' },
    ];
    const fp = buildStackFingerprint(stack);
    assert.ok(fp.includes('TypeScript (strict)'));
    assert.ok(fp.includes('Express'));
    assert.ok(fp.includes('Prisma'));
    assert.ok(fp.includes('Vitest'));
    assert.ok(fp.includes('Docker'));
  });

  it('handles Python stack', () => {
    const stack = [{ tech: 'python' }, { tech: 'fastapi' }, { tech: 'sqlalchemy' }, { tech: 'pytest' }];
    const fp = buildStackFingerprint(stack);
    assert.ok(fp.includes('Python'));
    assert.ok(fp.includes('Fastapi'));
    assert.ok(fp.includes('Pytest'));
  });

  it('returns Unknown for empty stack', () => {
    assert.equal(buildStackFingerprint([]), 'Unknown stack');
  });
});

// ---------------------------------------------------------------------------
// discoverRules (integration)
// ---------------------------------------------------------------------------

describe('discoverRules', () => {
  it('discovers rules from a Node.js + Express project', () => {
    const dir = makeTmpProject({
      'package.json': {
        type: 'module',
        dependencies: { express: '4.18.0', zod: '3.22.0' },
        devDependencies: { typescript: '5.3.0', vitest: '1.0.0' },
      },
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    });
    const { rules, stack, fingerprint } = discoverRules(dir);
    assert.ok(rules.length >= 5, `Expected 5+ rules, got ${rules.length}`);
    assert.ok(fingerprint.includes('TypeScript'));
    assert.ok(fingerprint.includes('Express'));
    const ruleTexts = rules.map(r => r.rule.toLowerCase());
    assert.ok(ruleTexts.some(r => r.includes('esm')));
    assert.ok(ruleTexts.some(r => r.includes('zod')));
    fs.rmSync(dir, { recursive: true });
  });

  it('discovers rules from a Python + Django project', () => {
    const dir = makeTmpProject({
      'requirements.txt': 'django==4.2\npytest==7.4\nmypy==1.0\n',
      'CLAUDE.md': '# Project\n- Always run migrations before deploying\n- Use class-based views\n',
    });
    const { rules, fingerprint } = discoverRules(dir);
    assert.ok(fingerprint.includes('Python'));
    assert.ok(fingerprint.includes('Django'));
    const ruleTexts = rules.map(r => r.rule.toLowerCase());
    assert.ok(ruleTexts.some(r => r.includes('django')));
    assert.ok(ruleTexts.some(r => r.includes('mypy')));
    assert.ok(ruleTexts.some(r => r.includes('migrations')));
    fs.rmSync(dir, { recursive: true });
  });

  it('discovers rules from a Go project', () => {
    const dir = makeTmpProject({
      'go.mod': 'module example.com/svc\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.0\nrequire google.golang.org/grpc v1.60.0\n',
    });
    const { rules, fingerprint } = discoverRules(dir);
    assert.ok(fingerprint.includes('Go'));
    assert.ok(fingerprint.includes('Gin'));
    const ruleTexts = rules.map(r => r.rule.toLowerCase());
    assert.ok(ruleTexts.some(r => r.includes('gofmt') || r.includes('go convention')));
    fs.rmSync(dir, { recursive: true });
  });

  it('deduplicates similar rules', () => {
    const dir = makeTmpProject({
      'package.json': { type: 'module', devDependencies: { typescript: '5.0' } },
      'tsconfig.json': '{ "compilerOptions": { "module": "esnext" } }',
    });
    const { rules } = discoverRules(dir);
    const esmRules = rules.filter(r => r.rule.toLowerCase().includes('esm'));
    assert.ok(esmRules.length <= 1, `ESM should be deduped, got ${esmRules.length}`);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// formatDiscoveredRules
// ---------------------------------------------------------------------------

describe('formatDiscoveredRules', () => {
  it('formats rules as markdown with sections', () => {
    const rules = [
      { rule: 'Use strict TypeScript', confidence: 'high' },
      { rule: 'Run lint before commit', confidence: 'medium' },
    ];
    const md = formatDiscoveredRules(rules);
    assert.ok(md.includes('### Must Load'));
    assert.ok(md.includes('Use strict TypeScript'));
    assert.ok(md.includes('### Load If Budget Allows'));
    assert.ok(md.includes('Run lint before commit'));
  });
});
