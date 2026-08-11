import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This program's most important guarantees — capacity under concurrency,
// schema-level constraints, webhook idempotency, catalog sync — live in
// `describe.skipIf(!hasLiveDatabase)` suites named `integration: ...`. A CI
// run where those silently skip is green and meaningless: the risk register
// names this explicitly, and this script is what turns "the gate cannot
// fail" into "the gate fails loudly."
//
// Run against the JSON report `vitest run --reporter=json` produces (Jest's
// JSON reporter shape, which Vitest 3 reuses): `testResults[].assertionResults[]`,
// each carrying `ancestorTitles` (the nested `describe` names, outermost
// first) and a `status` of `passed` / `failed` / `skipped` / `pending` /
// `todo`. A `describe.skipIf(true)(...)` block reports every one of its
// tests as `skipped` rather than omitting them, which is what makes this
// auditable at all — see this script's test file for a captured example.

const INTEGRATION_PREFIX = 'integration:';

// Named explicitly, not just "any suite with zero executed tests": deleting
// one of these must fail CI outright, not merely lose coverage quietly (WS-12
// spec step 6, acceptance criterion 7).
export const REQUIRED_INTEGRATION_SUITES = [
  'integration: reservation concurrency (SC-08)', // WS-06 capacity concurrency
  'integration: migrations and database-level constraints', // WS-02 schema constraints
  'integration: recordPaymentFromWebhook', // WS-10 webhook idempotency
  'integration: syncCatalog', // WS-04 catalog sync
] as const;

export interface VitestAssertionResult {
  readonly ancestorTitles: readonly string[];
  readonly status: string;
}

export interface VitestTestFileResult {
  readonly assertionResults: readonly VitestAssertionResult[];
}

export interface VitestJsonReport {
  readonly testResults: readonly VitestTestFileResult[];
}

interface SuiteCounts {
  executed: number;
  total: number;
}

/**
 * Groups every assertion whose outermost `describe` starts with
 * `integration:` by that describe's exact title. `ancestorTitles[0]` is the
 * outermost block for every suite in this program — none of them nest a
 * second `integration:` describe inside another.
 */
export function collectIntegrationSuites(report: VitestJsonReport): ReadonlyMap<string, SuiteCounts> {
  const suites = new Map<string, SuiteCounts>();

  for (const fileResult of report.testResults) {
    for (const assertion of fileResult.assertionResults) {
      const suiteName = assertion.ancestorTitles[0];
      if (suiteName === undefined || !suiteName.startsWith(INTEGRATION_PREFIX)) {
        continue;
      }
      const counts = suites.get(suiteName) ?? { executed: 0, total: 0 };
      counts.total += 1;
      // "Executed" means the test body ran at all — passed or failed both
      // count, since a failing test already fails `pnpm -r test` through the
      // ordinary gate. Only `skipped` (what `describe.skipIf` produces) is
      // the silent-pass failure mode this script exists to catch.
      if (assertion.status !== 'skipped') {
        counts.executed += 1;
      }
      suites.set(suiteName, counts);
    }
  }

  return suites;
}

/** Returns a human-readable failure message per problem found; empty when clean. */
export function auditIntegrationSuites(report: VitestJsonReport): readonly string[] {
  const found = collectIntegrationSuites(report);
  const failures: string[] = [];

  for (const [name, counts] of found) {
    if (counts.executed === 0) {
      failures.push(
        `"${name}" reports zero executed tests (${counts.total} skipped) — its integration suite did not run. ` +
          'Check that DATABASE_URL_POOLED/DATABASE_URL_DIRECT (or the equivalent live-dependency env var) is set ' +
          'in this job.',
      );
    }
  }

  for (const requiredName of REQUIRED_INTEGRATION_SUITES) {
    if (!found.has(requiredName)) {
      failures.push(
        `Required suite "${requiredName}" was not found in the report at all — has it been renamed or deleted?`,
      );
    }
  }

  return failures;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

function main(): void {
  const reportPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'vitest-report.json');

  let raw: string;
  try {
    raw = readFileSync(reportPath, 'utf-8');
  } catch (error) {
    console.error(`assert-integration-tests-ran: could not read the Vitest JSON report at "${reportPath}".`, error);
    process.exitCode = 1;
    return;
  }

  const report = JSON.parse(raw) as VitestJsonReport;
  const failures = auditIntegrationSuites(report);

  if (failures.length > 0) {
    console.error('assert-integration-tests-ran: integration test coverage gate failed:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `assert-integration-tests-ran: OK — every "integration:" suite executed, including all ` +
      `${REQUIRED_INTEGRATION_SUITES.length} required suites.`,
  );
}

if (isMainModule()) {
  main();
}
