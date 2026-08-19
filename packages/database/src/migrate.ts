import 'dotenv/config';
import { fileURLToPath } from 'node:url';
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
    // fileURLToPath, not `.pathname`: the latter leaves percent-encoding in
    // place, so a checkout under a directory with a space in its name (e.g.
    // "Keki Backend Prod") yields ".../Keki%20Backend%20Prod/..." and the
    // migrations folder is never found. CI only escapes this because its
    // workspace path happens to contain no spaces.
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
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
