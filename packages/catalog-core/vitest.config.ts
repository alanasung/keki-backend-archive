import { defineConfig } from 'vitest/config';

// `queries.test.ts` and `sync.test.ts` both write `catalog_items`, and
// `listCafeItems` has no filter parameter — its integration suite asserts on
// the whole table, so it is only correct while it is the sole writer. Vitest
// parallelizes test *files* within a package by default, so those two race and
// `excludes archived rows` intermittently sees a row `syncCatalog` seeded.
//
// This is the same reasoning `pnpm test`'s `--workspace-concurrency=1` and
// CI's consolidated `--no-file-parallelism` run already apply one level up
// (see .github/workflows/ci.yml): suites sharing one Neon branch must not
// interleave. Scoped to this package rather than set workspace-wide, because
// forcing it globally makes `notification-core`'s outbox suites fail — they
// pass under the default and are not the race being fixed here.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
