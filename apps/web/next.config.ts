import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@keki/auth', '@keki/ui', '@keki/contracts', '@keki/catalog-core'],
  typedRoutes: true,
  // The App Router bundles server dependencies by default; this is the
  // opt-out. `ws` — reached through @keki/database's `withTransaction`, which
  // needs the transaction-capable neon-serverless driver — guards its native
  // `bufferutil` addon behind a try/catch `require`. `bufferutil` is an
  // optional peer this repo does not install, so under Node's own resolution
  // that require throws and `ws` falls back to masking frames in JS. Bundled,
  // the require resolves to an empty module instead of throwing, the fallback
  // never engages, and the first outbound frame dies on
  // `bufferUtil.mask is not a function` — taking the Neon websocket down with
  // it, so `begin` fails with "Connection terminated unexpectedly" and
  // checkout 500s. Externalizing both restores the real require.
  serverExternalPackages: ['ws', '@neondatabase/serverless'],
};

export default nextConfig;
