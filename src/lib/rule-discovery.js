/**
 * rule-discovery.js — Auto-extract rules from any codebase
 *
 * Scans the repo's actual files to detect its technology stack and conventions.
 * Works with any ecosystem: JS/TS, Python, Go, Rust, Java/Kotlin, Swift,
 * Ruby, Docker, Terraform, dbt, and more.
 *
 * Returns a stack fingerprint (what this repo actually is) and proposed rules
 * (what conventions it should follow). No hardcoded "backend vs frontend"
 * taxonomy — the rules come from what's in the repo.
 *
 * All checks are deterministic: file reads, regex, git commands. No LLM calls.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Stack detection — what is this repo?
// ---------------------------------------------------------------------------

/**
 * Detect the technology stack by scanning for signature files.
 * Returns a list of { tech, version?, evidence } objects.
 */
export function detectStack(projectDir) {
  const stack = [];
  const has = (name) => fs.existsSync(path.join(projectDir, name));
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, name), 'utf8')); }
    catch { return null; }
  };
  const readText = (name) => {
    try { return fs.readFileSync(path.join(projectDir, name), 'utf8'); }
    catch { return null; }
  };

  // --- JavaScript / TypeScript ---
  const pkg = readJson('package.json');
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    stack.push({ tech: 'node', evidence: 'package.json' });
    if (pkg.type === 'module') stack.push({ tech: 'esm', evidence: 'package.json type:module' });
    if (deps.typescript) stack.push({ tech: 'typescript', evidence: 'package.json' });
    if (deps.react || deps['react-dom']) stack.push({ tech: 'react', evidence: 'package.json' });
    if (deps.vue) stack.push({ tech: 'vue', evidence: 'package.json' });
    if (deps.svelte) stack.push({ tech: 'svelte', evidence: 'package.json' });
    if (deps['@angular/core']) stack.push({ tech: 'angular', evidence: 'package.json' });
    if (deps.next) stack.push({ tech: 'nextjs', evidence: 'package.json' });
    if (deps.express) stack.push({ tech: 'express', evidence: 'package.json' });
    if (deps.fastify) stack.push({ tech: 'fastify', evidence: 'package.json' });
    if (deps['@nestjs/core']) stack.push({ tech: 'nestjs', evidence: 'package.json' });
    if (deps.koa) stack.push({ tech: 'koa', evidence: 'package.json' });
    if (deps.vitest) stack.push({ tech: 'vitest', evidence: 'package.json' });
    if (deps.jest) stack.push({ tech: 'jest', evidence: 'package.json' });
    if (deps.mocha) stack.push({ tech: 'mocha', evidence: 'package.json' });
    if (deps.zod) stack.push({ tech: 'zod', evidence: 'package.json' });
    if (deps.prisma || deps['@prisma/client']) stack.push({ tech: 'prisma', evidence: 'package.json' });
    if (deps.drizzle || deps['drizzle-orm']) stack.push({ tech: 'drizzle', evidence: 'package.json' });
    if (deps.eslint) stack.push({ tech: 'eslint', evidence: 'package.json' });
    if (deps.prettier) stack.push({ tech: 'prettier', evidence: 'package.json' });
    if (deps.tailwindcss) stack.push({ tech: 'tailwind', evidence: 'package.json' });
    if (deps.electron) stack.push({ tech: 'electron', evidence: 'package.json' });
  }
  if (has('tsconfig.json')) {
    const ts = readText('tsconfig.json');
    if (ts) {
      if (/"strict"\s*:\s*true/.test(ts)) stack.push({ tech: 'ts-strict', evidence: 'tsconfig.json strict:true' });
      if (/"noImplicitAny"\s*:\s*true/.test(ts)) stack.push({ tech: 'ts-no-implicit-any', evidence: 'tsconfig.json' });
    }
  }

  // --- Python ---
  if (has('pyproject.toml') || has('setup.py') || has('setup.cfg') || has('requirements.txt') || has('Pipfile')) {
    stack.push({ tech: 'python', evidence: has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt or setup.py' });
    const pyproject = readText('pyproject.toml');
    const reqs = readText('requirements.txt') || '';
    const allPy = (pyproject || '') + reqs;
    if (/fastapi/i.test(allPy)) stack.push({ tech: 'fastapi', evidence: 'python deps' });
    if (/django/i.test(allPy)) stack.push({ tech: 'django', evidence: 'python deps' });
    if (/flask/i.test(allPy)) stack.push({ tech: 'flask', evidence: 'python deps' });
    if (/sqlalchemy/i.test(allPy)) stack.push({ tech: 'sqlalchemy', evidence: 'python deps' });
    if (/pytest/i.test(allPy)) stack.push({ tech: 'pytest', evidence: 'python deps' });
    if (/ruff/i.test(allPy)) stack.push({ tech: 'ruff', evidence: 'python deps' });
    if (/mypy/i.test(allPy)) stack.push({ tech: 'mypy', evidence: 'python deps' });
    if (/pydantic/i.test(allPy)) stack.push({ tech: 'pydantic', evidence: 'python deps' });
    if (/torch|pytorch/i.test(allPy)) stack.push({ tech: 'pytorch', evidence: 'python deps' });
    if (/pandas/i.test(allPy)) stack.push({ tech: 'pandas', evidence: 'python deps' });
  }

  // --- Go ---
  if (has('go.mod')) {
    stack.push({ tech: 'go', evidence: 'go.mod' });
    const gomod = readText('go.mod') || '';
    if (/gin-gonic/.test(gomod)) stack.push({ tech: 'gin', evidence: 'go.mod' });
    if (/gorilla\/mux/.test(gomod)) stack.push({ tech: 'gorilla', evidence: 'go.mod' });
    if (/gorm/.test(gomod)) stack.push({ tech: 'gorm', evidence: 'go.mod' });
    if (/grpc/.test(gomod)) stack.push({ tech: 'grpc', evidence: 'go.mod' });
    if (/cobra/.test(gomod)) stack.push({ tech: 'cobra-cli', evidence: 'go.mod' });
  }

  // --- Rust ---
  if (has('Cargo.toml')) {
    stack.push({ tech: 'rust', evidence: 'Cargo.toml' });
    const cargo = readText('Cargo.toml') || '';
    if (/actix/.test(cargo)) stack.push({ tech: 'actix', evidence: 'Cargo.toml' });
    if (/axum/.test(cargo)) stack.push({ tech: 'axum', evidence: 'Cargo.toml' });
    if (/tokio/.test(cargo)) stack.push({ tech: 'tokio', evidence: 'Cargo.toml' });
    if (/serde/.test(cargo)) stack.push({ tech: 'serde', evidence: 'Cargo.toml' });
    if (/sqlx/.test(cargo)) stack.push({ tech: 'sqlx', evidence: 'Cargo.toml' });
  }

  // --- Java / Kotlin ---
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    const buildFile = has('build.gradle.kts') ? 'build.gradle.kts' : has('build.gradle') ? 'build.gradle' : 'pom.xml';
    const content = readText(buildFile) || '';
    if (has('build.gradle.kts') || /kotlin/i.test(content)) stack.push({ tech: 'kotlin', evidence: buildFile });
    else stack.push({ tech: 'java', evidence: buildFile });
    if (/spring/i.test(content)) stack.push({ tech: 'spring', evidence: buildFile });
    if (/jetpack|compose/i.test(content)) stack.push({ tech: 'jetpack-compose', evidence: buildFile });
    if (/junit/i.test(content)) stack.push({ tech: 'junit', evidence: buildFile });
  }

  // --- Swift / iOS ---
  if (has('Package.swift') || has('Podfile') || fs.readdirSync(projectDir).some(f => f.endsWith('.xcodeproj'))) {
    stack.push({ tech: 'swift', evidence: has('Package.swift') ? 'Package.swift' : 'Xcode project' });
    if (has('Podfile')) stack.push({ tech: 'cocoapods', evidence: 'Podfile' });
    const packageSwift = readText('Package.swift') || '';
    if (/SwiftUI/.test(packageSwift)) stack.push({ tech: 'swiftui', evidence: 'Package.swift' });
    if (/Vapor/.test(packageSwift)) stack.push({ tech: 'vapor', evidence: 'Package.swift' });
  }

  // --- Ruby ---
  if (has('Gemfile')) {
    stack.push({ tech: 'ruby', evidence: 'Gemfile' });
    const gemfile = readText('Gemfile') || '';
    if (/rails/.test(gemfile)) stack.push({ tech: 'rails', evidence: 'Gemfile' });
    if (/rspec/.test(gemfile)) stack.push({ tech: 'rspec', evidence: 'Gemfile' });
    if (/rubocop/.test(gemfile)) stack.push({ tech: 'rubocop', evidence: 'Gemfile' });
  }

  // --- Infrastructure ---
  if (has('Dockerfile') || has('docker-compose.yml') || has('docker-compose.yaml')) {
    stack.push({ tech: 'docker', evidence: has('Dockerfile') ? 'Dockerfile' : 'docker-compose.yml' });
  }
  if (fs.readdirSync(projectDir).some(f => f.endsWith('.tf'))) {
    stack.push({ tech: 'terraform', evidence: '*.tf files' });
  }
  if (has('helm') || has('Chart.yaml')) {
    stack.push({ tech: 'helm', evidence: has('Chart.yaml') ? 'Chart.yaml' : 'helm/' });
  }
  if (has('dbt_project.yml')) {
    stack.push({ tech: 'dbt', evidence: 'dbt_project.yml' });
  }
  if (has('.github/workflows') || has('.github/actions')) {
    stack.push({ tech: 'github-actions', evidence: '.github/workflows' });
  }

  // --- Common tooling ---
  if (has('.env.example') || has('.env.sample')) stack.push({ tech: 'dotenv', evidence: '.env.example' });
  if (has('CLAUDE.md') || has('.claude/CLAUDE.md')) stack.push({ tech: 'claude-code', evidence: 'CLAUDE.md' });

  return stack;
}

/**
 * Build a human-readable stack fingerprint from detected technologies.
 * Example: "TypeScript (strict) + Express + Prisma + Vitest + ESM"
 */
export function buildStackFingerprint(stack) {
  const techs = stack.map(s => s.tech);
  // Group into a readable summary: language + framework + ORM + test + tooling
  const parts = [];
  // Language
  if (techs.includes('typescript')) parts.push(techs.includes('ts-strict') ? 'TypeScript (strict)' : 'TypeScript');
  else if (techs.includes('python')) parts.push('Python');
  else if (techs.includes('go')) parts.push('Go');
  else if (techs.includes('rust')) parts.push('Rust');
  else if (techs.includes('kotlin')) parts.push('Kotlin');
  else if (techs.includes('java')) parts.push('Java');
  else if (techs.includes('swift')) parts.push('Swift');
  else if (techs.includes('ruby')) parts.push('Ruby');
  else if (techs.includes('node')) parts.push('Node.js');
  // Framework
  for (const fw of ['react', 'vue', 'svelte', 'angular', 'nextjs', 'express', 'fastify', 'nestjs', 'koa', 'fastapi', 'django', 'flask', 'gin', 'axum', 'actix', 'spring', 'rails', 'vapor']) {
    if (techs.includes(fw)) parts.push(fw.charAt(0).toUpperCase() + fw.slice(1));
  }
  // ORM / data
  for (const orm of ['prisma', 'drizzle', 'sqlalchemy', 'gorm', 'sqlx', 'dbt', 'pandas', 'pytorch']) {
    if (techs.includes(orm)) parts.push(orm.charAt(0).toUpperCase() + orm.slice(1));
  }
  // Test
  for (const test of ['vitest', 'jest', 'mocha', 'pytest', 'rspec', 'junit']) {
    if (techs.includes(test)) parts.push(test.charAt(0).toUpperCase() + test.slice(1));
  }
  // Infra
  for (const infra of ['docker', 'terraform', 'helm', 'github-actions']) {
    if (techs.includes(infra)) parts.push(infra.charAt(0).toUpperCase() + infra.slice(1));
  }
  return parts.join(' + ') || 'Unknown stack';
}

// ---------------------------------------------------------------------------
// Rule generators — produce rules from detected stack items
// ---------------------------------------------------------------------------

const RULE_GENERATORS = {
  // --- JS/TS ecosystem ---
  esm: () => ({ rule: 'Use ESM imports (import/export), not CommonJS require()', confidence: 'high' }),
  typescript: () => ({ rule: 'Write TypeScript with explicit types; avoid `any`', confidence: 'high' }),
  'ts-strict': () => ({ rule: 'TypeScript strict mode is enabled; do not use @ts-ignore or @ts-nocheck', confidence: 'high' }),
  'ts-no-implicit-any': () => ({ rule: 'No implicit any types; always provide explicit type annotations', confidence: 'high' }),
  react: () => ({ rule: 'Use React functional components with hooks, not class components', confidence: 'medium' }),
  express: () => ({ rule: 'Wrap Express route handlers in asyncHandler or try/catch for error handling', confidence: 'high' }),
  fastify: () => ({ rule: 'Use Fastify schema validation for route inputs', confidence: 'high' }),
  nestjs: () => ({ rule: 'Follow NestJS module/controller/service pattern; use dependency injection', confidence: 'high' }),
  vitest: () => ({ rule: 'Use Vitest for testing; write test files as *.spec.ts or *.test.ts', confidence: 'high' }),
  jest: () => ({ rule: 'Use Jest for testing; write test files as *.test.ts or *.test.js', confidence: 'high' }),
  mocha: () => ({ rule: 'Use Mocha for testing', confidence: 'high' }),
  zod: () => ({ rule: 'Validate all external inputs with zod schemas at the boundary', confidence: 'high' }),
  prisma: () => ({ rule: 'Use Prisma client for database queries; never write raw SQL with string interpolation', confidence: 'high' }),
  drizzle: () => ({ rule: 'Use Drizzle ORM for database queries; use the query builder, not raw SQL', confidence: 'high' }),
  eslint: () => ({ rule: 'Code must pass ESLint without errors', confidence: 'medium' }),
  prettier: () => ({ rule: 'Format code with Prettier before committing', confidence: 'medium' }),
  tailwind: () => ({ rule: 'Use Tailwind CSS utility classes; avoid custom CSS where Tailwind suffices', confidence: 'medium' }),
  electron: () => ({ rule: 'Separate main and renderer process code; do not use nodeIntegration in renderer', confidence: 'high' }),

  // --- Python ecosystem ---
  python: () => ({ rule: 'Follow PEP 8 style; use type hints on all function signatures', confidence: 'medium' }),
  fastapi: () => ({ rule: 'Use Pydantic models for request/response validation in FastAPI endpoints', confidence: 'high' }),
  django: () => ({ rule: 'Follow Django project structure; use ORM queries, not raw SQL', confidence: 'high' }),
  flask: () => ({ rule: 'Use Flask blueprints for route organization; add error handlers', confidence: 'high' }),
  sqlalchemy: () => ({ rule: 'Use SQLAlchemy ORM or Core queries; never use f-string SQL', confidence: 'high' }),
  pytest: () => ({ rule: 'Write tests with pytest; place test files in tests/ with test_ prefix', confidence: 'high' }),
  ruff: () => ({ rule: 'Code must pass Ruff linting without errors', confidence: 'medium' }),
  mypy: () => ({ rule: 'Code must pass mypy type checking', confidence: 'high' }),
  pydantic: () => ({ rule: 'Use Pydantic models for data validation and serialization', confidence: 'high' }),
  pytorch: () => ({ rule: 'Use torch.no_grad() during inference; document tensor shapes in comments', confidence: 'medium' }),
  pandas: () => ({ rule: 'Prefer vectorized pandas operations over iterrows(); document DataFrame schemas', confidence: 'medium' }),

  // --- Go ecosystem ---
  go: () => ({ rule: 'Follow Go conventions: gofmt formatting, error returns instead of panics, short variable names in small scopes', confidence: 'high' }),
  gin: () => ({ rule: 'Use Gin middleware for auth and logging; validate inputs with binding tags', confidence: 'high' }),
  gorm: () => ({ rule: 'Use GORM for database queries; avoid raw SQL unless necessary', confidence: 'high' }),
  grpc: () => ({ rule: 'Define services in .proto files; generate Go code with protoc', confidence: 'high' }),
  'cobra-cli': () => ({ rule: 'Use Cobra for CLI commands; add help text and examples to every command', confidence: 'medium' }),

  // --- Rust ecosystem ---
  rust: () => ({ rule: 'Use Result<T, E> for error handling, not unwrap() in production code; run cargo clippy', confidence: 'high' }),
  actix: () => ({ rule: 'Use Actix extractors for request parsing; handle errors with ResponseError', confidence: 'high' }),
  axum: () => ({ rule: 'Use Axum extractors and layers; return proper StatusCode on errors', confidence: 'high' }),
  tokio: () => ({ rule: 'Use tokio::spawn for concurrent tasks; avoid blocking the async runtime', confidence: 'high' }),
  serde: () => ({ rule: 'Derive Serialize/Deserialize on all data types exchanged over API boundaries', confidence: 'medium' }),
  sqlx: () => ({ rule: 'Use sqlx query macros with compile-time checking; no string-interpolated SQL', confidence: 'high' }),

  // --- Java/Kotlin ecosystem ---
  java: () => ({ rule: 'Follow Java naming conventions; use try-with-resources for closeable objects', confidence: 'medium' }),
  kotlin: () => ({ rule: 'Use Kotlin idioms: data classes, null safety, sealed classes for exhaustive when', confidence: 'high' }),
  spring: () => ({ rule: 'Use Spring dependency injection; annotate with @Service/@Repository/@Controller', confidence: 'high' }),
  'jetpack-compose': () => ({ rule: 'Use Compose state management; avoid direct mutable state access in composables', confidence: 'high' }),
  junit: () => ({ rule: 'Write JUnit 5 tests for all public methods; use @ParameterizedTest for data-driven tests', confidence: 'high' }),

  // --- Swift/iOS ecosystem ---
  swift: () => ({ rule: 'Use Swift optionals and guard let for nil safety; follow Swift API design guidelines', confidence: 'high' }),
  swiftui: () => ({ rule: 'Use SwiftUI state management (@State, @Binding, @ObservedObject); keep views small', confidence: 'high' }),
  cocoapods: () => ({ rule: 'Keep Podfile.lock committed; run pod install after Podfile changes', confidence: 'medium' }),
  vapor: () => ({ rule: 'Use Vapor Content protocol for request/response; handle errors with abort()', confidence: 'high' }),

  // --- Ruby ecosystem ---
  ruby: () => ({ rule: 'Follow Ruby style guide; prefer descriptive method names; use frozen_string_literal', confidence: 'medium' }),
  rails: () => ({ rule: 'Follow Rails conventions: RESTful routes, ActiveRecord for queries, concerns for shared logic', confidence: 'high' }),
  rspec: () => ({ rule: 'Write RSpec tests with describe/context/it; place specs in spec/ mirroring app/', confidence: 'high' }),
  rubocop: () => ({ rule: 'Code must pass RuboCop without offenses', confidence: 'medium' }),

  // --- Infrastructure ---
  docker: () => ({ rule: 'Use multi-stage Docker builds; do not run containers as root; use .dockerignore', confidence: 'high' }),
  terraform: () => ({ rule: 'Use Terraform modules for reusable infrastructure; run terraform plan before apply; store state remotely', confidence: 'high' }),
  helm: () => ({ rule: 'Use Helm values.yaml for configuration; template all environment-specific values', confidence: 'high' }),
  dbt: () => ({ rule: 'Write dbt models in SQL with ref() for dependencies; add tests for primary keys and not-null constraints', confidence: 'high' }),
  'github-actions': () => ({ rule: 'Pin GitHub Actions to commit SHAs, not tags; use least-privilege permissions', confidence: 'high' }),
  dotenv: () => ({ rule: 'Use environment variables for secrets and configuration; never hardcode them', confidence: 'high' }),
};

// ---------------------------------------------------------------------------
// CLAUDE.md and git pattern scanners (language-agnostic)
// ---------------------------------------------------------------------------

function scanClaudeMd(projectDir) {
  const rules = [];
  const paths = [
    path.join(projectDir, 'CLAUDE.md'),
    path.join(projectDir, '.claude', 'CLAUDE.md'),
  ];
  for (const mdPath of paths) {
    if (!fs.existsSync(mdPath)) continue;
    const content = fs.readFileSync(mdPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^[-*]\s+/.test(trimmed) && /\b(use|always|never|must|should|avoid|prefer|keep|write|add|ensure|follow|run|do not|don't)\b/i.test(trimmed)) {
        const ruleText = trimmed.replace(/^[-*]\s+/, '').replace(/\*\*/g, '');
        if (ruleText.length > 15 && ruleText.length < 200) {
          rules.push({ rule: ruleText, source: path.basename(mdPath), confidence: 'high' });
        }
      }
    }
  }
  return rules;
}

function scanGitPatterns(projectDir) {
  const rules = [];
  try { execSync('git rev-parse --is-inside-work-tree', { cwd: projectDir, stdio: 'pipe' }); }
  catch { return rules; }

  try {
    const commits = execSync('git log --oneline -50 2>/dev/null', { cwd: projectDir, encoding: 'utf8' }).trim();
    if (commits) {
      const lines = commits.split('\n');
      const conventional = lines.filter(l => /^\w+ (feat|fix|docs|chore|test|refactor|style|perf|ci|build|revert)[(:!]/.test(l)).length;
      if (conventional > lines.length * 0.5) {
        rules.push({ rule: 'Use Conventional Commits format (feat:, fix:, docs:, chore:, etc.)', source: `git log: ${conventional}/${lines.length} conventional`, confidence: 'high' });
      }
    }
  } catch {}

  try {
    const diffs = execSync('git log --name-only --pretty=format:"---" -30 2>/dev/null', { cwd: projectDir, encoding: 'utf8' });
    const batches = diffs.split('---').filter(c => c.trim());
    let coChange = 0, srcChange = 0;
    for (const batch of batches) {
      const files = batch.trim().split('\n').filter(f => f.trim());
      const src = files.filter(f => /\.(ts|js|tsx|jsx|py|go|rs|rb|java|kt|swift)$/.test(f) && !/(test|spec|_test|_spec|__tests__)/.test(f));
      const test = files.filter(f => /(test|spec|_test|_spec|__tests__)/.test(f));
      if (src.length > 0) { srcChange++; if (test.length > 0) coChange++; }
    }
    if (srcChange >= 10 && coChange / srcChange > 0.6) {
      rules.push({ rule: 'Write a test file for every modified source file', source: `git log: ${Math.round(coChange / srcChange * 100)}% co-change rate`, confidence: 'medium' });
    }
  } catch {}

  return rules;
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

/**
 * Discover rules from a project directory.
 * Returns { rules, stack, fingerprint }
 */
export function discoverRules(projectDir) {
  const allRules = [];

  // 1. Detect the stack
  const stack = detectStack(projectDir);
  const fingerprint = buildStackFingerprint(stack);

  // 2. Generate rules from detected technologies
  for (const item of stack) {
    const generator = RULE_GENERATORS[item.tech];
    if (generator) {
      const r = generator();
      allRules.push({ ...r, source: item.evidence });
    }
  }

  // 3. Scan CLAUDE.md and git patterns
  allRules.push(...scanClaudeMd(projectDir));
  allRules.push(...scanGitPatterns(projectDir));

  // 4. Deduplicate
  const unique = [];
  const seen = new Set();
  for (const r of allRules) {
    const key = r.rule.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 40);
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }

  // 5. Sort by confidence
  const order = { high: 0, medium: 1, low: 2 };
  unique.sort((a, b) => (order[a.confidence] || 2) - (order[b.confidence] || 2));

  return { rules: unique, stack, fingerprint };
}

/**
 * Format discovered rules as a markdown route config section.
 */
export function formatDiscoveredRules(rules) {
  const lines = ['### Must Load'];
  const high = rules.filter(r => r.confidence === 'high');
  const medium = rules.filter(r => r.confidence === 'medium');

  for (const r of high) lines.push(`- ${r.rule}`);

  if (medium.length > 0) {
    lines.push('');
    lines.push('### Load If Budget Allows');
    for (const r of medium) lines.push(`- ${r.rule}`);
  }

  return lines.join('\n');
}

export { scanClaudeMd, scanGitPatterns, RULE_GENERATORS };
