import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The `*-core` module boundary (AGENTS.md "Module boundaries") is a
// dependency-graph rule: no core package may depend on another core
// package. Checking package.json directly is more reliable than an ESLint
// import-path rule, which only catches an actual `import` statement.
describe('module boundaries', () => {
  it('depends on no other *-core package', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { dependencies?: Record<string, string> };

    const coreDependencies = Object.keys(packageJson.dependencies ?? {}).filter(
      (name) => name.startsWith('@keki/') && name.endsWith('-core'),
    );

    expect(coreDependencies).toEqual([]);
  });
});
