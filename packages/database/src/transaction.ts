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
let pool: Pool | undefined;
function getPool(): Pool {
  if (pool === undefined) {
    neonConfig.webSocketConstructor = ws;
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
