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

  // WS-09 spec test 11: the catalog-admin audit suite matters most — SC-11's
  // rollback guarantee is easy to delete when it becomes inconvenient, and
  // impossible to notice missing without this gate naming it explicitly.
  it('fails when the catalog-admin audit suite is absent entirely', () => {
    const assertions = passingBaseline().filter(
      (assertion) => assertion.ancestorTitles[0] !== 'integration: catalog-admin audit',
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(
      failures.some((failure) => failure.includes('integration: catalog-admin audit') && failure.includes('not found')),
    ).toBe(true);
  });

  // WS-09 spec test 12: passes when the catalog-admin suites — offerings,
  // occurrences, and audit — all ran with a non-zero count.
  it('passes when the catalog-admin offering, occurrence, and audit suites all executed', () => {
    const failures = auditIntegrationSuites(reportWith(passingBaseline()));

    for (const catalogAdminSuite of [
      'integration: catalog-admin offerings',
      'integration: catalog-admin occurrences',
      'integration: catalog-admin audit',
    ]) {
      expect(REQUIRED_INTEGRATION_SUITES).toContain(catalogAdminSuite);
      expect(failures.some((failure) => failure.includes(catalogAdminSuite))).toBe(false);
    }
  });

  // WS-09 spec test 13: the pre-existing zero-executed-tests behavior is
  // unchanged by adding the catalog-admin suites above.
  it('still fails a zero-count integration suite unrelated to catalog-admin', () => {
    const assertions = passingBaseline().map((assertion) =>
      assertion.ancestorTitles[0] === 'integration: reservation concurrency (SC-08)'
        ? { ancestorTitles: assertion.ancestorTitles, status: 'skipped' }
        : assertion,
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(
      failures.some(
        (failure) => failure.includes('integration: reservation concurrency (SC-08)') && failure.includes('zero executed tests'),
      ),
    ).toBe(true);
  });

  // phase-4-staff-surfaces WS-09 spec test 14: naming the staff-ops suites
  // explicitly means deleting the check-in suite fails CI outright — SC-11's
  // rollback guarantee and the roll-up-consistency cases are the kind of
  // thing that's easy to delete when it becomes inconvenient, and impossible
  // to notice missing without this gate naming it.
  it('fails when the staff-ops check-in suite is absent entirely', () => {
    const assertions = passingBaseline().filter(
      (assertion) => assertion.ancestorTitles[0] !== 'integration: staff-ops check-in',
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(
      failures.some((failure) => failure.includes('integration: staff-ops check-in') && failure.includes('not found')),
    ).toBe(true);
  });

  it('fails when the staff-ops queries suite is absent entirely', () => {
    const assertions = passingBaseline().filter(
      (assertion) => assertion.ancestorTitles[0] !== 'integration: staff-ops queries',
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(
      failures.some((failure) => failure.includes('integration: staff-ops queries') && failure.includes('not found')),
    ).toBe(true);
  });

  // Test 15: passes when both staff-ops suites ran with a non-zero count.
  it('passes when the staff-ops check-in and queries suites both executed', () => {
    const failures = auditIntegrationSuites(reportWith(passingBaseline()));

    for (const staffOpsSuite of ['integration: staff-ops check-in', 'integration: staff-ops queries']) {
      expect(REQUIRED_INTEGRATION_SUITES).toContain(staffOpsSuite);
      expect(failures.some((failure) => failure.includes(staffOpsSuite))).toBe(false);
    }
  });

  // Test 16: the pre-existing zero-executed-tests behavior is unchanged by
  // adding the staff-ops suites above.
  it('still fails a zero-count integration suite unrelated to staff-ops', () => {
    const assertions = passingBaseline().map((assertion) =>
      assertion.ancestorTitles[0] === 'integration: syncCatalog'
        ? { ancestorTitles: assertion.ancestorTitles, status: 'skipped' }
        : assertion,
    );

    const failures = auditIntegrationSuites(reportWith(assertions));

    expect(
      failures.some(
        (failure) => failure.includes('integration: syncCatalog') && failure.includes('zero executed tests'),
      ),
    ).toBe(true);
  });

  // Test 17: this program's additions did not displace the Phase 3 suites.
  it('still requires the three catalog-admin suites from phase-3-admin-catalog', () => {
    for (const catalogAdminSuite of [
      'integration: catalog-admin offerings',
      'integration: catalog-admin occurrences',
      'integration: catalog-admin audit',
    ]) {
      expect(REQUIRED_INTEGRATION_SUITES).toContain(catalogAdminSuite);
    }
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
