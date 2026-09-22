import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const config: NextConfig = {
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: [
    '@shuttle-lite/box',
    '@shuttle-lite/config',
    '@shuttle-lite/core',
    '@shuttle-lite/db',
    '@shuttle-lite/routing',
    '@shuttle-lite/telemetry',
  ],
  // Native module: it must not be bundled.
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingRoot: repoRoot,
  // Without this, opening the dev server on 127.0.0.1 blocks the HMR client
  // as a cross-origin request and the page never hydrates.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  experimental: {
    // The SSE endpoint streams for as long as the page is open.
    proxyTimeout: 0,
  },
};

export default config;
