#!/usr/bin/env bash
# The full test suite plus the integration-coverage audit, on a throwaway
# Neon branch. This is what `pipeline.config.json`'s verify.test runs.
#
# Why isolated: the build runner tells each workstream agent to run
# verification itself, then runs the same commands again independently. The
# agent's vitest process can still be finishing when the runner's starts, and
# two suites against one shared branch collide — which failed the gate on four
# workstreams across two programs and cost about three hours, every time on
# work that passed when re-run by hand seconds later.
#
# Giving verification its own database makes that collision impossible. The
# branch is deleted in a trap, so a failed suite, a Ctrl-C, or a crash still
# cleans up; `pnpm db:branch sweep` catches anything a hard kill leaks.
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH=""
cleanup() {
  if [ -n "$BRANCH" ]; then
    NODE_OPTIONS="--require=dotenv/config" pnpm exec tsx scripts/db-branch.ts delete "$BRANCH" || true
  fi
}
trap cleanup EXIT INT TERM

eval "$(NODE_OPTIONS='--require=dotenv/config' pnpm exec tsx scripts/db-branch.ts create)"
BRANCH="$KEKI_LOCAL_BRANCH"
export DATABASE_URL_POOLED DATABASE_URL_DIRECT

# A Neon branch is a copy-on-write clone: the schema is there, but so is the
# parent's data. Several suites assert on whole-table contents or clean up
# with an unqualified `delete from`, which fails the moment an inherited row
# is referenced further down the FK graph.
KEKI_ALLOW_DB_RESET=1 NODE_OPTIONS="--require=dotenv/config" \
  DATABASE_URL_POOLED="$DATABASE_URL_POOLED" DATABASE_URL_DIRECT="$DATABASE_URL_DIRECT" \
  pnpm exec tsx scripts/db-reset.ts

echo "verifying against $BRANCH" >&2
NODE_OPTIONS="--require=dotenv/config" pnpm exec vitest run \
  --no-file-parallelism --reporter=default --reporter=json --outputFile=vitest-report.json
NODE_OPTIONS="--require=dotenv/config" pnpm exec tsx scripts/assert-integration-tests-ran.ts vitest-report.json
