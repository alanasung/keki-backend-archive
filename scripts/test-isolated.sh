#!/usr/bin/env bash
# Run the workspace test suite against a throwaway Neon branch.
#
# Opt-in: `pnpm test` and the pipeline's verify gate still point at whatever
# DATABASE_URL_* your .env holds. This exists for when you want the isolation
# CI gets for free, without a Neon outage being able to block an ordinary
# test run.
#
# The branch is deleted in a trap, so a failed suite, a Ctrl-C, or a crash
# still cleans up. `db-branch.ts sweep` catches anything a hard kill leaks.
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH=""
cleanup() {
  if [ -n "$BRANCH" ]; then
    NODE_OPTIONS="--require=dotenv/config" pnpm exec tsx scripts/db-branch.ts delete "$BRANCH" || true
  fi
}
trap cleanup EXIT INT TERM

# `create` prints KEY='value' assignments on stdout and progress on stderr,
# so this eval picks up only the assignments.
eval "$(NODE_OPTIONS='--require=dotenv/config' pnpm exec tsx scripts/db-branch.ts create)"
BRANCH="$KEKI_LOCAL_BRANCH"

export DATABASE_URL_POOLED DATABASE_URL_DIRECT

# A Neon branch is a copy-on-write clone: the schema is there, but so is the
# parent's data. Several integration suites assert on whole-table contents or
# clean up with an unqualified `delete from`, which fails the moment an
# inherited row is referenced further down the FK graph. Emptying the mutable
# tables here is what makes the run actually isolated rather than merely
# concurrent-safe. Safe to do unconditionally: this branch dies on exit.
KEKI_ALLOW_DB_RESET=1 NODE_OPTIONS="--require=dotenv/config" \
  DATABASE_URL_POOLED="$DATABASE_URL_POOLED" DATABASE_URL_DIRECT="$DATABASE_URL_DIRECT" \
  pnpm exec tsx scripts/db-reset.ts

echo "running suite against $BRANCH" >&2
NODE_OPTIONS="--require=dotenv/config" pnpm exec vitest run --no-file-parallelism "$@"
