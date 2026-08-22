import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The `*-core` module boundary (AGENTS.md "Module boundaries") plus this
// package's own boundary: catalog-admin is the write path for staff,
// catalog-core is the read path customer ordering depends on, and a
// dependency either way invites the write path into the customer render
// path (see the workstream spec's Goal). Checking package.json directly is
// more reliable than an ESLint import-path rule, which only catches an
// actual `import` statement.
describe('module boundaries', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { dependencies?: Record<string, string> };
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});

  it('depends on no @keki/catalog-core and no other *-core package (test 23)', () => {
    const coreDependencies = dependencyNames.filter(
      (name) => name.startsWith('@keki/') && name.endsWith('-core'),
    );

    expect(coreDependencies).toEqual([]);
    expect(dependencyNames).not.toContain('@keki/catalog-core');
  });

  it('is registered in the vitest workspace so its suites actually run (test 24)', () => {
    const workspaceSource = readFileSync(
      new URL('../../../vitest.workspace.ts', import.meta.url),
      'utf-8',
    );

    expect(workspaceSource).toContain('@keki/catalog-admin');
    expect(workspaceSource).toContain('packages/catalog-admin');
  });
});
