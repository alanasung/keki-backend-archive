import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The `*-core` module boundary (AGENTS.md "Module boundaries") is a
// dependency-graph rule: no core package may depend on another core
// package, and catalog-core specifically must not depend on the Square SDK
// or @keki/square-client — syncCatalog receives a SquareClient by
// parameter, so the dependency direction stays interface-only (see WS-04
// spec, "Implementation Steps" step 1). Checking package.json directly is
// more reliable than an ESLint import-path rule, which only catches an
// actual `import` statement.
describe('module boundaries', () => {
  it('depends on no other *-core package, and never on the Square SDK', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { dependencies?: Record<string, string> };

    const dependencyNames = Object.keys(packageJson.dependencies ?? {});

    const coreDependencies = dependencyNames.filter(
      (name) => name.startsWith('@keki/') && name.endsWith('-core'),
    );
    expect(coreDependencies).toEqual([]);

    expect(dependencyNames).not.toContain('square');
    expect(dependencyNames).not.toContain('@keki/square-client');
  });
});
