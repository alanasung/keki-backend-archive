import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { getDatabaseEnv } from './env';
import * as schema from './schema';

// Application traffic only. Migrations use src/migrate.ts against
// DATABASE_URL_DIRECT instead — see AGENTS.md "Data access".
const { pooled } = getDatabaseEnv();

const sqlClient = neon(pooled);

export const db = drizzle(sqlClient, { schema });
export { schema };
