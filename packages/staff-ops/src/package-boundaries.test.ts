import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// staff-ops is the write path for front-of-house staff. reservation-core is
// the checkout write path and catalog-admin is the scheduling write path —
// a dependency on either would blur the boundary the workstream spec's Goal
// describes, or invite this package into the customer render path. Checking
// package.json directly is more reliable than an ESLint import-path rule,
// which only catches an actual `import` statement.
describe('module boundaries', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { dependencies?: Record<string, string> };
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});

  it('depends only on @keki/contracts and @keki/database among internal packages (test 24)', () => {
    const internalDependencies = dependencyNames.filter((name) => name.startsWith('@keki/'));

    expect(internalDependencies.sort()).toEqual(['@keki/contracts', '@keki/database']);
    expect(dependencyNames).not.toContain('@keki/reservation-core');
    expect(dependencyNames).not.toContain('@keki/catalog-admin');
  });

  it('is registered in the vitest workspace so its suites actually run (test 23)', () => {
    const workspaceSource = readFileSync(
      new URL('../../../vitest.workspace.ts', import.meta.url),
      'utf-8',
    );

    expect(workspaceSource).toContain('@keki/staff-ops');
    expect(workspaceSource).toContain('packages/staff-ops');
  });

  it('is not imported by the customer surface (test 25)', () => {
    const customerAppDir = fileURLToPath(
      new URL('../../../apps/web/app/(customer)/', import.meta.url),
    );

    const files = readdirSync(customerAppDir, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name),
    );

    for (const file of files) {
      const source = readFileSync(join(file.parentPath, file.name), 'utf-8');
      expect(source).not.toContain('@keki/staff-ops');
    }
  });
});
