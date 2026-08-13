import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@keki/auth', '@keki/ui', '@keki/contracts', '@keki/catalog-core'],
  typedRoutes: true,
};

export default nextConfig;
