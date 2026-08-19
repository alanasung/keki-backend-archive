import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { getDatabaseEnv } from './env';
import * as schema from './schema';

// `db` (client.ts) uses the neon-http driver, which has no real
// `db.transaction()` — it throws "No transactions support in neon-http
// driver" at runtime (drizzle-orm/neon-http/session.js). WS-06
// (reservation-core) is the first caller that needs a genuine multi-statement
// transaction: `holdReservation` must either join a caller-supplied
// transaction or open its own, and both must support a real ROLLBACK so a
// capacity failure never leaves a partial hold behind. The neon-serverless
// driver over a websocket `Pool` is Neon's transaction-capable client — the
// same one src/migrate.ts and schema.test.ts already use for DDL and
// constraint tests. This makes that pattern reusable instead of duplicating
// pool/websocket setup in every package that needs a real transaction, which
// AGENTS.md "Data access" reserves for this package alone.

// Node 22 (.nvmrc) ships a native global `WebSocket`; prefer it, and keep
// `ws` only as the fallback for a runtime that lacks one.
//
// `ws` guards its optional native `bufferutil` addon behind a try/catch
// `require`, and `bufferutil` is not installed here — under Node's own
// resolution that require throws and `ws` masks frames in JS instead. But
// this module is also pulled into Next's server bundle (checkout calls
// `withTransaction` through commerce-core's `createOrder`), and there the
// require resolves to an empty module rather than throwing: the fallback
// never engages and the first frame over ws's 48-byte threshold dies on
// `bufferUtil.mask is not a function`, taking the Neon socket down with it.
// Next's `serverExternalPackages` cannot fix that from apps/web — pnpm's
// strict node_modules layout leaves `ws` unresolvable from there, which is
// where Next resolves that list. Native `WebSocket` carries no addon and no
// masking code of its own, so the hazard goes away instead of being routed
// around.
//
// migrate.ts and schema.test.ts still import `ws` directly: both run in plain
// Node under tsx/vitest, never through a bundler, so the guarded require
// behaves and there is nothing to avoid.
const webSocketConstructor = globalThis.WebSocket ?? (ws as unknown as typeof WebSocket);

let pool: Pool | undefined;
function getPool(): Pool {
  if (pool === undefined) {
    neonConfig.webSocketConstructor = webSocketConstructor;
    pool = new Pool({ connectionString: getDatabaseEnv().pooled });
  }
  return pool;
}

let transactionalDb: NeonDatabase<typeof schema> | undefined;
function getTransactionalDb(): NeonDatabase<typeof schema> {
  transactionalDb ??= drizzle(getPool(), { schema });
  return transactionalDb;
}

export type Tx = Parameters<Parameters<NeonDatabase<typeof schema>['transaction']>[0]>[0];

/**
 * Opens a real Postgres transaction (BEGIN/COMMIT/ROLLBACK), not the
 * neon-http `db`'s single implicit-per-statement kind. Callers that already
 * hold a `Tx` — e.g. a `TransactionScope` handed down from an outer
 * transaction — should use it directly rather than nesting a new one.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getTransactionalDb().transaction(fn);
}
