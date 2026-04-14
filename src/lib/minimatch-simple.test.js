import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { minimatch } from './minimatch-simple.js';

describe('minimatch', () => {
  it('matches exact path', () => {
    assert.ok(minimatch('src/auth.ts', 'src/auth.ts'));
  });

  it('matches * wildcard', () => {
    assert.ok(minimatch('auth.ts', '*.ts'));
    assert.ok(!minimatch('auth.ts', '*.js'));
  });

  it('matches ** wildcard across directories', () => {
    assert.ok(minimatch('src/auth/jwt.ts', 'src/**/*.ts'));
    assert.ok(minimatch('src/jwt.ts', 'src/**/*.ts'));
    assert.ok(!minimatch('docs/jwt.ts', 'src/**/*.ts'));
  });

  it('matches test file patterns', () => {
    assert.ok(minimatch('auth.test.ts', '*.test.ts'));
    assert.ok(minimatch('src/auth.test.ts', '**/*.test.ts'));
    assert.ok(!minimatch('auth.ts', '*.test.ts'));
  });

  it('matches generated file patterns', () => {
    assert.ok(minimatch('types.generated.ts', '*.generated.*'));
    assert.ok(minimatch('src/types.generated.ts', '**/*.generated.*'));
  });

  it('handles ? wildcard for single char', () => {
    assert.ok(minimatch('a.ts', '?.ts'));
    assert.ok(!minimatch('ab.ts', '?.ts'));
  });
});
