import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = (name: string) => ({
  find: `@shuttle-lite/${name}`,
  replacement: fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
});

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      {
        find: '@shuttle-lite/core/progress',
        replacement: fileURLToPath(new URL('./packages/core/src/progress.ts', import.meta.url)),
      },
      {
        find: '@shuttle-lite/config/settings-schema',
        replacement: fileURLToPath(
          new URL('./packages/config/src/settings-schema.ts', import.meta.url),
        ),
      },
      ...['core', 'db', 'config', 'box', 'routing', 'telemetry'].map(alias),
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
