import 'dotenv/config';
import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import ws from 'ws';
import { getDatabaseEnv } from './env';

neonConfig.webSocketConstructor = ws;

async function main(): Promise<void> {
  const { direct } = getDatabaseEnv();
  const pool = new Pool({ connectionString: direct });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
  } finally {
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('Migrations applied successfully.');
  })
  .catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  });
