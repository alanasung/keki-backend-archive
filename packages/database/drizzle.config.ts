import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { getDatabaseEnv } from './src/env';

// DDL through the connection pooler fails in confusing ways — always the
// direct URL here, never DATABASE_URL_POOLED.
const { direct } = getDatabaseEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: direct,
  },
});
