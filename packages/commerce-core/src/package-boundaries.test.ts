import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The `*-core` module boundary (AGENTS.md "Module boundaries") is a
// dependency-graph rule: no core package may depend on another core
// package, and commerce-core in particular must depend on the SquareClient
// interface, never a vendor SDK. Checking package.json directly is more
// reliable than an ESLint import-path rule, which only catches an actual
// `import` statement.
describe('module boundaries', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { dependencies?: Record<string, string> };
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});

  it('depends on no other *-core package', () => {
    const coreDependencies = dependencyNames.filter(
      (name) => name.startsWith('@keki/') && name.endsWith('-core'),
    );

    expect(coreDependencies).toEqual([]);
  });

  it('declares no Square, SES, Twilio, or Klaviyo vendor SDK dependency', () => {
    const vendorSdkPattern = /square|ses|twilio|klaviyo/i;
    const vendorDependencies = dependencyNames.filter((name) => vendorSdkPattern.test(name));

    expect(vendorDependencies).toEqual([]);
  });
});
