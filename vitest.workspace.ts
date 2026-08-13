import { defineWorkspace } from 'vitest/config';

// `pnpm test:coverage` (root package.json) runs this workspace with the v8
// coverage provider, reporting `text` and `lcov`. No global threshold is
// configured here on purpose: Phase 1 is deliberately mostly skeletons and
// `NotImplementedInPhase1` stubs, so a percentage gate would either be
// trivially satisfied by testing those throws or fail for entirely correct
// reasons. TODO(phase-2): add a coverage threshold once real domain logic
// lands (WS-12 spec step 2).
//
// One project per workspace package that defines a `test` script (AGENTS.md
// "Delivery": every `apps/*`, `packages/*`, `functions/*` package defines
// one, even if its Vitest project is currently empty). `pnpm -r test` stays
// the canonical command `pipeline.config.json` runs — this workspace file is
// local convenience and coverage aggregation only (WS-12 spec step 1).
//
// Most packages have no `vitest.config.ts` of their own and rely on
// Vitest's defaults (Node environment, default include globs) when run via
// their own `vitest run` script; that's reproduced here as inline `test`
// blocks rather than by inventing a per-package config file each. `@keki/ui`
// needs `jsdom` and `@keki/web` needs its explicit env stubs (see their own
// `vitest.config.ts` files), so those two are referenced directly instead.
const nodeProjects: Record<string, string> = {
  '@keki/auth': 'packages/auth',
  '@keki/catalog-core': 'packages/catalog-core',
  '@keki/commerce-core': 'packages/commerce-core',
  '@keki/contracts': 'packages/contracts',
  '@keki/customer-core': 'packages/customer-core',
  '@keki/database': 'packages/database',
  '@keki/notification-core': 'packages/notification-core',
  '@keki/pass-core': 'packages/pass-core',
  '@keki/reservation-core': 'packages/reservation-core',
  '@keki/square-client': 'packages/square-client',
  '@keki/infra': 'infra',
  '@keki/notification-worker': 'functions/notification-worker',
  '@keki/reconciliation-worker': 'functions/reconciliation-worker',
  '@keki/scheduled-task-worker': 'functions/scheduled-task-worker',
  '@keki/square-webhook': 'functions/square-webhook',
  // Not a pnpm workspace package (no package.json — `scripts/` is a plain
  // script directory, exempt from AGENTS.md's "every package defines all
  // four scripts" convention, same as scripts/deployed-stage-smoke.ts and
  // scripts/publish-sample-message.ts). Registered here anyway so
  // assert-integration-tests-ran.test.ts actually executes under `pnpm exec
  // vitest run` — the command WS-12's CI audit step uses to produce the
  // JSON report it then audits — rather than existing as dead test code no
  // command ever runs.
  '@keki/scripts': 'scripts',
};

export default defineWorkspace([
  ...Object.entries(nodeProjects).map(([name, root]) => ({
    test: { name, root, environment: 'node' as const },
  })),
  './packages/ui/vitest.config.ts',
  './apps/web/vitest.config.ts',
]);
