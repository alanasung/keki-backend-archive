import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// This package translates between Square and our contracts; it must not
// reach into the database or any *-core package (AGENTS.md "Module
// boundaries"). Checking package.json directly is more reliable than an
// ESLint import-path rule, which only catches an actual `import` statement.
describe('module boundaries', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { name: string; dependencies?: Record<string, string> };
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});

  it('depends on no *-core package', () => {
    const coreDependencies = dependencyNames.filter(
      (name) => name.startsWith('@keki/') && name.endsWith('-core'),
    );

    expect(coreDependencies).toEqual([]);
  });

  it('depends on no @keki/database', () => {
    expect(dependencyNames).not.toContain('@keki/database');
  });

  it('declares the square SDK dependency', () => {
    expect(dependencyNames).toContain('square');
  });

  it('is the only workspace member depending on the Square SDK', () => {
    const repoRoot = new URL('../../../', import.meta.url);
    const manifestPaths = globSync('{apps,packages,functions}/*/package.json', {
      cwd: repoRoot,
    });

    const otherDependents = manifestPaths
      .filter((relativePath) => !relativePath.startsWith('packages/square-client/'))
      .filter((relativePath) => {
        const manifest = JSON.parse(readFileSync(new URL(relativePath, repoRoot), 'utf-8')) as {
          dependencies?: Record<string, string>;
        };
        return Object.keys(manifest.dependencies ?? {}).includes('square');
      });

    expect(otherDependents).toEqual([]);
  });
});
