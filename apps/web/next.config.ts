import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Self-contained server for the production image (ops/docker/Dockerfile). Tracing starts at the
  // monorepo root so workspace packages (packages/core, packages/db) are copied too.
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  // `next dev` only trusts `localhost` for HMR; Playwright and most docs here use 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1'],
  // The default bottom-left badge covers the phone bottom navigation.
  devIndicators: { position: 'top-right' },
};

export default config;
