import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditIntegrationSuites,
  collectIntegrationSuites,
  INTENTIONALLY_SKIPPED_IN_CI,
  REQUIRED_INTEGRATION_SUITES,
  type VitestAssertionResult,
  type VitestJsonReport,
} from './assert-integration-tests-ran';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

function reportWith(assertionResults: readonly VitestAssertionResult[]): VitestJsonReport {
  return { testResults: [{ assertionResults }] };
}

// One passing test per required suite, plus one *skipped* test per suite
// exempted from the execution check — the exact shape a healthy CI report
// has, and the "everything is fine" baseline each test below mutates, so a
// failure is attributable to exactly the one thing that test changed rather
// than an accidental gap in the fixture.
function passingBaseline(): VitestAssertionResult[] {
  return [
    ...REQUIRED_INTEGRATION_SUITES.map((name) => ({ ancestorTitles: [name], status: 'passed' })),
    ...INTENTIONALLY_SKIPPED_IN_CI.map((name) => ({ ancestorTitles: [name], status: 'skipped' })),
  ];
}

describe('collectIntegrationSuites', () => {
  it('ignores suites that are not prefixed "integration:"', () => {
    const report = reportWith([
      { ancestorTitles: ['getSquareClient'], status: 'passed' },
      { ancestorTitles: ['integration: syncCatalog'], status: 'passed' },
    ]);

    const found = collectIntegrationSuites(report);

    expect([...found.keys()]).toEqual(['integration: syncCatalog']);
  });

  it('counts skipped assertion results as not executed, and passed/failed as executed', () => {
    const report = reportWith([
      { ancestorTitles: ['integration: syncCatalog'], status: 'skipped' },
      { ancestorTitles: ['integration: syncCatalog'], status: 'passed' },
      { ancestorTitles: ['integration: syncCatalog'], status: 'failed' },
    ]);

    const found = collectIntegrationSuites(report);

    expect(found.get('integration: syncCatalog')).toEqual({ executed: 2, total: 3 });
  });

  it('groups by the outermost describe, ignoring nested describes', () => {
    const report = reportWith([
      { ancestorTitles: ['integration: migrations and database-level constraints', 'catalog_items'], status: 'skipped' },
    ]);

    const found = collectIntegrationSuites(report);

    expect(found.get('integration: migrations and database-level constraints')).toEqual({ executed: 0, total: 1 });
  });
});

describe('auditIntegrationSuites', () => {
  // Test 10 (WS-12 spec) — passes when every integration suite ran.
  it('passes with no failures when every required suite has at least one executed test', () => {
    const failures = auditIntegrationSuites(reportWith(passingBaseline()));

    expect(failures).toEqual([]);
  });

  // Test 9 — fails when a suite that IS present reports zero executed tests
  // (the `describe.skipIf` silent-pass scenario the risk register names).
  it('fails when an integration suite reports zero executed tests', () => {
    const assertions = passingBaseline().map((assertion) =>
      assertion.ancestorTitles[0] === 'integration: syncCatalog'
        ? { ancestorTitles: assertion.ancestorTitles, status: 'skipped' }
        : assertion,
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(failures.some((failure) => failure.includes('integration: syncCatalog'))).toBe(true);
    expect(failures.some((failure) => failure.includes('zero executed tests'))).toBe(true);
  });

  // The counterpart to the test above: a suite on INTENTIONALLY_SKIPPED_IN_CI
  // reporting zero executed tests is the expected CI outcome, not a failure.
  // Without this exemption the gate fails every run, because
  // SQUARE_ACCESS_TOKEN is deliberately never set as a CI secret
  // (docs/testing.md, "Sandbox payment-to-fulfillment").
  it('does not fail when an exempt suite reports zero executed tests', () => {
    const failures = auditIntegrationSuites(reportWith(passingBaseline()));

    for (const exemptName of INTENTIONALLY_SKIPPED_IN_CI) {
      expect(failures.some((failure) => failure.includes(exemptName))).toBe(false);
    }
    expect(failures).toEqual([]);
  });

  // The exemption covers *skipping*, never *disappearing*: an exempt suite
  // that no longer exists must fail exactly as a required one does.
  it('still fails when an exempt suite is absent from the report entirely', () => {
    const exemptNames = new Set<string>(INTENTIONALLY_SKIPPED_IN_CI);
    const assertions = passingBaseline().filter(
      (assertion) => !exemptNames.has(assertion.ancestorTitles[0] ?? ''),
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    for (const exemptName of INTENTIONALLY_SKIPPED_IN_CI) {
      expect(
        failures.some((failure) => failure.includes(exemptName) && failure.includes('not found')),
      ).toBe(true);
    }
  });

  // Test 11 — fails when a required suite is absent entirely (deleted), a
  // distinct failure mode from merely skipped: no assertion results at all
  // means the file (or the describe block) is gone.
  it('fails when the capacity concurrency suite is absent entirely, not merely skipped', () => {
    const assertions = passingBaseline().filter(
      (assertion) => assertion.ancestorTitles[0] !== 'integration: reservation concurrency (SC-08)',
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(
      failures.some(
        (failure) => failure.includes('reservation concurrency (SC-08)') && failure.includes('not found'),
      ),
    ).toBe(true);
  });

  it('names every required suite that is missing, not just the first', () => {
    const failures = auditIntegrationSuites(reportWith([]));

    for (const requiredName of REQUIRED_INTEGRATION_SUITES) {
      expect(failures.some((failure) => failure.includes(requiredName))).toBe(true);
    }
  });

  it('does not flag an unrelated integration suite as required when it is absent', () => {
    const failures = auditIntegrationSuites(reportWith(passingBaseline()));

    expect(failures.some((failure) => failure.includes('integration: reservation commands'))).toBe(false);
  });
});

// Process-level smoke tests: the unit tests above prove the audit logic is
// correct; these prove the CLI entry point actually surfaces that logic as
// an exit code, since that is the only thing a CI `run:` step observes.
describe('CLI', () => {
  function writeReport(assertionResults: readonly VitestAssertionResult[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'assert-integration-tests-ran-'));
    const reportPath = join(dir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(reportWith(assertionResults)));
    return reportPath;
  }

  function runCli(reportPath: string): { status: number } {
    try {
      execFileSync('pnpm', ['exec', 'tsx', join(SCRIPT_DIR, 'assert-integration-tests-ran.ts'), reportPath], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      return { status: 0 };
    } catch (error) {
      const status = (error as { status?: number }).status;
      return { status: status ?? 1 };
    }
  }

  it('exits zero when every required suite executed', () => {
    const reportPath = writeReport(passingBaseline());

    expect(runCli(reportPath).status).toBe(0);
  });

  it('exits non-zero when a required suite reports zero executed tests', () => {
    const assertions = passingBaseline().map((assertion) =>
      assertion.ancestorTitles[0] === 'integration: syncCatalog'
        ? { ancestorTitles: assertion.ancestorTitles, status: 'skipped' }
        : assertion,
    );
    const reportPath = writeReport(assertions);

    expect(runCli(reportPath).status).not.toBe(0);
  });

  it('exits non-zero when the report file does not exist', () => {
    expect(runCli(join(tmpdir(), 'does-not-exist-report.json')).status).not.toBe(0);
  });
});
